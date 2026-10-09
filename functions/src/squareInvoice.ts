/**
 * Squareの請求書（Invoices API）の自動発行
 *
 * 対象：
 *  - 許状代金：許状申請が「請求書発行依頼」になったら、申請の金額（申請料＋御礼）で請求書を作り、会員にメールで送る。
 *    送れたら申請を自動で「発行手続き中」に進める。
 *  - 入会金：ふつうはカード登録時・支払いページでお月謝と一緒にいただく（entryFee.ts）。入会から数日たっても
 *    払われていない会員にだけ、入会金の請求書を送る（名月会 ¥33,000・茶道教室 ¥15,000）。
 *
 * 流れ：Squareの顧客（会員番号で再利用）→ 注文（明細1行）→ 請求書の作成 → 送信（publish）。
 *   送れなかった場合（メールアドレス未登録など）は、経理チャンネルに「手動で発行してください」と従来どおり依頼する。
 *
 * 入金：Squareの invoice.payment_made 通知（square.ts の squareWebhook）で、経理タブを自動で「入金済」にする。
 * 期日超過：毎朝、期日を過ぎても未入金の請求書を経理チャンネルに知らせる。
 * 取消：許状申請を「取消」にしたら、未入金の請求書もSquare上でキャンセルする。
 *
 * 記録：
 *  - squareInvoices/{SquareのinvoiceId}：請求書ごとの記録（Cloud Functionsのみ読み書き）
 *  - 対象ドキュメント（licenseRequests/{id} または members/{id}）の squareInvoice / entryFeeInvoice フィールド：
 *    経理タブの表示用（請求書番号・期日・Squareの請求書ページURL・状態）
 *
 * 設定（functions/.env.<プロジェクトID>、いずれも省略可）：
 *   SQUARE_AUTO_INVOICE（on / off、既定 on）… off にすると従来どおりSlackで発行依頼するだけになる
 *   SQUARE_INVOICE_DUE_DAYS（既定 14）… 送信日から何日後を支払期日にするか
 */
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import {
  square,
  squareAccessToken,
  squareLocationId,
  SquareApiError,
  ensureCustomer,
  todayJst,
  ymd,
  MemberDoc,
} from "./square";

const slackBotToken = defineSecret("SLACK_BOT_TOKEN");
// 経理チャンネル（請求書-経理全般）
const slackKeiriChannel = defineString("SLACK_LICENSE_CHANNEL");
const slackKeiriMentionUserId = defineString("SLACK_LICENSE_MENTION_USER_ID", { default: "" });
const slackEntryFeeMentionUserId = defineString("SLACK_ENTRY_FEE_MENTION_USER_ID", { default: "" });
export const squareAutoInvoice = defineString("SQUARE_AUTO_INVOICE", { default: "on" });
const squareInvoiceDueDays = defineString("SQUARE_INVOICE_DUE_DAYS", { default: "14" });

/** 入会金の請求書を自動で送る会と金額（src/lib/memberFees.ts の ENTRY_FEES と同じ金額にしておくこと） */
export const ENTRY_FEE_INVOICE: Record<string, { amount: number; note: string }> = {
  "名月会": { amount: 33000, note: "名月会の入会金です。" },
  "茶道教室": { amount: 15000, note: "入会費・宗徧会費・入門許状代・扇子代を含みます。" },
};

const GROUP_DISPLAY: Record<string, string> = { "Gマダムの茶の湯講座": "G1マダムの茶の湯講座" };
export const groupName = (g?: string) => (g ? GROUP_DISPLAY[g] ?? g : "");

export type InvoiceKind = "license" | "entryFee";

/** 対象ドキュメントに保存する、経理タブ表示用の請求書情報 */
export interface InvoiceSummary {
  id: string;
  number: string | null;
  url: string | null;
  amount: number;
  dueDate: string;
  status: "UNPAID" | "PAID" | "CANCELED";
  sentAt: string;
  paidAt?: string;
}

interface InvoiceRecord {
  kind: InvoiceKind;
  targetPath: string;
  memberId: string;
  memberName: string;
  group: string;
  title: string;
  amount: number;
  dueDate: string;
  invoiceNumber: string | null;
  publicUrl: string | null;
  status: string; // UNPAID / PAID / CANCELED / SETTLED_MANUALLY
  createdAt: string;
  paidAt?: string;
  overdueNotifiedAt?: string;
}

