"use client";

// 管理画面の会員詳細：お月謝のカード自動払い（Square）の契約状況と入金履歴（閲覧のみ）。
// 契約の作成・カード変更は会員本人がマイページから行い、記録はCloud Functionsが書き込む。

import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { cardLabel, formatJpDate, yen, SUBSCRIPTION_STATUS_LABEL } from "@/lib/squareBilling";

interface SubDoc {
  status: string;
  amount?: number;
  label?: string;
  startDate?: string;
  startMonth?: string;
  migratedFromLink?: boolean;
  legacyCancelStatus?: string;
  legacyCancelNote?: string;
  cardBrand?: string;
  cardLast4?: string;
  squareSubscriptionId?: string;
  environment?: string;
  lastPaymentAt?: string;
  lastFailureAt?: string;
  createdAt?: string;
  cancelRequestedAt?: string;
  cancelScheduledDate?: string | null;
  cancelReason?: string;
}
interface PaymentDoc {
  id: string;
  kind: string;
  amount?: number | null;
  receivedAt: string;
}

export default function AdminSubscriptionStatus({ memberId }: { memberId: string }) {
  const [sub, setSub] = useState<SubDoc | null | undefined>(undefined);
  const [payments, setPayments] = useState<PaymentDoc[]>([]);

  useEffect(() => {
    const unsub1 = onSnapshot(
      doc(db, "memberSubscriptions", memberId),
      (s) => setSub(s.exists() ? (s.data() as SubDoc) : null),
      () => setSub(null)
    );
    const unsub2 = onSnapshot(
      query(collection(db, "memberSubscriptions", memberId, "payments"), orderBy("receivedAt", "desc"), limit(6)),
      (s) => setPayments(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentDoc, "id">) }))),
      () => setPayments([])
    );
    return () => {
      unsub1();
      unsub2();
    };
  }, [memberId]);

  if (sub === undefined) return <p className="text-xs text-muted">読み込み中…</p>;
  if (!sub || sub.status === "CREATING") {
    return <p className="text-xs text-muted">システムからのカード自動払いのお申込みはありません。</p>;
  }
  return (
    <div className="text-xs space-y-1">
      <div>
        <span className="font-bold text-matcha-deep">{SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status}</span>
        {sub.environment && sub.environment !== "production" && <span className="ml-2 text-hanko">（テスト環境）</span>}
      </div>
      <div>
        {sub.label}：{yen(sub.amount)}／月（前払い・毎月25日に翌月分）{sub.startMonth ? `　${sub.startMonth.replace("-", "年")}月から参加` : ""}
      </div>
      <div>カード：{cardLabel(sub.cardBrand, sub.cardLast4)}</div>
      {sub.cancelRequestedAt && (
        <div className="text-hanko">
          {sub.cancelReason ?? "解約"}により解約済み（{formatJpDate(sub.cancelRequestedAt)}）
          {sub.cancelScheduledDate ? `　${sub.cancelScheduledDate}で停止・以降の引き落としなし` : "　以降の引き落としなし"}
        </div>
      )}
      {sub.migratedFromLink && (
        <div className={sub.legacyCancelStatus === "pending" ? "text-hanko" : "text-muted"}>
          決済リンクの旧契約：
          {sub.legacyCancelStatus === "done"
            ? "解約済み（または見つからず）"
            : sub.legacyCancelStatus === "pending"
            ? "前月分の引き落とし後に自動解約（毎朝確認）"
            : "Squareで確認してください"}
          {sub.legacyCancelNote && <div className="whitespace-pre-wrap text-muted">{sub.legacyCancelNote}</div>}
        </div>
      )}
      {sub.lastFailureAt && (!sub.lastPaymentAt || sub.lastFailureAt > sub.lastPaymentAt) && (
        <div className="text-hanko">⚠️ 直近の引き落としに失敗（{formatJpDate(sub.lastFailureAt)}）</div>
      )}
      {payments.length > 0 && (
        <ul className="mt-1 border-t border-line pt-1">
          {payments.map((p) => (
            <li key={p.id} className={p.kind === "入金" ? "" : "text-hanko"}>
              {formatJpDate(p.receivedAt)}　{p.kind}
              {typeof p.amount === "number" ? `　${yen(p.amount)}` : ""}
            </li>
          ))}
        </ul>
      )}
      {sub.squareSubscriptionId && (
        <div className="text-muted">SquareサブスクリプションID：{sub.squareSubscriptionId}（解約・金額変更はSquareのダッシュボードで）</div>
      )}
    </div>
  );
}
