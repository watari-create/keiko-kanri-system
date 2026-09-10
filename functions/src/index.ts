import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { GoogleAuth } from "google-auth-library";
import * as crypto from "crypto";

admin.initializeApp();
const db = admin.firestore();

// Slack Bot Token（xoxb-...）。chat.postMessageで請求書発行依頼メッセージを送るのに使う。
// 設定方法： firebase functions:secrets:set SLACK_BOT_TOKEN
const slackBotToken = defineSecret("SLACK_BOT_TOKEN");

// Slack Appの「Signing Secret」。Slackから届くイベント通知が本物かを検証するのに使う。
// 設定方法： firebase functions:secrets:set SLACK_SIGNING_SECRET
const slackSigningSecret = defineSecret("SLACK_SIGNING_SECRET");

// 請求書発行依頼の通知を送るSlackチャンネルのID（例：C0123456789）。
// Botをこのチャンネルに /invite しておくこと。デプロイ時にCLIから入力を求められる。
const slackLicenseChannel = defineString("SLACK_LICENSE_CHANNEL");

// 休会・退会・復会の申請通知を送るSlackチャンネルのID（本部稽古bo）。
// Botをこのチャンネルに /invite しておくこと。デプロイ時にCLIから入力を求められる。
const slackHqChannel = defineString("SLACK_HQ_CHANNEL");

// 請求書発行依頼のSlack通知でメンションする人のSlackユーザーID（例：U0123456）。
// 未設定でもエラーにはならず、メンションなしで通知するだけになる。
const slackLicenseMentionUserId = defineString("SLACK_LICENSE_MENTION_USER_ID", { default: "" });

// 本部の共有GoogleカレンダーのカレンダーID（カレンダー設定の「カレンダーの統合」欄にある）。
// デプロイ時にCLIから入力を求められる（.env.sohenryu-okeiko-management に保存される）。
const hqCalendarId = defineString("HQ_CALENDAR_ID");

/**
 * マイページ・スタッフポータルのログイン確認。
 * 会員番号＋メールアドレスの組み合わせが members または staff コレクションと一致すれば、
 * role等のクレーム付きカスタムトークンを発行する。
 *
 * フロントは result.token を signInWithCustomToken() に渡す。
 */
export const verifyMemberLogin = onCall<{ memberNo: string; email: string }>(async (request) => {
  const { memberNo, email } = request.data;
  if (!memberNo || !email) {
    throw new HttpsError("invalid-argument", "会員番号とメールアドレスを入力してください。");
  }
  const normalizedEmail = email.trim().toLowerCase();

  // まず会員（マイページ）として確認
  const memberSnap = await db.collection("members").doc(memberNo).get();
  if (memberSnap.exists && (memberSnap.data()?.email || "").trim().toLowerCase() === normalizedEmail) {
    const uid = `member_${memberNo}`;
    const token = await admin.auth().createCustomToken(uid, {
      role: "member",
      memberId: memberNo,
    });
    return { token, role: "member" };
  }

  // 次にスタッフ（世話人・講師）として確認
  const staffSnap = await db.collection("staff").doc(memberNo).get();
  if (staffSnap.exists && (staffSnap.data()?.email || "").trim().toLowerCase() === normalizedEmail) {
    const uid = `staff_${memberNo}`;
    const token = await admin.auth().createCustomToken(uid, {
      role: "staff",
      staffId: memberNo,
    });
    return { token, role: "staff" };
  }

  throw new HttpsError("not-found", "会員番号とメールアドレスの組み合わせが確認できませんでした。");
});

/**
 * leaveRequests のステータスが pending → approved に変わったら、
 * members 側のステータスを自動的に反映し、通知ログに記録する。
 */
