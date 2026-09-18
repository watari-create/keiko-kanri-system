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

// LINE公式アカウント（Messaging API）のチャンネルアクセストークン。応答メッセージの送信に使う。
// 設定方法： firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
const lineChannelAccessToken = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

// LINE公式アカウントのチャンネルシークレット。Webhookの送信元がLINEであることを検証するのに使う。
// 設定方法： firebase functions:secrets:set LINE_CHANNEL_SECRET
const lineChannelSecret = defineSecret("LINE_CHANNEL_SECRET");

// LIFFアプリを追加した「LINEログイン」チャネル（Messaging APIのチャネルとは別チャネル。
// LIFFアプリはLINEログインチャネルにしか追加できない）のチャネルID。チャネル基本設定タブに表示される数字。
// マイページのLIFF連携で受け取るID Tokenの検証（audクレームの確認）に使う。
// デプロイ時にCLIから入力を求められる（.env.sohenryu-okeiko-management に保存される）。
const liffChannelId = defineString("LINE_LIFF_CHANNEL_ID");

// 請求書発行依頼の通知を送るSlackチャンネルのID（例：C0123456789）。
// Botをこのチャンネルに /invite しておくこと。デプロイ時にCLIから入力を求められる。
const slackLicenseChannel = defineString("SLACK_LICENSE_CHANNEL");

// 休会・退会・復会の申請通知を送るSlackチャンネルのID（本部稽古bo）。
// Botをこのチャンネルに /invite しておくこと。デプロイ時にCLIから入力を求められる。
const slackHqChannel = defineString("SLACK_HQ_CHANNEL");

// Slack通知文などユーザーの目に触れるテキストに使う表示用グループ名。
// Firestoreのgroupフィールドやクエリ条件・メンション対象判定などの内部的な値は、既存データとの
// 整合性のためこれまで通り「Gマダムの茶の湯講座」のままにし、表示だけ「G1マダムの茶の湯講座」にする。
const GROUP_DISPLAY_NAMES: Record<string, string> = {
  "Gマダムの茶の湯講座": "G1マダムの茶の湯講座",
};
function groupDisplayName(group: unknown): string {
  if (typeof group !== "string") return "";
  return GROUP_DISPLAY_NAMES[group] ?? group;
}

// 請求書発行依頼のSlack通知でメンションする人のSlackユーザーID（例：U0123456）。
// 未設定でもエラーにはならず、メンションなしで通知するだけになる。
const slackLicenseMentionUserId = defineString("SLACK_LICENSE_MENTION_USER_ID", { default: "" });

// 許状「発行済」のSlack通知でメンションする人のSlackユーザーID（例：U0123456）。
// 未設定でもエラーにはならず、メンションなしで通知するだけになる。
// メンションするのは名月会・Gマダムの茶の湯講座の申請のみ（下のonLicenseIssued内で判定）。
const slackLicenseIssuedMentionUserId = defineString("SLACK_LICENSE_ISSUED_MENTION_USER_ID", {
  default: "",
});

// 名月会の新規入会があったときの「入会金 請求書発行依頼」Slack通知でメンションする人（大谷さん）の
// SlackユーザーID（例：U0123456）。通知先チャンネルはSLACK_LICENSE_CHANNEL（請求書-経理全般）を流用する。
// 未設定でもエラーにはならず、メンションなしで通知するだけになる。
const slackEntryFeeMentionUserId = defineString("SLACK_ENTRY_FEE_MENTION_USER_ID", { default: "" });

// 本部の共有GoogleカレンダーのカレンダーID（カレンダー設定の「カレンダーの統合」欄にある）。
// デプロイ時にCLIから入力を求められる（.env.sohenryu-okeiko-management に保存される）。
const hqCalendarId = defineString("HQ_CALENDAR_ID");

// アプリの本番URL。Slack通知の「detail」ボタンのリンク先などに使う。
const APP_BASE_URL = "https://okeiko.sohenryu.com";

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
 * 入会申し込み（/enroll、未ログイン）から、既存のご家族（兄弟姉妹・保護者など）の会員番号と
 * 登録メールアドレスを入力してもらい、一致すれば新規会員と既存会員を相互に
 * linkedMemberIds で連携する。verifyMemberLogin と同じ「会員番号＋登録メールアドレス」の
 * 組み合わせを本人確認代わりに使う（第三者が無関係の会員番号を無断で連携できないようにするため）。
 * マイページの「家族を切り替える」機能はこのリストを参照する想定。
 */
