"use client";

// マイページの「お月謝のお支払い」欄。
//  - カード自動払い（Square、本システムから申込み）のご契約あり → カードと次回引き落とし日、「カードを変更する」
//  - 申込み対象 → 「カード自動払いを申し込む」
//  - それ以外（従来のSquare決済リンクでお支払い中の会員など）→ 従来どおりの案内文

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchSquareBillingInfo,
  cardLabel,
  formatJpDate,
  yen,
  SUBSCRIPTION_STATUS_LABEL,
  type SquareBillingInfo,
} from "@/lib/squareBilling";

function LegacyNotice() {
  return (
    <div className="text-xs text-muted bg-matcha-pale rounded-md p-3 space-y-1">
      <p>
        クレジットカード情報の変更は、ご登録時にSquareから届いた決済完了メール内の「このサブスクリプションを管理する」というリンクから、ご自身でお手続きいただけます。
      </p>
      <p>メールが見当たらない場合は、お手数ですが本部までご連絡ください。</p>
    </div>
  );
}

export default function MyPagePaymentCard() {
  const [info, setInfo] = useState<SquareBillingInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchSquareBillingInfo()
      .then(setInfo)
      .catch((e) => {
        console.warn("お支払い情報を取得できませんでした", e);
        setFailed(true);
      });
  }, []);

  const sub = info?.subscription;
  const hasLiveSub = sub && ["PENDING", "ACTIVE", "PAUSED"].includes(sub.status);

  return (
    <div className="bg-paper border border-line rounded-lg p-5 mb-4">
      <h2 className="text-base font-bold text-ink mb-3 pl-2 border-l-4 border-matcha">お月謝のお支払い</h2>
      {!info && !failed && <p className="text-xs text-muted">読み込み中…</p>}
      {(failed || (info && !sub && !info.eligible)) && <LegacyNotice />}

      {info && !sub && info.eligible && info.migration && info.schedules[0] && (
        <p className="text-xs text-matcha-deep bg-matcha-pale rounded-md p-3 mb-3 leading-relaxed">
          {Number(info.schedules[0].startMonth.slice(5, 7))}月分から、お月謝のお支払い方法が新しくなります（毎月25日に翌月分をカードで自動払い）。
          お手数ですが、下のボタンからカードのご登録をお願いいたします。
        </p>
      )}

      {info && sub && (
        <>
          <div className="text-sm space-y-1 mb-3">
            <div className="flex justify-between border-b border-line py-1">
              <span className="text-muted">カード自動払い</span>
              <span>{SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status}</span>
            </div>
            <div className="flex justify-between border-b border-line py-1">
              <span className="text-muted">{sub.label}</span>
              <span>{yen(sub.amount)}／月</span>
            </div>
            {hasLiveSub && sub.status !== "PAUSED" && (
              <div className="flex justify-between border-b border-line py-1">
                <span className="text-muted">次回のお引き落とし</span>
                <span>{formatJpDate(sub.nextBillingDate)}</span>
              </div>
            )}
            <div className="flex justify-between border-b border-line py-1">
              <span className="text-muted">お支払いカード</span>
              <span>{cardLabel(sub.cardBrand, sub.cardLast4)}</span>
            </div>
          </div>
          {sub.lastFailureAt && (!sub.lastPaymentAt || sub.lastFailureAt > sub.lastPaymentAt) && (
            <p className="text-xs text-hanko bg-hanko-pale rounded p-2 mb-3">
              前回のお引き落としができませんでした。カードの変更をお願いいたします。
            </p>
          )}
          {hasLiveSub && (
            <Link
              href="/mypage/payment?mode=change"
              className="block text-center w-full border border-matcha-deep text-matcha-deep rounded py-2 text-sm"
            >
              お支払いカードを変更する
            </Link>
          )}
        </>
      )}

      {info && !sub && info.eligible && (
        <>
          <p className="text-xs text-muted mb-3">
            お月謝（{yen(info.amount)}／月・前払い）を、毎月{info.billingDay}日に翌月分をクレジットカードで自動でお支払いいただけます。
          </p>
          <Link
            href="/mypage/payment"
            className="block text-center w-full bg-btn text-btn-ink rounded py-2.5 text-sm"
          >
            カード自動払いを申し込む
          </Link>
        </>
      )}
    </div>
  );
}