export const onLeaveRequestApproved = onDocumentUpdated(
  "leaveRequests/{requestId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === "pending" && after.status === "approved") {
      const newStatus = after.type === "復会" ? "在籍" : after.type;
      await db.collection("members").doc(after.memberId).update({ status: newStatus });
      await db.collection("notifications").add({
        kind: "leave_approved",
        message: `${after.memberName}様の${after.type}申請が受理されました。`,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
  }
);

/**
 * licenseRequests のステータスが「発行済」に変わったら、
 * members 側の許状段階を更新し、通知ログに記録する。
 */
export const onLicenseIssued = onDocumentUpdated(
  { document: "licenseRequests/{requestId}", secrets: [slackBotToken] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status !== "発行済" && after.status === "発行済") {
      await db.collection("members").doc(after.memberId).update({ license: after.licenseName });
      await db.collection("notifications").add({
        kind: "license_issued",
        message: `${after.memberName}様の「${after.licenseName}」が発行されました。`,
        createdAt: new Date().toISOString(),
        read: false,
      });

      // 講師が生徒に許状をお渡しできたら✔️のリアクションで「お渡し済」に進められるよう、
      // 本部稽古boチャンネルに通知する（下のslackEventsで突き合わせに使う）。
      const token = slackBotToken.value();
      const channel = slackHqChannel.value();
      if (token && channel) {
        const text =
          `許状が発行されました\n` +
          `会員：${after.memberName}様\n` +
          `許状：${after.licenseName}\n` +
          `生徒様にお渡しできたら、このメッセージに✔️のリアクションをつけてください（自動でステータスが進みます）。`;
        try {
          const posted = await postSlackMessage(token, channel, text);
          if (posted && event.data) {
            await event.data.after.ref.update({
              slackTs: posted.ts,
              slackChannel: posted.channel,
            });
            console.log(`Slack通知を送信しました ts=${posted.ts}`);
          }
        } catch (err) {
          console.error("Slack通知の送信に失敗しました", err);
        }
      } else {
        console.warn("SLACK_BOT_TOKEN または SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
      }
    }
  }
);

/**
 * Slack Web API（chat.postMessage）でメッセージを送信する。
 * Incoming Webhookと違い、送信したメッセージの ts（タイムスタンプ／ID）が返ってくるため、
 * あとで届く reaction_added イベントと突き合わせることができる。
 */
async function postSlackMessage(
  token: string,
  channel: string,
  text: string
): Promise<{ ts: string; channel: string } | null> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    ts?: string;
    channel?: string;
    error?: string;
  };
  if (!data.ok || !data.ts || !data.channel) {
    console.error(`Slack chat.postMessageがエラーを返しました: ${data.error ?? "unknown"}`);
    return null;
  }
  return { ts: data.ts, channel: data.channel };
}

/**
 * 許状申請が「請求書発行依頼」になったら、Slackに通知する（請求書発行の担当者への合図）。
 * それ以外のステータス変更では通知しない。許状段階の反映は上のonLicenseIssuedが別途行う。
 *
 * 送信したメッセージの ts / channel を licenseRequests ドキュメントに保存しておき、
 * 下の slackEvents（✔️リアクション受信）で突き合わせに使う。
 */
