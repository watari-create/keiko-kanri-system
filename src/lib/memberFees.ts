// 会員ごとのお月謝（お支払い金額）の算出。会員名簿タブで使う。
// 標準額は入会フォームの料金設定（enrollGroups.ts）から引き、会員ごとに個別の金額
// （ご家族割引・宗徧流稽古の会など、標準額が決まっていない場合）を設定していればそちらを優先する。

import { ENROLL_GROUPS } from "@/lib/enrollGroups";
import type { Member } from "@/types";

// 茶道教室・月2回プラン（土曜日クラス）の月謝。入会フォームでは選べない（進級先のプラン）ため、
// enrollGroups.ts ではコメントアウトされている。金額が変わった場合はここも合わせて更新すること。
const CHADO_TWICE_MONTHLY_FEE = 28000;

// 宗徧流稽古の会の標準のお月謝（月額）。入会フォームの対象外のため、ここで直接設定する。
const SOHENRYU_MONTHLY_FEES: Record<string, number> = {
  "萌芽会": 15000,
  "雪月花": 35000,
  "不識会": 35000,
  "星組": 35000,
  "一喝会": 35000,
  "紅月会": 20000,
  // 本部稽古・新月会（入会フォーム未登録のためここで設定。functions/src/square.ts と同じ金額にしておくこと）
  "新月会": 15000,
};

// 入会金。名月会は経理タブの「入会金」と同じ一律額、茶道教室は入会フォームの案内額。
// 宗徧流稽古の会（萌芽会は未設定）はここで直接設定する。
const ENTRY_FEES: Record<string, number> = {
  "名月会": 33000,
  "茶道教室": 15000,
  "雪月花": 250000,
  "不識会": 250000,
  "星組": 150000,
  "一喝会": 150000,
  "紅月会": 30000,
};

export interface MemberFee {
  amount: number | null; // 未設定の場合はnull
  unit: "月" | "回";
  label: string; // 例：月謝（月1回プラン）
  custom: boolean; // 会員ごとの個別設定か
}

function yen(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatYen(n: number | null | undefined): string {
  return typeof n === "number" ? `¥${n.toLocaleString()}` : "—";
}

export function memberFee(
  m: Pick<Member, "group" | "paymentMethod" | "chadoMonthlyQuota" | "monthlyFee">
): MemberFee {
  const perSession = m.paymentMethod === "都度払い";
  const unit: "月" | "回" = perSession ? "回" : "月";
  const baseLabel = perSession ? "都度払い" : "月謝";

  if (typeof m.monthlyFee === "number") {
    return { amount: m.monthlyFee, unit, label: `${baseLabel}（個別設定）`, custom: true };
  }

  if (m.group === "茶道教室") {
    const twice = m.chadoMonthlyQuota === 2;
    const once = yen(ENROLL_GROUPS.chado.plans?.options["月1回"]?.amount) ?? 15000;
    return {
      amount: twice ? CHADO_TWICE_MONTHLY_FEE : once,
      unit: "月",
      label: twice ? "月謝（月2回プラン）" : "月謝（月1回プラン）",
      custom: false,
    };
  }

  if (m.group in SOHENRYU_MONTHLY_FEES) {
    return { amount: SOHENRYU_MONTHLY_FEES[m.group], unit: "月", label: "月謝", custom: false };
  }

  const config = Object.values(ENROLL_GROUPS).find((g) => g.title === m.group);
  if (config) {
    return {
      amount: yen(perSession ? config.amounts.onetime : config.amounts.subscription),
      unit,
      label: baseLabel,
      custom: false,
    };
  }

  return { amount: null, unit, label: "未設定", custom: false };
}

export function entryFeeFor(group: string): number | null {
  return ENTRY_FEES[group] ?? null;
}
