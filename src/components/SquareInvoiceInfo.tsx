"use client";

// 経理タブ：Squareの請求書（許状代金・入会金）の送信状況を1行で表示する。
// 送れなかった場合や、まだ送っていない場合は「Squareで請求書を送る」ボタンを出す。
import type { SquareInvoiceSummary } from "@/types";

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export default function SquareInvoiceInfo({
  invoice,
  error,
  paid,
  sending,
  onSend,
  paidNote,
  waitingNote,
}: {
  // 請求書ではなく、カード登録時・支払いページでいただいた場合の表示（入会金）
  paidNote?: string;
  // まだ請求書を送っていない理由（入会金：最初のお支払いと一緒にいただく予定）
  waitingNote?: string;
  invoice?: SquareInvoiceSummary;
  error?: string;
  paid: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  if (paidNote) {
    return (
      <div className="text-xs text-matcha-deep mt-1">
        {paidNote}
        {invoice?.status === "CANCELED" && <span className="text-muted">（先に送った請求書は取り消し済み）</span>}
      </div>
    );
  }
  if (invoice && invoice.status !== "CANCELED") {
    const overdue = invoice.status === "UNPAID" && !paid && invoice.dueDate < todayJst();
    return (
      <div className="text-xs text-muted mt-1">
        Square請求書 {invoice.number ? `#${invoice.number}` : ""}　
        {invoice.status === "PAID" ? (
          <span className="text-matcha-deep">Squareで入金済（{invoice.paidAt?.slice(0, 10)}）</span>
        ) : (
          <>
            送信済（{invoice.sentAt.slice(0, 10)}）・お支払い期日 {invoice.dueDate}
            {overdue && <span className="text-hanko font-semibold">　期日超過</span>}
          </>
        )}
        {invoice.url && (
          <>
            　
            <a href={invoice.url} target="_blank" rel="noreferrer" className="underline">
              請求書を見る
            </a>
          </>
        )}
      </div>
    );
  }
  if (paid) return null;
  return (
    <div className="text-xs mt-1 flex flex-wrap items-center gap-2">
      {error ? (
        <span className="text-hanko">自動送信できませんでした：{error}</span>
      ) : (
        <span className="text-muted">
          {invoice?.status === "CANCELED" ? "請求書はキャンセルされています" : waitingNote ?? "Squareの請求書は未送信です"}
        </span>
      )}
      <button
        className="border border-matcha-deep text-matcha-deep rounded px-2 py-1 disabled:opacity-50"
        disabled={sending}
        onClick={onSend}
      >
        {sending ? "送信中…" : "Squareで請求書を送る"}
      </button>
    </div>
  );
}
