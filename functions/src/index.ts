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

// お稽古ノート（/keiko-note）の合言葉。VercelのKEIKO_NOTE_ACCESS_CODEと同じ値を入れる。
// 設定方法： firebase functions:secrets:set KEIKO_NOTE_ACCESS_CODE
const keikoNoteAccessCode = defineSecret("KEIKO_NOTE_ACCESS_CODE");

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

// 茶道教室のお稽古3日前に参加者一覧を通知するSlackチャンネル（本部稽古）のID。
// Botをこのチャンネルに /invite しておくこと。値は .env.sohenryu-okeiko-management に保存してある。
const slackChadoChannelId = defineString("SLACK_CHADO_CHANNEL_ID");

// 本部の共有GoogleカレンダーのカレンダーID（カレンダー設定の「カレンダーの統合」欄にある）。
// デプロイ時にCLIから入力を求められる（.env.sohenryu-okeiko-management に保存される）。
const hqCalendarId = defineString("HQ_CALENDAR_ID");

// アプリの本番URL。Slack通知の「detail」ボタンのリンク先などに使う。
const APP_BASE_URL = "https://okeiko.sohenryu.com";

// ---- セキュリティログ（不正アクセス監視用） ----
// ログイン試行（成功・失敗）を securityLogs に記録する。週次レポート〈weeklySecurityReport〉が集計する。
// クライアントからは読み書き不可（firestore.rules で禁止）。90日より古いログは週次レポート時に自動削除。
// 週次レポート・即時アラートを送るSlackの宛先。ユーザーID（U…）ならBotとのDM、チャンネルID（C…）ならそのチャンネル。
const slackSecurityReportTarget = defineString("SLACK_SECURITY_REPORT_TARGET", { default: "C02GH8X0U3C" });

// 即時アラートのしきい値
const ALERT_IP_WINDOW_MS = 10 * 60 * 1000; // 10分
const ALERT_IP_FAIL_COUNT = 5; // 10分以内に同じIPから5回以上失敗
const ALERT_SUCCESS_AFTER_FAILS = 3; // 3回以上連続失敗した会員番号でログイン成功
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 同じ内容の通知は1時間に1回まで

// ログインの一時停止（ロック）
const LOCK_MEMBER_FAILS = 5; // 同じ会員番号で5回連続失敗したら
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30分ログインを止める

/**
 * 会員番号がロック中なら、ロック解除時刻（ミリ秒）を返す。ロックされていなければ null。
 * 解除方法（本人確認後に早く解除したい場合）：Firestoreコンソールで
 * securityCounters/member_{会員番号} の lockedUntil を削除する。
 */
async function getMemberLockUntil(memberNo: string): Promise<number | null> {
  try {
    const snap = await db.collection("securityCounters").doc(safeDocId("member_" + memberNo)).get();
    const until = snap.exists ? (snap.data()?.lockedUntil as admin.firestore.Timestamp | undefined) : undefined;
    if (until && until.toMillis() > Date.now()) return until.toMillis();
  } catch (e) {
    console.error("ロック状態の確認に失敗しました", e);
  }
  return null;
}

function safeDocId(s: string): string {
  return (s || "unknown").replace(/[\/]/g, "_").slice(0, 200);
}

/**
 * 不正アクセスの兆候を即時にSlackへ通知する。同じkeyの通知は1時間に1回まで。
 */
async function sendSecurityAlert(key: string, text: string): Promise<void> {
  try {
    const ref = db.collection("securityAlerts").doc(safeDocId(key));
    const shouldSend = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists ? (snap.data()?.lastSentAt as admin.firestore.Timestamp | undefined) : undefined;
      if (last && Date.now() - last.toMillis() < ALERT_COOLDOWN_MS) return false;
      tx.set(ref, { lastSentAt: admin.firestore.Timestamp.now(), text });
      return true;
    });
    if (!shouldSend) return;
    const token = slackBotToken.value();
    const target = slackSecurityReportTarget.value();
    if (token && target) {
      await postSlackMessage(token, target, `🚨【不正アクセスの疑い】\n${text}\n（${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false })}）`);
    } else {
      console.warn("Slack未設定のためセキュリティアラートを送れませんでした: " + text);
    }
  } catch (e) {
    console.error("セキュリティアラートの送信に失敗しました", e);
  }
}

/**
 * ログイン試行のたびに呼ばれ、即時アラートの条件に当てはまるかを判定する。
 * - 10分以内に同じIPから5回以上失敗（総当たりの疑い）
 * - 3回以上連続で失敗した会員番号で、ログインに成功（乗っ取りの疑い）
 */
async function checkLoginAnomaly(entry: LoginLogInput, ip: string): Promise<void> {
  try {
    const now = Date.now();
    if (entry.result === "fail" && ip) {
      const ref = db.collection("securityCounters").doc(safeDocId("ip_" + ip));
      const recent = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() ?? {} : {};
        const fails = ((data.fails as { t: number; m: string }[]) ?? []).filter((f) => now - f.t < ALERT_IP_WINDOW_MS);
        fails.push({ t: now, m: entry.memberNo ?? "" });
        tx.set(ref, { fails: fails.slice(-50), updatedAt: admin.firestore.Timestamp.now() });
        return fails;
      });
      if (recent.length >= ALERT_IP_FAIL_COUNT) {
        const members = new Set(recent.map((f) => f.m).filter(Boolean));
        await sendSecurityAlert(
          "ipfail_" + ip,
          `IP ${ip} から10分以内に${recent.length}回ログインに失敗しています（試された会員番号 ${members.size}件：${[...members].slice(0, 5).join("、")}）。総当たりの可能性があります。`
        );
      }
    }

    if (entry.memberNo) {
      const ref = db.collection("securityCounters").doc(safeDocId("member_" + entry.memberNo));
      const { prevFails, lockedNow } = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists ? Number(snap.data()?.consecutiveFails ?? 0) : 0;
        if (entry.result === "fail") {
          const next = prev + 1;
          const lock = next % LOCK_MEMBER_FAILS === 0;
          tx.set(ref, {
            consecutiveFails: next,
            lastFailIp: ip,
            updatedAt: admin.firestore.Timestamp.now(),
            ...(lock ? { lockedUntil: admin.firestore.Timestamp.fromMillis(now + LOCK_DURATION_MS) } : {}),
          }, { merge: true });
          return { prevFails: prev, lockedNow: lock };
        }
        // 成功したら連続失敗数とロックをリセット
        tx.set(ref, { consecutiveFails: 0, updatedAt: admin.firestore.Timestamp.now() });
        return { prevFails: prev, lockedNow: false };
      });
      if (lockedNow) {
        await sendSecurityAlert(
          "locked_" + entry.memberNo,
          `会員番号 ${entry.memberNo} で${prevFails + 1}回連続してログインに失敗したため、30分間ログインを停止しました（最後の試行のIP ${ip || "不明"}）。ご本人が困っている場合は、本人確認のうえ securityCounters/member_${entry.memberNo} の lockedUntil を削除すると解除できます。`
        );
      }
      if (entry.result === "success" && prevFails >= ALERT_SUCCESS_AFTER_FAILS) {
        await sendSecurityAlert(
          "succafter_" + entry.memberNo,
          `会員番号 ${entry.memberNo}（${entry.role ?? ""}）で、${prevFails}回連続で失敗した後にログインが成功しました（IP ${ip || "不明"}、${entry.method === "line" ? "LINEログイン" : "会員番号ログイン"}）。ご本人か確認してください。`
        );
      }
    }
  } catch (e) {
    console.error("ログイン異常チェックに失敗しました", e);
  }
}