export const linkFamilyOnEnroll = onCall<{
  newMemberId: string;
  existingMemberNo: string;
  existingEmail: string;
}>(async (request) => {
  const { newMemberId, existingMemberNo, existingEmail } = request.data;
  if (!newMemberId || !existingMemberNo || !existingEmail) {
    throw new HttpsError("invalid-argument", "会員番号とメールアドレスを入力してください。");
  }
  if (newMemberId === existingMemberNo) {
    throw new HttpsError("invalid-argument", "同じ会員番号は連携できません。");
  }
  const normalizedEmail = existingEmail.trim().toLowerCase();

  const newRef = db.collection("members").doc(newMemberId);
  const existingRef = db.collection("members").doc(existingMemberNo);

  return db.runTransaction(async (tx) => {
    const [newSnap, existingSnap] = await Promise.all([tx.get(newRef), tx.get(existingRef)]);
    if (!newSnap.exists) {
      throw new HttpsError("not-found", "新しく発行された会員番号が見つかりませんでした。");
    }
    if (!existingSnap.exists) {
      throw new HttpsError("not-found", "会員番号とメールアドレスの組み合わせが確認できませんでした。");
    }
    const existingData = existingSnap.data() as admin.firestore.DocumentData;
    if (((existingData.email as string) || "").trim().toLowerCase() !== normalizedEmail) {
      throw new HttpsError("not-found", "会員番号とメールアドレスの組み合わせが確認できませんでした。");
    }
    const newData = newSnap.data() as admin.firestore.DocumentData;

    const newLinked: string[] = Array.from(
      new Set([...(((newData.linkedMemberIds as string[]) ?? [])), existingMemberNo])
    );
    const existingLinked: string[] = Array.from(
      new Set([...(((existingData.linkedMemberIds as string[]) ?? [])), newMemberId])
    );

    tx.update(newRef, { linkedMemberIds: newLinked });
    tx.update(existingRef, { linkedMemberIds: existingLinked });

    return { linked: true, existingMemberName: (existingData.name as string) ?? "" };
  });
});

/**
 * マイページの「ご家族を切り替える」機能。ログイン中の会員（親など）から、
 * 連携済みのご家族（linkedMemberIdsに含まれる会員番号）へ、再ログインなしで
 * 切り替えるためのカスタムトークンを発行する。
 * 連携関係はログイン中の会員自身のドキュメントを見て確認する（クライアントから
 * 送られてきた値は信用しない）ため、連携していない会員番号を指定しても発行されない。
 */
export const switchToLinkedMember = onCall<{ targetMemberId: string }>(async (request) => {
  if (!request.auth || request.auth.token.role !== "member") {
    throw new HttpsError("permission-denied", "マイページにログインしてからご利用ください。");
  }
  const currentMemberId = request.auth.token.memberId as string | undefined;
  const { targetMemberId } = request.data;
  if (!currentMemberId || !targetMemberId) {
    throw new HttpsError("invalid-argument", "切り替え先の会員番号が指定されていません。");
  }
  if (targetMemberId === currentMemberId) {
    throw new HttpsError("invalid-argument", "同じ会員番号には切り替えられません。");
  }

  const currentSnap = await db.collection("members").doc(currentMemberId).get();
  const linkedIds = (currentSnap.data()?.linkedMemberIds as string[] | undefined) ?? [];
  if (!linkedIds.includes(targetMemberId)) {
    throw new HttpsError("permission-denied", "この会員へは切り替えられません。");
  }

  const targetSnap = await db.collection("members").doc(targetMemberId).get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "切り替え先の会員が見つかりませんでした。");
  }

  const token = await admin.auth().createCustomToken(`member_${targetMemberId}`, {
    role: "member",
    memberId: targetMemberId,
  });
  return { token };
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
 * licenseRequests のステータス変更に応じて、Slack通知と許状段階の反映を行う。
 *
 * ・「発行済」になったら → 講師が生徒にお渡しできるよう、Slackに通知する
 *   （許状段階の反映はまだ行わない。✔️リアクションで「お渡し済」に進む）。
 * ・「完了」になったら → members 側の許状段階（license）を実際に更新し、通知ログに記録する
 *   （本部の管理者が管理画面で最後の「次に進める」を押したタイミング）。
 */
export const onLicenseIssued = onDocumentUpdated(
  { document: "licenseRequests/{requestId}", secrets: [slackBotToken] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    if (before.status !== "発行済" && after.status === "発行済") {
      // 講師が生徒に許状をお渡しできたら✔️のリアクションで「お渡し済」に進められるよう、
      // 本部稽古boチャンネルに通知する（下のslackEventsで突き合わせに使う）。
      const token = slackBotToken.value();
      const channel = slackHqChannel.value();
      if (token && channel) {
        // メンションするのは名月会・Gマダムの茶の湯講座のみ（茶道教室では通知するがメンションしない）。
        const mentionTargetGroups = ["名月会", "Gマダムの茶の湯講座"];
        const mentionUserId = mentionTargetGroups.includes(after.group)
          ? slackLicenseIssuedMentionUserId.value()
          : "";
        const mentionPrefix = mentionUserId ? `<@${mentionUserId}> ` : "";
        const text =
          mentionPrefix +
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

    if (before.status !== "完了" && after.status === "完了") {
      // 茶歴（licenseHistory）にも取得年月を記録する。申請時に指定された申請月（issueMonth）が
      // あればそれを使い、なければ完了操作を行った今月を使う。
      const now = new Date();
      const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const issueMonth = after.issueMonth || fallbackMonth;

      await db
        .collection("members")
        .doc(after.memberId)
        .update({
          license: after.licenseName,
          [`licenseHistory.${after.licenseName}`]: issueMonth,
        });
      await db.collection("notifications").add({
        kind: "license_issued",
        message: `${after.memberName}様の「${after.licenseName}」の手続きが完了しました。`,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
  }
);

/**
 * Slack Web API（chat.postMessage）でメッセージを送信する。
 * Incoming Webhookと違い、送信したメッセージの ts（タイムスタンプ／ID）が返ってくるため、
 * あとで届く reaction_added イベントと突き合わせることができる。
 *
 * blocks を渡すと、Block Kitのリッチな表示（ボタンなど）で送信する
 * （text はその場合も通知プレビュー用のフォールバックとして必須）。
 */
async function postSlackMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<{ ts: string; channel: string } | null> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(blocks ? { channel, text, blocks } : { channel, text }),
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
 * Slackメッセージに「detail」ボタン（押すと指定URLへ移動）を付けるためのBlock Kitブロックを作る。
 */
function detailButtonBlocks(bodyText: string, url: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: bodyText },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "detail", emoji: true },
          url,
        },
      ],
    },
  ];
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
 * licenseRequests が新規作成されたら（講師が許状申請した直後、status: "受付"）、Slackに通知する。
 * 「detail」ボタンを押すと、管理画面のその申請までジャンプできる。
 *
 * ステータスの進行はここでは行わない（本部の担当者が管理画面の「次に進める」を押して進める）。
 */
