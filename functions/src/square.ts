/**
 * Square決済（お月謝のカード自動払い＝サブスクリプション）
 *
 * 流れ：
 *  1. マイページ（/mypage/payment）で Square Web Payments SDK がカード情報を「トークン」に変換する
 *     （カード番号そのものはこのシステムを一切通らず、Squareのサーバーにだけ送られる）。
 *  2. startSquareSubscription がトークンを受け取り、Square上に
 *     顧客（Customer）→ カード（Card on file）→ サブスクリプション を作成する。
 *     お引き落としは毎月25日（初回は次の25日）。
 *  3. 会員がカードを変えたいときは updateSquareSubscriptionCard で新しいカードに差し替える。
 *  4. Squareからの通知（squareWebhook）で、毎月の入金・失敗・契約状態の変化を記録する。
 *
 * 記録先：memberSubscriptions/{会員番号}（Cloud Functionsのみ書き込み可。本部と本人が閲覧可）
 *
 * 設定（README_SQUARE_PAYMENT.md 参照）：
 *   シークレット：SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY
 *   パラメータ（functions/.env.<プロジェクトID>）：
 *     SQUARE_ENVIRONMENT（sandbox / production）, SQUARE_APPLICATION_ID, SQUARE_LOCATION_ID,
 *     SQUARE_WEBHOOK_URL, SQUARE_BILLING_FROM（この日以降に入会した会員に申込ボタンを表示）
 */
import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import * as crypto from "crypto";
import { refreshGroupSettings, isCardAutoPayGroup, isNoLegacyLinkGroup, monthlyFeeStd, hasTwicePlan } from "./groupSettings";

export const squareAccessToken = defineSecret("SQUARE_ACCESS_TOKEN");
const squareWebhookSignatureKey = defineSecret("SQUARE_WEBHOOK_SIGNATURE_KEY");
export const squareEnvironment = defineString("SQUARE_ENVIRONMENT", { default: "sandbox" });
const squareApplicationId = defineString("SQUARE_APPLICATION_ID");
export const squareLocationId = defineString("SQUARE_LOCATION_ID");
const squareWebhookUrl = defineString("SQUARE_WEBHOOK_URL", { default: "" });
const squareBillingFrom = defineString("SQUARE_BILLING_FROM", { default: "2026-11-01" });
// 決済リンク（従来のSquareサブスク）でお支払い中の会員が、この仕組みに切り替える最初の月（YYYY-MM）。
// 入会日が SQUARE_BILLING_FROM より前の会員は「切り替え会員」として扱い、参加開始月をこの月（過ぎていれば翌月）に固定する。
const squareMigrationMonth = defineString("SQUARE_MIGRATION_MONTH", { default: "2026-12" });
// 引き落とし失敗などの通知先（既存の本部稽古boチャンネル）
const slackBotTokenForSquare = defineSecret("SLACK_BOT_TOKEN");
// お支払い関係の通知は「請求書-経理」チャンネル（許状の請求書発行依頼と同じ SLACK_LICENSE_CHANNEL）に送る
const slackKeiriChannelForSquare = defineString("SLACK_LICENSE_CHANNEL");

const SQUARE_VERSION = "2025-01-23";
// 毎月のお引き落とし日
const BILLING_DAY = 25;
// カード自動払いの対象の会・標準のお月謝・決済リンク（従来のSquareサブスク）を使っていた会は、
// 管理画面の「会の設定」（Firestore groupSettings）から読む（groupSettings.ts）。
// 決済リンクを使っていない会（新月会・新しく発足した会）は、切り替え月（SQUARE_MIGRATION_MONTH）からの開始は同じだが、
// 同じメールアドレスの旧契約の検索・自動解約はしない（別の会の契約を誤って解約しないため）。
// 新月会：2026-10開始。10月分は別の仕組みで支払い済み、11月分（10/25）からカード自動払い（2026-10-09 ゆちゃ）

function db() {
  return admin.firestore();
}

function squareBase(): string {
  return squareEnvironment.value() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

export class SquareApiError extends Error {
  constructor(public status: number, public errors: { code?: string; detail?: string; category?: string }[]) {
    super(errors.map((e) => `${e.code}: ${e.detail}`).join(" / ") || `HTTP ${status}`);
  }
}

export async function square<T = any>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${squareBase()}${path}`, {
    method,
    headers: {
      "Square-Version": SQUARE_VERSION,
      Authorization: `Bearer ${squareAccessToken.value()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.errors) {
    throw new SquareApiError(res.status, data.errors ?? []);
  }
  return data as T;
}

// カード決済まわりのエラーを会員向けのメッセージに変換する
function friendlyCardError(err: unknown): string {
  if (err instanceof SquareApiError) {
    const codes = err.errors.map((e) => e.code);
    if (codes.includes("CARD_DECLINED") || codes.includes("GENERIC_DECLINE"))
      return "カード会社により承認されませんでした。別のカードをお試しいただくか、カード会社にお問い合わせください。";
    if (codes.includes("CVV_FAILURE") || codes.includes("INVALID_CARD"))
      return "カード情報（セキュリティコード等）をご確認のうえ、もう一度お試しください。";
    if (codes.includes("INVALID_EXPIRATION") || codes.includes("CARD_EXPIRED"))
      return "カードの有効期限をご確認ください。";
    if (codes.includes("ADDRESS_VERIFICATION_FAILURE") || codes.includes("INVALID_POSTAL_CODE"))
      return "郵便番号などのご請求先情報をご確認ください。";
    if (codes.includes("CARD_NOT_SUPPORTED"))
      return "このカードはご利用いただけません。別のカードをお試しください。";
  }
  return "カードの登録に失敗しました。時間をおいて再度お試しいただくか、本部までご連絡ください。";
}

// ---- 日付（日本時間） ----
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
export function ymd(y: number, m: number, d: number): string {
  // m は 1〜12（範囲外は繰り上げ・繰り下げ）
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}
export interface MemberDoc {
  name?: string;
  email?: string;
  phone?: string;
  group?: string;
  status?: string;
  joinDate?: string;
  paymentMethod?: string;
  monthlyFee?: number | null;
  chadoMonthlyQuota?: number;
  chadoCohortId?: string;
  squareBillingAllowed?: boolean;
  // 休会・退会でカード自動払いを解約した会員（復会後は決済リンクからの切り替え扱いにしない）
  squareRejoin?: boolean;
}

/** お月謝の金額と表示名 */
async function monthlyFeeFor(m: MemberDoc): Promise<{ amount: number | null; label: string; cohortStartDate?: string }> {
  await refreshGroupSettings();
  let cohortStartDate: string | undefined;
  let cohortFee: number | undefined;
  if (m.group === "茶道教室" && m.chadoCohortId) {
    const c = await db().doc(`chadoRecruitClasses/${m.chadoCohortId}`).get();
    if (c.exists) {
      const cd = c.data() as { monthlyFee?: number; startDate?: string };
      if (typeof cd.monthlyFee === "number" && cd.monthlyFee > 0) cohortFee = cd.monthlyFee;
      cohortStartDate = cd.startDate;
    }
  }
  if (typeof m.monthlyFee === "number" && m.monthlyFee > 0) {
    return { amount: m.monthlyFee, label: "お月謝（個別設定）", cohortStartDate };
  }
  if (m.group === "茶道教室" && cohortFee) return { amount: cohortFee, label: "お月謝", cohortStartDate };
  if (hasTwicePlan(m.group)) {
    const twice = m.chadoMonthlyQuota === 2;
    return {
      amount: monthlyFeeStd(m.group, twice),
      label: twice ? "お月謝（月2回プラン）" : "お月謝（月1回プラン）",
      cohortStartDate,
    };
  }
  return { amount: monthlyFeeStd(m.group), label: "お月謝", cohortStartDate };
}

