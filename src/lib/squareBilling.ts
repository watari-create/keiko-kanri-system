// お月謝のカード自動払い（Square）のクライアント側の型とヘルパー。
// サーバー側の処理は functions/src/square.ts。

import { getFunctions, httpsCallable } from "firebase/functions";

export interface SquareBillingSubscription {
  status: string; // PENDING / ACTIVE / PAUSED / CANCELED / DEACTIVATED
  amount: number;
  label: string;
  startDate: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  lastPaymentAt: string | null;
  lastFailureAt: string | null;
  nextBillingDate: string;
}

// 前払いのお引き落としスケジュール（functions/src/square.ts の buildSchedule と同じ形）
export interface BillingSchedule {
  startMonth: string; // 参加開始月 YYYY-MM
  subscriptionStartDate: string;
  oneTimeMonth: string | null;
  nowItems: string[]; // お申込み時に引き落とす月（例：["2026年10月分"]）
  nowCount: number;
  nextDate: string; // 次の定期お引き落とし日
  nextMonth: string; // その対象月（例："2026年11月分"）
}

export interface SquareBillingInfo {
  square: { applicationId: string; locationId: string; environment: "sandbox" | "production" | string };
  eligible: boolean;
  reason: string | null;
  amount: number | null;
  label: string;
  schedules: BillingSchedule[]; // 選べる参加開始月ごとのスケジュール（新規募集クラスは1つ）
  billingDay: number;
  memberName: string;
  email: string;
  subscription: SquareBillingSubscription | null;
}

export async function fetchSquareBillingInfo(): Promise<SquareBillingInfo> {
  const fn = httpsCallable<void, SquareBillingInfo>(getFunctions(), "getSquareBillingInfo");
  return (await fn()).data;
}

export async function startSquareSubscription(token: string, startMonth: string) {
  const fn = httpsCallable<
    { token: string; startMonth: string },
    { ok: boolean; schedule: BillingSchedule; amount: number; cardBrand: string | null; cardLast4: string | null }
  >(getFunctions(), "startSquareSubscription");
  return (await fn({ token, startMonth })).data;
}

export async function updateSquareSubscriptionCard(token: string) {
  const fn = httpsCallable<{ token: string }, { ok: boolean; cardBrand: string | null; cardLast4: string | null }>(
    getFunctions(),
    "updateSquareSubscriptionCard"
  );
  return (await fn({ token })).data;
}

export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  PENDING: "お申込み済み（初回お引き落とし待ち）",
  ACTIVE: "ご利用中",
  PAUSED: "一時停止中",
  CANCELED: "解約済み",
  DEACTIVATED: "停止中",
};

const BRAND_LABEL: Record<string, string> = {
  VISA: "VISA",
  MASTERCARD: "Mastercard",
  AMERICAN_EXPRESS: "American Express",
  JCB: "JCB",
  DISCOVER: "Discover",
  DISCOVER_DINERS: "Diners Club",
  CHINA_UNIONPAY: "UnionPay",
};

export function cardLabel(brand: string | null | undefined, last4: string | null | undefined): string {
  if (!last4) return "—";
  return `${BRAND_LABEL[brand ?? ""] ?? "カード"}　**** ${last4}`;
}

export function formatJpDate(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${y}年${m}月${d}日`;
}

export function yen(n: number | null | undefined): string {
  return typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "—";
}

/** Cloud Functionsのエラーから会員向けメッセージを取り出す */
export function callableErrorMessage(err: unknown): string {
  const msg = (err as { message?: string })?.message;
  if (msg && !/^(internal|INTERNAL)$/.test(msg)) return msg;
  return "処理に失敗しました。時間をおいて再度お試しいただくか、本部までご連絡ください。";
}

export function formatYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月`;
}