function db() {
  return admin.firestore();
}

export function autoInvoiceEnabled(): boolean {
  return squareAutoInvoice.value().trim().toLowerCase() !== "off";
}

function dueDateFromToday(): string {
  const days = Math.max(1, Math.min(60, Number(squareInvoiceDueDays.value()) || 14));
  const [y, m, d] = todayJst().split("-").map(Number);
  return ymd(y, m, d + days);
}

/** 送れなかった理由を、経理担当にわかる言葉にする */
export function describeInvoiceError(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("NO_EMAIL")) return "会員のメールアドレスが登録されていません";
  if (err instanceof SquareApiError) {
    const detail = err.errors.map((e) => e.detail || e.code).filter(Boolean).join(" / ");
    return `Squareでエラーになりました（${detail || `HTTP ${err.status}`}）`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function postKeiri(text: string): Promise<void> {
  try {
    const token = slackBotToken.value();
    const channel = slackKeiriChannel.value();
    if (!token || !channel) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text }),
    });
  } catch (err) {
    console.error("経理チャンネルへのSlack通知に失敗しました", err);
  }
}

interface IssueParams {
  kind: InvoiceKind;
  targetPath: string; // licenseRequests/{id} or members/{id}
  memberId: string;
  title: string; // 請求書のタイトル・明細名
  description: string; // 請求書の本文
  amount: number;
  attempt?: number; // 再送のたびに増やす（Squareの重複防止キーを変えるため）
}

/**
 * 請求書を作って会員にメールで送る。成功すると squareInvoices に記録し、表示用の情報を返す。
 * 失敗したら例外を投げる（呼び出し側でSlackの手動依頼にフォールバックする）。
 */
export async function issueSquareInvoice(p: IssueParams): Promise<InvoiceSummary> {
  if (!Number.isFinite(p.amount) || p.amount <= 0) throw new Error("金額が設定されていません");
  const memberSnap = await db().doc(`members/${p.memberId}`).get();
  if (!memberSnap.exists) throw new Error(`会員（${p.memberId}）が見つかりません`);
  const m = memberSnap.data() as MemberDoc & { squareCustomerId?: string };
  const email = (m.email ?? "").trim();
  if (!email) throw new Error("NO_EMAIL");

  // 顧客：カード自動払いで作った顧客がいれば再利用する
  const sub = await db().doc(`memberSubscriptions/${p.memberId}`).get();
  const existingCustomerId = (sub.exists ? (sub.data()?.squareCustomerId as string | undefined) : undefined) ?? undefined;
  const customerId = await ensureCustomer(p.memberId, m, existingCustomerId);
  // 請求書はメールで届くため、Square上の顧客のメールアドレスを名簿と同じにしておく
  const cust = await square<{ customer: { email_address?: string; given_name?: string; family_name?: string } }>(
    "GET",
    `/v2/customers/${customerId}`
  );
  if ((cust.customer.email_address ?? "").trim().toLowerCase() !== email.toLowerCase()) {
    await square("PUT", `/v2/customers/${customerId}`, { email_address: email });
  }

  const keyBase = `${p.kind}-${p.targetPath.split("/")[1]}-${p.attempt ?? 0}`;
  const locationId = squareLocationId.value();

  const order = await square<{ order: { id: string } }>("POST", "/v2/orders", {
    idempotency_key: `${keyBase}-order`,
    order: {
      location_id: locationId,
      customer_id: customerId,
      reference_id: p.memberId,
      line_items: [
        {
          name: p.title,
          quantity: "1",
          base_price_money: { amount: Math.round(p.amount), currency: "JPY" },
        },
      ],
    },
  });

  const dueDate = dueDateFromToday();
  const created = await square<{ invoice: { id: string; version: number } }>("POST", "/v2/invoices", {
    idempotency_key: `${keyBase}-invoice`,
    invoice: {
      location_id: locationId,
      order_id: order.order.id,
      primary_recipient: { customer_id: customerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: dueDate,
          automatic_payment_source: "NONE",
          reminders: [
            { relative_scheduled_days: -3, message: "お支払い期日が近づいております。ご確認をお願いいたします。" },
            { relative_scheduled_days: 3, message: "お支払い期日を過ぎております。お手数ですがご確認をお願いいたします。" },
          ],
        },
      ],
      delivery_method: "EMAIL",
      accepted_payment_methods: { card: true },
      title: p.title,
      description: p.description,
    },
  });

  const published = await square<{
    invoice: { id: string; invoice_number?: string; public_url?: string; status?: string };
  }>("POST", `/v2/invoices/${created.invoice.id}/publish`, {
    version: created.invoice.version,
    idempotency_key: `${keyBase}-publish`,
  });

  const inv = published.invoice;
  const now = new Date().toISOString();
  const summary: InvoiceSummary = {
    id: inv.id,
    number: inv.invoice_number ?? null,
    url: inv.public_url ?? null,
    amount: Math.round(p.amount),
    dueDate,
    status: "UNPAID",
    sentAt: now,
  };
  const record: InvoiceRecord = {
    kind: p.kind,
    targetPath: p.targetPath,
    memberId: p.memberId,
    memberName: m.name ?? "",
    group: m.group ?? "",
    title: p.title,
    amount: summary.amount,
    dueDate,
    invoiceNumber: summary.number,
    publicUrl: summary.url,
    status: "UNPAID",
    createdAt: now,
  };
  await db().doc(`squareInvoices/${inv.id}`).set(record);
  return summary;
}

