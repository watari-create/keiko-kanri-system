/**
 * 都度払い会員のお支払い（Squareの支払いページ＝Checkout API の決済リンク）
 *
 * これまで：会ごとに1本の固定の決済リンクを開くだけで、誰の何月分の支払いかシステムでは分からず、
 *           経理タブの「都度払い会員の月謝」は本部が手で「済」にしていた。
 * これから：マイページで「出席する」を押すと、その会員・その月専用の支払いページを作って開く。
 *           支払いが終わると Square の payment.updated 通知（square.ts の squareWebhook）で
 *           members.sessionPayments[月] を自動で「済」にし、経理チャンネルに知らせる。
 *
 *  - 金額：会員の「お月謝（個別設定）」（都度払いは1回あたり）があればそれ、なければ会の標準額
 *  - 同じ月の支払いページは使い回す（二重払い防止）。支払い済みの月は支払いページを作らない
 *  - 入会フォームの「都度払い・今回分」も同じ仕組み（createEnrollSessionCheckout）
 *  - 入会金がまだの会員は、支払いページに入会金の明細も足して、1回でお支払いいただく（entryFee.ts）
 *  - 支払い後に「欠席」に変えたら経理チャンネルに知らせる（返金・次回への振替は本部判断）
 *  - 出席したのに未入金の月を、毎朝1回だけ経理チャンネルに知らせる
 *
 * 記録：sessionCheckouts/{会員番号}_{YYYY-MM}（Cloud Functionsのみ読み書き）
 * 設定（functions/.env.<プロジェクトID>、省略可）：
 *   SESSION_UNPAID_FROM（既定 2026-10）… この月以降の未入金だけを通知する
 */
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import * as crypto from "crypto";
import { square, squareAccessToken, squareLocationId, ensureCustomer, todayJst, MemberDoc } from "./square";
import { postKeiri, groupName } from "./squareInvoice";
import { pendingEntryFee, markEntryFeePaid } from "./entryFee";
import { refreshGroupSettings, sessionFeeStd } from "./groupSettings";

const slackBotToken = defineSecret("SLACK_BOT_TOKEN");
const sessionUnpaidFrom = defineString("SESSION_UNPAID_FROM", { default: "2026-10" });

// 都度払いの1回あたりの標準額は、管理画面の「会の設定」から読む（groupSettings.ts の sessionFeeStd）

interface SessionMember extends MemberDoc {
  attendance?: Record<string, string>;
  sessionPayments?: Record<string, string>;
  rsvpByDate?: Record<string, string>;
  createdAt?: admin.firestore.Timestamp;
  sessionPaymentExempt?: boolean;
}

interface CheckoutRecord {
  memberId: string;
  memberName: string;
  group: string;
  monthKey: string;
  amount: number; // お月謝（1回分）
  entryFeeAmount?: number; // 一緒にいただく入会金（なければ 0／未設定）
  entryFeeTitle?: string;
  status: "OPEN" | "PAID";
  paymentLinkId?: string;
  url?: string;
  orderId?: string;
  createdAt?: string;
  paidAt?: string;
  squarePaymentId?: string;
  unpaidNotifiedAt?: string;
}

