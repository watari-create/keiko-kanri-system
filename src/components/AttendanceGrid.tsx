"use client";

// 出席簿：会員×月のグリッド。セルをクリックすると 未記録 → 出席 → 欠席 → 未記録 と切り替わる。
// editable=false のときはクリック不可（閲覧のみ）。
//
// sections を渡すと、雪月花のように組（雪組・月組・花組）ごとに見出し付きで区切って表示できる。
// sections を渡さない場合は members をそのまま1つの表として表示する（従来通り）。
//
// スマホでも見やすいように、氏名欄は幅を固定して省略表示にし、上部の月選択で
// 「全期間」または特定の1か月だけに絞って表示できるようにしている
// （スマホ幅では初期状態で今月だけの表示になる）。

import { useEffect, useState } from "react";
import { currentMonthKey, fiscalYearMonths, monthLabel } from "@/lib/fiscalMonths";
import type { Member } from "@/types";

type AttendanceValue = "出席" | "欠席" | undefined;
const CYCLE: AttendanceValue[] = [undefined, "出席", "欠席"];
const SYMBOL: Record<string, string> = { "": "－", 出席: "○", 欠席: "×" };

export type AttendanceSection = { label: string | null; members: Member[] };

export default function AttendanceGrid({
  members,
  sections,
  editable,
  onCellChange,
}: {
  members?: Member[];
  sections?: AttendanceSection[];
  editable: boolean;
  onCellChange?: (memberId: string, monthKey: string, next: AttendanceValue) => void;
}) {
  const allMonths = fiscalYearMonths();
  const [selectedMonth, setSelectedMonth] = useState<string>("all");

  // スマホ幅（640px未満）で開いたときは、初期表示を「今月のみ」に絞る。
  // PC幅ではこれまで通り「全期間」を初期表示にする。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 640px)").matches) {
      const thisMonth = currentMonthKey();
      setSelectedMonth(allMonths.includes(thisMonth) ? thisMonth : allMonths[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const months = selectedMonth === "all" ? allMonths : allMonths.filter((mk) => mk === selectedMonth);
  const resolvedSections: AttendanceSection[] =
    sections ?? [{ label: null, members: members ?? [] }];
  const totalMembers = resolvedSections.reduce((sum, s) => sum + s.members.length, 0);
  const colCount = 1 + months.length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <label className="text-muted">表示：</label>
        <select
          className="border border-line rounded px-2 py-1 text-xs"
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
        >
          <option value="all">全期間</option>
          {allMonths.map((mk) => (
            <option key={mk} value={mk}>
              {monthLabel(mk)}のみ
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
      <table className="text-sm border-collapse">
        <thead>
          <tr className="text-left text-muted border-b border-line">
            <th className="py-2 pr-2 sticky left-0 bg-paper w-16 sm:w-24">氏名</th>
            {months.map((mk) => (
              <th key={mk} className="px-1 text-center font-medium">
                {monthLabel(mk)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {resolvedSections.map((section, sIdx) => (
            <>
              {section.label && (
                <tr key={`heading-${section.label}-${sIdx}`}>
                  <td colSpan={colCount} className="pt-4 pb-1 text-xs font-bold text-matcha-deep">
                    {section.label}（{section.members.length}名）
                  </td>
                </tr>
              )}
              {section.members.map((m) => (
                <tr key={m.id} className="border-b border-line">
                  <td className="py-2 pr-2 sticky left-0 bg-paper w-16 sm:w-24">
                    <span className="block truncate" title={m.name}>
                      {m.name}
                    </span>
                  </td>
                  {months.map((mk) => {
                    const val = (m.attendance?.[mk] ?? "") as string;
                    const colorClass =
                      val === "出席"
                        ? "text-matcha-deep font-bold bg-matcha-pale"
                        : val === "欠席"
                        ? "text-hanko bg-hanko-pale"
                        : "text-muted";
                    return (
                      <td
                        key={mk}
                        className={`w-9 h-9 text-center border border-line ${colorClass} ${
                          editable ? "cursor-pointer hover:bg-matcha-pale/40" : ""
                        }`}
                        onClick={() => {
                          if (!editable || !onCellChange) return;
                          const current = val === "" ? undefined : (val as AttendanceValue);
                          const idx = CYCLE.indexOf(current);
                          const next = CYCLE[(idx + 1) % CYCLE.length];
                          onCellChange(m.id, mk, next);
                        }}
                      >
                        {SYMBOL[val] ?? "－"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </>
          ))}
          {totalMembers === 0 && (
            <tr>
              <td colSpan={colCount} className="py-4 text-center text-muted">
                会員がいません
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      <div className="flex gap-4 mt-2 text-xs text-muted">
        <span>○ 出席</span>
        <span>× 欠席</span>
        <span>－ 未記録</span>
      </div>
    </div>
  );
}
