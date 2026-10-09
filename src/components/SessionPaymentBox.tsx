"use client";

// マイページ：都度払いの会員向け。今月分のお支払い状況と、出席したのに未入金の月の「お支払いへ」ボタン。
// 入金の記録（members.sessionPayments）は、Squareの支払いページで払うと自動で「済」になる
// （functions/src/squareSessionCheckout.ts）。
import { currentMonthKey } from "@/lib/fiscalMonths";
import type { Member } from "@/types";

// この月より前の未入金は表示しない（functions の SESSION_UNPAID_FROM と同じ）
const UNPAID_FROM = "2026-10";

function label(mk: string) {
  const [y, m] = mk.split("-").map(Number);
  return `${y}年${m}月分`;
}

export default function SessionPaymentBox({
  member,
  busy,
  checkoutUrl,
  onPay,
}: {
  member: Member;
  busy: boolean;
  checkoutUrl: string | null;
  onPay: (monthKey: string) => void;
}) {
  const thisMonth = currentMonthKey();
  const paidThisMonth = member.sessionPayments?.[thisMonth] === "済";
  const attendingThisMonth = member.attendance?.[thisMonth] === "出席";
  const unpaidPast = Object.entries(member.attendance ?? {})
    .filter(([mk, v]) => v === "出席" && mk >= UNPAID_FROM && mk < thisMonth && member.sessionPayments?.[mk] !== "済")
    .map(([mk]) => mk)
    .sort();

  return (
    <div className="mt-4 border-t border-line pt-3 text-xs">
      <p className="text-muted mb-2">都度払い：出席するお稽古の月ごとに、Squareでお支払いください。</p>
      {paidThisMonth ? (
        <span className="inline-block font-bold text-matcha-deep bg-matcha-pale rounded-full px-3 py-1">
          ✓ {label(thisMonth)} お支払い済み
        </span>
      ) : attendingThisMonth ? (
        <button
          className="w-full rounded py-2 text-sm bg-white border border-hanko text-hanko disabled:opacity-50"
          disabled={busy}
          onClick={() => onPay(thisMonth)}
        >
          {busy ? "お支払いページを準備中…" : `${label(thisMonth)}のお支払いへ`}
        </button>
      ) : null}

      {unpaidPast.length > 0 && (
        <div className="mt-3 bg-hanko-pale rounded p-3">
          <p className="font-bold text-hanko mb-2">未払いのお月謝があります</p>
          <div className="space-y-2">
            {unpaidPast.map((mk) => (
              <button
                key={mk}
                className="w-full rounded py-2 text-sm bg-white border border-hanko text-hanko disabled:opacity-50"
                disabled={busy}
                onClick={() => onPay(mk)}
              >
                {label(mk)}のお支払いへ
              </button>
            ))}
          </div>
          <p className="text-muted mt-2">すでに別の方法でお支払い済みの場合は、本部へお知らせください。</p>
        </div>
      )}

      {checkoutUrl && (
        <a
          href={checkoutUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center mt-3 bg-hanko text-white rounded py-2 text-sm"
        >
          お支払いページを開く
        </a>
      )}
    </div>
  );
}