type LoginLogInput = {
  method: "memberNo" | "line";
  result: "success" | "fail";
  memberNo?: string;
  role?: string;
  reason?: string;
};
async function logLoginAttempt(
  rawRequest: { ip?: string; headers?: Record<string, unknown> } | undefined,
  entry: LoginLogInput
): Promise<void> {
  try {
    const headers = rawRequest?.headers ?? {};
    const fwd = typeof headers["x-forwarded-for"] === "string" ? (headers["x-forwarded-for"] as string) : "";
    const ip = (fwd.split(",")[0] || rawRequest?.ip || "").trim();
    const ua = typeof headers["user-agent"] === "string" ? (headers["user-agent"] as string).slice(0, 300) : "";
    await db.collection("securityLogs").add({
      type: "login",
      ...entry,
      memberNo: entry.memberNo ? String(entry.memberNo).slice(0, 50) : "",
      ip,
      userAgent: ua,
      at: admin.firestore.Timestamp.now(),
    });
    if (entry.reason !== "locked") await checkLoginAnomaly(entry, ip);
  } catch (e) {
    // ログ記録の失敗でログイン処理自体を止めない
    console.error("securityLogsへの記録に失敗しました", e);
  }
}

/**
 * マイページ・スタッフポータルのログイン確認。
 * 会員番号＋メールアドレスの組み合わせが members または staff コレクションと一致すれば、
 * role等のクレーム付きカスタムトークンを発行する。
 *
 * フロントは result.token を signInWithCustomToken() に渡す。
 */
export const verifyMemberLogin = onCall<{ memberNo: string; email: string }>({ secrets: [slackBotToken] }, async (request) => {
  const { memberNo, email } = request.data;
  if (!memberNo || !email) {
    await logLoginAttempt(request.rawRequest, { method: "memberNo", result: "fail", memberNo, reason: "empty" });
    throw new HttpsError("invalid-argument", "会員番号とメールアドレスを入力してください。");
  }
  // 失敗が続いてロック中なら、照合せずに断る
  const lockUntil = await getMemberLockUntil(memberNo);
  if (lockUntil) {
    await logLoginAttempt(request.rawRequest, { method: "memberNo", result: "fail", memberNo, reason: "locked" });
    const mins = Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000));
    throw new HttpsError(
      "resource-exhausted",
      `ログインの失敗が続いたため、一時的にログインを停止しています。約${mins}分後にもう一度お試しください。お困りの場合は本部までご連絡ください。`
    );
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
    await logLoginAttempt(request.rawRequest, { method: "memberNo", result: "success", memberNo, role: "member" });
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
    await logLoginAttempt(request.rawRequest, { method: "memberNo", result: "success", memberNo, role: "staff" });
    return { token, role: "staff" };
  }

  await logLoginAttempt(request.rawRequest, {
    method: "memberNo",
    result: "fail",
    memberNo,
    reason: memberSnap.exists || staffSnap.exists ? "email-mismatch" : "unknown-memberNo",
  });
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
          `会員：${after.memberName}様（${groupDisplayName(after.group)}）\n` +
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
      `会員：${after.memberName}様（${groupDisplayName(after.group)}）\n` +
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

    // 本部稽古（名月会・茶道教室・Gマダムの茶の湯講座・新月会）の入会申込のみ通知する。
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

/**
 * 送信したLINEメッセージをFirestore（lineMessageLogs）に記録する。
 * LINE Official Account ManagerのチャットBoxには、Messaging API経由（プッシュ・マルチキャスト）で
 * 送ったメッセージが表示されない（応答モード「Bot」時、API送信分は履歴に残らない仕様）ため、
 * こちら側で記録しないと送信内容を後から確認できない。
 */