// ---- 前払いのお引き落としスケジュール ----
// お月謝は前払い：毎月25日に「翌月分」をお引き落とし。
// 参加開始月の分は、その前月25日に引き落とす。前月25日がすでに過ぎている（＝今月から参加など）場合は、
// お申込み時にすぐ引き落とす。
//   例）10/9に申込み・10月から参加 → 10/9に10月分、10/25に11月分、以降毎月25日に翌月分
//       10/9に申込み・11月から参加 → 10/25に11月分（申込み時の引き落としなし）
//       10/27に申込み・10月から参加 → 10/27に10月分（単発決済）＋11月分（サブスク初回）、11/25に12月分
//       10/27に申込み・11月から参加 → 10/27に11月分、11/25に12月分

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  return ymd(y, m + n, 1).slice(0, 7);
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月分`;
}

export interface BillingSchedule {
  startMonth: string; // 参加開始月 YYYY-MM
  subscriptionStartDate: string; // Squareのサブスク開始日（この日に1回目が引き落とされる）
  oneTimeMonth: string | null; // サブスクとは別に、申込み時に単発で引き落とす月（25日以降に今月から参加の場合のみ）
  nowItems: string[]; // 申込み時に引き落とす月（表示用、例：["2026年10月分"]）
  nowCount: number; // 申込み時に引き落とす月数
  nextDate: string; // 次の定期お引き落とし日
  nextMonth: string; // 次の定期お引き落としの対象月（表示用）
}

function buildSchedule(startMonthInput: string): BillingSchedule {
  const today = todayJst();
  const cur = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const startMonth = startMonthInput < cur ? cur : startMonthInput;
  const [sy, sm] = startMonth.split("-").map(Number);
  const billDate = ymd(sy, sm - 1, BILLING_DAY); // 参加開始月の前月25日

  if (billDate > today) {
    // まだ前月25日が来ていない → その日に初回（申込み時の引き落としなし）
    return {
      startMonth,
      subscriptionStartDate: billDate,
      oneTimeMonth: null,
      nowItems: [],
      nowCount: 0,
      nextDate: billDate,
      nextMonth: monthLabel(startMonth),
    };
  }
  if (startMonth === cur && day >= BILLING_DAY) {
    // 25日以降に今月から参加：今月分（単発）＋翌月分（サブスク初回）を申込み時に
    const next = addMonths(cur, 1);
    const [ny, nm] = next.split("-").map(Number);
    return {
      startMonth,
      subscriptionStartDate: today,
      oneTimeMonth: cur,
      nowItems: [monthLabel(cur), monthLabel(next)],
      nowCount: 2,
      nextDate: ymd(ny, nm, BILLING_DAY),
      nextMonth: monthLabel(addMonths(cur, 2)),
    };
  }
  // 前月25日を過ぎている → 申込み時に参加開始月の分を引き落とし、次は今月（または翌月）の25日
  const nextDate = nextBillingDateAfter(today);
  return {
    startMonth,
    subscriptionStartDate: today,
    oneTimeMonth: null,
    nowItems: [monthLabel(startMonth)],
    nowCount: 1,
    nextDate,
    nextMonth: monthLabel(addMonths(startMonth, 1)),
  };
}

/** 指定日より後で最初の25日 */
function nextBillingDateAfter(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return d < BILLING_DAY ? ymd(y, m, BILLING_DAY) : ymd(y, m + 1, BILLING_DAY);
}

/** 決済リンク（従来の方式）から切り替える会員か：入会日が SQUARE_BILLING_FROM より前で、新規募集クラスの会員ではない */
function isMigrationMember(m: MemberDoc): boolean {
  return !m.chadoCohortId && !m.squareRejoin && (m.joinDate ?? "") < squareBillingFrom.value();
}

/** 切り替え会員のうち、決済リンクの旧契約がある（＝旧契約の検索・自動解約の対象になる）会員か */
function hasLegacyLink(m: MemberDoc): boolean {
  return isMigrationMember(m) && !isNoLegacyLinkGroup(m.group);
}

/** 選べる参加開始月。新規募集クラスは開講月、切り替え会員は切り替え月（過ぎていれば翌月）に固定、それ以外は今月・来月から選ぶ */
function startMonthOptions(cohortStartDate: string | undefined, migration: boolean): string[] {
  const cur = todayJst().slice(0, 7);
  if (cohortStartDate && /^\d{4}-\d{2}-\d{2}$/.test(cohortStartDate)) {
    const cm = cohortStartDate.slice(0, 7);
    return [cm < cur ? cur : cm];
  }
  if (migration) {
    // 今月分は決済リンクで支払い済みのため、早くても翌月分から
    const next = addMonths(cur, 1);
    const mm = squareMigrationMonth.value();
    return [mm > next ? mm : next];
  }
  return [cur, addMonths(cur, 1)];
}

/** 申込ボタンを出してよい会員か。出せない場合は理由を返す */
function eligibility(m: MemberDoc): { ok: boolean; reason?: string } {
  if (!m.group || !isCardAutoPayGroup(m.group)) return { ok: false, reason: "対象外の会" };
  if (m.status !== "在籍") return { ok: false, reason: "在籍中の会員のみ" };
  if (m.paymentMethod === "都度払い") return { ok: false, reason: "都度払いの会員" };
  // 個別のお月謝が0円＝お月謝なしの会員（カード登録不要）
  if (m.monthlyFee === 0) return { ok: false, reason: "お月謝なし" };
  if (m.squareBillingAllowed === false) return { ok: false, reason: "本部の設定で対象外" };
  if (m.squareBillingAllowed === true) return { ok: true };
  // テスト環境（sandbox）の間は、管理画面で「マイページに表示する」にした会員（テスト用）だけに表示する
  if (squareEnvironment.value() !== "production") return { ok: false, reason: "テスト中" };
  // 本番：新しく入会した会員はそのまま、決済リンクでお支払い中の会員（切り替え会員）は
  // 切り替え月の前月1日から表示する（例：12月分から切り替え → 11/1から表示）
  if (!isMigrationMember(m)) return { ok: true };
  const openFrom = addMonths(squareMigrationMonth.value(), -1);
  if (todayJst().slice(0, 7) >= openFrom) return { ok: true };
  return { ok: false, reason: "切り替え前" };
}

function requireMember(request: { auth?: { token?: Record<string, unknown> } }): string {
  const memberId = request.auth?.token?.memberId as string | undefined;
  if (request.auth?.token?.role !== "member" || !memberId) {
    throw new HttpsError("permission-denied", "会員としてログインしてください。");
  }
  return memberId;
}

interface SubscriptionRecord {
  memberId: string;
  memberName: string;
  group: string;
  environment: string;
  status: string; // CREATING / PENDING / ACTIVE / PAUSED / CANCELED / DEACTIVATED
  amount: number;
  label: string;
  startDate: string;
  squareCustomerId: string;
  squareCardId: string;
  squareSubscriptionId: string;
  planVariationId: string;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
  lastPaymentAt?: string;
  lastPaymentAmount?: number;
  lastFailureAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

const ACTIVE_STATUSES = ["CREATING", "PENDING", "ACTIVE", "PAUSED"];

// ---- Square上のオブジェクトの作成・取得 ----

export async function ensureCustomer(memberId: string, m: MemberDoc, existingId?: string): Promise<string> {
  if (existingId) return existingId;
  // 同じ会員番号の顧客がすでにSquareにいれば再利用する
  const found = await square<{ customers?: { id: string }[] }>("POST", "/v2/customers/search", {
    query: { filter: { reference_id: { exact: memberId } } },
    limit: 1,
  });
  if (found.customers?.[0]) return found.customers[0].id;
  const created = await square<{ customer: { id: string } }>("POST", "/v2/customers", {
    idempotency_key: crypto.randomUUID(),
    family_name: m.name ?? memberId,
    email_address: m.email || undefined,
    reference_id: memberId,
    note: `会員番号 ${memberId}（${m.group ?? ""}）`,
  });
  return created.customer.id;
}

interface SquareCard {
  id: string;
  card_brand?: string;
  last_4?: string;
  exp_month?: number;
  exp_year?: number;
}

async function createCard(token: string, customerId: string, memberId: string, name?: string): Promise<SquareCard> {
  const res = await square<{ card: SquareCard }>("POST", "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: token,
    card: {
      customer_id: customerId,
      cardholder_name: name || undefined,
      reference_id: memberId,
    },
  });
  return res.card;
}

async function ensurePlanVariation(amount: number): Promise<string> {
  const env = squareEnvironment.value();
  const cacheRef = db().doc(`squareCatalog/${env}_monthly_${amount}`);
  const cached = await cacheRef.get();
  if (cached.exists && cached.data()?.planVariationId) return cached.data()!.planVariationId as string;

  // お月謝のサブスクリプションプラン（1つ）を用意
  const planRef = db().doc(`squareCatalog/${env}_plan`);
  const planSnap = await planRef.get();
  let planId = planSnap.exists ? (planSnap.data()?.planId as string | undefined) : undefined;
  if (!planId) {
    const plan = await square<{ catalog_object: { id: string } }>("POST", "/v2/catalog/object", {
      idempotency_key: crypto.randomUUID(),
      object: {
        type: "SUBSCRIPTION_PLAN",
        id: "#okeiko_monthly_plan",
        subscription_plan_data: { name: "お月謝（毎月25日 自動払い）", all_items: false },
      },
    });
    planId = plan.catalog_object.id;
    await planRef.set({ planId, createdAt: new Date().toISOString() });
  }

  // 金額ごとのプランバリエーション（毎月・25日締め・日割りなし）
  const variation = await square<{ catalog_object: { id: string } }>("POST", "/v2/catalog/object", {
    idempotency_key: crypto.randomUUID(),
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      id: `#okeiko_monthly_${amount}`,
      subscription_plan_variation_data: {
        name: `お月謝 月額¥${amount.toLocaleString("ja-JP")}`,
        subscription_plan_id: planId,
        monthly_billing_anchor_date: BILLING_DAY,
        can_prorate: false,
        phases: [
          {
            cadence: "MONTHLY",
            ordinal: 0,
            pricing: { type: "STATIC", price: { amount, currency: "JPY" } },
          },
        ],
      },
    },
  });
  const planVariationId = variation.catalog_object.id;
  await cacheRef.set({ planVariationId, amount, createdAt: new Date().toISOString() });
  return planVariationId;
}

async function notifySlack(text: string, thread?: { channel?: string; ts?: string }) {
  // テスト環境（sandbox）の間はSlackに通知しない
  if (squareEnvironment.value() !== "production") {
    console.log("（テスト環境のためSlack通知を省略）", text);
    return;
  }
  try {
    const token = slackBotTokenForSquare.value();
    const channel = slackKeiriChannelForSquare.value();
    if (!token || !channel) return;
    // スレッド返信は、元のメッセージが同じ「請求書-経理」チャンネルにある場合のみ。
    // 本部稽古boの申請スレッドなどへの返信は、請求書-経理に単独のメッセージとして送る。
    const inThread = thread?.ts && (!thread.channel || thread.channel === channel);
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(inThread ? { channel, thread_ts: thread!.ts, text } : { channel, text }),
    });
  } catch (err) {
    console.error("Slack通知に失敗しました", err);
  }
}

