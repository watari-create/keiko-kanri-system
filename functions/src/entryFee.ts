/**
 * 入会金を「最初のお支払いと一緒に」いただく仕組み
 *
 * これまで：入会と同時にSquareの請求書をメールで送り、会員はお月謝とは別にもう一度カード番号を入れて払っていた。
 * これから：
 *  - カード自動払い（月謝）の会員 … マイページでカードを登録するとき、同じカードで入会金も引き落とす（square.ts の startSquareSubscription）
 *  - 都度払いの会員             … 入会フォームの「今回分」の支払いページに入会金の明細を足して、1回で払う（squareSessionCheckout.ts）
 *  - どちらでも払われなかった会員 … 入会日から ENTRY_FEE_INVOICE_AFTER_DAYS 日（既定3日）たったら、従来どおりSquareの請求書を自動で送る（毎朝9:15）
 *
 * 対象：管理画面の「会の設定」で入会金を設定した本部稽古の会（既定は名月会 ¥33,000・茶道教室 ¥15,000）で、入会日が ENTRY_FEE_COLLECT_FROM 以降の新規入会者
 *       （それより前に入会して請求書が未入金のまま残っている会員も、カード登録・支払いページで一緒に払えるようにし、請求書は取り消す）
 *
 * 記録（members/{会員番号}）：
 *   entryFeeStatus＝"済"、entryFeePaid＝{ amount, paidAt, method（"カード登録時"／"支払いページ"）, squarePaymentId }
 *
 * 設定（functions/.env.<プロジェクトID>、いずれも省略可）：
 *   ENTRY_FEE_COLLECT_FROM（既定 2026-10-10）… この日以降の入会者を対象にする
 *   ENTRY_FEE_INVOICE_AFTER_DAYS（既定 3）… 入会から何日たっても未払いなら請求書を送るか
 */
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { square, squareAccessToken, todayJst, ymd } from "./square";
import {
  entryFeeFor,
  InvoiceSummary,
  cancelSquareInvoice,
  handleOneOffInvoicePaid,
  issueEntryFeeInvoice,
  postKeiri,
  groupName,
} from "./squareInvoice";
import { refreshGroupSettings } from "./groupSettings";

const slackBotToken = defineSecret("SLACK_BOT_TOKEN");
export const entryFeeCollectFrom = defineString("ENTRY_FEE_COLLECT_FROM", { default: "2026-10-10" });
const entryFeeInvoiceAfterDays = defineString("ENTRY_FEE_INVOICE_AFTER_DAYS", { default: "3" });

function db() {
  return admin.firestore();
}

export type EntryFeeMethod = "カード登録時" | "支払いページ";

export interface PendingEntryFee {
  amount: number;
  title: string; // 明細名（例：入会金（名月会））
  invoiceId: string | null; // 未入金のまま残っている請求書（払われたら取り消す）
}

export function invoiceAfterDays(): number {
  return Math.max(1, Math.min(30, Number(entryFeeInvoiceAfterDays.value()) || 3));
}

/**
 * この会員から、いま入会金をいただくべきか（Squareへの問い合わせなし・すぐ判定できる版）。
 * いただく場合は金額と明細名を返す。
 */
export function pendingEntryFee(m: FirebaseFirestore.DocumentData | undefined): PendingEntryFee | null {
  if (!m) return null;
  const conf = entryFeeFor(m.group as string | undefined);
  if (!conf) return null;
  if (m.entryFeeStatus === "済" || m.isTestAccount === true || m.skipEnrollmentNotice === true) return null;
  const inv = m.entryFeeInvoice as InvoiceSummary | undefined;
  const invoiceUnpaid = !!inv && inv.status === "UNPAID";
  const newMember = typeof m.joinDate === "string" && m.joinDate >= entryFeeCollectFrom.value();
  if (!invoiceUnpaid && !newMember) return null;
  if (inv && inv.status === "PAID") return null;
  return {
    amount: invoiceUnpaid ? inv!.amount : conf.amount,
    title: `入会金（${groupName(m.group)}）`,
    invoiceId: invoiceUnpaid ? inv!.id : null,
  };
}

/**
 * カードで引き落とす直前の確認：請求書がすでにSquare上で払われていたら記録して null を返す（二重払い防止）。
 */
export async function resolvePendingEntryFee(memberId: string, m: FirebaseFirestore.DocumentData): Promise<PendingEntryFee | null> {
  const p = pendingEntryFee(m);
  if (!p || !p.invoiceId) return p;
  try {
    const got = await square<{ invoice: { status: string } }>("GET", `/v2/invoices/${p.invoiceId}`);
    if (got.invoice.status === "PAID") {
      await handleOneOffInvoicePaid({ id: p.invoiceId, status: "PAID" });
      return null;
    }
    if (!["UNPAID", "SCHEDULED", "PARTIALLY_PAID"].includes(got.invoice.status)) {
      return { ...p, invoiceId: null };
    }
  } catch (err) {
    console.warn("入会金の請求書の状態確認に失敗しました", memberId, p.invoiceId, err);
  }
  return p;
}

