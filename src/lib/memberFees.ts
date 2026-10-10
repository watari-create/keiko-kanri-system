// 会員ごとのお月謝（お支払い金額）の算出。会員名簿タブ・会員詳細で使う。
// 標準額は管理画面の「会の設定」（src/lib/groupSettings.ts）から引き、会員ごとに個別の金額
// （ご家族割引など）を設定していればそちらを優先する。

import { groupSetting } from "@/lib/groupSettings";
import type { Member } from "@/types";

export interface MemberFee {
  amount: number | null; // 未設定の場合はnull
  unit: "月" | "回";
  label: string; // 例：月謝（月1回プラン）
  custom: boolean; // 会員ごとの個別設定か
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

  // 0円＝お月謝なし（カード自動払いの登録も不要）
  if (m.monthlyFee === 0) {
    return { amount: 0, unit, label: perSession ? "都度払いなし（個別設定）" : "お月謝なし（個別設定）", custom: true };
  }
  if (typeof m.monthlyFee === "number") {
    return { amount: m.monthlyFee, unit, label: `${baseLabel}（個別設定）`, custom: true };
  }

  const s = groupSetting(m.group);
  if (!s) return { amount: null, unit, label: "未設定", custom: false };

  // 月2回プランのある会（茶道教室・土曜日クラス）
  if (s.monthlyFeeTwice != null && !perSession) {
    const twice = m.chadoMonthlyQuota === 2;
    return {
      amount: twice ? s.monthlyFeeTwice : s.monthlyFee,
      unit: "月",
      label: twice ? "月謝（月2回プラン）" : "月謝（月1回プラン）",
      custom: false,
    };
  }

  return { amount: perSession ? s.sessionFee : s.monthlyFee, unit, label: baseLabel, custom: false };
}

export function entryFeeFor(group: string): number | null {
  return groupSetting(group)?.entryFee ?? null;
}