export const onLicenseRequestStatusChanged = onDocumentUpdated(
  { document: "licenseRequests/{requestId}", secrets: [slackBotToken] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return;
    if (after.status !== "請求書発行依頼") return;

    const token = slackBotToken.value();
    if (!token) {
      console.warn("SLACK_BOT_TOKEN が未設定のため、Slack通知をスキップしました。");
      return;
    }
    const channel = slackLicenseChannel.value();
    if (!channel) {
      console.warn("SLACK_LICENSE_CHANNEL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const mentionUserId = slackLicenseMentionUserId.value();
    const mentionPrefix = mentionUserId ? `<@${mentionUserId}> ` : "";
    const text =
      mentionPrefix +
      `請求書発行のご依頼です\n` +
      `会員：${after.memberName}様\n` +
      `許状：${after.licenseName}\n` +
      `合計：¥${after.fee?.toLocaleString?.() ?? after.fee}\n` +
      `発行できたら、このメッセージに✔️のリアクションをつけてください（自動でステータスが進みます）。`;

    try {
      const posted = await postSlackMessage(token, channel, text);
      if (posted && event.data) {
        await event.data.after.ref.update({
          slackTs: posted.ts,
          slackChannel: posted.channel,
        });
        console.log(`Slack通知を送信しました ts=${posted.ts}`);
      }
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }
  }
);

/**
 * leaveRequests が新規作成されたら（申請直後、status: "pending"）、Slackに通知する。
 * 本部担当者がこのメッセージに✔️のリアクションをつけると、下のslackEventsが検知して
 * 自動的に「承認」処理を行う（onLeaveRequestApprovedが会員ステータスへ反映）。
 *
 * 送信したメッセージの ts / channel を leaveRequests ドキュメントに保存しておき、
 * 下の slackEvents（✔️リアクション受信）で突き合わせに使う。
 */
export const onLeaveRequestCreated = onDocumentCreated(
  { document: "leaveRequests/{requestId}", secrets: [slackBotToken] },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.status !== "pending") return;

    const token = slackBotToken.value();
    if (!token) {
      console.warn("SLACK_BOT_TOKEN が未設定のため、Slack通知をスキップしました。");
      return;
    }
    const channel = slackHqChannel.value();
    if (!channel) {
      console.warn("SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const text =
      `${data.type}申請が届きました\n` +
      `会員：${data.memberName}様（${data.group ?? ""}）\n` +
      (data.reason ? `理由：${data.reason}\n` : "") +
      `承認する場合は、このメッセージに✔️のリアクションをつけてください（自動でステータスが進みます）。`;

    try {
      const posted = await postSlackMessage(token, channel, text);
      if (posted && event.data) {
        await event.data.ref.update({
          slackTs: posted.ts,
          slackChannel: posted.channel,
        });
        console.log(`Slack通知を送信しました ts=${posted.ts}`);
      }
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }
  }
);

/**
 * members に新規ドキュメントが作成されたら（/enroll ページからの入会申し込み）、
 * Slackに通知する（入門セット準備の合図）。承認フローは無く、通知のみ。
 */
// 名月会のFirestore上のgroup名。入門セット在庫の自動減算の対象を判定するのに使う。
const MEIGETSUKAI_GROUP = "名月会";

// 会員の性別（入会フォームの「性別」欄）から、減らすべき入門セットの品目名を決める。
// 性別が未設定・不明な場合は null を返し、在庫は減らさない。
function nyumonSetKeyForGender(gender: unknown): string | null {
  if (gender === "男の子") return "男性用入門セット";
  if (gender === "女の子") return "女性用入門セット";
  return null;
}

/**
 * 名月会の入門セット在庫を、新規入門1件につき1つ減らす。
 * 男の子なら「男性用入門セット」、女の子なら「女性用入門セット」を、それぞれ1つだけ減らす
 * （こども服紗・扇子などの単品は自動では減らさない。管理画面から手動で調整する）。
 * 0未満にはせず、結果が0になった場合はその品目名を返す（Slack通知で在庫不足として知らせる）。
 * ドキュメントが未作成、または対象の品目が未登録の場合は何もしない
 * （先に管理画面で在庫を登録しておく想定）。性別が未設定・不明な場合も何もしない。
 */
async function decrementNyumonSetInventory(gender: unknown): Promise<string[]> {
  const key = nyumonSetKeyForGender(gender);
  if (!key) {
    console.warn(`性別が未設定または不明（"${String(gender)}"）のため、入門セット在庫の自動減算をスキップしました。`);
    return [];
  }
  const ref = db.doc("meta/nyumonSetInventory");
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        console.warn(
          "meta/nyumonSetInventory が未作成のため、入門セット在庫の自動減算をスキップしました。"
        );
        return [];
      }
      const current = (snap.data()?.items ?? {}) as Record<string, number>;
      if (!(key in current)) {
        console.warn(
          `meta/nyumonSetInventory に「${key}」が登録されていないため、入門セット在庫の自動減算をスキップしました。`
        );
        return [];
      }
      const next = Math.max(0, (Number(current[key]) || 0) - 1);
      tx.update(ref, {
        [`items.${key}`]: next,
        updatedAt: new Date().toISOString(),
        updatedBy: "system:入門登録",
      });
      return next === 0 ? [key] : [];
    });
  } catch (err) {
    console.error("入門セット在庫の自動減算に失敗しました", err);
    return [];
  }
}