// ---- マイページから呼ぶ関数 ----

/**
 * マイページの決済画面を表示するための情報（Squareの公開設定・金額・初回引き落とし日・現在の契約）。
 */
export const getSquareBillingInfo = onCall(async (request) => {
  await refreshGroupSettings(); // 会の設定（料金など）を最新にする
  const memberId = requireMember(request);
  const snap = await db().doc(`members/${memberId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "会員情報が見つかりません。");
  const m = snap.data() as MemberDoc;
  const fee = await monthlyFeeFor(m);
  const subSnap = await db().doc(`memberSubscriptions/${memberId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubscriptionRecord) : null;
  const elig = eligibility(m);
  // 入会金がまだなら、カード登録時にお月謝と一緒に引き落とす（entryFee.ts）
  const { pendingEntryFee } = await import("./entryFee");
  const entry = sub && ACTIVE_STATUSES.includes(sub.status) && !(sub as LeaveRecord).cancelRequestedAt ? null : pendingEntryFee(snap.data());
  return {
    entryFee: entry ? { amount: entry.amount, label: entry.title } : null,
    square: {
      applicationId: squareApplicationId.value(),
      locationId: squareLocationId.value(),
      environment: squareEnvironment.value(),
    },
    eligible: elig.ok && fee.amount !== null,
    reason: fee.amount === null ? "お月謝が未設定" : elig.reason ?? null,
    amount: fee.amount,
    label: fee.label,
    schedules: startMonthOptions(fee.cohortStartDate, isMigrationMember(m)).map(buildSchedule),
    migration: isMigrationMember(m),
    legacyLink: hasLegacyLink(m),
    billingDay: BILLING_DAY,
    memberName: m.name ?? "",
    email: m.email ?? "",
    subscription: sub && sub.status !== "CREATING"
      ? {
          status: sub.status,
          amount: sub.amount,
          label: sub.label,
          startDate: sub.startDate,
          cardBrand: sub.cardBrand ?? null,
          cardLast4: sub.cardLast4 ?? null,
          cardExpMonth: sub.cardExpMonth ?? null,
          cardExpYear: sub.cardExpYear ?? null,
          lastPaymentAt: sub.lastPaymentAt ?? null,
          lastFailureAt: sub.lastFailureAt ?? null,
          nextBillingDate: sub.startDate > todayJst() ? sub.startDate : nextBillingDateAfter(todayJst()),
        }
      : null,
  };
});

/**
 * カード自動払い（サブスクリプション）の申込み。token は Web Payments SDK の card.tokenize() の結果。
 */
export const startSquareSubscription = onCall<{ token: string; startMonth?: string }>(
  { secrets: [squareAccessToken, slackBotTokenForSquare] },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const memberId = requireMember(request);
    const token = request.data?.token;
    if (typeof token !== "string" || token.length < 10) {
      throw new HttpsError("invalid-argument", "カード情報を読み取れませんでした。もう一度ご入力ください。");
    }

    const memberRef = db().doc(`members/${memberId}`);
    const subRef = db().doc(`memberSubscriptions/${memberId}`);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists) throw new HttpsError("not-found", "会員情報が見つかりません。");
    const m = memberSnap.data() as MemberDoc;

    const elig = eligibility(m);
    if (!elig.ok) throw new HttpsError("failed-precondition", "カード自動払いのお申込み対象ではありません。本部までご連絡ください。");
    if (!m.email) throw new HttpsError("failed-precondition", "メールアドレスが未登録です。先に連絡先情報からご登録ください。");
    const fee = await monthlyFeeFor(m);
    if (!fee.amount) throw new HttpsError("failed-precondition", "お月謝が設定されていません。本部までご連絡ください。");

    // 二重申込みの防止（申込み処理中・契約中なら止める）
    const previous = await db().runTransaction(async (tx) => {
      const s = await tx.get(subRef);
      const data = s.exists ? (s.data() as SubscriptionRecord) : null;
      // 休会・退会で解約予約済みの契約は、復会後に申し込み直せるようにする
      if (data && ACTIVE_STATUSES.includes(data.status) && !(data as LeaveRecord).cancelRequestedAt) {
        const stale = data.status === "CREATING" && data.updatedAt && Date.now() - Date.parse(data.updatedAt) > 5 * 60 * 1000;
        if (!stale) throw new HttpsError("already-exists", "すでにお申込み済みです。");
      }
      tx.set(subRef, { status: "CREATING", memberId, updatedAt: new Date().toISOString() }, { merge: true });
      return data;
    });

    // 入会金（カード登録時にお月謝と一緒にいただく）。途中で失敗したら返金する
    const entryFeeLib = await import("./entryFee");
    let entryFee: { amount: number; title: string } | null = null;
    let entryFeePaymentId: string | null = null;
    try {
      const customerId = await ensureCustomer(memberId, m, previous?.squareCustomerId);
      let card: SquareCard;
      try {
        card = await createCard(token, customerId, memberId, m.name);
      } catch (err) {
        console.error("カード登録エラー", memberId, err);
        throw new HttpsError("invalid-argument", friendlyCardError(err));
      }
      const planVariationId = await ensurePlanVariation(fee.amount);
      const migration = isMigrationMember(m);
      const options = startMonthOptions(fee.cohortStartDate, migration);
      const requested = typeof request.data?.startMonth === "string" ? request.data.startMonth : options[0];
      const schedule = buildSchedule(options.includes(requested) ? requested : options[0]);
      const startDate = schedule.subscriptionStartDate;

      // 入会金がまだなら、このカードで先に引き落とす（失敗したらここで中止）
      entryFee = await entryFeeLib.resolvePendingEntryFee(memberId, memberSnap.data()!);
      if (entryFee) {
        try {
          const pay = await square<{ payment: { id: string; status: string } }>("POST", "/v2/payments", {
            idempotency_key: crypto.randomUUID(),
            source_id: card.id,
            customer_id: customerId,
            location_id: squareLocationId.value(),
            amount_money: { amount: entryFee.amount, currency: "JPY" },
            autocomplete: true,
            reference_id: memberId,
            note: `${entryFee.title}（会員番号 ${memberId}）`,
          });
          entryFeePaymentId = pay.payment.id;
        } catch (err) {
          console.error("入会金の決済エラー", memberId, err);
          await square("POST", `/v2/cards/${card.id}/disable`).catch(() => undefined);
          throw new HttpsError("invalid-argument", friendlyCardError(err));
        }
      }

      // 25日以降に今月から参加する場合：今月分を単発で先に決済（失敗したらここで中止）
      let oneTimePaymentId: string | null = null;
      if (schedule.oneTimeMonth) {
        try {
          const pay = await square<{ payment: { id: string; status: string } }>("POST", "/v2/payments", {
            idempotency_key: crypto.randomUUID(),
            source_id: card.id,
            customer_id: customerId,
            location_id: squareLocationId.value(),
            amount_money: { amount: fee.amount, currency: "JPY" },
            autocomplete: true,
            reference_id: memberId,
            note: `お月謝 ${monthLabel(schedule.oneTimeMonth)}（会員番号 ${memberId}）`,
          });
          oneTimePaymentId = pay.payment.id;
        } catch (err) {
          console.error("今月分の決済エラー", memberId, err);
          await square("POST", `/v2/cards/${card.id}/disable`).catch(() => undefined);
          throw new HttpsError("invalid-argument", friendlyCardError(err));
        }
      }
      const created = await square<{ subscription: { id: string; status: string } }>("POST", "/v2/subscriptions", {
        idempotency_key: crypto.randomUUID(),
        location_id: squareLocationId.value(),
        plan_variation_id: planVariationId,
        customer_id: customerId,
        card_id: card.id,
        start_date: startDate,
        timezone: "Asia/Tokyo",
        source: { name: "お稽古管理システム" },
      });

      const now = new Date().toISOString();
      const record: SubscriptionRecord = {
        memberId,
        memberName: m.name ?? "",
        group: m.group ?? "",
        environment: squareEnvironment.value(),
        status: created.subscription.status ?? "PENDING",
        amount: fee.amount,
        label: fee.label,
        startDate,
        squareCustomerId: customerId,
        squareCardId: card.id,
        squareSubscriptionId: created.subscription.id,
        planVariationId,
        cardBrand: card.card_brand,
        cardLast4: card.last_4,
        cardExpMonth: card.exp_month,
        cardExpYear: card.exp_year,
        createdAt: now,
        updatedAt: now,
      };
      // 決済リンクからの切り替え会員は、同じメールアドレスの旧契約を探して自動解約を予約する
      let legacyIds: string[] = [];
      const legacyLink = hasLegacyLink(m);
      if (legacyLink && m.email) {
        try {
          const ours = (await db().collection("memberSubscriptions").get()).docs
            .map((d) => (d.data() as SubscriptionRecord).squareSubscriptionId)
            .filter(Boolean);
          const found = await findLegacySquare(m.email, [...ours, created.subscription.id]);
          legacyIds = found.subscriptions.map((x) => x.id);
        } catch (e) {
          console.warn("旧契約の検索に失敗", memberId, e);
        }
      }
      await subRef.set({
        ...record,
        startMonth: schedule.startMonth,
        migratedFromLink: legacyLink,
        ...(legacyLink
          ? {
              legacySubscriptionIds: legacyIds,
              legacyCancelAfter: lastDayOfMonth(addMonths(schedule.startMonth, -1)),
              legacyCanceledIds: [],
              legacyCancelStatus: legacyIds.length ? "pending" : "done",
            }
          : {}),
      });
      const legacyState = legacyLink && legacyIds.length ? await processLegacyCancellation(memberId) : null;
      if (oneTimePaymentId) {
        await subRef.collection("payments").add({
          kind: "入金",
          amount: fee.amount,
          note: `${monthLabel(schedule.oneTimeMonth!)}（お申込み時の単発決済）`,
          squarePaymentId: oneTimePaymentId,
          receivedAt: now,
        });
      }
      await memberRef.update({ nextBillingDate: schedule.nextDate });
      if (entryFee && entryFeePaymentId) {
        await subRef.collection("payments").add({
          kind: "入金",
          amount: entryFee.amount,
          note: `${entryFee.title}（お申込み時）`,
          squarePaymentId: entryFeePaymentId,
          receivedAt: now,
        });
        const paidId = entryFeePaymentId;
        entryFeePaymentId = null; // ここから先で失敗しても返金しない（入会金はいただいた）
        await entryFeeLib
          .markEntryFeePaid(memberId, { amount: entryFee.amount, method: "カード登録時", squarePaymentId: paidId })
          .catch((e) => console.error("入会金の記録に失敗しました", memberId, e));
      }
      await notifySlack(
        `💳 カード自動払いのお申込みがありました\n${m.name ?? ""}様（${memberId}・${m.group ?? ""}）\n` +
          `月額¥${fee.amount.toLocaleString("ja-JP")}　参加開始：${monthLabel(schedule.startMonth).replace("分", "")}\n` +
          (schedule.nowCount ? `お申込み時に引き落とし：${schedule.nowItems.join("・")}\n` : "") +
          (entryFee ? `入会金：¥${entryFee.amount.toLocaleString("ja-JP")}（お申込み時に引き落とし済み）\n` : "") +
          `次回：${schedule.nextDate}（${schedule.nextMonth}）` +
          (legacyLink
            ? legacyState
              ? `\n決済リンクの旧契約：${legacyState}（${monthLabel(addMonths(schedule.startMonth, -1))}の引き落とし後に自動で解約します）`
              : `\n⚠️ 決済リンクからの切り替えですが、同じメールアドレスの旧契約が見つかりませんでした。` +
                `Squareのダッシュボードで確認し、残っていれば解約して、管理画面の会員詳細で「旧契約（決済リンク）を解約済み」にチェックしてください。`
            : "") +
          (squareEnvironment.value() === "production" ? "" : "\n（テスト環境）")
      );
      return {
        ok: true,
        schedule,
        amount: fee.amount,
        entryFee: entryFee ? { amount: entryFee.amount, label: entryFee.title } : null,
        cardBrand: card.card_brand ?? null,
        cardLast4: card.last_4 ?? null,
      };
    } catch (err) {
      // 入会金だけ引き落としてその後で失敗した場合は返金する
      if (entryFee && entryFeePaymentId) {
        await entryFeeLib.refundEntryFeePayment(memberId, entryFeePaymentId, entryFee.amount);
      }
      // 失敗時は申込み中の印を戻す（以前の記録があればそれに戻す）
      if (previous) await subRef.set(previous);
      else await subRef.delete();
      if (err instanceof HttpsError) throw err;
      console.error("サブスク申込みエラー", memberId, err);
      throw new HttpsError("internal", "お申込みの処理に失敗しました。時間をおいて再度お試しいただくか、本部までご連絡ください。");
    }
  }
);

