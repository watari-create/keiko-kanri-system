"use client";

// 出席簿：会員×月のグリッド。セルをクリックすると 未記録 → 出席 → 欠席 → 未記録 と切り替わる。
// editable=false のときはクリック不可（閲覧のみ）。

import { fiscalYearMonths, monthLabel } from "@/lib/fiscalMonths";
import type { Member } from "@/types";

type AttendanceValue = "出席" | "欠席" | undefined;
const CYCLE: AttendanceValue[] = [undefined, "出席", "欠席"];
const SYMBOL: Record<string, string> = { "": "－", 出席: "○", 欠席: "×" };

export default function AttendanceGrid({
  members,
  editable,
  onCellChange,
}: {
  members: Member[];
  editable: boolean;
  onCellChange?: (memberId: string, monthKey: string, next: AttendanceValue) => void;
}) {
  const months = fiscalYearMonths();

  return (
    <div className="overflow-x-auto">
      <table className="text-sm border-collapse min-w-[720px]">
        <thead>
          <tr className="text-left text-muted border-b border-line">
            <th className="py-2 pr-3 sticky left-0 bg-paper">氏名</th>
            {months.map((mk) => (
              <th key={mk} className="px-1 text-center font-medium">
                {monthLabel(mk)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-b border-line">
              <td className="py-2 pr-3 sticky left-0 bg-paper whitespace-nowrap">{m.name}</td>
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
          {members.length === 0 && (
            <tr>
              <td colSpan={13} className="py-4 text-center text-muted">
                会員がいません
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex gap-4 mt-2 text-xs text-muted">
        <span>○ 出席</span>
        <span>× 欠席</span>
        <span>－ 未記録</span>
      </div>
    </div>
  );
}
