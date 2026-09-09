import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { GoogleAuth } from "google-auth-library";

admin.initializeApp();
const db = admin.firestore();

// Slack Incoming Webhook のURL。
// 設定方法： firebase functions:secrets:set SLACK_WEBHOOK_URL
const slackWebhookUrl = defineSecret("SLACK_WEBHOOK_URL");

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
  if (memberSnap.exists && (memberSnap.data()?.email || "").toLowerCase() === normalizedEmail) {
    const uid = `member_${memberNo}`;
    const token = await admin.auth().createCustomToken(uid, {
      role: "member",
      memberId: memberNo,
    });
    return { token, role: "member" };
  }

  // 次にスタッフ（世話人・講師）として確認
  const staffSnap = await db.collection("staff").doc(memberNo).get();
  if (staffSnap.exists && (staffSnap.data()?.email || "").toLowerCase() === normalizedEmail) {
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
  "licenseRequests/{requestId}",
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
    }
  }
);

/**
 * 許状申請のステータスが進んだら（本部管理画面で「次に進める」を押したら）、
 * Slackに通知する。許状段階の反映は上のonLicenseIssuedが別途行う。
 */
export const onLicenseRequestStatusChanged = onDocumentUpdated(
  { document: "licenseRequests/{requestId}", secrets: [slackWebhookUrl] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return;

    const webhookUrl = slackWebhookUrl.value();
    if (!webhookUrl) {
      console.warn("SLACK_WEBHOOK_URL が未設定のため、Slack通知をスキップしました。");
      return;
    }

    const text =
      `許状申請が進みました\n` +
      `会員：${after.memberName}様\n` +
      `許状：${after.licenseName}\n` +
      `ステータス：${before.status} → ${after.status}`;

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("Slack通知の送信に失敗しました", err);
    }
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