async function logLineMessage(entry: {
  memberId: string;
  memberName: string;
  group: string;
  message: string;
  kind: "予約リマインド" | "出欠リマインド" | "一斉送信";
  sentBy?: string;
}): Promise<void> {
  try {
    await db.collection("lineMessageLogs").add({
      ...entry,
      sentAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("LINE送信履歴の記録に失敗しました", err);
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
  const next = dates?.[nextLessonKey(member.group, member.chadoClass)];
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

        // 会員番号（連携）・「予約」「出欠」以外のメッセージには自動返信しない。
        // 生徒から本部宛ての通常の会話（質問・お礼など）にまで案内文が自動送信されて
        // しまうのを避けるため（2026-09-18、ゆちゃの指示）。
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

/**
 * LINE公式アカウントのリッチメニュー「マイページ」ボタンから開かれるLIFFページ
 * （/mypage/line-link）が、未ログイン状態のときに呼び出す。
 * LIFFのID Tokenを検証し、そのLINEユーザーIDが既にmembers.lineUserIdとして
 * 連携済みであれば、その会員としてログインするためのカスタムトークンを発行する。
 * まだ連携されていない場合は linked: false を返し、フロント側は通常の
 * 会員番号＋メールアドレスのログイン画面に案内する（ログイン後、マイページの
 * 「公式LINEとの連携」から連携すれば、次回以降はこのボタンで自動ログインできるようになる）。
 */
export const loginViaLine = onCall<{ idToken: string }>({ secrets: [slackBotToken] }, async (request) => {
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
    console.error(`LINEログインのID Token検証に失敗しました: ${verifyRes.status} ${await verifyRes.text()}`);
    await logLoginAttempt(request.rawRequest, { method: "line", result: "fail", reason: "line-token-invalid" });
    throw new HttpsError("unauthenticated", "LINEの認証確認に失敗しました。もう一度お試しください。");
  }
  const verifyData = (await verifyRes.json()) as { sub?: string };
  if (!verifyData.sub) {
    throw new HttpsError("internal", "LINEのユーザー情報を取得できませんでした。");
  }

  const memberSnap = await db
    .collection("members")
    .where("lineUserId", "==", verifyData.sub)
    .limit(1)
    .get();
  if (memberSnap.empty) {
    return { linked: false as const };
  }

  const memberId = memberSnap.docs[0].id;
  const uid = `member_${memberId}`;
  const token = await admin.auth().createCustomToken(uid, {
    role: "member",
    memberId,
  });
  await logLoginAttempt(request.rawRequest, { method: "line", result: "success", memberNo: memberId, role: "member" });
  return { linked: true as const, token, role: "member" as const };
});

// 「次回のお稽古」表示の対象となる会。イベントのタイトルにこの文字列が
// 含まれているかどうかで、どの会のお稽古かを判定する（例："名月会お稽古"）。
// 新月会は月2会開催。カレンダーの予定タイトルに「新月会」を含めると次回のお稽古として拾われる。
const LESSON_GROUPS = ["名月会", "Gマダムの茶の湯講座", "茶道教室", "新月会"];

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
  for (const ev of items) {
    const title = ev.summary ?? "";
    const date = ev.start?.dateTime ?? ev.start?.date;
    if (!date) continue;
    // 「名月会/茶道教室」のような合同の予定は、タイトルに含まれるすべての会の予定として扱う
    for (const group of LESSON_GROUPS.filter((g) => title.includes(g))) {
      // 茶道教室は木曜日・日曜日クラスで別々のお稽古日を持つので、クラスごとのキーに分けて保存する
      // （土曜日クラスは予約制で chadoSaturdaySessions を使うため対象外）
      let key: string = group;
      if (group === "茶道教室") {
        const chadoClass = chadoClassOfEvent(title, date);
        if (!chadoClass) continue;
        // 日曜日はカレンダー上1つの予定で午前・午後の両クラスを兼ねるため、両方のキーに保存する
        const classes = chadoClass === "日曜日" ? (["日曜日", "日曜日午後"] as const) : [chadoClass];
        for (const c of classes) {
          const k = nextLessonKey(group, c);
          if (!result[k]) result[k] = { date, title };
        }
        continue;
      }
      // itemsは開始日時順なので、最初に見つかったものが一番近い予定
      if (!result[key]) result[key] = { date, title };
    }
  }
  return result;
}

// 茶道教室のうち、出欠ボタンで管理する（次回のお稽古日を表示する）曜日クラス
const CHADO_RSVP_CLASSES = ["木曜日", "日曜日", "日曜日午後"] as const;

// 表示用のクラス名（「日曜日」は午前クラス。値は既存データ互換のため据え置き）
const CHADO_RSVP_CLASS_LABEL: Record<(typeof CHADO_RSVP_CLASSES)[number], string> = {
  "木曜日": "木曜日",
  "日曜日": "日曜日午前",
  "日曜日午後": "日曜日午後",
};

/**
 * meta/nextLessonDates.dates のキー。茶道教室だけはクラスごとに
 * 「茶道教室・木曜日」「茶道教室・日曜日」のように分ける（src/lib/nextLesson.ts と同じ規則）。
 */
function nextLessonKey(group: string, chadoClass?: string): string {
  return group === "茶道教室" && chadoClass ? `${group}・${chadoClass}` : group;
}

/**
 * 茶道教室の予定がどの曜日クラスのものかを判定する。
 * 開催日（日本時間）の曜日を最優先する（木曜→木曜日クラス、日曜→日曜日クラス）。
 * タイトルに「木曜」「日曜」「土曜」などが含まれていても、実際の開催日が木曜・日曜であればそちらに従う
 * （例：「茶道教室（木曜・日曜クラス）」のような合同タイトルや、土曜の予定に「木曜」の文字が入っている場合に
 *  別の曜日の予定が「次回」として表示されてしまうのを防ぐ）。
 * 開催日が木曜・日曜以外の場合のみ、振替などのためにタイトルで判定する（土曜を含むものは土曜日クラス扱いで対象外）。
 */
function chadoClassOfEvent(title: string, date: string): "木曜日" | "日曜日" | null {
  // 終日予定（YYYY-MM-DD）はUTC0時として解釈されるが、+9時間しても同じ日付のままなので問題ない
  const t = Date.parse(date);
  if (!Number.isNaN(t)) {
    const weekday = new Date(t + 9 * 60 * 60 * 1000).getUTCDay();
    if (weekday === 4) return "木曜日";
    if (weekday === 0) return "日曜日";
  }
  if (title.includes("土曜")) return null;
  const hasThu = title.includes("木曜");
  const hasSun = title.includes("日曜");
  if (hasThu && !hasSun) return "木曜日";
  if (hasSun && !hasThu) return "日曜日";
  return null;
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
          const reservationText = `${member.name}様
明日${formatDateJp(tomorrowKey)}(${slot.label})のお稽古のご予約があります。${teacherText}`;
          await pushLineMessage(member.lineUserId, accessToken, reservationText);
          await logLineMessage({
            memberId: booking.memberId,
            memberName: member.name ?? "",
            group: member.group ?? "",
            message: reservationText,
            kind: "予約リマインド",
          });
        }
      }
    }

    // 2. 出欠リマインド:明日が「次回のお稽古」日の茶道教室クラスについて、出欠未回答の会員に送る
    // (自動リマインドは茶道教室のみが対象。土曜日クラスは予約制のため対象外。木曜日・日曜日クラスはrsvpで管理するため対象)
    const nextLessonSnap = await db.doc("meta/nextLessonDates").get();
    const nextDates = nextLessonSnap.data()?.dates as Record<string, { date: string }> | undefined;
    if (nextDates) {
      for (const [key, info] of Object.entries(nextDates)) {
        if (info.date.slice(0, 10) !== tomorrowKey) continue;
        const group = key.split("・")[0];
        if (group !== "茶道教室") continue;
        const membersSnap = await db.collection("members").where("group", "==", group).get();
        for (const memberDoc of membersSnap.docs) {
          const member = memberDoc.data();
          // 茶道教室は該当クラス（キーと一致するクラス）の会員だけに送る
          if (nextLessonKey(member.group, member.chadoClass) !== key) continue;
          if (!member.lineUserId) continue;
          if ((member.rsvp ?? "未回答") !== "未回答") continue;
          const attendanceText = `${member.name}様
明日${formatDateJp(tomorrowKey)}のお稽古の出欠がまだ未回答です。マイページからご回答をお願いします。`;
          await pushLineMessage(member.lineUserId, accessToken, attendanceText);
          await logLineMessage({
            memberId: memberDoc.id,
            memberName: member.name ?? "",
            group: member.group ?? "",
            message: attendanceText,
            kind: "出欠リマインド",
          });
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
    let sentBy = "本部";
    if (role === "staff") {
      const staffId = request.auth?.token?.staffId as string | undefined;
      if (!staffId) {
        throw new HttpsError("permission-denied", "スタッフ情報が確認できません。");
      }
      const staffSnap = await db.collection("staff").doc(staffId).get();
      allowedGroups = (staffSnap.data()?.groups as string[] | undefined) ?? [];
      sentBy = (staffSnap.data()?.name as string | undefined) ?? "スタッフ";
    } else {
      sentBy = (request.auth?.token?.email as string | undefined) ?? "本部";
    }

    const memberSnaps = await Promise.all(memberIds.map((id) => db.collection("members").doc(id).get()));

    const targets: { memberId: string; memberName: string; group: string; lineUserId: string }[] = [];
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
        targets.push({ memberId: snap.id, memberName: data.name ?? "", group: data.group ?? "", lineUserId: data.lineUserId });
      } else {
        skipped.push(data.name ?? snap.id);
      }
    }

    if (targets.length > 0) {
      const accessToken = lineChannelAccessToken.value();
      const trimmedMessage = message.trim();
      await multicastLineMessage(targets.map((t) => t.lineUserId), accessToken, trimmedMessage);
      await Promise.all(
        targets.map((t) =>
          logLineMessage({
            memberId: t.memberId,
            memberName: t.memberName,
            group: t.group,
            message: trimmedMessage,
            kind: "一斉送信",
            sentBy,
          })
        )
      );
    }

    return { sent: targets.length, skipped };
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
    // 午前・午後は別々の予約として扱う（同じ日に午前と午後の両方を予約できる。2026-10-06 ゆちゃの決定）。
    const targetExisting = slot === "am" ? existingAm : existingPm;
    const myBookingInSlot = targetExisting.find((b) => b.memberId === memberId);

    const writeSession = (amBookings: ChadoSaturdayBookingDoc[], pmBookings: ChadoSaturdayBookingDoc[]) =>
      tx.set(
        sessionRef,
        {
          date,
          amCapacity,
          pmCapacity,
          amTeacher: sessionData.amTeacher ?? "",
          pmTeacher: sessionData.pmTeacher ?? "",
          amBookings,
          pmBookings,
        },
        { merge: true }
      );

    if (action === "cancel") {
      if (!myBookingInSlot) return { ok: true };
      const remaining = targetExisting.filter((b) => b.memberId !== memberId);
      writeSession(slot === "am" ? remaining : existingAm, slot === "pm" ? remaining : existingPm);
      // 振替チケットを使って確保した予約を取り消した場合は、チケットを1枚戻す
      if (myBookingInSlot.usedTicket) {
        tx.update(memberRef, {
          chadoMakeupTickets: (member.chadoMakeupTickets ?? 0) + 1,
        });
      }
      return { ok: true };
    }

    // action === "book"
    if (myBookingInSlot) return { ok: true }; // すでにこの枠を予約済み

    // 今月、この会員がすでに予約している枠の数（午前・午後はそれぞれ1回と数える。
    // 出欠が未確認・欠席のものも「予約を使った」ことに変わりないため含める）
    let bookedThisMonth = 0;
    monthSnap.docs.forEach((docSnap) => {
      const d = docSnap.data() as {
        amBookings?: ChadoSaturdayBookingDoc[];
        pmBookings?: ChadoSaturdayBookingDoc[];
      };
      if ((d.amBookings ?? []).some((b) => b.memberId === memberId)) bookedThisMonth += 1;
      if ((d.pmBookings ?? []).some((b) => b.memberId === memberId)) bookedThisMonth += 1;
    });

    const quota = member.chadoMonthlyQuota ?? CHADO_SATURDAY_DEFAULT_MONTHLY_QUOTA;
    let usedTicket = false;
    if (bookedThisMonth >= quota) {
      const tickets = member.chadoMakeupTickets ?? 0;
      if (tickets <= 0) {
        throw new HttpsError(
          "resource-exhausted",
          `今月の予約可能回数（月${quota}回）の上限に達しています。振替チケットもありません。`
        );
      }
      usedTicket = true;
    }

    const targetCapacity = slot === "am" ? amCapacity : pmCapacity;
    if (targetExisting.length >= targetCapacity) {
      throw new HttpsError("resource-exhausted", "この枠はすでに定員に達しています。");
    }
    const added = [
      ...targetExisting,
      {
        memberId,
        memberName: member.name ?? "",
        bookedAt: new Date().toISOString(),
        usedTicket,
      },
    ];
    writeSession(slot === "am" ? added : existingAm, slot === "pm" ? added : existingPm);

    if (usedTicket) {
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

/**
 * 茶道教室・土曜日クラスの振替チケット自動付与（開催日ごとの出欠経由）。
 *
 * 土曜日クラスの出欠は「開催日ごと」（chadoSaturdaySessions の各予約の attended）に一本化している。
 * 月2回コースの人が1回だけ休んだ場合も正しく数えられるよう、予約1件の欠席＝チケット1枚とする。
 * （予約しなかった回はチケットにならない。2026-10-06 ゆちゃの決定）
 *
 * 管理画面・講師画面のどちらで出欠を付けても、ここで一括して処理する
 * （講師は Firestore ルール上 chadoMakeupTickets を書き換えられないため、サーバー側で行う）。
 *   ・予約が「欠席」になった → +1
 *   ・「欠席」から出席／未確認になった、または欠席の予約が削除された → -1（下限0）
 * あわせて、出席簿（members.attendance の月別セル）をその月の開催日ごとの出欠から自動で埋める
 * （1回でも出席 → 出席、出席がなく欠席あり → 欠席、記録なし → 空欄）。
 * 出席簿の土曜日クラスの行は画面上で編集できないようにしている。
 */
type ChadoSaturdayAttendanceDoc = {
  date?: string;
  amBookings?: { memberId: string; attended?: string }[];
  pmBookings?: { memberId: string; attended?: string }[];
};

// 予約ごとの出欠を「枠:会員ID」をキーにして集める（同じ日に午前・午後の両方を予約している場合があるため）。
function collectSaturdayAttendance(d: ChadoSaturdayAttendanceDoc): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  (d.amBookings ?? []).forEach((b) => map.set(`am:${b.memberId}`, b.attended));
  (d.pmBookings ?? []).forEach((b) => map.set(`pm:${b.memberId}`, b.attended));
  return map;
}

export const onChadoSaturdaySessionAttendanceChanged = onDocumentUpdated(
  "chadoSaturdaySessions/{sessionId}",
  async (event) => {
    const before = event.data?.before.data() as ChadoSaturdayAttendanceDoc | undefined;
    const after = event.data?.after.data() as ChadoSaturdayAttendanceDoc | undefined;
    if (!before || !after) return;

    const prev = collectSaturdayAttendance(before);
    const next = collectSaturdayAttendance(after);
    const deltas = new Map<string, number>(); // 会員ID → チケット増減
    new Set([...prev.keys(), ...next.keys()]).forEach((key) => {
      const p = prev.get(key);
      const n = next.get(key);
      if (p === n) return;
      const memberId = key.slice(3);
      let delta = 0;
      if (p !== "欠席" && n === "欠席") delta = 1;
      if (p === "欠席" && n !== "欠席") delta = -1;
      deltas.set(memberId, (deltas.get(memberId) ?? 0) + delta);
    });
    const changed = [...deltas.entries()].map(([memberId, delta]) => ({ memberId, delta }));
    if (changed.length === 0) return;

    const date = after.date ?? event.params.sessionId;
    const monthKey = date.slice(0, 7);
    const monthSnap = await db
      .collection("chadoSaturdaySessions")
      .where("date", ">=", `${monthKey}-01`)
      .where("date", "<=", `${monthKey}-31`)
      .get();

    for (const { memberId, delta } of changed) {
      // この会員のその月の出欠を、全開催日から集計する
      let hasPresent = false;
      let hasAbsent = false;
      monthSnap.docs.forEach((docSnap) => {
        const map = collectSaturdayAttendance(docSnap.data() as ChadoSaturdayAttendanceDoc);
        [map.get(`am:${memberId}`), map.get(`pm:${memberId}`)].forEach((att) => {
          if (att === "出席") hasPresent = true;
          if (att === "欠席") hasAbsent = true;
        });
      });
      const monthValue = hasPresent ? "出席" : hasAbsent ? "欠席" : null;

      const memberRef = db.collection("members").doc(memberId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(memberRef);
        if (!snap.exists) return;
        const updates: Record<string, unknown> = {
          [`attendance.${monthKey}`]:
            monthValue === null ? admin.firestore.FieldValue.delete() : monthValue,
        };
        if (delta !== 0) {
          const current = (snap.data()?.chadoMakeupTickets as number | undefined) ?? 0;
          updates.chadoMakeupTickets = Math.max(0, current + delta);
        }
        tx.update(memberRef, updates);
      });
      console.log(
        `土曜日クラスの出欠を反映しました memberId=${memberId} date=${date} ticketDelta=${delta} month=${monthValue ?? "空欄"}`
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 茶道教室：お稽古3日前の参加者一覧をSlackへ通知
// ─────────────────────────────────────────────────────────────

/**
 * 講師名とSlackユーザーIDの対応表（講師を追加するときはここに1行足すだけでよい）。
 * keyword：土曜日クラスの担当講師名（管理画面で手入力）にこの文字列が含まれていれば、その講師とみなす。
 * name：木曜日・日曜日クラスの固定講師名（CHADO_FIXED_TEACHERS）と一致させる。
 */
const CHADO_TEACHER_SLACK_MENTIONS: { name: string; keyword: string; slackUserIds: string[] }[] = [
  { name: "阿部宗亜先生", keyword: "阿部", slackUserIds: ["U054136CZ28"] },
  { name: "郷田家元教授", keyword: "郷田", slackUserIds: ["UFYCQMG1L", "U05NTNNSHE1"] },
];

// 木曜日・日曜日クラスの固定の時間帯・担当講師（src/lib/chadoClasses.ts の
// CHADO_CLASS_TIME / CHADO_FIXED_TEACHERS と同じ値。functionsは別パッケージで
// src/ を import できないため、変更するときは両方を揃えること）。
const CHADO_RSVP_CLASS_INFO: Record<(typeof CHADO_RSVP_CLASSES)[number], { time: string; teacher: string }> = {
  "木曜日": { time: "15:00〜17:00", teacher: "阿部宗亜先生" },
  "日曜日": { time: "10:00〜12:00", teacher: "郷田家元教授" },
  "日曜日午後": { time: "13:00〜15:00", teacher: "郷田家元教授" },
};

// 何日前に通知するか
const CHADO_PARTICIPANT_NOTICE_DAYS_BEFORE = 3;

// 新月会の出欠通知（3日前、本部稽古チャンネル）でメンションするSlackユーザー（2026-10-09 ゆちゃ指定）
const SHINGETSUKAI_NOTICE_MENTIONS = ["UG8JH2Q1F"];

/**
 * 講師名（複数可）から、メンションするSlackユーザーIDを重複なしで集める。
 * 名前が未入力・対応表にない場合は何も追加しない（メンションなしで送る）。
 */
function chadoTeacherMentionIds(teacherNames: (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const teacherName of teacherNames) {
    if (!teacherName) continue;
    for (const t of CHADO_TEACHER_SLACK_MENTIONS) {
      if (teacherName.includes(t.keyword) || teacherName === t.name) {
        for (const id of t.slackUserIds) if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

function joinNames(names: string[]): string {
  return names.length > 0 ? names.join("、") : "なし";
}

/**
 * 毎朝9:00（JST）に実行。今日（JST）から3日後が茶道教室の開催日であれば、
 * 参加者一覧を本部稽古チャンネルにSlack通知する（開催日がなければ何も送らない）。
 * ・土曜日クラス：chadoSaturdaySessions の予約状況（午前・午後）
 * ・木曜日／日曜日クラス：meta/nextLessonDates の次回日が3日後と一致する場合のみ、members の rsvp
 * ・新月会：meta/nextLessonDates の「新月会」の次回日が3日後と一致する場合のみ、members の rsvp（UG8JH2Q1F をメンション）
 * 同じ開催日・クラスについて二重送信しないよう、meta/chadoParticipantNotice に送信済みを記録する。
 */
export const notifyChadoParticipants = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Tokyo", secrets: [slackBotToken] },
  async () => {
    const targetDateKey = addDaysToDateKey(todayKeyJST(), CHADO_PARTICIPANT_NOTICE_DAYS_BEFORE);
    const dateLabel = formatDateJp(targetDateKey);
    const header = `【茶道教室】${dateLabel} お稽古の参加者（${CHADO_PARTICIPANT_NOTICE_DAYS_BEFORE}日前のお知らせ）`;

    const messages: { key: string; text: string }[] = [];

    // 1. 土曜日クラス
    const sessionSnap = await db.collection("chadoSaturdaySessions").where("date", "==", targetDateKey).get();
    for (const sessionDoc of sessionSnap.docs) {
      const data = sessionDoc.data() as {
        amTeacher?: string;
        pmTeacher?: string;
        amCapacity?: number;
        pmCapacity?: number;
        amBookings?: ChadoSaturdayBookingDoc[];
        pmBookings?: ChadoSaturdayBookingDoc[];
      };
      const slots = [
        { label: "午前", teacher: data.amTeacher, capacity: data.amCapacity, bookings: data.amBookings ?? [] },
        { label: "午後", teacher: data.pmTeacher, capacity: data.pmCapacity, bookings: data.pmBookings ?? [] },
      ];
      const mentionIds = chadoTeacherMentionIds(slots.map((s) => s.teacher));
      const lines: string[] = [];
      if (mentionIds.length > 0) lines.push(mentionIds.map((id) => `<@${id}>`).join(" "));
      lines.push(header, "土曜日クラス");
      for (const slot of slots) {
        const capacity = slot.capacity ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
        const teacher = slot.teacher?.trim() || "未定";
        const names = slot.bookings.map((b) => b.memberName).filter(Boolean);
        lines.push(
          `■${slot.label}／担当：${teacher}`,
          `予約（${slot.bookings.length}/${capacity}名）：${names.length > 0 ? names.join("、") : "予約なし"}`
        );
      }
      messages.push({ key: `${targetDateKey}_土曜日_${sessionDoc.id}`, text: lines.join("\n") });
    }

    // 2. 木曜日・日曜日クラス（日程変更があるため曜日ではなく meta/nextLessonDates の次回日で判定）
    const nextLessonSnap = await db.doc("meta/nextLessonDates").get();
    const nextDates = nextLessonSnap.data()?.dates as Record<string, { date: string }> | undefined;
    const targetClasses = CHADO_RSVP_CLASSES.filter(
      (c) => nextDates?.[nextLessonKey("茶道教室", c)]?.date?.slice(0, 10) === targetDateKey
    );
    if (targetClasses.length > 0) {
      const membersSnap = await db.collection("members").where("group", "==", "茶道教室").get();
      for (const chadoClass of targetClasses) {
        const info = CHADO_RSVP_CLASS_INFO[chadoClass];
        const attend: string[] = [];
        const absent: string[] = [];
        const unanswered: string[] = [];
        for (const memberDoc of membersSnap.docs) {
          const m = memberDoc.data();
          if (m.chadoClass !== chadoClass) continue;
          if ((m.status ?? "在籍") !== "在籍") continue;
          const name = (m.name as string | undefined) ?? "（氏名未登録）";
          const rsvp = m.rsvp ?? "未回答";
          if (rsvp === "出席") attend.push(name);
          else if (rsvp === "欠席") absent.push(name);
          else unanswered.push(name);
        }
        const mentionIds = chadoTeacherMentionIds([info.teacher]);
        const lines: string[] = [];
        if (mentionIds.length > 0) lines.push(mentionIds.map((id) => `<@${id}>`).join(" "));
        lines.push(
          header,
          `${CHADO_RSVP_CLASS_LABEL[chadoClass]}クラス ${info.time}／担当：${info.teacher}`,
          `出席（${attend.length}名）：${joinNames(attend)}`,
          `欠席（${absent.length}名）：${joinNames(absent)}`,
          `未回答（${unanswered.length}名）：${joinNames(unanswered)}`
        );
        messages.push({ key: `${targetDateKey}_${chadoClass}`, text: lines.join("\n") });
      }
    }

    // 3. 新月会（カレンダーの予定タイトルに「新月会」を含む次回日が3日後のとき）
    const shingetsuNext = nextDates?.["新月会"]?.date;
    if (shingetsuNext && eventDateKeyJST(shingetsuNext) === targetDateKey) {
      const membersSnap = await db.collection("members").where("group", "==", "新月会").get();
      const attend: string[] = [];
      const absent: string[] = [];
      const unanswered: string[] = [];
      for (const memberDoc of membersSnap.docs) {
        const m = memberDoc.data();
        if (m.isTestAccount) continue;
        if ((m.status ?? "在籍") !== "在籍") continue;
        const name = (m.name as string | undefined) ?? "（氏名未登録）";
        const rsvp = m.rsvp ?? "未回答";
        if (rsvp === "出席") attend.push(name);
        else if (rsvp === "欠席") absent.push(name);
        else unanswered.push(name);
      }
      // 時刻指定の予定なら開始時刻（JST）も添える
      const startTime = shingetsuNext.includes("T")
        ? new Date(Date.parse(shingetsuNext) + 9 * 60 * 60 * 1000).toISOString().slice(11, 16) + "〜"
        : "";
      const lines = [
        SHINGETSUKAI_NOTICE_MENTIONS.map((id) => `<@${id}>`).join(" "),
        `【新月会】${dateLabel}${startTime ? " " + startTime : ""} お稽古の出欠（${CHADO_PARTICIPANT_NOTICE_DAYS_BEFORE}日前のお知らせ）`,
        `出席（${attend.length}名）：${joinNames(attend)}`,
        `欠席（${absent.length}名）：${joinNames(absent)}`,
        `未回答（${unanswered.length}名）：${joinNames(unanswered)}`,
      ].filter(Boolean);
      messages.push({ key: `${targetDateKey}_新月会`, text: lines.join("\n") });
    }

    if (messages.length === 0) return; // 3日後に開催日なし

    const token = slackBotToken.value();
    const channel = slackChadoChannelId.value();
    if (!token || !channel) {
      console.warn("SLACK_BOT_TOKEN または SLACK_CHADO_CHANNEL_ID が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const noticeRef = db.doc("meta/chadoParticipantNotice");
    const sentKeys = ((await noticeRef.get()).data()?.sentKeys as string[] | undefined) ?? [];
    for (const msg of messages) {
      if (sentKeys.includes(msg.key)) continue; // 送信済み
      try {
        const posted = await postSlackMessage(token, channel, msg.text);
        if (!posted) continue;
        sentKeys.push(msg.key);
        console.log(`茶道教室の参加者一覧を送信しました key=${msg.key}`);
      } catch (err) {
        console.error("Slack通知の送信に失敗しました", err);
      }
    }
    // 記録が増え続けないよう直近50件だけ残す
    await noticeRef.set({ sentKeys: sentKeys.slice(-50), updatedAt: new Date().toISOString() });
  }
);

// お菓子発注リマインダー：月の最初のお稽古の何日前に送るか
const CHADO_SWEETS_ORDER_DAYS_BEFORE = 10;

/** カレンダーの start（終日 YYYY-MM-DD／時刻指定 ISO）を日本時間の YYYY-MM-DD に変換する */
function eventDateKeyJST(date: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 指定した月（YYYY-MM）の茶道教室のお稽古日（全クラス）を昇順で返す。
 * ・木曜日／日曜日クラスなど：本部の共有Googleカレンダーで、タイトルに「茶道教室」を含む予定
 * ・土曜日クラス：chadoSaturdaySessions の開催日
 */
async function fetchChadoLessonDatesInMonth(monthKey: string): Promise<string[]> {
  const [y, m] = monthKey.split("-").map(Number);
  const firstDay = `${monthKey}-01`;
  const nextMonthFirst = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const dates = new Set<string>();

  // 1. Googleカレンダー（月初〜月末、日本時間）
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Googleカレンダーへのアクセストークンを取得できませんでした。");
  }
  const timeMin = new Date(`${firstDay}T00:00:00+09:00`).toISOString();
  const timeMax = new Date(`${nextMonthFirst}T00:00:00+09:00`).toISOString();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(hqCalendarId.value())}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken.token}` } });
  if (!res.ok) {
    throw new Error(`Googleカレンダーの取得に失敗しました：${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    items?: { summary?: string; start?: { date?: string; dateTime?: string } }[];
  };
  for (const ev of data.items ?? []) {
    if (!(ev.summary ?? "").includes("茶道教室")) continue;
    const raw = ev.start?.dateTime ?? ev.start?.date;
    const key = raw ? eventDateKeyJST(raw) : null;
    if (key && key.startsWith(monthKey)) dates.add(key);
  }

  // 2. 土曜日クラス
  const satSnap = await db
    .collection("chadoSaturdaySessions")
    .where("date", ">=", firstDay)
    .where("date", "<", nextMonthFirst)
    .get();
  for (const doc of satSnap.docs) {
    const d = doc.data().date as string | undefined;
    if (d) dates.add(d);
  }

  return [...dates].sort();
}

/**
 * 毎朝9:00（JST）に実行。茶道教室のみ対象。
 * 今日から10日後が「その月の最初のお稽古日」（全クラス合わせて最も早い日）であれば、
 * 本部稽古boチャンネルに「お菓子の発注をしてください」とリマインダーを送る。
 * 同じ月について二重送信しないよう、meta/chadoSweetsOrderReminder に送信済みの月を記録する。
 */
export const remindChadoSweetsOrder = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Tokyo", secrets: [slackBotToken] },
  async () => {
    const targetDateKey = addDaysToDateKey(todayKeyJST(), CHADO_SWEETS_ORDER_DAYS_BEFORE);
    const monthKey = targetDateKey.slice(0, 7);

    const reminderRef = db.doc("meta/chadoSweetsOrderReminder");
    const sentMonths = ((await reminderRef.get()).data()?.sentMonths as string[] | undefined) ?? [];
    if (sentMonths.includes(monthKey)) return; // 送信済み

    const lessonDates = await fetchChadoLessonDatesInMonth(monthKey);
    if (lessonDates[0] !== targetDateKey) return; // 10日後が月の最初のお稽古ではない

    const token = slackBotToken.value();
    const channel = slackHqChannel.value(); // 本部稽古bo
    if (!token || !channel) {
      console.warn("SLACK_BOT_TOKEN または SLACK_HQ_CHANNEL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const [, month] = monthKey.split("-").map(Number);
    const text =
      `【茶道教室】お菓子発注のリマインダー\n` +
      `${month}月の最初のお稽古（${formatDateJp(targetDateKey)}）まで${CHADO_SWEETS_ORDER_DAYS_BEFORE}日です。お菓子の発注をしてください。\n` +
      `${month}月のお稽古日：${lessonDates.map((d) => formatDateJp(d)).join("、")}`;

    try {
      const posted = await postSlackMessage(token, channel, text);
      if (!posted) return;
      sentMonths.push(monthKey);
      await reminderRef.set({ sentMonths: sentMonths.slice(-24), updatedAt: new Date().toISOString() });
      console.log(`茶道教室のお菓子発注リマインダーを送信しました month=${monthKey} firstLesson=${targetDateKey}`);
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }
  }
);


// ===================================================================
// 週次セキュリティレポート（不正アクセスの兆候チェック）
// ===================================================================


// しきい値（これ以上で「要確認」として警告）
const SEC_IP_FAIL_THRESHOLD = 10; // 同じIPからのログイン失敗回数
const SEC_MEMBER_FAIL_THRESHOLD = 5; // 同じ会員番号へのログイン失敗回数
const SEC_IP_DISTINCT_MEMBER_THRESHOLD = 5; // 同じIPから失敗した会員番号の種類数（総当たりの兆候）
const SEC_LOG_RETENTION_DAYS = 90;

type SecurityReport = {
  periodFrom: string;
  periodTo: string;
  totals: { success: number; fail: number; lineSuccess: number; lineFail: number };
  alerts: string[];
  topFailIps: { ip: string; fails: number; members: number }[];
  topFailMembers: { memberNo: string; fails: number }[];
  successAfterFails: { memberNo: string; fails: number; ip: string }[];
  honbuAccounts: { email: string; uid: string; created: string; lastSignIn: string; isNew: boolean }[];
  newAuthUsers: { member: number; staff: number; other: { uid: string; email: string; provider: string }[] };
  deletedOldLogs: number;
};

function fmtJst(d: Date | string | undefined): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
}

async function buildSecurityReport(): Promise<SecurityReport> {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const alerts: string[] = [];

  // ---- 1) ログイン試行ログの集計 ----
  const logsSnap = await db
    .collection("securityLogs")
    .where("at", ">=", admin.firestore.Timestamp.fromDate(from))
    .get();

  const totals = { success: 0, fail: 0, lineSuccess: 0, lineFail: 0 };
  const failByIp = new Map<string, { fails: number; members: Set<string> }>();
  const failByMember = new Map<string, number>();
  const events = logsSnap.docs
    .map((d) => d.data())
    .sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const pendingFails = new Map<string, number>(); // 会員番号ごとの「直近の連続失敗数」
  const successAfterFails: SecurityReport["successAfterFails"] = [];

  for (const e of events) {
    const isLine = e.method === "line";
    const memberNo = String(e.memberNo || "");
    const ip = String(e.ip || "(不明)");
    if (e.result === "success") {
      if (isLine) totals.lineSuccess++;
      else totals.success++;
      const prev = pendingFails.get(memberNo) ?? 0;
      if (memberNo && prev >= 3) successAfterFails.push({ memberNo, fails: prev, ip });
      pendingFails.delete(memberNo);
    } else {
      if (isLine) totals.lineFail++;
      else totals.fail++;
      const ipEntry = failByIp.get(ip) ?? { fails: 0, members: new Set<string>() };
      ipEntry.fails++;
      if (memberNo) ipEntry.members.add(memberNo);
      failByIp.set(ip, ipEntry);
      if (memberNo) {
        failByMember.set(memberNo, (failByMember.get(memberNo) ?? 0) + 1);
        pendingFails.set(memberNo, (pendingFails.get(memberNo) ?? 0) + 1);
      }
    }
  }

  const topFailIps = [...failByIp.entries()]
    .map(([ip, v]) => ({ ip, fails: v.fails, members: v.members.size }))
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 5);
  const topFailMembers = [...failByMember.entries()]
    .map(([memberNo, fails]) => ({ memberNo, fails }))
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 5);

  for (const r of topFailIps) {
    if (r.fails >= SEC_IP_FAIL_THRESHOLD) alerts.push(`IP ${r.ip} からログイン失敗が${r.fails}回`);
    if (r.members >= SEC_IP_DISTINCT_MEMBER_THRESHOLD)
      alerts.push(`IP ${r.ip} が${r.members}件の異なる会員番号でログインを試行（総当たりの可能性）`);
  }
  for (const r of topFailMembers) {
    if (r.fails >= SEC_MEMBER_FAIL_THRESHOLD) alerts.push(`会員番号 ${r.memberNo} へのログイン失敗が${r.fails}回`);
  }
  for (const r of successAfterFails) {
    alerts.push(`会員番号 ${r.memberNo}：${r.fails}回失敗した後にログイン成功（IP ${r.ip}）`);
  }

  // ---- 2) Firebase Authenticationのアカウント確認 ----
  const honbuAccounts: SecurityReport["honbuAccounts"] = [];
  const newAuthUsers: SecurityReport["newAuthUsers"] = { member: 0, staff: 0, other: [] };
  let pageToken: string | undefined;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      const created = new Date(u.metadata.creationTime);
      const isNew = created >= from;
      if (u.customClaims?.role === "honbu") {
        honbuAccounts.push({
          email: u.email ?? "(メールなし)",
          uid: u.uid,
          created: fmtJst(u.metadata.creationTime),
          lastSignIn: fmtJst(u.metadata.lastSignInTime),
          isNew,
        });
        if (isNew) alerts.push(`本部権限のアカウントが新しく作られています：${u.email ?? u.uid}`);
      }
      if (isNew) {
        if (u.uid.startsWith("member_")) newAuthUsers.member++;
        else if (u.uid.startsWith("staff_")) newAuthUsers.staff++;
        else if (u.customClaims?.role !== "honbu") {
          const provider = u.providerData.map((p) => p.providerId).join(",") || "custom";
          newAuthUsers.other.push({ uid: u.uid, email: u.email ?? "", provider });
          alerts.push(`想定外の新規アカウント：${u.email || u.uid}（${provider}）`);
        }
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // ---- 3) 古いログの削除 ----
  const cutoff = new Date(now.getTime() - SEC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deletedOldLogs = 0;
  while (true) {
    const old = await db
      .collection("securityLogs")
      .where("at", "<", admin.firestore.Timestamp.fromDate(cutoff))
      .limit(400)
      .get();
    if (old.empty) break;
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deletedOldLogs += old.size;
    if (old.size < 400) break;
  }

  return {
    periodFrom: fmtJst(from),
    periodTo: fmtJst(now),
    totals,
    alerts,
    topFailIps,
    topFailMembers,
    successAfterFails,
    honbuAccounts,
    newAuthUsers,
    deletedOldLogs,
  };
}

function formatSecurityReport(r: SecurityReport): string {
  const lines: string[] = [];
  lines.push(`【週次セキュリティレポート】${r.periodFrom} 〜 ${r.periodTo}`);
  lines.push(r.alerts.length ? `⚠️ 要確認 ${r.alerts.length}件` : "✅ 不正アクセスの兆候は見つかりませんでした");
  if (r.alerts.length) r.alerts.forEach((a) => lines.push(`・${a}`));
  lines.push("");
  lines.push(
    `ログイン（会員番号）成功 ${r.totals.success}回／失敗 ${r.totals.fail}回、LINEログイン 成功 ${r.totals.lineSuccess}回／失敗 ${r.totals.lineFail}回`
  );
  if (r.topFailIps.length) {
    lines.push("失敗の多いIP：" + r.topFailIps.map((x) => `${x.ip}（${x.fails}回・${x.members}件）`).join("、"));
  }
  if (r.topFailMembers.length) {
    lines.push("失敗の多い会員番号：" + r.topFailMembers.map((x) => `${x.memberNo}（${x.fails}回）`).join("、"));
  }
  lines.push(
    `新規アカウント：会員 ${r.newAuthUsers.member}件、スタッフ ${r.newAuthUsers.staff}件、その他 ${r.newAuthUsers.other.length}件`
  );
  lines.push("");
  lines.push(`本部権限アカウント（${r.honbuAccounts.length}件）：`);
  r.honbuAccounts.forEach((h) =>
    lines.push(`・${h.email}　最終ログイン ${h.lastSignIn}${h.isNew ? "　🆕今週作成" : ""}`)
  );
  if (r.deletedOldLogs) lines.push(`\n（${SEC_LOG_RETENTION_DAYS}日より古いログ ${r.deletedOldLogs}件を削除しました）`);
  return lines.join("\n");
}

async function runSecurityReport(): Promise<{ report: SecurityReport; text: string }> {
  const report = await buildSecurityReport();
  const text = formatSecurityReport(report);
  await db.collection("securityReports").doc(todayKeyJST()).set({
    ...report,
    text,
    createdAt: admin.firestore.Timestamp.now(),
  });
  // 週次レポートはSlackには投稿しない（Firestoreに保存のみ）。即時アラートだけSlackに送る。
  return { report, text };
}

/**
 * 毎週月曜 9:00（JST）に過去7日間のログイン試行・アカウントを確認し、
 * securityReports/{YYYY-MM-DD} に保存する（Slackには投稿しない）。
 */
export const weeklySecurityReport = onSchedule(
  { schedule: "every monday 09:00", timeZone: "Asia/Tokyo" },
  async () => {
    await runSecurityReport();
  }
);

/** 上と同じ処理を今すぐ実行する（本部のみ）。動作確認用。 */
export const runSecurityReportNow = onCall(async (request) => {
  if (request.auth?.token?.role !== "honbu") {
    throw new HttpsError("permission-denied", "本部のみ実行できます。");
  }
  const { text } = await runSecurityReport();
  return { text };
});

/**
 * 1時間ごとに Firebase Authentication のアカウントを確認し、前回から
 * - 本部権限（role: honbu）のアカウントが増えた／外れた
 * - 会員・スタッフ以外の想定外のアカウントが作られた
 * 場合に即時アラートを送る。前回の状態は securityState/accounts に保存。
 */
export const watchPrivilegedAccounts = onSchedule(
  { schedule: "every 60 minutes", timeZone: "Asia/Tokyo", secrets: [slackBotToken] },
  async () => {
    const honbu: Record<string, string> = {};
    const other: Record<string, string> = {};
    let pageToken: string | undefined;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        const label = u.email || u.uid;
        if (u.customClaims?.role === "honbu") honbu[u.uid] = label;
        else if (!u.uid.startsWith("member_") && !u.uid.startsWith("staff_") && !u.uid.startsWith("keikonote_"))
          other[u.uid] = label;
      }
      pageToken = page.pageToken;
    } while (pageToken);

    const stateRef = db.collection("securityState").doc("accounts");
    const prevSnap = await stateRef.get();
    if (prevSnap.exists) {
      const prev = prevSnap.data() ?? {};
      const prevHonbu = (prev.honbu ?? {}) as Record<string, string>;
      const prevOther = (prev.other ?? {}) as Record<string, string>;
      for (const [uid, label] of Object.entries(honbu)) {
        if (!prevHonbu[uid]) {
          await sendSecurityAlert("honbu_added_" + uid, `本部権限のアカウントが追加されました：${label}（UID ${uid}）。心当たりがなければすぐに確認してください。`);
        }
      }
      for (const [uid, label] of Object.entries(prevHonbu)) {
        if (!honbu[uid]) {
          await sendSecurityAlert("honbu_removed_" + uid, `本部権限のアカウントが削除・権限解除されました：${label}（UID ${uid}）。`);
        }
      }
      for (const [uid, label] of Object.entries(other)) {
        if (!prevOther[uid] && !honbu[uid]) {
          await sendSecurityAlert("other_added_" + uid, `会員・スタッフ以外の新しいアカウントが作られました：${label}（UID ${uid}）。心当たりがなければ確認してください。`);
        }
      }
    }
    await stateRef.set({ honbu, other, checkedAt: admin.firestore.Timestamp.now() });
  }
);

/**
 * お稽古ノート（/keiko-note）の閲覧用ログイン。
 * 合言葉が正しければ、閲覧専用のゲスト（role: keikoNoteGuest）としてのカスタムトークンを発行する。
 * Firestoreの keikoNoteEntries はログイン中の人だけが読めるルールにしてあるため、
 * 会員・スタッフ・本部としてログインしていない人は、これでゲストログインしてから読む。
 * 合言葉の誤りが10分以内に10回以上続いたら即時アラートを送る。
 */
export const keikoNoteGuestLogin = onCall<{ code: string }>(
  { secrets: [keikoNoteAccessCode, slackBotToken] },
  async (request) => {
    const code = typeof request.data?.code === "string" ? request.data.code : "";
    const expected = keikoNoteAccessCode.value();
    const a = Buffer.from(code);
    const b = Buffer.from(expected || "");
    const ok = !!expected && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      const now = Date.now();
      const ref = db.collection("securityCounters").doc("keikonote_code");
      const recent = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const fails = ((snap.data()?.fails as number[]) ?? []).filter((t) => now - t < ALERT_IP_WINDOW_MS);
        fails.push(now);
        tx.set(ref, { fails: fails.slice(-50), updatedAt: admin.firestore.Timestamp.now() });
        return fails.length;
      });
      if (recent >= 10) {
        await sendSecurityAlert(
          "keikonote_code",
          `お稽古ノートの合言葉が10分以内に${recent}回間違えて入力されています。合言葉を当てようとしている可能性があります。`
        );
      }
      throw new HttpsError("permission-denied", "合言葉が正しくありません。");
    }
    const token = await admin.auth().createCustomToken("keikonote_guest", { role: "keikoNoteGuest" });
    return { token };
  }
);
