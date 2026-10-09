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
import { defineSecret, defineString } from "firebase-functions/params";
import * as crypto from "crypto";

const squareAccessToken = defineSecret("SQUARE_ACCESS_TOKEN");
const squareWebhookSignatureKey = defineSecret("SQUARE_WEBHOOK_SIGNATURE_KEY");
const squareEnvironment = defineString("SQUARE_ENVIRONMENT", { default: "sandbox" });
const squareApplicationId = defineString("SQUARE_APPLICATION_ID");
const squareLocationId = defineString("SQUARE_LOCATION_ID");
const squareWebhookUrl = defineString("SQUARE_WEBHOOK_URL", { default: "" });
const squareBillingFrom = defineString("SQUARE_BILLING_FROM", { default: "2026-11-01" });
// 決済リンク（従来のSquareサブスク）でお支払い中の会員が、この仕組みに切り替える最初の月（YYYY-MM）。
// 入会日が SQUARE_BILLING_FROM より前の会員は「切り替え会員」として扱い、参加開始月をこの月（過ぎていれば翌月）に固定する。
const squareMigrationMonth = defineString("SQUARE_MIGRATION_MONTH", { default: "2026-12" });
// 引き落とし失敗などの通知先（既存の本部稽古boチャンネル）
const slackBotTokenForSquare = defineSecret("SLACK_BOT_TOKEN");
const slackHqChannelForSquare = defineString("SLACK_HQ_CHANNEL");

const SQUARE_VERSION = "2025-01-23";
// 毎月のお引き落とし日
const BILLING_DAY = 25;
// カード自動払いの対象の会（Firestoreのgroup名）
const TARGET_GROUPS = ["茶道教室", "名月会", "Gマダムの茶の湯講座"];
// 標準のお月謝（src/lib/enrollGroups.ts・src/lib/memberFees.ts と同じ金額にしておくこと）
const STANDARD_MONTHLY_FEES: Record<string, number> = {
  "名月会": 12000,
  "Gマダムの茶の湯講座": 20000,
};
const CHADO_ONCE_FEE = 15000;
const CHADO_TWICE_FEE = 28000;

function db() {
  return admin.firestore();
}