/**
 * お支払いカードの変更。新しいカードを登録してサブスクリプションに設定し、古いカードは無効にする。
 */
export const updateSquareSubscriptionCard = onCall<{ token: string }>(
  { secrets: [squareAccessToken] },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const memberId = requireMember(request);
    const token = request.data?.token;
    if (typeof token !== "string" || token.length < 10) {
      throw new HttpsError("invalid-argument", "カード情報を読み取れませんでした。もう一度ご入力ください。");
    }
    const subRef = db().doc(`memberSubscriptions/${memberId}`);
    const subSnap = await subRef.get();
    const sub = subSnap.exists ? (subSnap.data() as SubscriptionRecord) : null;
    if (!sub || !sub.squareSubscriptionId || !["PENDING", "ACTIVE", "PAUSED"].includes(sub.status)) {
      throw new HttpsError("failed-precondition", "変更できるカード自動払いのご契約がありません。");
    }
    const m = ((await db().doc(`members/${memberId}`).get()).data() ?? {}) as MemberDoc;

    let card: SquareCard;
    try {
      card = await createCard(token, sub.squareCustomerId, memberId, m.name);
    } catch (err) {
      console.error("カード変更：カード登録エラー", memberId, err);
      throw new HttpsError("invalid-argument", friendlyCardError(err));
    }
    try {
      await square("PUT", `/v2/subscriptions/${sub.squareSubscriptionId}`, {
        subscription: { card_id: card.id },
      });
    } catch (err) {
      console.error("カード変更：サブスク更新エラー", memberId, err);
      // 新しいカードは使わないので無効化しておく
      await square("POST", `/v2/cards/${card.id}/disable`).catch(() => undefined);
      throw new HttpsError("internal", "カードの変更に失敗しました。時間をおいて再度お試しいただくか、本部までご連絡ください。");
    }
    // 古いカードを無効化（失敗しても契約には影響しない）
    if (sub.squareCardId && sub.squareCardId !== card.id) {
      await square("POST", `/v2/cards/${sub.squareCardId}/disable`).catch((e) =>
        console.warn("古いカードの無効化に失敗", memberId, e)
      );
    }
    await subRef.update({
      squareCardId: card.id,
      cardBrand: card.card_brand ?? null,
      cardLast4: card.last_4 ?? null,
      cardExpMonth: card.exp_month ?? null,
      cardExpYear: card.exp_year ?? null,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, cardBrand: card.card_brand ?? null, cardLast4: card.last_4 ?? null };
  }
);

// ---- Squareからの通知（Webhook） ----

function isValidSquareSignature(rawBody: string, signature: string | undefined, requestUrls: string[]): boolean {
  const key = squareWebhookSignatureKey.value().trim();
  if (!key || !signature) return false;
  // Squareは「登録したURL＋本文」で署名する。登録URLの末尾スラッシュの有無や、
  // cloudfunctions.net／run.app のどちらのURLで登録したかの違いでずれないよう、候補をすべて試す。
  const configured = squareWebhookUrl.value().trim();
  const bases = [configured, ...requestUrls].filter(Boolean);
  const candidates = new Set<string>();
  for (const u of bases) {
    candidates.add(u);
    candidates.add(u.endsWith("/") ? u.slice(0, -1) : u + "/");
  }
  const b = Buffer.from(signature);
  for (const url of candidates) {
    const expected = Buffer.from(crypto.createHmac("sha256", key).update(url + rawBody).digest("base64"));
    if (expected.length === b.length && crypto.timingSafeEqual(expected, b)) return true;
  }
  console.warn("Square Webhook：署名が一致しません", { tried: [...candidates], keyLength: key.length, bodyLength: rawBody.length });
  return false;
}

async function findSubscriptionDoc(subscriptionId: string | undefined) {
  if (!subscriptionId) return null;
  const q = await db().collection("memberSubscriptions").where("squareSubscriptionId", "==", subscriptionId).limit(1).get();
  return q.empty ? null : q.docs[0];
}

/**
 * Square Webhook 受信。Square開発者ダッシュボードの Webhooks で、このURLと次のイベントを登録する：
 *   invoice.payment_made / invoice.scheduled_charge_failed / subscription.created / subscription.updated / payment.updated
 */