export const onMemberCreated = onDocumentCreated(
  { document: "members/{memberId}", secrets: [slackBotToken] },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // 本部稽古（名月会・茶道教室・Gマダムの茶の湯講座）の入会申込のみ通知する。
    // 宗徧流稽古・UCIの新規登録（名簿のCSV一括取り込みを含む）ではSlack通知しない。
    if (data.groupCategory !== "本部稽古") return;

    // 名月会の新規入門なら、性別に応じた入門セット在庫を自動的に1減らす（Slack通知の有無に関わらず実行）。
    const lowStockItems =
      data.group === MEIGETSUKAI_GROUP ? await decrementNyumonSetInventory(data.gender) : [];

    const token = slackBotToken.value();
    if (!token) {
      console.warn("SLACK_BOT_TOKEN が未設定のため、Slack通知をスキップしました。");
      return;
    }
    const channel = slackHqChannel.value();
    if (!channel) {
      console.warn("SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const text =
      `新しい入会申込がありました\n` +
      `会員：${data.name ?? ""}様（${data.group ?? ""}）\n` +
      `会員No：${event.params.memberId}\n` +
      `入門セット（扇子、懐紙、服紗）をご用意ください。` +
      (lowStockItems.length > 0
        ? `\n⚠️ 入門セットの在庫が不足しています：${lowStockItems.join("、")}`
        : "");

    try {
      await postSlackMessage(token, channel, text);
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }

    await db.collection("notifications").add({
      kind: "new_enrollment",
      message: `${data.name ?? ""}様が入会しました。`,
      createdAt: new Date().toISOString(),
      read: false,
    });
  }
);

/**
 * Slack Events API受信エンドポイント。
 * 「請求書発行依頼」のSlackメッセージに✔️（heavy_check_mark）のリアクションがつくと、
 * 対応するlicenseRequestsのステータスを自動的に「請求書発行済」に進める。
 *
 * 事前準備（Slack App側）：
 * 1. api.slack.com/apps でAppを作成
 * 2. OAuth & Permissions → Bot Token Scopes に chat:write, reactions:read を追加してインストール
 * 3. Event Subscriptions を有効化し、Request URLにこの関数のデプロイ後URLを設定
 * 4. Subscribe to bot events で reaction_added を追加
 * 5. BotをSlackチャンネルに /invite しておく
 */
export const slackEvents = onRequest(
  { secrets: [slackSigningSecret] },
  async (req, res) => {
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signingSecret = slackSigningSecret.value();

    if (!signature || !timestamp || !signingSecret) {
      res.status(400).send("bad request");
      return;
    }

    // リプレイ攻撃対策：5分以上古いリクエストは拒否
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) {
      res.status(400).send("stale request");
      return;
    }

    const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
    const baseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
    const expectedSignature =
      "v0=" + crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).send("invalid signature");
      return;
    }

    const body = req.body;

    // Slackアプリ作成時・Event Subscriptions設定時の初回URL検証
    if (body.type === "url_verification") {
      res.status(200).send(body.challenge);
      return;
    }

    if (body.type === "event_callback") {
      const slackEvent = body.event;
      if (
        slackEvent?.type === "reaction_added" &&
        slackEvent.reaction === "heavy_check_mark" &&
        slackEvent.item?.type === "message"
      ) {
        const snap = await db
          .collection("licenseRequests")
          .where("slackTs", "==", slackEvent.item.ts)
          .limit(1)
          .get();
        if (!snap.empty) {
          const requestDoc = snap.docs[0];
          if (requestDoc.data().status === "請求書発行依頼") {
            await requestDoc.ref.update({
              status: "請求書発行済",
              updatedAt: new Date().toISOString(),
            });
            console.log(`✔️リアクションによりステータスを更新しました requestId=${requestDoc.id}`);
          } else if (requestDoc.data().status === "発行済") {
            await requestDoc.ref.update({
              status: "お渡し済",
              updatedAt: new Date().toISOString(),
            });
            console.log(`✔️リアクションにより許状のお渡しステータスを更新しました requestId=${requestDoc.id}`);
          }
        }

        const leaveSnap = await db
          .collection("leaveRequests")
          .where("slackTs", "==", slackEvent.item.ts)
          .limit(1)
          .get();
        if (!leaveSnap.empty) {
          const leaveDoc = leaveSnap.docs[0];
          if (leaveDoc.data().status === "pending") {
            await leaveDoc.ref.update({
              status: "approved",
              approvedAt: new Date().toISOString(),
              approvedBy: "slack",
            });
            console.log(`✔️リアクションにより休会・退会・復会申請を承認しました requestId=${leaveDoc.id}`);
          }
        }
      }
    }

    res.status(200).send("ok");
  }
);

