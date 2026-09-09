import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();
const db = admin.firestore();

// Slack Incoming Webhook のURL。
// 設定方法： firebase functions:secrets:set SLACK_WEBHOOK_URL
const slackWebhookUrl = defineSecret("SLACK_WEBHOOK_URL");

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