export const squareWebhook = onRequest(
  // Squareのサーバーから呼ばれるため、誰でも呼び出せる（公開）設定にする。本物かどうかは署名で確認する
  { secrets: [squareWebhookSignatureKey, slackBotTokenForSquare, squareAccessToken], invoker: "public" },
  async (req, res) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    if (req.method !== "POST") {
      res.status(405).send("method not allowed");
      return;
    }
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
    const host = req.header("x-forwarded-host") || req.header("host") || "";
    const path = req.originalUrl || "/";
    const requestUrls = host
      ? [`https://${host}${path === "/" ? "" : path}`, `https://${host}${path}`]
      : [];
    if (!isValidSquareSignature(raw, req.header("x-square-hmacsha256-signature"), requestUrls)) {
      console.warn("Square Webhook：署名が一致しません");
      res.status(403).send("invalid signature");
      return;
    }
    const event = req.body as { event_id?: string; type?: string; data?: { object?: any } };
    const type = event?.type ?? "";
    const obj = event?.data?.object ?? {};

    try {
      // 同じ通知が再送されても二重に処理しない
      if (event.event_id) {
        const seenRef = db().doc(`squareWebhookEvents/${event.event_id}`);
        const fresh = await db().runTransaction(async (tx) => {
          const s = await tx.get(seenRef);
          if (s.exists) return false;
          tx.set(seenRef, { type, receivedAt: new Date().toISOString() });
          return true;
        });
        if (!fresh) {
          res.status(200).send("duplicate");
          return;
        }
      }

      if (type === "invoice.payment_made" && !obj.invoice?.subscription_id) {
        // 許状代金・入会金の請求書（squareInvoice.ts で発行したもの）。循環importを避けるため遅延読み込み
        const { handleOneOffInvoicePaid } = await import("./squareInvoice");
        await handleOneOffInvoicePaid(obj.invoice);
      } else if (type === "invoice.payment_made") {
        const invoice = obj.invoice ?? {};
        const doc = await findSubscriptionDoc(invoice.subscription_id);
        const amount =
          invoice.payment_requests?.[0]?.total_completed_amount_money?.amount ??
          invoice.payment_requests?.[0]?.computed_amount_money?.amount ??
          null;
        const now = new Date().toISOString();
        if (doc) {
          await doc.ref.update({ lastPaymentAt: now, lastPaymentAmount: amount, status: "ACTIVE", updatedAt: now });
          await doc.ref.collection("payments").add({
            kind: "入金",
            amount,
            invoiceId: invoice.id ?? null,
            invoiceNumber: invoice.invoice_number ?? null,
            receivedAt: now,
          });
          await db().doc(`members/${doc.id}`).update({ paymentStatus: "済" }).catch(() => undefined);
        }
      } else if (type === "invoice.scheduled_charge_failed") {
        const invoice = obj.invoice ?? {};
        const doc = await findSubscriptionDoc(invoice.subscription_id);
        const now = new Date().toISOString();
        if (doc) {
          const s = doc.data() as SubscriptionRecord;
          await doc.ref.update({ lastFailureAt: now, updatedAt: now });
          await doc.ref.collection("payments").add({ kind: "引き落とし失敗", invoiceId: invoice.id ?? null, receivedAt: now });
          await db().doc(`members/${doc.id}`).update({ paymentStatus: "未納" }).catch(() => undefined);
          await notifySlack(
            `⚠️ お月謝のカード引き落としに失敗しました\n${s.memberName}様（${doc.id}・${s.group}）月額¥${(s.amount ?? 0).toLocaleString("ja-JP")}\n` +
              "Squareからご本人に請求書メールが届きます。マイページの「お支払いカードの変更」からカードを変更いただくようご案内ください。"
          );
        }
      } else if (type === "subscription.created" || type === "subscription.updated") {
        const s = obj.subscription ?? {};
        const doc = await findSubscriptionDoc(s.id);
        if (doc && s.status) {
          await doc.ref.update({ status: s.status, updatedAt: new Date().toISOString() });
          if (s.status === "DEACTIVATED" || s.status === "CANCELED") {
            const d = doc.data() as SubscriptionRecord;
            await notifySlack(`ℹ️ カード自動払いが停止（${s.status}）になりました：${d.memberName}様（${doc.id}・${d.group}）`);
          }
        }
      } else if (type === "payment.updated" && obj.payment?.status === "COMPLETED") {
        // 決済リンク等を含むSquareの全入金の記録（従来どおり）
        const payment = obj.payment;
        // 都度払いの支払いページ（squareSessionCheckout.ts で作ったもの）なら経理を自動で「済」に
        const { handleSessionCheckoutPaid } = await import("./squareSessionCheckout");
        const matched = await handleSessionCheckoutPaid(payment);
        await db().collection("paymentEvents").add({
          amount: payment.amount_money?.amount ?? null,
          squarePaymentId: payment.id,
          customerId: payment.customer_id ?? null,
          orderId: payment.order_id ?? null,
          receivedAt: new Date().toISOString(),
          matched,
        });
      }
      res.status(200).send("ok");
    } catch (err) {
      console.error("Square Webhook処理エラー", type, err);
      res.status(500).send("error");
    }
  }
);

// ============================================================================
// 決済リンク（従来のSquareサブスク）からの切り替え（本部の管理画面から）
// ----------------------------------------------------------------------------
// 会員がSquareに登録済みのカードを使って、本部が新しい契約（毎月25日・前払い）を作る。
// 旧契約は「切り替え前月分の引き落としが済んだら」自動で解約する（毎日のチェックで実行）。
//   例）12月分から切り替え → 旧契約の11月分の引き落としが済んだ時点で解約（12月以降は旧契約で引き落とされない）
// ============================================================================

function requireHonbu(request: { auth?: { token?: Record<string, unknown> } }) {
  if (request.auth?.token?.role !== "honbu") {
    throw new HttpsError("permission-denied", "本部アカウントでログインしてください。");
  }
}

interface LegacySub {
  id: string;
  status: string;
  customerId: string;
  cardId: string | null;
  amount: number | null;
  planName: string | null;
  startDate: string | null;
  chargedThroughDate: string | null;
}

interface LegacyCard {
  id: string;
  customerId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  expired: boolean;
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** メールアドレスでSquareの顧客を探し、登録済みカードと進行中のサブスク（このシステムで作ったもの以外）を返す */
async function findLegacySquare(email: string, excludeSubscriptionIds: string[]): Promise<{
  customerIds: string[];
  cards: LegacyCard[];
  subscriptions: LegacySub[];
}> {
  const found = await square<{ customers?: { id: string }[] }>("POST", "/v2/customers/search", {
    query: { filter: { email_address: { exact: email.trim() } } },
    limit: 10,
  });
  const customerIds = (found.customers ?? []).map((c) => c.id);
  if (!customerIds.length) return { customerIds, cards: [], subscriptions: [] };

  // 次の引き落としに使えるかの判定は、切り替え月の初回（前月25日）時点で期限内か
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const cards: LegacyCard[] = [];
  for (const cid of customerIds) {
    const res = await square<{ cards?: any[] }>("GET", `/v2/cards?customer_id=${encodeURIComponent(cid)}`);
    for (const c of res.cards ?? []) {
      if (c.enabled === false) continue;
      const expired =
        typeof c.exp_year === "number" && typeof c.exp_month === "number"
          ? c.exp_year < now.getUTCFullYear() || (c.exp_year === now.getUTCFullYear() && c.exp_month < now.getUTCMonth() + 1)
          : false;
      cards.push({
        id: c.id,
        customerId: cid,
        brand: c.card_brand ?? null,
        last4: c.last_4 ?? null,
        expMonth: c.exp_month ?? null,
        expYear: c.exp_year ?? null,
        expired,
      });
    }
  }

  const subsRes = await square<{ subscriptions?: any[] }>("POST", "/v2/subscriptions/search", {
    query: { filter: { customer_ids: customerIds } },
    limit: 50,
  });
  const live = (subsRes.subscriptions ?? []).filter(
    (s) => ["ACTIVE", "PENDING", "PAUSED"].includes(s.status) && !excludeSubscriptionIds.includes(s.id) && !s.canceled_date
  );

  // 金額とプラン名（プランバリエーションから取得）
  const variationIds = Array.from(new Set(live.map((s) => s.plan_variation_id).filter(Boolean)));
  const variationInfo: Record<string, { amount: number | null; name: string | null }> = {};
  if (variationIds.length) {
    const cat = await square<{ objects?: any[]; related_objects?: any[] }>("POST", "/v2/catalog/batch-retrieve", {
      object_ids: variationIds,
      include_related_objects: true,
    });
    const plans: Record<string, string> = {};
    for (const o of cat.related_objects ?? []) {
      if (o.type === "SUBSCRIPTION_PLAN") plans[o.id] = o.subscription_plan_data?.name ?? "";
    }
    for (const o of cat.objects ?? []) {
      const d = o.subscription_plan_variation_data ?? {};
      const phase = (d.phases ?? [])[(d.phases ?? []).length - 1] ?? {};
      const amount = phase.pricing?.price?.amount ?? phase.pricing?.price_money?.amount ?? phase.recurring_price_money?.amount ?? null;
      variationInfo[o.id] = {
        amount: typeof amount === "number" ? amount : null,
        name: [plans[d.subscription_plan_id], d.name].filter(Boolean).join("／") || null,
      };
    }
  }

  const subscriptions: LegacySub[] = live.map((s) => ({
    id: s.id,
    status: s.status,
    customerId: s.customer_id,
    cardId: s.card_id ?? null,
    amount:
      typeof s.price_override_money?.amount === "number"
        ? s.price_override_money.amount
        : variationInfo[s.plan_variation_id]?.amount ?? null,
    planName: variationInfo[s.plan_variation_id]?.name ?? null,
    startDate: s.start_date ?? null,
    chargedThroughDate: s.charged_through_date ?? null,
  }));
  return { customerIds, cards, subscriptions };
}

/** 本部用：切り替え対象の会員と、Square上の旧契約・登録済みカードの一覧 */
export const listLegacySquareMembers = onCall(
  { secrets: [squareAccessToken], timeoutSeconds: 300 },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    requireHonbu(request);
    const [membersSnap, subsSnap] = await Promise.all([
      db().collection("members").where("status", "==", "在籍").get(),
      db().collection("memberSubscriptions").get(),
    ]);
    const ourSubIds = subsSnap.docs.map((d) => (d.data() as SubscriptionRecord).squareSubscriptionId).filter(Boolean);
    const liveMemberIds = new Set(
      subsSnap.docs.filter((d) => ACTIVE_STATUSES.includes((d.data() as SubscriptionRecord).status)).map((d) => d.id)
    );

    const targets = membersSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as MemberDoc & { isTestAccount?: boolean }) }))
      .filter((m) => isCardAutoPayGroup(m.group) && m.paymentMethod !== "都度払い" && !m.isTestAccount)
      .filter((m) => !liveMemberIds.has(m.id) && hasLegacyLink(m));

    const rows: any[] = [];
    // Squareの制限に配慮して少しずつ問い合わせる
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const m = queue.shift()!;
        const fee = await monthlyFeeFor(m);
        const startMonth = startMonthOptions(fee.cohortStartDate, true)[0];
        const base = {
          memberId: m.id,
          name: m.name ?? "",
          group: m.group ?? "",
          email: m.email ?? "",
          newAmount: fee.amount,
          newLabel: fee.label,
          startMonth,
          schedule: buildSchedule(startMonth),
        };
        if (!m.email) {
          rows.push({ ...base, problem: "メールアドレス未登録", cards: [], subscriptions: [] });
          continue;
        }
        try {
          const found = await findLegacySquare(m.email, ourSubIds);
          let problem: string | null = null;
          if (!found.customerIds.length) problem = "Squareに同じメールアドレスの顧客が見つかりません";
          else if (!found.cards.some((c) => !c.expired)) problem = "使えるカードが登録されていません";
          rows.push({ ...base, problem, cards: found.cards, subscriptions: found.subscriptions });
        } catch (err) {
          console.error("旧契約の検索エラー", m.id, err);
          rows.push({ ...base, problem: "Squareへの問い合わせに失敗しました", cards: [], subscriptions: [] });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    rows.sort((a, b) => (a.group + a.memberId).localeCompare(b.group + b.memberId, "ja"));
    return { environment: squareEnvironment.value(), rows };
  }
);