function squareBase(): string {
  return squareEnvironment.value() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

class SquareApiError extends Error {
  constructor(public status: number, public errors: { code?: string; detail?: string; category?: string }[]) {
    super(errors.map((e) => `${e.code}: ${e.detail}`).join(" / ") || `HTTP ${status}`);
  }
}

async function square<T = any>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
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
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function ymd(y: number, m: number, d: number): string {
  // m は 1〜12（範囲外は繰り上げ・繰り下げ）
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}
interface MemberDoc {
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
}

/** お月謝の金額と表示名 */
async function monthlyFeeFor(m: MemberDoc): Promise<{ amount: number | null; label: string; cohortStartDate?: string }> {
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
  if (m.group === "茶道教室") {
    if (cohortFee) return { amount: cohortFee, label: "お月謝", cohortStartDate };
    const twice = m.chadoMonthlyQuota === 2;
    return {
      amount: twice ? CHADO_TWICE_FEE : CHADO_ONCE_FEE,
      label: twice ? "お月謝（月2回プラン）" : "お月謝（月1回プラン）",
      cohortStartDate,
    };
  }
  const std = m.group ? STANDARD_MONTHLY_FEES[m.group] : undefined;
  return { amount: std ?? null, label: "お月謝" };
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
  return !m.chadoCohortId && (m.joinDate ?? "") < squareBillingFrom.value();
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
  if (!m.group || !TARGET_GROUPS.includes(m.group)) return { ok: false, reason: "対象外の会" };
  if (m.status !== "在籍") return { ok: false, reason: "在籍中の会員のみ" };
  if (m.paymentMethod === "都度払い") return { ok: false, reason: "都度払いの会員" };
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

async function ensureCustomer(memberId: string, m: MemberDoc, existingId?: string): Promise<string> {
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

async function notifySlack(text: string) {
  // テスト環境（sandbox）の間はSlackに通知しない
  if (squareEnvironment.value() !== "production") {
    console.log("（テスト環境のためSlack通知を省略）", text);
    return;
  }
  try {
    const token = slackBotTokenForSquare.value();
    const channel = slackHqChannelForSquare.value();
    if (!token || !channel) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text }),
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
  const memberId = requireMember(request);
  const snap = await db().doc(`members/${memberId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "会員情報が見つかりません。");
  const m = snap.data() as MemberDoc;
  const fee = await monthlyFeeFor(m);
  const subSnap = await db().doc(`memberSubscriptions/${memberId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubscriptionRecord) : null;
  const elig = eligibility(m);
  return {
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
      if (data && ACTIVE_STATUSES.includes(data.status)) {
        const stale = data.status === "CREATING" && data.updatedAt && Date.now() - Date.parse(data.updatedAt) > 5 * 60 * 1000;
        if (!stale) throw new HttpsError("already-exists", "すでにお申込み済みです。");
      }
      tx.set(subRef, { status: "CREATING", memberId, updatedAt: new Date().toISOString() }, { merge: true });
      return data;
    });

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
      if (migration && m.email) {
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
        migratedFromLink: migration,
        ...(migration
          ? {
              legacySubscriptionIds: legacyIds,
              legacyCancelAfter: lastDayOfMonth(addMonths(schedule.startMonth, -1)),
              legacyCanceledIds: [],
              legacyCancelStatus: legacyIds.length ? "pending" : "done",
            }
          : {}),
      });
      const legacyState = migration && legacyIds.length ? await processLegacyCancellation(memberId) : null;
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
      await notifySlack(
        `💳 カード自動払いのお申込みがありました\n${m.name ?? ""}様（${memberId}・${m.group ?? ""}）\n` +
          `月額¥${fee.amount.toLocaleString("ja-JP")}　参加開始：${monthLabel(schedule.startMonth).replace("分", "")}\n` +
          (schedule.nowCount ? `お申込み時に引き落とし：${schedule.nowItems.join("・")}\n` : "") +
          `次回：${schedule.nextDate}（${schedule.nextMonth}）` +
          (migration
            ? legacyState
              ? `\n決済リンクの旧契約：${legacyState}（${monthLabel(addMonths(schedule.startMonth, -1))}の引き落とし後に自動で解約します）`
              : `\n⚠️ 決済リンクからの切り替えですが、同じメールアドレスの旧契約が見つかりませんでした。` +
                `Squareのダッシュボードで確認し、残っていれば解約して、管理画面の会員詳細で「旧契約（決済リンク）を解約済み」にチェックしてください。`
            : "") +
          (squareEnvironment.value() === "production" ? "" : "\n（テスト環境）")
      );
      return { ok: true, schedule, amount: fee.amount, cardBrand: card.card_brand ?? null, cardLast4: card.last_4 ?? null };
    } catch (err) {
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
  { secrets: [squareWebhookSignatureKey, slackBotTokenForSquare], invoker: "public" },
  async (req, res) => {
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

      if (type === "invoice.payment_made") {
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
        await db().collection("paymentEvents").add({
          amount: payment.amount_money?.amount ?? null,
          squarePaymentId: payment.id,
          customerId: payment.customer_id ?? null,
          receivedAt: new Date().toISOString(),
          matched: false,
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
      .filter((m) => TARGET_GROUPS.includes(m.group ?? "") && m.paymentMethod !== "都度払い" && !m.isTestAccount)
      .filter((m) => !liveMemberIds.has(m.id) && isMigrationMember(m));

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
    requireHonbu(request);
    const { memberId, cardId } = request.data ?? ({} as any);
    const legacyIds: string[] = Array.isArray(request.data?.legacySubscriptionIds) ? request.data.legacySubscriptionIds : [];
    if (typeof memberId !== "string" || typeof cardId !== "string") throw new HttpsError("invalid-argument", "パラメータが不正です。");

    const memberRef = db().doc(`members/${memberId}`);
    const subRef = db().doc(`memberSubscriptions/${memberId}`);
    const m = (await memberRef.get()).data() as MemberDoc | undefined;
    if (!m) throw new HttpsError("not-found", "会員が見つかりません。");
    if (!m.group || !TARGET_GROUPS.includes(m.group) || m.paymentMethod === "都度払い" || m.status !== "在籍") {
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
    const q = await db().collection("memberSubscriptions").where("legacyCancelStatus", "==", "pending").get();
    for (const d of q.docs) {
      const r = await processLegacyCancellation(d.id);
      console.log("旧契約の解約チェック", d.id, r);
    }
  }
);