/** 未入金の請求書をSquare上でキャンセルする（すでに入金・キャンセル済みなら何もしない） */
export async function cancelSquareInvoice(invoiceId: string): Promise<boolean> {
  const got = await square<{ invoice: { version: number; status: string } }>("GET", `/v2/invoices/${invoiceId}`);
  if (!["UNPAID", "SCHEDULED", "PARTIALLY_PAID"].includes(got.invoice.status)) return false;
  await square("POST", `/v2/invoices/${invoiceId}/cancel`, { version: got.invoice.version });
  await db().doc(`squareInvoices/${invoiceId}`).set({ status: "CANCELED", canceledAt: new Date().toISOString() }, { merge: true });
  return true;
}

// ---- 許状代金 ----

export function licenseInvoiceParams(requestId: string, r: FirebaseFirestore.DocumentData, attempt = 0): IssueParams {
  return {
    kind: "license",
    targetPath: `licenseRequests/${requestId}`,
    memberId: r.memberId,
    title: `許状申請料（${r.licenseName}）`,
    description:
      `${r.memberName ?? ""}様\n` +
      `茶道宗徧流不審庵 本部稽古（${groupName(r.group)}）の許状申請料（御礼を含む）のご請求です。\n` +
      `お支払いはこのページからクレジットカードでお手続きいただけます。`,
    amount: Number(r.fee),
    attempt,
  };
}

// ---- 入会金 ----

export function entryFeeInvoiceParams(memberId: string, m: FirebaseFirestore.DocumentData, attempt = 0): IssueParams | null {
  const conf = m.group ? ENTRY_FEE_INVOICE[m.group] : undefined;
  if (!conf) return null;
  return {
    kind: "entryFee",
    targetPath: `members/${memberId}`,
    memberId,
    title: `入会金（${groupName(m.group)}）`,
    description:
      `${m.name ?? ""}様\n` +
      `このたびは茶道宗徧流不審庵 本部稽古（${groupName(m.group)}）にご入会いただき、ありがとうございます。\n` +
      `${conf.note}\nお支払いはこのページからクレジットカードでお手続きいただけます。`,
    amount: conf.amount,
    attempt,
  };
}

/**
 * 入会金の請求書を送り、結果を経理チャンネルに知らせる。
 * 入会金はふつうカード登録時・支払いページでお月謝と一緒にいただく（entryFee.ts）。
 * 入会から数日たっても払われていない会員にだけ、entryFee.ts の毎朝のチェックからこれを呼ぶ。
 */