/** 旧契約のうち、切り替え前月分の引き落としが済んだものを解約する。すべて済めば legacyCancelStatus を done にする */
async function processLegacyCancellation(memberId: string): Promise<string> {
  const ref = db().doc(`memberSubscriptions/${memberId}`);
  const snap = await ref.get();
  const rec = snap.data() as SubscriptionRecord & {
    legacySubscriptionIds?: string[];
    legacyCancelAfter?: string;
    legacyCanceledIds?: string[];
    legacyCancelStatus?: string;
  };
  if (!rec?.legacySubscriptionIds?.length || rec.legacyCancelStatus === "done") return "対象なし";
  const canceled = new Set(rec.legacyCanceledIds ?? []);
  const notes: string[] = [];
  for (const id of rec.legacySubscriptionIds) {
    if (canceled.has(id)) continue;
    try {
      const { subscription: s } = await square<{ subscription: any }>("GET", `/v2/subscriptions/${id}`);
      if (!["ACTIVE", "PENDING", "PAUSED"].includes(s.status) || s.canceled_date) {
        canceled.add(id);
        notes.push(`${id}：すでに停止済み`);
        continue;
      }
      // 切り替え前月の月末まで支払い済み（＝前月分の引き落とし済み）なら解約する。
      // 解約は「支払い済み期間の終わり」で有効になるので、それ以降は旧契約で引き落とされない。
      if ((s.charged_through_date ?? "") >= (rec.legacyCancelAfter ?? "9999-12-31")) {
        await square("POST", `/v2/subscriptions/${id}/cancel`);
        canceled.add(id);
        notes.push(`${id}：解約しました（${s.charged_through_date}まで支払い済み）`);
      } else {
        notes.push(`${id}：前月分の引き落とし待ち（現在 ${s.charged_through_date ?? "—"} まで支払い済み）`);
      }
    } catch (err) {
      console.error("旧契約の解約エラー", memberId, id, err);
      notes.push(`${id}：解約処理に失敗（翌日再試行）`);
    }
  }
  const done = rec.legacySubscriptionIds.every((id) => canceled.has(id));
  await ref.update({
    legacyCanceledIds: Array.from(canceled),
    legacyCancelStatus: done ? "done" : "pending",
    legacyCancelNote: notes.join("\n"),
    updatedAt: new Date().toISOString(),
  });
  if (done) await db().doc(`members/${memberId}`).update({ legacySquareCanceled: true }).catch(() => undefined);
  return done ? "解約済み" : "解約待ち";
}

/** 本部用：会員の登録済みカードで新しい契約を作り、旧契約を解約予約する */
export const migrateLegacySquareMember = onCall<{ memberId: string; cardId: string; legacySubscriptionIds: string[] }>(
  { secrets: [squareAccessToken, slackBotTokenForSquare] },
  async (request) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    requireHonbu(request);
    const { memberId, cardId } = request.data ?? ({} as any);
    const legacyIds: string[] = Array.isArray(request.data?.legacySubscriptionIds) ? request.data.legacySubscriptionIds : [];
    if (typeof memberId !== "string" || typeof cardId !== "string") throw new HttpsError("invalid-argument", "パラメータが不正です。");

    const memberRef = db().doc(`members/${memberId}`);
    const subRef = db().doc(`memberSubscriptions/${memberId}`);
    const m = (await memberRef.get()).data() as MemberDoc | undefined;
    if (!m) throw new HttpsError("not-found", "会員が見つかりません。");
    if (!m.group || !isCardAutoPayGroup(m.group) || m.paymentMethod === "都度払い" || m.status !== "在籍") {
      throw new HttpsError("failed-precondition", "カード自動払いの対象ではない会員です。");
    }
    const fee = await monthlyFeeFor(m);
    if (!fee.amount) throw new HttpsError("failed-precondition", "お月謝が設定されていません。");

    const previous = await db().runTransaction(async (tx) => {
      const s = await tx.get(subRef);
      const data = s.exists ? (s.data() as SubscriptionRecord) : null;
      if (data && ACTIVE_STATUSES.includes(data.status)) throw new HttpsError("already-exists", "すでにカード自動払いの契約があります。");
      tx.set(subRef, { status: "CREATING", memberId, updatedAt: new Date().toISOString() }, { merge: true });
      return data;
    });

    try {
      // カードがこの会員のメールアドレスの顧客のものか確認
      const { card } = await square<{ card: any }>("GET", `/v2/cards/${cardId}`);
      const found = await square<{ customers?: { id: string }[] }>("POST", "/v2/customers/search", {
        query: { filter: { email_address: { exact: (m.email ?? "").trim() } } },
        limit: 10,
      });
      if (!card?.enabled || !(found.customers ?? []).some((c) => c.id === card.customer_id)) {
        throw new HttpsError("failed-precondition", "このカードは会員のメールアドレスの顧客に登録されたものではないか、無効になっています。");
      }
      const customerId = card.customer_id as string;
      // 会員番号をSquareの顧客に記録（以後の検索用）
      await square("PUT", `/v2/customers/${customerId}`, { reference_id: memberId }).catch(() => undefined);

      const startMonth = startMonthOptions(fee.cohortStartDate, true)[0];
      const schedule = buildSchedule(startMonth);
      const planVariationId = await ensurePlanVariation(fee.amount);
      const created = await square<{ subscription: { id: string; status: string } }>("POST", "/v2/subscriptions", {
        idempotency_key: crypto.randomUUID(),
        location_id: squareLocationId.value(),
        plan_variation_id: planVariationId,
        customer_id: customerId,
        card_id: card.id,
        start_date: schedule.subscriptionStartDate,
        timezone: "Asia/Tokyo",
        source: { name: "お稽古管理システム" },
      });

      const now = new Date().toISOString();
      const record: SubscriptionRecord = {
        memberId,
        memberName: m.name ?? "",
        group: m.group ?? "",
        environment: squareEnvironment.value(),
        status: created.subscription.status ?? "PENDING",
        amount: fee.amount,
        label: fee.label,
        startDate: schedule.subscriptionStartDate,
        squareCustomerId: customerId,
        squareCardId: card.id,
        squareSubscriptionId: created.subscription.id,
        planVariationId,
        cardBrand: card.card_brand,
        cardLast4: card.last_4,
        cardExpMonth: card.exp_month,
        cardExpYear: card.exp_year,
        createdAt: now,
        updatedAt: now,
      };
      await subRef.set({
        ...record,
        startMonth: schedule.startMonth,
        migratedFromLink: true,
        migratedBy: "honbu",
        legacySubscriptionIds: legacyIds,
        legacyCancelAfter: lastDayOfMonth(addMonths(schedule.startMonth, -1)),
        legacyCanceledIds: [],
        legacyCancelStatus: legacyIds.length ? "pending" : "done",
      });
      await memberRef.update({ nextBillingDate: schedule.nextDate, squareBillingAllowed: true });
      const cancelState = legacyIds.length ? await processLegacyCancellation(memberId) : "旧契約なし";

      // 本部が自分で操作した切り替えなので、Slackには通知しない（結果は管理画面に表示）
      console.log("決済リンクから切り替え", memberId, schedule.startMonth, cancelState);
      return { ok: true, startMonth: schedule.startMonth, nextDate: schedule.nextDate, cancelState };
    } catch (err) {
      if (previous) await subRef.set(previous);
      else await subRef.delete();
      if (err instanceof HttpsError) throw err;
      console.error("切り替えエラー", memberId, err);
      throw new HttpsError("internal", `切り替えに失敗しました：${(err as Error).message}`);
    }
  }
);

