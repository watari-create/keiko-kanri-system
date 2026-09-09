// 出席簿で使う「会計年度（4月始まり）の12か月」ユーティリティ。
// 例：2026年9月時点なら 2026-04 〜 2027-03 の12か月を返す。

export function fiscalYearMonths(base: Date = new Date()): string[] {
  const y = base.getMonth() >= 3 ? base.getFullYear() : base.getFullYear() - 1;
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m = 4 + i; // 4..15
    const year = m <= 12 ? y : y + 1;
    const month = ((m - 1) % 12) + 1;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

export function monthLabel(monthKey: string): string {
  const parts = monthKey.split("-");
  const m = parseInt(parts[1] ?? "0", 10);
  return `${m}月`;
}