export const onLicenseRequestCreated = onDocumentCreated(
  { document: "licenseRequests/{requestId}", secrets: [slackBotToken] },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.status !== "受付") return;

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

    const detailUrl = `${APP_BASE_URL}/admin?licenseRequestId=${event.params.requestId}`;
    const text =
      `許状申請が届きました\n` +
      `会員：${data.memberName}様（${groupDisplayName(data.group)}）\n` +
      `許状：${data.licenseName}`;

    try {
      await postSlackMessage(token, channel, text, detailButtonBlocks(text, detailUrl));
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
      `会員：${data.memberName}様（${groupDisplayName(data.group)}）\n` +
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

// 生年月日から満年齢を計算する（入会した瞬間の年齢を計算する）。
function calculateAgeFromBirthDate(birthDate: unknown, at: Date = new Date()): number | null {
  if (typeof birthDate !== "string" || !birthDate) return null;
  const bd = new Date(birthDate);
  if (Number.isNaN(bd.getTime())) return null;
  let age = at.getFullYear() - bd.getFullYear();
  const monthDiff = at.getMonth() - bd.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < bd.getDate())) {
    age--;
  }
  return age;
}

// 年齢から、減らすべき服紗の品目名を決める（3〜8歳と9歳以上で品目が分かれている）。
// 3歳未満・年齢不明の場合は null を返し、服紗の在庫は減らさない。
function fukusaKeyForAge(age: number | null): string | null {
  if (age === null) return null;
  if (age >= 3 && age <= 8) return "子供用服紗（3歳から8歳まで）";
  if (age >= 9) return "服紗（9歳以上）";
  return null;
}

// 性別（入会フォームの「性別」欄）から、減らすべき扇子の品目名を決める。
// 性別が未設定・不明な場合は null を返し、在庫は減らさない。
function sensuKeyForGender(gender: unknown): string | null {
  if (gender === "男性") return "扇子　男性用";
  if (gender === "女性") return "扇子　女性用";
  return null;
}

/**
 * 名月会の入門セット在庫を、新規入門1件につき減らす。
 * ・服紗：年齢に応じて「子供用服紗（3歳から8歳まで）」または「服紗（9歳以上）」を1つ
 * ・扇子：性別に応じて「扇子　男性用」または「扇子　女性用」を1つ
 * ・懐紙：年齢・性別に関わらず、必ず1つ
 * をそれぞれ減らす（年齢・性別が未設定/不明、または3歳未満の場合は、服紗・扇子はその分だけスキップする）。
 * 0未満にはせず、結果が0になった品目名を返す（Slack通知で在庫不足として知らせる）。
 * ドキュメントが未作成、または対象の品目が未登録の場合はその品目だけスキップする
 * （先に管理画面で在庫を登録しておく想定）。
 */