/** 毎日6:00（日本時間）：旧契約の解約待ちを確認し、前月分の引き落としが済んだものを解約する */
export const processLegacySquareCancellations = onSchedule(
  { schedule: "every day 06:00", timeZone: "Asia/Tokyo", secrets: [squareAccessToken] },
  async () => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const q = await db().collection("memberSubscriptions").where("legacyCancelStatus", "==", "pending").get();
    for (const d of q.docs) {
      const r = await processLegacyCancellation(d.id);
      console.log("旧契約の解約チェック", d.id, r);
    }
  }
);

// ---- 休会・退会の承認でカード自動払いを止める／復会で再開する ----

type LeaveRecord = SubscriptionRecord & {
  legacySubscriptionIds?: string[];
  legacyCanceledIds?: string[];
  legacyCancelStatus?: string;
  cancelScheduledDate?: string | null;
  cancelRequestedAt?: string;
  paidThroughMonth?: string;
};

/**
 * その日の時点で何月分まで支払い済みか（毎月25日に翌月分を前払いする前提）。
 * 例）11/10 → 11月分まで（10/25に11月分）、11/26 → 12月分まで（11/25に12月分）。
 * サブスク開始前（初回の25日より前）なら、開始日の月（＝初回で払う月の前月）まで。
 */
function paidThroughMonthAt(date: string, subscriptionStartDate?: string): string {
  if (subscriptionStartDate && date < subscriptionStartDate) return subscriptionStartDate.slice(0, 7);
  const cur = date.slice(0, 7);
  return Number(date.slice(8, 10)) >= BILLING_DAY ? addMonths(cur, 1) : cur;
}

/** Squareのサブスクを解約する（支払い済み期間の終わりで停止＝次の25日以降は引き落とされない） */
async function cancelSquareSubscription(id: string): Promise<{ result: "canceled" | "already"; endDate: string | null; chargedThrough: string | null }> {
  const { subscription: s } = await square<{ subscription: any }>("GET", `/v2/subscriptions/${id}`);
  if (!["ACTIVE", "PENDING", "PAUSED"].includes(s.status) || s.canceled_date) {
    return { result: "already", endDate: s.canceled_date ?? null, chargedThrough: s.charged_through_date ?? null };
  }
  const res = await square<{ subscription: any }>("POST", `/v2/subscriptions/${id}/cancel`);
  return {
    result: "canceled",
    endDate: res.subscription?.canceled_date ?? null,
    chargedThrough: res.subscription?.charged_through_date ?? s.charged_through_date ?? null,
  };
}

/** 休会・退会：このシステムの契約と決済リンクの旧契約を解約する。結果の説明文を返す */
async function stopSquareBillingForLeave(memberId: string, type: string): Promise<{ lines: string[]; needsCheck: boolean }> {
  const lines: string[] = [];
  let needsCheck = false;
  const now = new Date().toISOString();
  const subRef = db().doc(`memberSubscriptions/${memberId}`);
  const subSnap = await subRef.get();
  const rec = subSnap.exists ? (subSnap.data() as LeaveRecord) : null;
  const ourIds: string[] = [];
  await db().doc(`members/${memberId}`).update({ squareRejoin: true }).catch(() => undefined);

  // 1. カード自動払い（このシステムで作った契約）
  if (rec?.squareSubscriptionId) {
    ourIds.push(rec.squareSubscriptionId);
    if (ACTIVE_STATUSES.includes(rec.status)) {
      try {
        const r = await cancelSquareSubscription(rec.squareSubscriptionId);
        await subRef.update({
          cancelScheduledDate: r.endDate,
          cancelReason: `${type}申請の承認`,
          cancelRequestedAt: now,
          paidThroughMonth: paidThroughMonthAt(todayJst(), rec.startDate),
          updatedAt: now,
        });
        lines.push(
          r.result === "canceled"
            ? `カード自動払い：解約しました（${r.chargedThrough ? `${r.chargedThrough}まで支払い済み・` : ""}以降の引き落としはありません）`
            : `カード自動払い：すでに解約済みでした${r.endDate ? `（${r.endDate}で停止）` : ""}`
        );
      } catch (err) {
        console.error("休会・退会時の解約エラー", memberId, err);
        needsCheck = true;
        lines.push("⚠️ カード自動払いの解約に失敗しました。Squareのダッシュボードで解約してください。");
      }
    } else {
      lines.push(`カード自動払い：停止済み（${rec.status}）`);
    }
  }

  // 2. 切り替え時に見つかった決済リンクの旧契約（解約待ちのもの）は待たずに解約する
  if (rec?.legacySubscriptionIds?.length && rec.legacyCancelStatus !== "done") {
    const canceled = new Set(rec.legacyCanceledIds ?? []);
    let failed = false;
    for (const id of rec.legacySubscriptionIds) {
      if (canceled.has(id)) continue;
      try {
        await cancelSquareSubscription(id);
        canceled.add(id);
      } catch (err) {
        console.error("休会・退会時の旧契約解約エラー", memberId, id, err);
        failed = true;
      }
    }
    await subRef.update({
      legacyCanceledIds: Array.from(canceled),
      legacyCancelStatus: failed ? "pending" : "done",
      legacyCancelNote: `${type}申請の承認により解約${failed ? "（一部失敗・毎朝再試行）" : ""}`,
      updatedAt: now,
    });
    if (!failed) await db().doc(`members/${memberId}`).update({ legacySquareCanceled: true }).catch(() => undefined);
    if (failed) needsCheck = true;
    lines.push(failed ? "⚠️ 決済リンクの旧契約：一部の解約に失敗しました。Squareで確認してください。" : "決済リンクの旧契約：解約しました");
  }

  // 3. まだ切り替えていない会員：同じメールアドレスの決済リンクの契約を探す
  if (!rec?.squareSubscriptionId || !ACTIVE_STATUSES.includes(rec?.status ?? "")) {
    const mSnap = await db().doc(`members/${memberId}`).get();
    const m = mSnap.data() as MemberDoc | undefined;
    const email = (m?.email ?? "").trim();
    if (email && !isNoLegacyLinkGroup(m?.group)) {
      try {
        const allOurs = (await db().collection("memberSubscriptions").get()).docs
          .map((d) => (d.data() as SubscriptionRecord).squareSubscriptionId)
          .filter(Boolean);
        const found = await findLegacySquare(email, [...allOurs, ...(rec?.legacySubscriptionIds ?? [])]);
        if (found.subscriptions.length) {
          // ご家族などが同じメールアドレスで在籍中なら、誰の契約か分からないので自動では解約しない
          const sameEmail = await db().collection("members").where("email", "==", email).get();
          const others = sameEmail.docs.filter((d) => d.id !== memberId && (d.data() as MemberDoc).status === "在籍");
          if (others.length) {
            needsCheck = true;
            lines.push(
              `⚠️ 同じメールアドレスの決済リンクの契約が${found.subscriptions.length}件ありますが、` +
                `${others.map((d) => (d.data() as MemberDoc).name ?? d.id).join("・")}様も同じメールアドレスで在籍中のため自動解約していません。` +
                `Squareのダッシュボードでどの契約か確認して解約してください。`
            );
          } else {
            const done: string[] = [];
            for (const sub of found.subscriptions) {
              try {
                await cancelSquareSubscription(sub.id);
                done.push(`${sub.planName ?? "契約"}${typeof sub.amount === "number" ? ` ¥${sub.amount.toLocaleString("ja-JP")}` : ""}`);
              } catch (err) {
                console.error("休会・退会時の決済リンク解約エラー", memberId, sub.id, err);
                needsCheck = true;
                lines.push(`⚠️ 決済リンクの契約（${sub.id}）の解約に失敗しました。Squareで解約してください。`);
              }
            }
            if (done.length) {
              lines.push(`決済リンクの契約：解約しました（${done.join("、")}）`);
              await db().doc(`members/${memberId}`).update({ legacySquareCanceled: true }).catch(() => undefined);
            }
          }
        }
      } catch (err) {
        console.error("休会・退会時の決済リンク検索エラー", memberId, err);
        needsCheck = true;
        lines.push("⚠️ 決済リンクの契約の確認に失敗しました。Squareのダッシュボードで確認してください。");
      }
    }
  }
  return { lines, needsCheck };
}

/**
 * 復会：
 *  ・休会時に解約したカード自動払いがまだ停止前なら、解約予約を取り消す（そのまま続く）
 *  ・すでに停止していれば、Squareに登録済みのカードで新しく契約し直す。
 *    休会前に支払い済みの月の翌月から（早くても復会した月から）お月謝をいただき、
 *    すでに過ぎている分（復会した月の分など）は承認時にすぐ引き落とす。
 */