/**
 * 入会金をいただいたことを記録する。未入金の請求書が残っていれば取り消し、経理チャンネルに知らせる。
 * すでに「済」だった場合（請求書でも払われていた等）は二重払いの可能性として知らせる。
 */
export async function markEntryFeePaid(
  memberId: string,
  pay: { amount: number; method: EntryFeeMethod; squarePaymentId: string | null }
): Promise<void> {
  const ref = db().doc(`members/${memberId}`);
  const now = new Date().toISOString();
  const before = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const m = s.data() ?? {};
    if (m.entryFeeStatus !== "済") {
      tx.update(ref, {
        entryFeeStatus: "済",
        entryFeePaid: { amount: pay.amount, paidAt: now, method: pay.method, squarePaymentId: pay.squarePaymentId },
      });
    }
    return m;
  });
  const name = `${before.name ?? ""}様（${memberId}・${groupName(before.group)}）`;

  if (before.entryFeeStatus === "済") {
    await postKeiri(
      `⚠️ 入会金がすでに入金済みの会員から、もう一度入会金をいただいた可能性があります（${pay.method}）\n` +
        `${name}　¥${pay.amount.toLocaleString("ja-JP")}\n` +
        `経理タブ・Squareで確認し、二重であればSquareで返金してください。`
    );
    return;
  }

  // 請求書が残っていれば取り消す（もう払っていただいたため）
  const inv = before.entryFeeInvoice as InvoiceSummary | undefined;
  let invoiceNote = "";
  if (inv && inv.status === "UNPAID") {
    try {
      const canceled = await cancelSquareInvoice(inv.id);
      if (canceled) {
        await ref.update({ "entryFeeInvoice.status": "CANCELED" });
        invoiceNote = `\n先にお送りしていた請求書（#${inv.number ?? "-"}）は自動で取り消しました。`;
      } else {
        invoiceNote = `\n⚠️ 先にお送りした請求書（#${inv.number ?? "-"}）を取り消せませんでした。Squareで状態をご確認ください（入金済みなら返金が必要です）。`;
      }
    } catch (err) {
      console.error("入会金の請求書の取り消しに失敗しました", memberId, inv.id, err);
      invoiceNote = `\n⚠️ 先にお送りした請求書（#${inv.number ?? "-"}）を取り消せませんでした。Squareで取り消してください。`;
    }
  }
  await postKeiri(
    `💴 入会金の入金がありました（${pay.method}・経理タブは自動で「入金済」になりました）\n` +
      `${name}　¥${pay.amount.toLocaleString("ja-JP")}` +
      invoiceNote
  );
}

/** カード登録の途中で失敗したとき、先に引き落とした入会金を返金する */
export async function refundEntryFeePayment(memberId: string, paymentId: string, amount: number): Promise<boolean> {
  try {
    await square("POST", "/v2/refunds", {
      idempotency_key: `ef-rf-${paymentId}`.slice(0, 45),
      payment_id: paymentId,
      amount_money: { amount, currency: "JPY" },
      reason: "お申込みの処理を完了できなかったため",
    });
    return true;
  } catch (err) {
    console.error("入会金の返金に失敗しました", memberId, paymentId, err);
    await postKeiri(
      `⚠️ カード登録の途中でエラーになり、先に引き落とした入会金を自動で返金できませんでした\n` +
        `会員No：${memberId}　¥${amount.toLocaleString("ja-JP")}　Squareの支払いID：${paymentId}\n` +
        `Squareのダッシュボードで返金するか、入金済みとして扱ってください。`
    );
    return false;
  }
}

/**
 * 毎朝9:15：入会から一定日数たっても入会金が払われていない新規入会者に、Squareの請求書を送る。
 */
export const sendPendingEntryFeeInvoices = onSchedule(
  {
    schedule: "15 9 * * *",
    timeZone: "Asia/Tokyo",
    secrets: [squareAccessToken, slackBotToken],
  },
  async () => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const [y, mo, d] = todayJst().split("-").map(Number);
    const cutoff = ymd(y, mo, d - invoiceAfterDays()); // この日以前に入会した会員が対象
    const from = entryFeeCollectFrom.value();
    const snap = await db()
      .collection("members")
      .where("joinDate", ">=", from)
      .get();
    for (const doc of snap.docs) {
      const m = doc.data();
      if (m.joinDate > cutoff || m.status !== "在籍" || m.groupCategory !== "本部稽古") continue;
      if (m.entryFeeInvoice || m.entryFeeInvoiceError || m.entryFeeInvoiceAutoAt) continue;
      const p = pendingEntryFee(m);
      if (!p) continue;
      // 同じ会員に2回送らないよう、先に印をつける
      await doc.ref.update({ entryFeeInvoiceAutoAt: new Date().toISOString() });
      await issueEntryFeeInvoice(
        doc.id,
        m,
        `入会から${invoiceAfterDays()}日たっても、カード登録・支払いページで入会金のお支払いがなかったため`
      );
    }
  }
);