export async function issueEntryFeeInvoice(memberId: string, m: FirebaseFirestore.DocumentData, why = ""): Promise<void> {
  const params = entryFeeInvoiceParams(memberId, m);
  if (!params) return;
  const mention = slackEntryFeeMentionUserId.value() || slackKeiriMentionUserId.value();
  const mentionPrefix = mention ? `<@${mention}> ` : "";
  const head =
    (why ? `（${why}）\n` : "") +
    `会員：${m.name ?? ""}様（${groupName(m.group)}）\n会員No：${memberId}\n入会金：¥${params.amount.toLocaleString("ja-JP")}`;

  if (!autoInvoiceEnabled()) {
    await postKeiri(`${mentionPrefix}入会金の請求書発行のご依頼です\n${head}`);
    return;
  }
  try {
    const inv = await issueSquareInvoice(params);
    await db().doc(`members/${memberId}`).update({ entryFeeInvoice: inv, entryFeeStatus: "未納" });
    await postKeiri(
      `📄 入会金の請求書をSquareから自動で送りました\n${head}\n` +
        `請求書番号：${inv.number ?? "-"}　お支払い期日：${inv.dueDate}\n` +
        `入金されると経理タブが自動で「入金済」になります。`
    );
  } catch (err) {
    const reason = describeInvoiceError(err);
    console.error("入会金の請求書の自動発行に失敗しました", memberId, err);
    await db().doc(`members/${memberId}`).update({ entryFeeInvoiceError: reason }).catch(() => undefined);
    await postKeiri(
      `${mentionPrefix}⚠️ 入会金の請求書を自動で送れませんでした（${reason}）\n${head}\n` +
        `お手数ですが、Squareで請求書を発行してください（メールアドレスを登録したあと、経理タブの「Squareで請求書を送る」からも送れます）。`
    );
  }
}

// ---- 入金（square.ts の squareWebhook から呼ぶ） ----

/** サブスクではない請求書（このファイルで発行したもの）の入金通知を処理する。対象外なら false */
export async function handleOneOffInvoicePaid(invoice: any): Promise<boolean> {
  if (!invoice?.id) return false;
  const ref = db().doc(`squareInvoices/${invoice.id}`);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (invoice.status && invoice.status !== "PAID") return true; // 一部入金などは完了まで待つ
  const rec = snap.data() as InvoiceRecord;
  if (rec.status === "PAID") return true;
  const now = new Date().toISOString();
  await ref.update({ status: "PAID", paidAt: now });

  const target = db().doc(rec.targetPath);
  if (rec.kind === "entryFee") {
    // カード登録時・支払いページですでに入会金をいただいていた（請求書の取り消しが間に合わなかった）場合
    const t = (await target.get()).data() ?? {};
    if (t.entryFeeStatus === "済" && t.entryFeePaid) {
      await target.update({ "entryFeeInvoice.status": "PAID", "entryFeeInvoice.paidAt": now });
      await postKeiri(
        `⚠️ 入会金を二重にいただいた可能性があります（${t.entryFeePaid.method ?? "カード"}でお支払い済みのあと、請求書でもお支払い）\n` +
          `${rec.memberName}様（${groupName(rec.group)}）${rec.title}　¥${rec.amount.toLocaleString("ja-JP")}　請求書番号：${rec.invoiceNumber ?? "-"}\n` +
          `Squareでどちらかを返金してください。`
      );
      return true;
    }
  }
  if (rec.kind === "license") {
    await target.update({ accountingPaymentStatus: "済", "squareInvoice.status": "PAID", "squareInvoice.paidAt": now });
  } else {
    await target.update({ entryFeeStatus: "済", "entryFeeInvoice.status": "PAID", "entryFeeInvoice.paidAt": now });
  }
  await postKeiri(
    `💴 Squareの請求書に入金がありました（経理タブは自動で「入金済」になりました）\n` +
      `${rec.memberName}様（${groupName(rec.group)}）${rec.title}　¥${rec.amount.toLocaleString("ja-JP")}\n` +
      `請求書番号：${rec.invoiceNumber ?? "-"}`
  );
  return true;
}

// ---- 期日超過のお知らせ（毎朝） ----