async function resumeSquareBillingForReturn(memberId: string): Promise<{ lines: string[]; needsCheck: boolean }> {
  const subRef = db().doc(`memberSubscriptions/${memberId}`);
  const snap = await subRef.get();
  const rec = snap.exists ? (snap.data() as LeaveRecord) : null;
  const memberRef = db().doc(`members/${memberId}`);
  const m = ((await memberRef.get()).data() ?? {}) as MemberDoc;
  const guide = "マイページの「お支払い」からカードを登録していただくようご案内ください。";
  if (!rec?.squareSubscriptionId || !rec.squareCustomerId) {
    // このシステムでのカード自動払いの記録がない（決済リンクのみ・都度払いなど）
    if (!isCardAutoPayGroup(m.group) || m.paymentMethod === "都度払い") return { lines: [], needsCheck: false };
    return { lines: [`カード自動払いの登録がありません。${guide}`], needsCheck: true };
  }

  // 1. まだ停止前なら、解約予約を取り消す
  let stopped = !ACTIVE_STATUSES.includes(rec.status);
  try {
    const { subscription: s, actions } = await square<{ subscription: any; actions?: any[] }>(
      "GET",
      `/v2/subscriptions/${rec.squareSubscriptionId}?include=actions`
    );
    const active = ["ACTIVE", "PENDING", "PAUSED"].includes(s.status);
    const cancelAction = (actions ?? s.actions ?? []).find((a: any) => a.type === "CANCEL");
    if (active && cancelAction && (!s.canceled_date || s.canceled_date > todayJst())) {
      await square("DELETE", `/v2/subscriptions/${rec.squareSubscriptionId}/actions/${cancelAction.id}`);
      await subRef.update({
        status: s.status,
        cancelScheduledDate: null,
        cancelReason: admin.firestore.FieldValue.delete(),
        cancelRequestedAt: admin.firestore.FieldValue.delete(),
        paidThroughMonth: admin.firestore.FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
      return { lines: ["カード自動払い：休会時の解約を取り消しました（これまでどおり毎月25日に翌月分を引き落とし）"], needsCheck: false };
    }
    if (active && !s.canceled_date && !cancelAction) {
      return { lines: ["カード自動払い：解約されていないため、そのまま継続しています"], needsCheck: false };
    }
    stopped = true;
  } catch (err) {
    console.error("復会時の契約確認エラー", memberId, err);
    return { lines: [`⚠️ Squareの契約を確認できませんでした。Squareのダッシュボードで確認のうえ、必要なら${guide}`], needsCheck: true };
  }
  if (!stopped) return { lines: [], needsCheck: false };

  // 2. 停止済み → 登録済みのカードで契約し直す
  if (m.squareBillingAllowed === false || m.monthlyFee === 0 || m.paymentMethod === "都度払い" || !isCardAutoPayGroup(m.group)) {
    return { lines: ["カード自動払いの対象外の設定のため、再開していません"], needsCheck: false };
  }
  const fee = await monthlyFeeFor(m);
  if (!fee.amount) return { lines: [`⚠️ お月謝が未設定のためカード自動払いを再開できませんでした。お月謝を設定のうえ、${guide}`], needsCheck: true };

  // 使えるカード（前回のカード→無ければ同じ顧客の別のカード）
  const nowJ = new Date(Date.now() + 9 * 3600 * 1000);
  const usable = (c: any) =>
    c &&
    c.enabled !== false &&
    !(typeof c.exp_year === "number" && typeof c.exp_month === "number" &&
      (c.exp_year < nowJ.getUTCFullYear() || (c.exp_year === nowJ.getUTCFullYear() && c.exp_month < nowJ.getUTCMonth() + 1)));
  let card: any = null;
  try {
    if (rec.squareCardId) {
      const r = await square<{ card: any }>("GET", `/v2/cards/${rec.squareCardId}`).catch(() => null);
      if (usable(r?.card)) card = r!.card;
    }
    if (!card) {
      const r = await square<{ cards?: any[] }>("GET", `/v2/cards?customer_id=${encodeURIComponent(rec.squareCustomerId)}`);
      card = (r.cards ?? []).find(usable) ?? null;
    }
  } catch (err) {
    console.error("復会時のカード確認エラー", memberId, err);
  }
  if (!card) return { lines: [`⚠️ 登録済みのカードが無効または期限切れのため、カード自動払いを再開できませんでした。${guide}`], needsCheck: true };

  // 何月分からいただくか：休会前に払い済みの月の翌月（早くても今月）
  const cur = todayJst().slice(0, 7);
  const paidThrough = rec.paidThroughMonth ?? addMonths(cur, -1);
  const startMonth = addMonths(paidThrough, 1) > cur ? addMonths(paidThrough, 1) : cur;
  const schedule = buildSchedule(startMonth);
  const now = new Date().toISOString();

  try {
    let oneTimePaymentId: string | null = null;
    if (schedule.oneTimeMonth) {
      const pay = await square<{ payment: { id: string } }>("POST", "/v2/payments", {
        idempotency_key: crypto.randomUUID(),
        source_id: card.id,
        customer_id: rec.squareCustomerId,
        location_id: squareLocationId.value(),
        amount_money: { amount: fee.amount, currency: "JPY" },
        autocomplete: true,
        reference_id: memberId,
        note: `お月謝 ${monthLabel(schedule.oneTimeMonth)}（復会・会員番号 ${memberId}）`,
      });
      oneTimePaymentId = pay.payment.id;
    }
    const planVariationId = await ensurePlanVariation(fee.amount);
    const created = await square<{ subscription: { id: string; status: string } }>("POST", "/v2/subscriptions", {
      idempotency_key: crypto.randomUUID(),
      location_id: squareLocationId.value(),
      plan_variation_id: planVariationId,
      customer_id: rec.squareCustomerId,
      card_id: card.id,
      start_date: schedule.subscriptionStartDate,
      timezone: "Asia/Tokyo",
      source: { name: "お稽古管理システム" },
    });
    await subRef.update({
      status: created.subscription.status ?? "PENDING",
      amount: fee.amount,
      label: fee.label,
      startDate: schedule.subscriptionStartDate,
      startMonth: schedule.startMonth,
      squareSubscriptionId: created.subscription.id,
      planVariationId,
      squareCardId: card.id,
      cardBrand: card.card_brand ?? null,
      cardLast4: card.last_4 ?? null,
      cardExpMonth: card.exp_month ?? null,
      cardExpYear: card.exp_year ?? null,
      previousSubscriptionIds: admin.firestore.FieldValue.arrayUnion(rec.squareSubscriptionId),
      resumedAt: now,
      cancelScheduledDate: null,
      cancelReason: admin.firestore.FieldValue.delete(),
      cancelRequestedAt: admin.firestore.FieldValue.delete(),
      paidThroughMonth: admin.firestore.FieldValue.delete(),
      lastFailureAt: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    });
    if (oneTimePaymentId) {
      await subRef.collection("payments").add({
        kind: "入金",
        amount: fee.amount,
        note: `${monthLabel(schedule.oneTimeMonth!)}（復会時の単発決済）`,
        squarePaymentId: oneTimePaymentId,
        receivedAt: now,
      });
    }
    await memberRef.update({ nextBillingDate: schedule.nextDate }).catch(() => undefined);
    return {
      lines: [
        `カード自動払いを再開しました（${cardLabelText(card)}・月額¥${fee.amount.toLocaleString("ja-JP")}）`,
        `休会前のお支払い：${monthLabel(paidThrough)}まで`,
        schedule.nowCount ? `承認時に引き落とし：${schedule.nowItems.join("・")}` : "承認時の引き落とし：なし",
        `次回：${schedule.nextDate}（${schedule.nextMonth}）`,
      ],
      needsCheck: false,
    };
  } catch (err) {
    console.error("復会時の再契約エラー", memberId, err);
    return {
      lines: [`⚠️ カードでの引き落としまたは契約に失敗したため、カード自動払いを再開できませんでした。${guide}`],
      needsCheck: true,
    };
  }
}

function cardLabelText(c: any): string {
  return `${c?.card_brand ?? "カード"}${c?.last_4 ? ` 末尾${c.last_4}` : ""}`;
}

/**
 * 休会・退会・復会の申請が承認されたら（管理画面の承認・Slackの✔️リアクションのどちらでも）、
 * お月謝のカード自動払い（Square）を止める／再開する。結果はSlackの申請メッセージのスレッドに返信する。
 */
export const onLeaveRequestApprovedSquare = onDocumentUpdated(
  { document: "leaveRequests/{requestId}", secrets: [squareAccessToken, slackBotTokenForSquare] },
  async (event) => {
    await refreshGroupSettings(); // 会の設定（料金など）を最新にする
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || !event.data) return;
    if (!(before.status === "pending" && after.status === "approved")) return;
    if (after.squareHandledAt) return;
    const memberId: string = after.memberId;
    if (!memberId) return;

    let lines: string[] = [];
    let needsCheck = false;
    try {
      if (after.type === "休会" || after.type === "退会") {
        const r = await stopSquareBillingForLeave(memberId, after.type);
        lines = r.lines;
        needsCheck = r.needsCheck;
      } else if (after.type === "復会") {
        const r = await resumeSquareBillingForReturn(memberId);
        lines = r.lines;
        needsCheck = r.needsCheck;
      }
    } catch (err) {
      console.error("休会・退会・復会時のSquare処理エラー", memberId, err);
      lines = ["⚠️ Squareの処理中にエラーが発生しました。Squareのダッシュボードで確認してください。"];
      needsCheck = true;
    }
    await event.data.after.ref
      .update({ squareHandledAt: new Date().toISOString(), squareResult: lines.join("\n") || "対象なし" })
      .catch(() => undefined);
    if (!lines.length) return;
    await notifySlack(
      `${needsCheck ? "⚠️" : "💳"} ${after.memberName ?? memberId}様（${memberId}）の${after.type}に伴うお月謝の自動払い\n` + lines.join("\n"),
      { channel: after.slackChannel, ts: after.slackTs }
    );
  }
);
