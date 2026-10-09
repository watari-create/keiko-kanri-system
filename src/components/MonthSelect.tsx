"use client";

// 年・月を和文のプルダウンで選ぶ入力欄（値は "YYYY-MM"、未選択は ""）。
// <input type="month"> はブラウザ・OSの言語設定によって「October 2026」のように英語表示になるため、その代わりに使う。
type Props = {
  value: string;
  onChange: (value: string) => void;
  yearFrom?: number; // 選択肢の最初の年（既定：今年の前年）
  yearTo?: number; // 選択肢の最後の年（既定：今年の翌年）
  allowEmpty?: boolean; // 「未選択」を選べるようにする
  className?: string;
  selectClassName?: string;
};

export default function MonthSelect({
  value,
  onChange,
  yearFrom,
  yearTo,
  allowEmpty = false,
  className = "",
  selectClassName = "border border-line rounded px-3 py-2 text-sm",
}: Props) {
  const thisYear = new Date().getFullYear();
  const [y, m] = value ? value.split("-") : ["", ""];
  const from = Math.min(yearFrom ?? thisYear - 1, y ? Number(y) : Infinity);
  const to = Math.max(yearTo ?? thisYear + 1, y ? Number(y) : -Infinity);
  const years: number[] = [];
  for (let i = to; i >= from; i--) years.push(i);

  function update(nextY: string, nextM: string) {
    if (!nextY && !nextM) return onChange("");
    // 片方だけ選ばれたら、もう片方は今年／1月で補う
    const yy = nextY || String(thisYear);
    const mm = nextM || "01";
    onChange(`${yy}-${mm}`);
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <select className={selectClassName} value={y} onChange={(e) => update(e.target.value, e.target.value ? m : "")}>
        {(allowEmpty || !y) && <option value="">年</option>}
        {years.map((yr) => (
          <option key={yr} value={String(yr)}>
            {yr}年
          </option>
        ))}
      </select>
      <select className={selectClassName} value={m} onChange={(e) => update(e.target.value ? y : "", e.target.value)}>
        {(allowEmpty || !m) && <option value="">月</option>}
        {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((mm) => (
          <option key={mm} value={mm}>
            {Number(mm)}月
          </option>
        ))}
      </select>
    </div>
  );
}