// 「次回のお稽古」表示の対象となる会。イベントのタイトルにこの文字列が
// 含まれているかどうかで、どの会のお稽古かを判定する（例："名月会お稽古"）。
const LESSON_GROUPS = ["名月会", "Gマダムの茶の湯講座", "茶道教室"];

interface NextLessonInfo {
  date: string; // イベントのstart（終日なら日付のみ、時刻指定ならISO日時）
  title: string;
}

/**
 * 本部の共有Googleカレンダーから、直近120日以内の予定を読み取り、
 * LESSON_GROUPS それぞれについて一番近い予定を拾う。
 *
 * 事前準備：
 * 1. Google Cloud ConsoleでCalendar APIを有効化する
 *    （gcloud services enable calendar-json.googleapis.com）
 * 2. 対象のGoogleカレンダーを、Cloud Functionsのランタイムサービスアカウント
 *    （例：69899565701-compute@developer.gserviceaccount.com）と
 *    「予定の詳細を表示する」権限で共有する
 */
async function fetchNextLessonDates(): Promise<Record<string, NextLessonInfo>> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Googleカレンダーへのアクセストークンを取得できませんでした。カレンダーがサービスアカウントと共有されているか確認してください。");
  }

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 120).toISOString();

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(hqCalendarId.value())}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=100`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken.token}` } });
  if (!res.ok) {
    throw new Error(`Googleカレンダーの取得に失敗しました：${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    items?: { summary?: string; start?: { date?: string; dateTime?: string } }[];
  };
  const items = data.items ?? [];

  const result: Record<string, NextLessonInfo> = {};
  for (const group of LESSON_GROUPS) {
    const match = items.find((ev) => (ev.summary ?? "").includes(group));
    const date = match?.start?.dateTime ?? match?.start?.date;
    if (match && date) {
      result[group] = { date, title: match.summary ?? "" };
    }
  }
  return result;
}

/**
 * 30分ごとに本部の共有Googleカレンダーを確認し、各会の「次回のお稽古」日を
 * meta/nextLessonDates に保存する。管理画面・スタッフ画面・マイページはこの
 * ドキュメントをそのまま表示する（onSnapshotで購読するだけでよい）。
 */
export const syncNextLessonDates = onSchedule(
  { schedule: "every 30 minutes", timeZone: "Asia/Tokyo" },
  async () => {
    const dates = await fetchNextLessonDates();
    await db.doc("meta/nextLessonDates").set({ dates, updatedAt: new Date().toISOString() });
  }
);

/**
 * 上と同じ処理を、待たずに手動で今すぐ実行するための呼び出し可能関数（本部のみ）。
 * カレンダー共有設定後の動作確認などに使う。
 */
export const syncNextLessonDatesNow = onCall(async (request) => {
  if (request.auth?.token?.role !== "honbu") {
    throw new HttpsError("permission-denied", "本部のみ実行できます。");
  }
  const dates = await fetchNextLessonDates();
  await db.doc("meta/nextLessonDates").set({ dates, updatedAt: new Date().toISOString() });
  return { dates };
});

// G1（Gマダムの茶の湯講座）で毎回発送する道具のデフォルト一覧。
const G1_SHIPPING_ITEMS = ["お軸", "花入", "主茶盌", "菓子器"];

// 荷物発送リマインダーでメンションするSlackユーザーID。
const G1_SHIPPING_MENTION_USER_ID = "UAK415FF0";

// JST（Asia/Tokyo）での「今日」を "YYYY-MM-DD" で返す。
// Cloud FunctionsのランタイムはOSのタイムゾーンがUTCのことが多く、
// new Date().getDate() 等をそのまま使うと日付がずれるため、Intlで明示的にJSTへ変換する。
function todayKeyJST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD" の日付キーに days 日を加算した日付キーを返す（暦日だけの単純な加算）。
function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * 毎朝、G1（Gマダムの茶の湯講座）の「次回のお稽古」日（meta/nextLessonDatesを参照）が
 * ちょうど1週間後になったら、荷物発送のリマインダーを本部稽古boチャンネルに送る。
 * 同じお稽古日について二重送信しないよう、meta/g1ShippingReminder に送信済みの
 * お稽古日を記録しておく。
 */
export const checkG1ShippingReminder = onSchedule(
  { schedule: "every day 09:00", timeZone: "Asia/Tokyo", secrets: [slackBotToken] },
  async () => {
    const nextLessonSnap = await db.doc("meta/nextLessonDates").get();
    const info = nextLessonSnap.data()?.dates?.["Gマダムの茶の湯講座"] as
      | { date: string; title: string }
      | undefined;
    if (!info?.date) return;

    const lessonDateKey = info.date.slice(0, 10);
    const targetDateKey = addDaysToDateKey(todayKeyJST(), 7);
    if (lessonDateKey !== targetDateKey) return;

    const reminderRef = db.doc("meta/g1ShippingReminder");
    const reminderSnap = await reminderRef.get();
    if (reminderSnap.data()?.notifiedForDate === lessonDateKey) return; // 送信済み

    const token = slackBotToken.value();
    const channel = slackHqChannel.value();
    if (!token || !channel) {
      console.warn("SLACK_BOT_TOKEN または SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const text =
      `<@${G1_SHIPPING_MENTION_USER_ID}>\n` +
      `【G1 荷物発送リマインダー】\n` +
      `次回のお稽古（${lessonDateKey}）まで1週間です。荷物の発送をお願いします。\n` +
      `送るもの：${G1_SHIPPING_ITEMS.join("・")}`;

    try {
      await postSlackMessage(token, channel, text);
      await reminderRef.set({ notifiedForDate: lessonDateKey, notifiedAt: new Date().toISOString() });
      console.log(`G1荷物発送リマインダーを送信しました lessonDate=${lessonDateKey}`);
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }
  }
);

/**
 * Square Webhook受信エンドポイント（雛形）。
 * 実際の導入時は、Square側のWebhook署名検証を必ず行うこと。
 * https://developer.squareup.com/docs/webhooks/step3verify
 */
export const squareWebhook = onRequest(async (req, res) => {
  // TODO: req.headers["x-square-hmacsha256-signature"] を使った署名検証を実装する
  const event = req.body;

  if (event?.type === "payment.updated" && event?.data?.object?.payment?.status === "COMPLETED") {
    const payment = event.data.object.payment;
    await db.collection("paymentEvents").add({
      amount: payment.amount_money?.amount ?? null,
      squarePaymentId: payment.id,
      receivedAt: new Date().toISOString(),
      matched: false, // TODO: メモ欄の会員番号などで members と突き合わせる処理を追加
    });
  }

  res.status(200).send("ok");
});