export const checkOverdueSquareInvoices = onSchedule(
  {
    schedule: "every day 09:10",
    timeZone: "Asia/Tokyo",
    secrets: [squareAccessToken, slackBotToken],
  },
  async () => {
    const today = todayJst();
    const snap = await db().collection("squareInvoices").where("status", "==", "UNPAID").get();
    const lines: string[] = [];
    for (const d of snap.docs) {
      const rec = d.data() as InvoiceRecord;
      if (rec.dueDate >= today || rec.overdueNotifiedAt) continue;

      // 経理が手動で「入金済」にしたもの（現金などでお支払い）は対象外
      const target = await db().doc(rec.targetPath).get();
      const t = target.data() ?? {};
      if ((rec.kind === "license" && t.accountingPaymentStatus === "済") || (rec.kind === "entryFee" && t.entryFeeStatus === "済")) {
        await d.ref.update({ status: "SETTLED_MANUALLY" });
        continue;
      }
      // Square上の最新の状態を確認（ダッシュボードでキャンセル・入金記録された場合など）
      try {
        const got = await square<{ invoice: { status: string } }>("GET", `/v2/invoices/${d.id}`);
        if (got.invoice.status === "PAID") {
          await handleOneOffInvoicePaid({ id: d.id, status: "PAID" });
          continue;
        }
        if (got.invoice.status === "CANCELED" || got.invoice.status === "REFUNDED") {
          await d.ref.update({ status: got.invoice.status });
          await db().doc(rec.targetPath).update({ [rec.kind === "license" ? "squareInvoice.status" : "entryFeeInvoice.status"]: "CANCELED" }).catch(() => undefined);
          continue;
        }
      } catch (err) {
        console.warn("請求書の状態確認に失敗しました", d.id, err);
      }
      lines.push(
        `・${rec.memberName}様（${groupName(rec.group)}）${rec.title}　¥${rec.amount.toLocaleString("ja-JP")}　期日 ${rec.dueDate}　請求書番号 ${rec.invoiceNumber ?? "-"}`
      );
      await d.ref.update({ overdueNotifiedAt: new Date().toISOString() });
    }
    if (lines.length === 0) return;
    const mention = slackKeiriMentionUserId.value();
    await postKeiri(
      `${mention ? `<@${mention}> ` : ""}⏰ お支払い期日を過ぎても未入金の請求書があります\n${lines.join("\n")}\n` +
        `Squareからご本人に督促メールが自動で届きます。必要に応じてご連絡ください。`
    );
  }
);

// ---- 経理タブから手動で送る・再送する（本部のみ） ----

export const sendSquareInvoiceManually = onCall<{ kind: InvoiceKind; id: string }>(
  { secrets: [squareAccessToken, slackBotToken] },
  async (request) => {
    if (request.auth?.token?.role !== "honbu") {
      throw new HttpsError("permission-denied", "本部アカウントでログインしてください。");
    }
    const { kind, id } = request.data ?? ({} as { kind: InvoiceKind; id: string });
    if ((kind !== "license" && kind !== "entryFee") || !id) throw new HttpsError("invalid-argument", "対象が指定されていません。");

    const path = kind === "license" ? `licenseRequests/${id}` : `members/${id}`;
    const ref = db().doc(path);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "対象が見つかりません。");
    const data = snap.data()!;
    const field = kind === "license" ? "squareInvoice" : "entryFeeInvoice";
    const existing = data[field] as InvoiceSummary | undefined;
    if (existing && existing.status !== "CANCELED") {
      throw new HttpsError("already-exists", "この請求書はすでに送信済みです。");
    }
    const attempt = Number(data.squareInvoiceAttempts ?? 0) + 1;
    const params = kind === "license" ? licenseInvoiceParams(id, data, attempt) : entryFeeInvoiceParams(id, data, attempt);
    if (!params) throw new HttpsError("failed-precondition", "この会は入会金の請求書の対象外です。");
    try {
      const inv = await issueSquareInvoice(params);
      await ref.update({
        [field]: inv,
        [kind === "license" ? "squareInvoiceError" : "entryFeeInvoiceError"]: admin.firestore.FieldValue.delete(),
        squareInvoiceAttempts: attempt,
      });
      return { number: inv.number, dueDate: inv.dueDate };
    } catch (err) {
      const reason = describeInvoiceError(err);
      await ref.update({ squareInvoiceAttempts: attempt }).catch(() => undefined);
      throw new HttpsError("failed-precondition", reason);
    }
  }
);