async function decrementNyumonSetInventory(gender: unknown, birthDate: unknown): Promise<string[]> {
  const age = calculateAgeFromBirthDate(birthDate);
  const fukusaKey = fukusaKeyForAge(age);
  const sensuKey = sensuKeyForGender(gender);
  if (!fukusaKey) {
    console.warn(`年齢が不明または3歳未満（"${String(age)}"）のため、服紗の在庫の自動減算をスキップしました。`);
  }
  if (!sensuKey) {
    console.warn(`性別が未設定または不明（"${String(gender)}"）のため、扇子の在庫の自動減算をスキップしました。`);
  }
  const keysToDecrement = ["懐紙", fukusaKey, sensuKey].filter((k): k is string => !!k);

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
      const updates: Record<string, number> = {};
      const lowStock: string[] = [];
      for (const key of keysToDecrement) {
        if (!(key in current)) {
          console.warn(
            `meta/nyumonSetInventory に「${key}」が登録されていないため、この品目の自動減算をスキップしました。`
          );
          continue;
        }
        const next = Math.max(0, (Number(current[key]) || 0) - 1);
        updates[`items.${key}`] = next;
        if (next === 0) lowStock.push(key);
      }
      if (Object.keys(updates).length === 0) return [];
      tx.update(ref, {
        ...updates,
        updatedAt: new Date().toISOString(),
        updatedBy: "system:入門登録",
      });
      return lowStock;
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

    // インポート漏れの既存会員を後から追加するようなバックフィルは、新規入会ではないため
    // Slack通知・入門セット在庫の自動減算の対象外とする（ドキュメントに skipEnrollmentNotice: true を立てて作成する）。
    if (data.skipEnrollmentNotice === true) return;

    // 名月会の新規入門なら、年齢・性別に応じた入門セット在庫を自動的に減らす（Slack通知の有無に関わらず実行）。
    const lowStockItems =
      data.group === MEIGETSUKAI_GROUP
        ? await decrementNyumonSetInventory(data.gender, data.birthDate)
        : [];

    const token = slackBotToken.value();
    if (!token) {
      console.warn("SLACK_BOT_TOKEN が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const channel = slackHqChannel.value();
    if (!channel) {
      console.warn("SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
    } else {
      const text =
        `新しい入会申込がありました\n` +
        `会員：${data.name ?? ""}様（${groupDisplayName(data.group)}）\n` +
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
    }

    // 名月会の新規入会なら、入会金（¥33,000）の請求書発行依頼を経理チャンネルに送る（大谷さん宛）。
    // 経理タブでの入金確認（entryFeeStatus）とは連動しない、あくまで発行依頼の合図。
    if (data.group === MEIGETSUKAI_GROUP) {
      const entryFeeChannel = slackLicenseChannel.value();
      if (!entryFeeChannel) {
        console.warn(
          "SLACK_LICENSE_CHANNEL が未設定のため、入会金請求書発行依頼のSlack通知をスキップしました。"
        );
      } else {
        const mentionUserId = slackEntryFeeMentionUserId.value();
        const mentionPrefix = mentionUserId ? `<@${mentionUserId}> ` : "";
        const entryFeeText =
          mentionPrefix +
          `入会金の請求書発行のご依頼です\n` +
          `会員：${data.name ?? ""}様（名月会）\n` +
          `会員No：${event.params.memberId}\n` +
          `入会金：¥33,000`;
        try {
          await postSlackMessage(token, entryFeeChannel, entryFeeText);
        } catch (err) {
          console.error("入会金請求書発行依頼のSlack通知に失敗しました", err);
        }
      }
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
 * 対応するlicenseRequestsのステータスを自動的に「発行手続き中」に進める。
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
              status: "発行手続き中",
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

/**
 * LINE公式アカウントに応答メッセージ（replyToken使用・無料）を送信する。
 * プッシュメッセージと違い、ユーザーからのメッセージ受信をきっかけにした返信のみに使える。
 */
async function replyLineMessage(replyToken: string, accessToken: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error(`LINE応答メッセージの送信に失敗しました: ${res.status} ${await res.text()}`);
  }
}

/**
 * LINE公式アカウントからプッシュメッセージ(1人宛)を送信する。応答メッセージと違い、
 * 無料枠(月200通)を消費するため、必要な相手にだけ送るよう呼び出し側で絞り込むこと。
 */
async function pushLineMessage(userId: string, accessToken: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error(`LINEプッシュメッセージの送信に失敗しました(to=${userId}): ${res.status} ${await res.text()}`);
  }
}

/**
 * LINE公式アカウントからマルチキャストメッセージ(複数人へ一括送信)を送信する。宛先ごとに
 * 無料枠(月200通)を消費する。LINE側の上限(1回あたり500人まで)に合わせて分割して送る。
 */
async function multicastLineMessage(userIds: string[], accessToken: string, text: string): Promise<void> {
  const chunkSize = 500;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to: chunk, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) {
      console.error(`LINEマルチキャストメッセージの送信に失敗しました: ${res.status} ${await res.text()}`);
    }
  }
}

function formatDateJp(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getMonth() + 1}月${d.getDate()}日(${weekdays[d.getDay()]})`;
}

/**
 * LINE連携済みの会員に「予約状況」と聞かれたときの返信文を組み立てる。
 * 茶道教室・土曜日クラスの会員は直近の予約（午前/午後・担当講師）、それ以外は
 * 次回のお稽古日と現在の出欠回答（rsvp）を案内する。
 */
async function buildLineStatusMessage(
  member: FirebaseFirestore.DocumentData & { id: string }
): Promise<string> {
  if (member.group === "茶道教室" && member.chadoClass === "土曜日") {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db
      .collection("chadoSaturdaySessions")
      .where("date", ">=", today)
      .orderBy("date")
      .limit(10)
      .get();
    for (const sessionDoc of snap.docs) {
      const data = sessionDoc.data();
      const amBookings = (data.amBookings ?? []) as Array<{ memberId: string }>;
      const pmBookings = (data.pmBookings ?? []) as Array<{ memberId: string }>;
      if (amBookings.some((b) => b.memberId === member.id)) {
        return `${member.name}様
${formatDateJp(data.date)}（午前）にご予約があります。${
          data.amTeacher ? `担当：${data.amTeacher}` : ""
        }`;
      }
      if (pmBookings.some((b) => b.memberId === member.id)) {
        return `${member.name}様
${formatDateJp(data.date)}（午後）にご予約があります。${
          data.pmTeacher ? `担当：${data.pmTeacher}` : ""
        }`;
      }
    }
    return `${member.name}様
現在、今後のご予約はありません。ご予約はマイページからどうぞ。`;
  }

  const nextLessonSnap = await db.doc("meta/nextLessonDates").get();
  const dates = nextLessonSnap.data()?.dates as Record<string, { date: string }> | undefined;
  const next = dates?.[member.group];
  const rsvp = member.rsvp ?? "未回答";
  if (next) {
    return `${member.name}様
次回のお稽古：${formatDateJp(next.date)}
出欠回答：${rsvp}`;
  }
  return `${member.name}様
現在の出欠回答：${rsvp}`;
}

/**
 * LINE公式アカウントのWebhook（メッセージ受信）を処理する。
 * 応答メッセージ（replyToken使用）のみを使うため、料金は一切発生しない。
 *
 * 会員番号（数字）を送ると、そのLINEアカウントを会員（members/{id}）に連携する
 * （members/{id}.lineUserId に保存）。連携済みのアカウントが「予約状況」を含む
 * メッセージを送ると、予約・出欠の状況を返信する。
 *
 * リッチメニューのボタンは、LINE公式アカウントマネージャー側で
 * 「アクション：テキスト」「テキスト：予約状況」のように設定すれば、
 * ユーザーがそのボタンを押したときと同じメッセージイベントとして届く
 * （Webhook側で個別のpostback対応を実装する必要はない）。
 */
export const lineEvents = onRequest(
  { secrets: [lineChannelAccessToken, lineChannelSecret] },
  async (req, res) => {
    const signature = req.headers["x-line-signature"] as string | undefined;
    const channelSecret = lineChannelSecret.value();
    if (!signature || !channelSecret) {
      res.status(400).send("bad request");
      return;
    }

    const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
    const expectedSignature = crypto
      .createHmac("sha256", channelSecret)
      .update(rawBody)
      .digest("base64");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).send("invalid signature");
      return;
    }

    const accessToken = lineChannelAccessToken.value();
    const events = (req.body?.events ?? []) as Array<{
      type: string;
      replyToken?: string;
      source?: { userId?: string };
      message?: { type: string; text?: string };
    }>;

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const replyToken = event.replyToken;
      const userId = event.source?.userId;
      const text = event.message.text?.trim() ?? "";
      if (!replyToken || !userId || !text) continue;

      try {
        if (/^\d{5,}$/.test(text)) {
          // 数字（会員番号）が送られてきたら連携する
          const memberRef = db.collection("members").doc(text);
          const memberSnap = await memberRef.get();
          if (memberSnap.exists) {
            await memberRef.update({ lineUserId: userId });
            await replyLineMessage(
              replyToken,
              accessToken,
              `${memberSnap.data()!.name}様、連携が完了しました。
「予約状況」と送るとご予約・出欠の状況を確認できます。`
            );
          } else {
            await replyLineMessage(
              replyToken,
              accessToken,
              "その会員番号は見つかりませんでした。ご確認のうえ、もう一度お送りください。"
            );
          }
          continue;
        }

        if (text.includes("予約") || text.includes("出欠")) {
          const linkedSnap = await db
            .collection("members")
            .where("lineUserId", "==", userId)
            .limit(1)
            .get();
          if (linkedSnap.empty) {
            await replyLineMessage(
              replyToken,
              accessToken,
              "まだ連携されていません。お手数ですが会員番号（数字）を送ってください。"
            );
          } else {
            const memberDoc = linkedSnap.docs[0];
            const statusText = await buildLineStatusMessage({
              id: memberDoc.id,
              ...memberDoc.data(),
            });
            await replyLineMessage(replyToken, accessToken, statusText);
          }
          continue;
        }

        await replyLineMessage(
          replyToken,
          accessToken,
          "「予約状況」と送ると、ご予約・出欠の状況を確認できます。\n初めての方は会員番号（数字）を送って連携してください。"
        );
      } catch (err) {
        console.error("LINE Webhookの処理でエラーが発生しました", err);
      }
    }

    res.status(200).send("ok");
  }
);

/**
 * マイページのLIFFページ（/mypage/line-link）が、LIFF SDKで取得したID Tokenを渡して呼び出す。
 * LINEの検証エンドポイントでID Tokenの正当性とaud（このMessaging APIチャネル宛かどうか）を確認し、
 * 取得したユーザーID（sub）を members/{memberId} に lineUserId として保存する。
 * クライアントから直接userIdを送らせず、必ずID Tokenをサーバー側で検証してから書き込む設計にしている
 * （なりすまし防止）。
 */
export const linkLineViaLiff = onCall<{ idToken: string }>(async (request) => {
  const memberId = request.auth?.token?.memberId as string | undefined;
  if (request.auth?.token?.role !== "member" || !memberId) {
    throw new HttpsError("permission-denied", "会員としてログインしてください。");
  }

  const { idToken } = request.data ?? ({} as { idToken?: string });
  if (typeof idToken !== "string" || !idToken) {
    throw new HttpsError("invalid-argument", "IDトークンが指定されていません。");
  }

  const verifyRes = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id_token: idToken,
      client_id: liffChannelId.value(),
    }),
  });
  if (!verifyRes.ok) {
    console.error(`LIFFのID Token検証に失敗しました: ${verifyRes.status} ${await verifyRes.text()}`);
    throw new HttpsError("unauthenticated", "LINEの認証確認に失敗しました。もう一度お試しください。");
  }
  const verifyData = (await verifyRes.json()) as { sub?: string };
  if (!verifyData.sub) {
    throw new HttpsError("internal", "LINEのユーザー情報を取得できませんでした。");
  }

  await db.collection("members").doc(memberId).update({ lineUserId: verifyData.sub });
  return { ok: true };
});

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

/**
 * 出欠・予約のリマインドを自動プッシュ送信する(LINE連携済みの会員のみが対象)。
 * 毎日18:00(JST)に実行し、「明日」が対象のお稽古・予約についてのみ送る(前日リマインド)。
 * 応答メッセージと違い、宛先ごとに無料枠(月200通)を消費するので注意。
 */
export const sendLineReminders = onSchedule(
  { schedule: "0 18 * * *", timeZone: "Asia/Tokyo", secrets: [lineChannelAccessToken] },
  async () => {
    const accessToken = lineChannelAccessToken.value();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = tomorrow.toISOString().slice(0, 10);

    // 1. 予約リマインド:茶道教室・土曜日クラスの、明日の予約者
    const sessionSnap = await db
      .collection("chadoSaturdaySessions")
      .where("date", "==", tomorrowKey)
      .get();
    for (const sessionDoc of sessionSnap.docs) {
      const data = sessionDoc.data() as {
        amTeacher?: string;
        pmTeacher?: string;
        amBookings?: ChadoSaturdayBookingDoc[];
        pmBookings?: ChadoSaturdayBookingDoc[];
      };
      const slots: { label: string; teacher?: string; bookings: ChadoSaturdayBookingDoc[] }[] = [
        { label: "午前", teacher: data.amTeacher, bookings: data.amBookings ?? [] },
        { label: "午後", teacher: data.pmTeacher, bookings: data.pmBookings ?? [] },
      ];
      for (const slot of slots) {
        for (const booking of slot.bookings) {
          const memberSnap = await db.collection("members").doc(booking.memberId).get();
          const member = memberSnap.data();
          if (!member || !member.lineUserId) continue;
          const teacherText = slot.teacher ? `担当:${slot.teacher}` : "";
          await pushLineMessage(
            member.lineUserId,
            accessToken,
            `${member.name}様
明日${formatDateJp(tomorrowKey)}(${slot.label})のお稽古のご予約があります。${teacherText}`
          );
        }
      }
    }

    // 2. 出欠リマインド:明日が「次回のお稽古」日の会について、出欠未回答の会員に送る
    // (茶道教室・土曜日クラスは予約制のため対象外。木曜日・日曜日クラスはrsvpで管理するため対象)
    const nextLessonSnap = await db.doc("meta/nextLessonDates").get();
    const nextDates = nextLessonSnap.data()?.dates as Record<string, { date: string }> | undefined;
    if (nextDates) {
      for (const [group, info] of Object.entries(nextDates)) {
        if (info.date !== tomorrowKey) continue;
        const membersSnap = await db.collection("members").where("group", "==", group).get();
        for (const memberDoc of membersSnap.docs) {
          const member = memberDoc.data();
          if (member.group === "茶道教室" && member.chadoClass === "土曜日") continue;
          if (!member.lineUserId) continue;
          if ((member.rsvp ?? "未回答") !== "未回答") continue;
          await pushLineMessage(
            member.lineUserId,
            accessToken,
            `${member.name}様
明日${formatDateJp(tomorrowKey)}のお稽古の出欠がまだ未回答です。マイページからご回答をお願いします。`
          );
        }
      }
    }
  }
);

/**
 * 講師・本部がスタッフページ/管理画面から選択した生徒に、LINEで一斉送信する(マルチキャスト)。
 * 講師(role: "staff")はなりすまし防止のため、自分の担当グループ(staffドキュメントのgroups)に
 * 含まれる生徒にしか送れない。本部(role: "honbu")はグループの制限なく送信できる。
 * 応答メッセージと違い、宛先ごとに無料枠(月200通)を消費するので注意。
 */
export const sendStaffLineBroadcast = onCall<{ memberIds: string[]; message: string }>(
  { secrets: [lineChannelAccessToken] },
  async (request) => {
    const role = request.auth?.token?.role;
    if (role !== "staff" && role !== "honbu") {
      throw new HttpsError("permission-denied", "スタッフとしてログインしてください。");
    }

    const { memberIds, message } = request.data ?? ({} as { memberIds?: string[]; message?: string });
    if (!Array.isArray(memberIds) || memberIds.length === 0 || typeof message !== "string" || !message.trim()) {
      throw new HttpsError("invalid-argument", "送信先とメッセージを指定してください。");
    }
    if (memberIds.length > 500) {
      throw new HttpsError("invalid-argument", "一度に送信できるのは500人までです。");
    }

    let allowedGroups: string[] | null = null;
    if (role === "staff") {
      const staffId = request.auth?.token?.staffId as string | undefined;
      if (!staffId) {
        throw new HttpsError("permission-denied", "スタッフ情報が確認できません。");
      }
      const staffSnap = await db.collection("staff").doc(staffId).get();
      allowedGroups = (staffSnap.data()?.groups as string[] | undefined) ?? [];
    }

    const memberSnaps = await Promise.all(memberIds.map((id) => db.collection("members").doc(id).get()));

    const targetUserIds: string[] = [];
    const skipped: string[] = [];
    for (const snap of memberSnaps) {
      const data = snap.data();
      if (!data) {
        skipped.push(snap.id);
        continue;
      }
      if (allowedGroups && !allowedGroups.includes(data.group)) {
        throw new HttpsError("permission-denied", `担当外の会員が含まれています(${data.name})。`);
      }
      if (data.lineUserId) {
        targetUserIds.push(data.lineUserId);
      } else {
        skipped.push(data.name ?? snap.id);
      }
    }

    if (targetUserIds.length > 0) {
      const accessToken = lineChannelAccessToken.value();
      await multicastLineMessage(targetUserIds, accessToken, message.trim());
    }

    return { sent: targetUserIds.length, skipped };
  }
);

// ---- 茶道教室：土曜日クラスの予約（午前／午後、各枠定員制） ----
// 会員本人のマイページから呼び出す。定員チェックをAdmin SDKのトランザクションで行うことで、
// 同時に複数人が予約しても「定員3名」を確実に守る（クライアントの直接書き込みだと
// レースコンディションで定員超過しうるため、あえてCloud Functions経由にしている）。
const CHADO_SATURDAY_DEFAULT_CAPACITY = 3;
const CHADO_SATURDAY_DEFAULT_MONTHLY_QUOTA = 1; // 月の予約可能回数（会員ごとに設定されていない場合のデフォルト）

interface ChadoSaturdayBookingDoc {
  memberId: string;
  memberName: string;
  bookedAt: string;
  usedTicket?: boolean;
  attended?: "出席" | "欠席";
}

// dateKey（YYYY-MM-DD）が属する月の範囲を [開始日, 翌月開始日) の形で返す（monthQueryのwhere条件に使う）。
function monthBoundsForDate(dateKey: string): { start: string; endExclusive: string } {
  const [y, m] = dateKey.split("-").map(Number);
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const endExclusive = `${String(nextY).padStart(4, "0")}-${String(nextM).padStart(2, "0")}-01`;
  return { start, endExclusive };
}

export const bookChadoSaturdaySlot = onCall<{
  date: string; // YYYY-MM-DD
  slot: "am" | "pm";
  action: "book" | "cancel";
}>(async (request) => {
  const memberId = request.auth?.token?.memberId as string | undefined;
  if (request.auth?.token?.role !== "member" || !memberId) {
    throw new HttpsError("permission-denied", "会員としてログインしてください。");
  }

  const { date, slot, action } = request.data ?? ({} as { date?: string; slot?: string; action?: string });
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    (slot !== "am" && slot !== "pm") ||
    (action !== "book" && action !== "cancel")
  ) {
    throw new HttpsError("invalid-argument", "パラメータが不正です。");
  }

  const memberRef = db.doc(`members/${memberId}`);
  const sessionRef = db.doc(`chadoSaturdaySessions/${date}`);
  const { start, endExclusive } = monthBoundsForDate(date);
  const monthQuery = db
    .collection("chadoSaturdaySessions")
    .where("date", ">=", start)
    .where("date", "<", endExclusive);

  return db.runTransaction(async (tx) => {
    // Firestoreのトランザクションは、書き込みより前にすべての読み取りを終える必要があるため、
    // 予約先セッション・会員情報・当月の全セッション（月の予約回数を数えるため）をまとめて先に読む。
    const [memberSnap, sessionSnap, monthSnap] = await Promise.all([
      tx.get(memberRef),
      tx.get(sessionRef),
      tx.get(monthQuery),
    ]);

    if (!memberSnap.exists) throw new HttpsError("not-found", "会員情報が見つかりません。");
    const member = memberSnap.data() as {
      name?: string;
      group?: string;
      chadoClass?: string;
      chadoMonthlyQuota?: number;
      chadoMakeupTickets?: number;
    };
    if (member.group !== "茶道教室" || member.chadoClass !== "土曜日") {
      throw new HttpsError("permission-denied", "土曜日クラスの会員のみ予約できます。");
    }

    const sessionData = sessionSnap.exists
      ? (sessionSnap.data() as {
          amCapacity?: number;
          pmCapacity?: number;
          amTeacher?: string;
          pmTeacher?: string;
          amBookings?: ChadoSaturdayBookingDoc[];
          pmBookings?: ChadoSaturdayBookingDoc[];
        })
      : {};

    const amCapacity = sessionData.amCapacity ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
    const pmCapacity = sessionData.pmCapacity ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
    const existingAm = sessionData.amBookings ?? [];
    const existingPm = sessionData.pmBookings ?? [];
    const myExistingBooking =
      existingAm.find((b) => b.memberId === memberId) ?? existingPm.find((b) => b.memberId === memberId);
    const filteredAm = existingAm.filter((b) => b.memberId !== memberId);
    const filteredPm = existingPm.filter((b) => b.memberId !== memberId);

    // 今月、この会員が（このセッション以外で）すでに予約している開催日の数を数える
    // （月の予約可能回数のチェックに使う。出欠が未確認・欠席のものも「予約を使った」ことに変わりないため含める）
    let bookedElsewhereThisMonth = 0;
    monthSnap.docs.forEach((docSnap) => {
      if (docSnap.id === date) return; // 対象セッション自体は別途カウント
      const d = docSnap.data() as {
        amBookings?: ChadoSaturdayBookingDoc[];
        pmBookings?: ChadoSaturdayBookingDoc[];
      };
      const has =
        (d.amBookings ?? []).some((b) => b.memberId === memberId) ||
        (d.pmBookings ?? []).some((b) => b.memberId === memberId);
      if (has) bookedElsewhereThisMonth += 1;
    });

    if (action === "cancel") {
      // 振替チケットを使って確保した予約を取り消した場合は、チケットを1枚戻す
      const ticketDelta = myExistingBooking?.usedTicket ? 1 : 0;
      tx.set(
        sessionRef,
        {
          date,
          amCapacity,
          pmCapacity,
          amTeacher: sessionData.amTeacher ?? "",
          pmTeacher: sessionData.pmTeacher ?? "",
          amBookings: filteredAm,
          pmBookings: filteredPm,
        },
        { merge: true }
      );
      if (ticketDelta !== 0) {
        tx.update(memberRef, {
          chadoMakeupTickets: Math.max(0, (member.chadoMakeupTickets ?? 0) + ticketDelta),
        });
      }
      return { ok: true };
    }

    // action === "book"
    // 同じ開催日内での午前⇔午後の変更（すでにその日を予約済み）は、月の予約回数を追加消費しない
    const isSwitchingSameDate = !!myExistingBooking;
    let usedTicket = myExistingBooking?.usedTicket ?? false;

    if (!isSwitchingSameDate) {
      const quota = member.chadoMonthlyQuota ?? CHADO_SATURDAY_DEFAULT_MONTHLY_QUOTA;
      if (bookedElsewhereThisMonth >= quota) {
        const tickets = member.chadoMakeupTickets ?? 0;
        if (tickets <= 0) {
          throw new HttpsError(
            "resource-exhausted",
            `今月の予約可能回数（月${quota}回）の上限に達しています。振替チケットもありません。`
          );
        }
        usedTicket = true;
      } else {
        usedTicket = false;
      }
    }

    const targetBookings = slot === "am" ? filteredAm : filteredPm;
    const targetCapacity = slot === "am" ? amCapacity : pmCapacity;
    if (targetBookings.length >= targetCapacity) {
      throw new HttpsError("resource-exhausted", "この枠はすでに定員に達しています。");
    }
    targetBookings.push({
      memberId,
      memberName: member.name ?? "",
      bookedAt: new Date().toISOString(),
      usedTicket,
    });

    tx.set(
      sessionRef,
      {
        date,
        amCapacity,
        pmCapacity,
        amTeacher: sessionData.amTeacher ?? "",
        pmTeacher: sessionData.pmTeacher ?? "",
        amBookings: slot === "am" ? targetBookings : filteredAm,
        pmBookings: slot === "pm" ? targetBookings : filteredPm,
      },
      { merge: true }
    );

    // 新規に振替チケットを消費した場合のみ1枚減らす（同日内の枠変更では消費しない）
    if (!isSwitchingSameDate && usedTicket) {
      tx.update(memberRef, {
        chadoMakeupTickets: Math.max(0, (member.chadoMakeupTickets ?? 0) - 1),
      });
    }

    return { ok: true };
  });
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

/**
 * 毎週月曜3:00（JST）に、お稽古ノート（keikoNoteEntries）の内容を丸ごと
 * keikoNoteBackups/{YYYY-MM-DD}/entries/{entryId} に複製してバックアップする。
 * 誤操作・誤削除からの復旧用。90日より古いバックアップは自動的に削除する。
 */
export const backupKeikoNoteEntries = onSchedule(
  { schedule: "every monday 03:00", timeZone: "Asia/Tokyo" },
  async () => {
    const snapshotId = todayKeyJST();
    const entriesSnap = await db.collection("keikoNoteEntries").get();

    const backupRef = db.collection("keikoNoteBackups").doc(snapshotId);
    await backupRef.set({
      createdAt: new Date().toISOString(),
      count: entriesSnap.size,
    });

    // Firestoreの1バッチ上限（500件）に対する安全マージンとして400件ずつ書き込む
    const docs = entriesSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      for (const entryDoc of docs.slice(i, i + 400)) {
        batch.set(backupRef.collection("entries").doc(entryDoc.id), entryDoc.data());
      }
      await batch.commit();
    }

    // 90日より古いバックアップ（スナップショットとその配下のentries）を削除し、無制限に増え続けないようにする
    const cutoff = addDaysToDateKey(snapshotId, -90);
    const oldSnaps = await db
      .collection("keikoNoteBackups")
      .where(admin.firestore.FieldPath.documentId(), "<", cutoff)
      .get();
    for (const oldSnap of oldSnaps.docs) {
      const oldEntries = await oldSnap.ref.collection("entries").get();
      if (!oldEntries.empty) {
        const delBatch = db.batch();
        oldEntries.docs.forEach((e) => delBatch.delete(e.ref));
        await delBatch.commit();
      }
      await oldSnap.ref.delete();
    }

    console.log(`keikoNoteEntriesのバックアップを作成しました snapshotId=${snapshotId} count=${entriesSnap.size}`);
  }
);
