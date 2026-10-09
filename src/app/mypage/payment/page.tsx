"use client";

export const dynamic = "force-dynamic";

// マイページ：お月謝のカード自動払い（Square）
//  - 未申込み：①ご確認 → ②カード情報の入力 → ③お申込み完了
//  - 申込み済み：ご契約内容の表示と「お支払いカードの変更」

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/AuthContext";
import SquareCardForm from "@/components/SquareCardForm";
import {
  fetchSquareBillingInfo,
  startSquareSubscription,
  updateSquareSubscriptionCard,
  callableErrorMessage,
  cardLabel,
  formatJpDate,
  yen,
  formatYm,
  SUBSCRIPTION_STATUS_LABEL,
  type SquareBillingInfo,
  type BillingSchedule,
} from "@/lib/squareBilling";

type Step = "confirm" | "card" | "done" | "changeCard" | "changed";

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const items = ["ご確認", "カード情報", "完了"];
  return (
    <ol className="flex items-center justify-between mb-5 text-[11px]">
      {items.map((label, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <li key={label} className="flex-1 flex flex-col items-center">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center mb-1 ${
                active ? "bg-matcha-deep text-white" : done ? "bg-matcha-pale text-matcha-deep" : "bg-bg border border-line text-muted"
              }`}
            >
              {done ? "✓" : n}
            </span>
            <span className={active ? "text-matcha-deep font-bold" : "text-muted"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-line py-1.5 text-sm">
      <span className="text-muted shrink-0 mr-3">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export default function PaymentPage() {
  const router = useRouter();
  const { role, loading } = useAuth();
  const [info, setInfo] = useState<SquareBillingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("confirm");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    schedule?: BillingSchedule;
    card?: string;
    entryFee?: { amount: number; label: string } | null;
  } | null>(null);
  const [startMonth, setStartMonth] = useState<string>("");

  useEffect(() => {
    if (!loading && role !== "member") router.replace("/mypage/login");
  }, [loading, role, router]);

  async function reload() {
    try {
      const data = await fetchSquareBillingInfo();
      setInfo(data);
      if (data.schedules?.[0]) setStartMonth((prev) => prev || data.schedules[0].startMonth);
      const wantsChange = new URLSearchParams(window.location.search).get("mode") === "change";
      if (data.subscription && wantsChange) setStep("changeCard");
    } catch (e) {
      setLoadError(callableErrorMessage(e));
    }
  }

  useEffect(() => {
    if (role === "member") reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function handleStart(token: string) {
    setError(null);
    try {
      const r = await startSquareSubscription(token, startMonth);
      setResult({ schedule: r.schedule, card: cardLabel(r.cardBrand, r.cardLast4), entryFee: r.entryFee ?? null });
      setStep("done");
      fetchSquareBillingInfo().then(setInfo).catch(() => undefined);
    } catch (e) {
      setError(callableErrorMessage(e));
    }
  }

  async function handleChange(token: string) {
    setError(null);
    try {
      const r = await updateSquareSubscriptionCard(token);
      setResult({ card: cardLabel(r.cardBrand, r.cardLast4) });
      setStep("changed");
      fetchSquareBillingInfo().then(setInfo).catch(() => undefined);
    } catch (e) {
      setError(callableErrorMessage(e));
    }
  }

  const back = (
    <Link href="/mypage" className="text-xs text-muted underline">
      ← マイページに戻る
    </Link>
  );

  if (loading || (!info && !loadError)) {
    return <div className="max-w-md mx-auto p-6 text-sm text-muted">読み込み中…</div>;
  }
  if (loadError || !info) {
    return (
      <div className="max-w-md mx-auto p-6">
        {back}
        <p className="text-hanko text-sm mt-4">{loadError}</p>
      </div>
    );
  }

  const sub = info.subscription;
  const schedule = info.schedules.find((x) => x.startMonth === startMonth) ?? info.schedules[0];
  // 本日のお引き落とし（入会金がまだの方は入会金も一緒に）
  const nowLabel = (sc: BillingSchedule, entry: { amount: number } | null | undefined = info.entryFee) => {
    const entryAmount = entry?.amount ?? 0;
    const total = (info.amount ?? 0) * sc.nowCount + entryAmount;
    const items = [...(entryAmount ? ["入会金"] : []), ...sc.nowItems];
    return total === 0 ? "なし" : `${yen(total)}（${items.join("・")}）`;
  };
  const card = (
    <div className="bg-paper border border-line rounded-md p-6 mb-4">
      {/* ---- 申込み済み：ご契約内容 ---- */}
      {sub && step !== "done" && step !== "changeCard" && step !== "changed" && (
        <>
          <h1 className="text-base font-bold text-matcha-deep mb-3">お月謝のカード自動払い</h1>
          <Row label="ご契約" value={SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status} />
          <Row label={sub.label} value={`${yen(sub.amount)}／月`} />
          <Row label="お引き落とし日" value={`毎月${info.billingDay}日（翌月分）`} />
          {["PENDING", "ACTIVE"].includes(sub.status) && <Row label="次回のお引き落とし" value={formatJpDate(sub.nextBillingDate)} />}
          <Row label="お支払いカード" value={cardLabel(sub.cardBrand, sub.cardLast4)} />
          {sub.cardExpMonth && sub.cardExpYear && (
            <Row label="有効期限" value={`${String(sub.cardExpMonth).padStart(2, "0")}/${sub.cardExpYear}`} />
          )}
          {sub.lastPaymentAt && <Row label="前回のお支払い" value={formatJpDate(sub.lastPaymentAt)} />}
          {sub.lastFailureAt && (!sub.lastPaymentAt || sub.lastFailureAt > sub.lastPaymentAt) && (
            <p className="text-xs text-hanko bg-hanko-pale rounded p-2 mt-3">
              前回のお引き落としができませんでした。お手数ですが、下の「お支払いカードを変更する」から有効なカードをご登録ください。Squareからお送りした請求書メールからもお支払いいただけます。
            </p>
          )}
          {["PENDING", "ACTIVE", "PAUSED"].includes(sub.status) && (
            <button
              className="w-full mt-4 border border-matcha-deep text-matcha-deep rounded py-2 text-sm"
              onClick={() => {
                setError(null);
                setStep("changeCard");
              }}
            >
              お支払いカードを変更する
            </button>
          )}
          <p className="text-[11px] text-muted mt-3">ご解約・金額の変更は本部までご連絡ください。</p>
        </>
      )}

      {/* ---- カード変更 ---- */}
      {sub && step === "changeCard" && (
        <>
          <h1 className="text-base font-bold text-matcha-deep mb-1">お支払いカードの変更</h1>
          <p className="text-xs text-muted mb-4">
            現在のカード：{cardLabel(sub.cardBrand, sub.cardLast4)}
            <br />
            新しいカードを登録すると、次回（{formatJpDate(sub.nextBillingDate)}）以降のお引き落としは新しいカードになります。
          </p>
          <SquareCardForm
            applicationId={info.square.applicationId}
            locationId={info.square.locationId}
            environment={info.square.environment}
            buyerName={info.memberName}
            buyerEmail={info.email}
            submitLabel="このカードに変更する"
            onToken={handleChange}
          />
          {error && <p className="text-hanko text-xs mt-3">{error}</p>}
          <button className="w-full mt-3 text-xs text-muted underline" onClick={() => setStep("confirm")}>
            変更せずに戻る
          </button>
        </>
      )}
      {step === "changed" && (
        <div className="text-center">
          <div className="text-3xl mb-2">✓</div>
          <h1 className="text-base font-bold text-matcha-deep mb-2">カードを変更しました</h1>
          <p className="text-sm">{result?.card}</p>
          <p className="text-xs text-muted mt-2">次回のお引き落としから新しいカードでお支払いいただきます。</p>
        </div>
      )}

      {/* ---- 新規申込み ---- */}
      {!sub && step === "confirm" && (
        <>
          <Steps current={1} />
          <h1 className="text-base font-bold text-matcha-deep mb-3">お月謝のカード自動払い お申込み</h1>
          {!info.eligible ? (
            <p className="text-sm text-muted">
              カード自動払いのお申込み対象ではありません。お月謝のお支払いについては本部までお問い合わせください。
            </p>
          ) : (
            <>
              <Row label="お名前" value={`${info.memberName} 様`} />
              <Row label={info.label} value={`${yen(info.amount)}／月`} />
              {info.entryFee && <Row label={`${info.entryFee.label}（初回のみ）`} value={yen(info.entryFee.amount)} />}
              {info.schedules.length > 1 ? (
                <div className="border-b border-line py-2 text-sm">
                  <div className="text-muted mb-1">お稽古の参加開始月</div>
                  <div className="flex gap-2">
                    {info.schedules.map((sc) => (
                      <label
                        key={sc.startMonth}
                        className={`flex-1 text-center rounded border py-2 cursor-pointer ${
                          startMonth === sc.startMonth ? "border-matcha-deep bg-matcha-pale text-matcha-deep font-bold" : "border-line text-muted"
                        }`}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          checked={startMonth === sc.startMonth}
                          onChange={() => setStartMonth(sc.startMonth)}
                        />
                        {formatYm(sc.startMonth)}から
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                schedule && <Row label="お稽古の参加開始月" value={`${formatYm(schedule.startMonth)}から`} />
              )}
              {schedule && (
                <>
                  <Row label="本日のお引き落とし" value={nowLabel(schedule)} />
                  <Row label="次回のお引き落とし" value={`${formatJpDate(schedule.nextDate)}（${schedule.nextMonth}）`} />
                </>
              )}
              <Row label="以降のお引き落とし" value={`毎月${info.billingDay}日に翌月分`} />
              <Row label="お支払い方法" value="クレジットカード" />
              {info.migration && info.legacyLink !== false && schedule && (
                <p className="text-xs text-matcha-deep bg-matcha-pale rounded p-3 mt-3 leading-relaxed">
                  これまでの決済リンク（Square）でのお支払いは、{formatYm(schedule.startMonth)}分の前月分までで終了します。
                  旧契約の解約は本部でお手続きしますので、お客様のお手続きは不要です。
                </p>
              )}
              <ul className="text-xs text-muted list-disc pl-4 mt-3 space-y-1">
                <li>お月謝は前払いです。毎月{info.billingDay}日に、翌月分をご登録のカードから自動でお引き落としします。</li>
                <li>参加開始月の分は、お申込み時（または参加開始月の前月{info.billingDay}日）にお引き落としします。</li>
                {info.entryFee && <li>入会金は、お申込み時に同じカードからお引き落としします（初回のみ）。</li>}
                <li>領収書（レシート）はSquareからメールでお送りします。</li>
                <li>カードはこのマイページからいつでも変更できます。</li>
                <li>休会・退会の際は、マイページのお申請または本部へのご連絡をお願いします。</li>
              </ul>
              <label className="flex items-start gap-2 text-sm mt-4">
                <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>上記の内容に同意して、カード自動払いを申し込みます</span>
              </label>
              <button
                className="w-full mt-4 bg-matcha-deep text-white rounded py-2.5 text-sm disabled:opacity-50"
                disabled={!agreed}
                onClick={() => setStep("card")}
              >
                カード情報の入力へ進む
              </button>
            </>
          )}
        </>
      )}
      {!sub && step === "card" && (
        <>
          <Steps current={2} />
          <h1 className="text-base font-bold text-matcha-deep mb-1">カード情報の入力</h1>
          <p className="text-xs text-muted mb-4">
            {info.label} {yen(info.amount)}／月
            {schedule && (
              <>
                <br />
                {formatYm(schedule.startMonth)}から参加　本日のお引き落とし：{nowLabel(schedule)}
              </>
            )}
          </p>
          <SquareCardForm
            applicationId={info.square.applicationId}
            locationId={info.square.locationId}
            environment={info.square.environment}
            buyerName={info.memberName}
            buyerEmail={info.email}
            submitLabel="カードを登録して申し込む"
            onToken={handleStart}
          />
          {error && <p className="text-hanko text-xs mt-3">{error}</p>}
          <button className="w-full mt-3 text-xs text-muted underline" onClick={() => setStep("confirm")}>
            ← 内容の確認に戻る
          </button>
        </>
      )}
      {step === "done" && (
        <>
          <Steps current={3} />
          <div className="text-center">
            <div className="text-3xl mb-2">✓</div>
            <h1 className="text-base font-bold text-matcha-deep mb-3">お申込みが完了しました</h1>
          </div>
          <Row label="お支払いカード" value={result?.card} />
          {result?.schedule && (
            <>
              <Row label="本日のお引き落とし" value={nowLabel(result.schedule, result.entryFee)} />
              <Row
                label="次回のお引き落とし"
                value={`${formatJpDate(result.schedule.nextDate)}（${result.schedule.nextMonth}）`}
              />
            </>
          )}
          <Row label="以降のお引き落とし" value={`毎月${info.billingDay}日に翌月分`} />
          <p className="text-xs text-muted mt-3">
            お引き落としのたびに、Squareから領収書のメールが届きます。カードの変更はマイページの「お月謝のお支払い」からいつでも行えます。
          </p>
        </>
      )}
    </div>
  );

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-4">{back}</div>
      {card}
    </div>
  );
}
