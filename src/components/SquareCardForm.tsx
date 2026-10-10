"use client";

// Square Web Payments SDK のカード入力欄。
// カード番号などはSquareが用意する入力欄（iframe）に直接入力され、このシステムには届かない。
// 「登録」を押すと、3Dセキュア（本人認証）を含めてSquareがカードを確認し、
// 使い捨ての「トークン」だけを onToken に渡す。

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    Square?: any;
  }
}

const SCRIPT_URL = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};

function loadSquareScript(environment: string): Promise<void> {
  const src = environment === "production" ? SCRIPT_URL.production : SCRIPT_URL.sandbox;
  if (window.Square) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(s);
  });
}

export default function SquareCardForm({
  applicationId,
  locationId,
  environment,
  buyerName,
  buyerEmail,
  submitLabel,
  onToken,
  disabled,
}: {
  applicationId: string;
  locationId: string;
  environment: string;
  buyerName: string;
  buyerEmail: string;
  submitLabel: string;
  onToken: (token: string) => Promise<void>;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSquareScript(environment);
        if (cancelled || !window.Square) return;
        const payments = window.Square.payments(applicationId, locationId);
        const card = await payments.card();
        if (cancelled) {
          card.destroy?.();
          return;
        }
        await card.attach(containerRef.current);
        cardRef.current = card;
        setReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("カード入力欄を読み込めませんでした。ページを再読み込みしてください。");
      }
    })();
    return () => {
      cancelled = true;
      cardRef.current?.destroy?.();
      cardRef.current = null;
    };
  }, [applicationId, locationId, environment]);

  async function submit() {
    if (!cardRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cardRef.current.tokenize({
        intent: "STORE",
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: {
          familyName: buyerName || undefined,
          email: buyerEmail || undefined,
          countryCode: "JP",
        },
      });
      if (result.status !== "OK" || !result.token) {
        const detail = result.errors?.[0]?.message;
        setError(detail ? `カード情報をご確認ください（${detail}）` : "カード情報をご確認ください。");
        return;
      }
      await onToken(result.token);
    } catch (e) {
      setError((e as Error)?.message || "処理に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {environment !== "production" && (
        <p className="text-[11px] text-hanko bg-hanko-pale rounded px-2 py-1 mb-2">
          テスト環境です（実際の請求は発生しません）。テスト用カード：4111 1111 1111 1111
        </p>
      )}
      <div ref={containerRef} className="min-h-[90px]" />
      {!ready && !error && <p className="text-xs text-muted mb-2">カード入力欄を読み込み中…</p>}
      {error && <p className="text-hanko text-xs mb-2 whitespace-pre-wrap">{error}</p>}
      <button
        className="w-full bg-btn text-btn-ink rounded py-2.5 text-sm disabled:opacity-50"
        onClick={submit}
        disabled={!ready || busy || disabled}
      >
        {busy ? "処理中…（画面を閉じずにお待ちください）" : submitLabel}
      </button>
      <p className="text-[11px] text-muted mt-2">
        カード情報は決済代行会社Square（スクエア）が安全に管理し、本システムには保存されません。
      </p>
    </div>
  );
}
