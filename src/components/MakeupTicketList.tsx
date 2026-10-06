"use client";

import type { Member } from "@/types";

// 茶道教室・土曜日クラスの在籍会員ごとの振替チケット保有枚数一覧（管理画面・講師画面で共用）。
// 振替チケットを1枚以上持っている会員だけを、保有枚数の多い順に表示する。
export default function MakeupTicketList({
  members,
  onSelect,
}: {
  members: Member[];
  onSelect?: (m: Member) => void;
}) {
  const rows = members
    .filter(
      (m) =>
        m.group === "茶道教室" &&
        m.chadoClass === "土曜日" &&
        m.status === "在籍" &&
        (m.chadoMakeupTickets ?? 0) > 0
    )
    .sort(
      (a, b) =>
        (b.chadoMakeupTickets ?? 0) - (a.chadoMakeupTickets ?? 0) || a.id.localeCompare(b.id)
    );
  const total = rows.reduce((sum, m) => sum + (m.chadoMakeupTickets ?? 0), 0);

  return (
    <div className="border border-line rounded-md p-3 mb-4">
      <p className="text-sm font-semibold mb-2">
        振替チケット保有状況
        <span className="text-xs text-muted font-normal">
          　（{rows.length}名・合計{total}枚）
        </span>
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">振替チケットを持っている会員はいません</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted text-left border-b border-line">
              <th className="py-1 pr-3 font-normal">会員番号</th>
              <th className="py-1 pr-3 font-normal">氏名</th>
              <th className="py-1 font-normal text-right">保有枚数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const n = m.chadoMakeupTickets ?? 0;
              return (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="py-1 pr-3 text-muted">{m.id}</td>
                  <td className="py-1 pr-3">
                    {onSelect ? (
                      <button
                        className="text-matcha-deep underline decoration-dotted underline-offset-2"
                        onClick={() => onSelect(m)}
                      >
                        {m.name}
                      </button>
                    ) : (
                      m.name
                    )}
                  </td>
                  <td className={`py-1 text-right ${n > 0 ? "font-bold text-matcha-deep" : "text-muted"}`}>
                    {n}枚
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