function db() {
  return admin.firestore();
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月`;
}

function sessionFeeFor(m: SessionMember): number | null {
  if (typeof m.monthlyFee === "number" && m.monthlyFee > 0) return m.monthlyFee;
  return sessionFeeStd(m.group);
}

function isMonthKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** 今月の前後1か月だけ受け付ける（ブラウザの時計ずれ・月末をまたぐ操作を許容） */
function isNearMonth(mk: string): boolean {
  const [y, m] = todayJst().split("-").map(Number);
  const idx = (s: string) => {
    const [a, b] = s.split("-").map(Number);
    return a * 12 + b;
  };
  return Math.abs(idx(mk) - (y * 12 + m)) <= 1;
}

function safeReturnUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 会員・月ごとの支払いページを用意する（あれば使い回す）。
 * 返り値：paid=true なら支払い済み（支払いページは返さない）
 */
async function ensureSessionCheckout(
  memberId: string,
  monthKey: string,
  returnUrl?: string
): Promise<{ paid: boolean; url?: string; amount?: number; entryFee?: number }> {
  const memberSnap = await db().doc(`members/${memberId}`).get();
  if (!memberSnap.exists) throw new HttpsError("not-found", "会員が見つかりません。");
  const m = memberSnap.data() as SessionMember;
  if (m.paymentMethod !== "都度払い") throw new HttpsError("failed-precondition", "都度払いの会員ではありません。");
  if (m.status !== "在籍") throw new HttpsError("failed-precondition", "在籍中の会員のみお支払いいただけます。");
  if (m.sessionPayments?.[monthKey] === "済") return { paid: true };
  const amount = sessionFeeFor(m);
  if (!amount) throw new HttpsError("failed-precondition", "お支払い金額が設定されていません。本部より別途ご連絡します。");

  // 入会金がまだなら、同じ支払いページで一緒にいただく
  const entry = pendingEntryFee(m);
  const entryAmount = entry?.amount ?? 0;

  const ref = db().doc(`sessionCheckouts/${memberId}_${monthKey}`);
  const snap = await ref.get();
  const rec = snap.exists ? (snap.data() as CheckoutRecord) : null;
  if (rec?.status === "PAID") return { paid: true };
  if (rec?.url && rec.paymentLinkId && rec.amount === amount && (rec.entryFeeAmount ?? 0) === entryAmount) {
    return { paid: false, url: rec.url, amount, entryFee: entryAmount };
  }

  // 金額が変わった（個別設定の変更・入会金を別に払われた等）場合は古い支払いページを無効にして作り直す
  if (rec?.paymentLinkId) {
    await square("DELETE", `/v2/online-checkout/payment-links/${rec.paymentLinkId}`).catch((e) =>
      console.warn("古い支払いページの削除に失敗しました", rec.paymentLinkId, e)
    );
  }

  const sub = await db().doc(`memberSubscriptions/${memberId}`).get();
  const customerId = await ensureCustomer(memberId, m, sub.exists ? (sub.data()?.squareCustomerId as string | undefined) : undefined);
  const title = `${groupName(m.group)} ${monthLabel(monthKey)}分 お月謝（都度払い）`;
  const email = (m.email ?? "").trim();

  const res = await square<{ payment_link: { id: string; url: string; order_id: string } }>(
    "POST",
    "/v2/online-checkout/payment-links",
    {
      idempotency_key: crypto.randomUUID(),
      description: entry ? `${title}・${entry.title}` : title,
      payment_note: `${m.name ?? ""}様（会員番号 ${memberId}）${title}${entry ? `・${entry.title}` : ""}`,
      order: {
        location_id: squareLocationId.value(),
        customer_id: customerId,
        reference_id: `${memberId}_${monthKey}`,
        line_items: [
          {
            name: title,
            quantity: "1",
            base_price_money: { amount: Math.round(amount), currency: "JPY" },
            note: `会員番号 ${memberId}`,
          },
          ...(entry
            ? [
                {
                  name: entry.title,
                  quantity: "1",
                  base_price_money: { amount: Math.round(entry.amount), currency: "JPY" },
                  note: `会員番号 ${memberId}（初回のみ）`,
                },
              ]
            : []),
        ],
      },
      checkout_options: {
        allow_tipping: false,
        ask_for_shipping_address: false,
        ...(returnUrl ? { redirect_url: returnUrl } : {}),
      },
      ...(email ? { pre_populated_data: { buyer_email: email } } : {}),
    }
  );
  const link = res.payment_link;
  const now = new Date().toISOString();
  await ref.set(
    {
      memberId,
      memberName: m.name ?? "",
      group: m.group ?? "",
      monthKey,
      amount,
      entryFeeAmount: entryAmount,
      entryFeeTitle: entry?.title ?? "",
      status: "OPEN",
      paymentLinkId: link.id,
      url: link.url,
      orderId: link.order_id,
      createdAt: now,
    } satisfies CheckoutRecord,
    { merge: true }
  );
  return { paid: false, url: link.url, amount, entryFee: entryAmount };
}

function wrapError(err: unknown): never {
  if (err instanceof HttpsError) throw err;
  console.error("都度払いの支払いページの作成に失敗しました", err);
  throw new HttpsError("internal", "お支払いページを用意できませんでした。時間をおいて再度お試しいただくか、本部までご連絡ください。");
}

/** マイページ：都度払いの会員が「出席する」または「お支払いへ」を押したとき */
export const createSessionCheckout = onCall<{ monthKey: string; returnUrl?: string }>(
  { secrets: [squareAccessToken] },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const memberId = request.auth?.token?.memberId as string | undefined;
    if (request.auth?.token?.role !== "member" || !memberId) {
      throw new HttpsError("permission-denied", "会員としてログインしてください。");
    }
    const { monthKey } = request.data ?? ({} as { monthKey: string });
    if (!isMonthKey(monthKey)) throw new HttpsError("invalid-argument", "月の指定が正しくありません。");
    // 未入金の過去の月（経理で未納のまま）も払えるように、今月±1か月に加えて、出席済みの過去の月も許可する
    if (!isNearMonth(monthKey)) {
      const snap = await db().doc(`members/${memberId}`).get();
      const att = (snap.data() as SessionMember | undefined)?.attendance?.[monthKey];
      if (att !== "出席" || monthKey < sessionUnpaidFrom.value()) {
        throw new HttpsError("invalid-argument", "この月のお支払いはマイページからはできません。本部までご連絡ください。");
      }
    }
    try {
      return await ensureSessionCheckout(memberId, monthKey, safeReturnUrl(request.data?.returnUrl));
    } catch (err) {
      wrapError(err);
    }
  }
);

/** 入会フォーム：都度払いを選んだ新規入会者の「今回分」（入会直後のみ・ログイン前でも呼べる） */
export const createEnrollSessionCheckout = onCall<{ memberId: string; returnUrl?: string }>(
  { secrets: [squareAccessToken] },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const memberId = String(request.data?.memberId ?? "");
    if (!/^\d{5,10}$/.test(memberId)) throw new HttpsError("invalid-argument", "会員番号が正しくありません。");
    const snap = await db().doc(`members/${memberId}`).get();
    if (!snap.exists) throw new HttpsError("not-found", "会員が見つかりません。");
    const m = snap.data() as SessionMember;
    const created = m.createdAt?.toMillis?.() ?? 0;
    if (!created || Date.now() - created > 3 * 3600 * 1000) {
      throw new HttpsError("failed-precondition", "マイページにログインしてお支払いください。");
    }
    try {
      return await ensureSessionCheckout(memberId, todayJst().slice(0, 7), safeReturnUrl(request.data?.returnUrl));
    } catch (err) {
      wrapError(err);
    }
  }
);

/**
 * square.ts の squareWebhook（payment.updated・COMPLETED）から呼ぶ。
 * この仕組みで作った支払いページの入金なら経理を「済」にして true を返す。
 */
export async function handleSessionCheckoutPaid(payment: any): Promise<boolean> {
  const orderId = payment?.order_id as string | undefined;
  if (!orderId) return false;
  const q = await db().collection("sessionCheckouts").where("orderId", "==", orderId).limit(1).get();
  if (q.empty) return false;
  const ref = q.docs[0].ref;
  const rec = q.docs[0].data() as CheckoutRecord;
  if (rec.status === "PAID") return true;
  const now = new Date().toISOString();
  const paidTotal = payment.amount_money?.amount ?? rec.amount + (rec.entryFeeAmount ?? 0);
  const entryAmount = rec.entryFeeAmount ?? 0;
  const paidAmount = entryAmount > 0 ? Math.max(0, paidTotal - entryAmount) : paidTotal;
  await ref.update({ status: "PAID", paidAt: now, squarePaymentId: payment.id ?? null });
  await db()
    .doc(`members/${rec.memberId}`)
    .update({
      [`sessionPayments.${rec.monthKey}`]: "済",
      [`sessionPaymentsSquare.${rec.monthKey}`]: { amount: paidAmount, paidAt: now },
    });
  // 使い終わった支払いページは無効にしておく（二重払い防止）
  if (rec.paymentLinkId) {
    await square("DELETE", `/v2/online-checkout/payment-links/${rec.paymentLinkId}`).catch(() => undefined);
  }
  await postKeiri(
    `💴 都度払いのお月謝の入金がありました（経理タブは自動で「入金済」になりました）\n` +
      `${rec.memberName}様（${groupName(rec.group)}）${monthLabel(rec.monthKey)}分　¥${Number(paidAmount).toLocaleString("ja-JP")}`
  );
  // 支払いページに入会金も含めていた場合は、入会金も「済」に（請求書が残っていれば取り消す）
  if (entryAmount > 0) {
    await markEntryFeePaid(rec.memberId, { amount: entryAmount, method: "支払いページ", squarePaymentId: payment.id ?? null }).catch((e) =>
      console.error("入会金の記録に失敗しました", rec.memberId, e)
    );
  }
  return true;
}

/** 支払い後に「欠席」に変えた会員を経理チャンネルに知らせる */
export const onSessionPaidThenAbsent = onDocumentUpdated(
  { document: "members/{memberId}", secrets: [slackBotToken] },
  async (event) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const before = event.data?.before.data() as SessionMember | undefined;
    const after = event.data?.after.data() as SessionMember | undefined;
    if (!before || !after || after.paymentMethod !== "都度払い" || after.sessionPaymentExempt) return;
    const months = Object.keys(after.attendance ?? {}).filter(
      (mk) => before.attendance?.[mk] === "出席" && after.attendance?.[mk] === "欠席" && after.sessionPayments?.[mk] === "済"
    );
    for (const mk of months) {
      await postKeiri(
        `⚠️ 都度払いでお支払い済みの会員が「欠席」に変更しました（返金・次回への振替をご判断ください）\n` +
          `${after.name ?? ""}様（${event.params.memberId}・${groupName(after.group)}）${monthLabel(mk)}分`
      );
    }
  }
);

/** 毎朝：出席したのに未入金の都度払い会員を、経理チャンネルに1回だけ知らせる */
export const checkUnpaidSessionPayments = onSchedule(
  { schedule: "20 9 * * *", timeZone: "Asia/Tokyo", secrets: [slackBotToken] },
  async () => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const today = todayJst();
    const thisMonth = today.slice(0, 7);
    const [y, mo, d] = today.split("-").map(Number);
    const threeDaysAgo = new Date(Date.UTC(y, mo - 1, d - 3)).toISOString().slice(0, 10);
    const from = sessionUnpaidFrom.value();

    const members = await db()
      .collection("members")
      .where("paymentMethod", "==", "都度払い")
      .where("status", "==", "在籍")
      .get();
    const lines: string[] = [];
    for (const doc of members.docs) {
      const m = doc.data() as SessionMember & { isTestAccount?: boolean };
      if (m.isTestAccount || m.sessionPaymentExempt) continue;
      for (const [mk, v] of Object.entries(m.attendance ?? {})) {
        if (v !== "出席" || mk < from || mk > thisMonth || m.sessionPayments?.[mk] === "済") continue;
        // 月が終わった、または出席と答えたお稽古日から3日たった
        const lessonPassed =
          mk < thisMonth ||
          Object.entries(m.rsvpByDate ?? {}).some(([date, r]) => r === "出席" && date >= `${mk}-01` && date <= threeDaysAgo);
        if (!lessonPassed) continue;
        const ref = db().doc(`sessionCheckouts/${doc.id}_${mk}`);
        const rec = (await ref.get()).data() as CheckoutRecord | undefined;
        if (rec?.unpaidNotifiedAt || rec?.status === "PAID") continue;
        await ref.set(
          { memberId: doc.id, memberName: m.name ?? "", group: m.group ?? "", monthKey: mk, unpaidNotifiedAt: new Date().toISOString() },
          { merge: true }
        );
        lines.push(`・${m.name ?? ""}様（${doc.id}・${groupName(m.group)}）${monthLabel(mk)}分`);
      }
    }
    if (lines.length > 0) {
      await postKeiri(
        `🔔 出席したのに都度払いのお月謝が未入金の会員がいます（マイページに「お支払いへ」ボタンが出ています）\n` +
          lines.join("\n") +
          `\n※別の方法で受け取り済みの場合は、経理タブで「入金済」にしてください。`
      );
    }
  }
);
