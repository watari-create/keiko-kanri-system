"use client";

export const dynamic = "force-dynamic";

// LIFF（LINE Front-end Framework）経由での会員LINEアカウント連携ページ。
// マイページの「LINEでログインして連携する」リンクは https://liff.line.me/{LIFF_ID} を開き、
// そのLIFFアプリの「エンドポイントURL」としてこのページが登録されている想定。
// LINEアプリ内ブラウザ・通常ブラウザのどちらで開かれても、LIFF SDKが必要に応じて
// LINEログインへリダイレクトし、戻ってきたときにこのページが再度読み込まれる。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { getFunctions, httpsCallable } from "firebase/functions";
import { useAuth } from "@/lib/AuthContext";

declare global {
  interface Window {
    liff?: {
      init: (config: { liffId: string | undefined }) => Promise<void>;
      isLoggedIn: () => boolean;
      login: () => void;
      getIDToken: () => string | null;
    };
  }
}

export default function LineLinkPage() {
  const { role, loading } = useAuth();
  const router = useRouter();
  const [sdkReady, setSdkReady] = useState(false);
  const [status, setStatus] = useState("読み込み中…");

  useEffect(() => {
    if (loading) return;
    if (role !== "member") {
      router.replace("/mypage/login");
      return;
    }
    if (!sdkReady || !window.liff) return;

    let cancelled = false;

    (async () => {
      try {
        setStatus("LINEと通信しています…");
        await window.liff!.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID });
        if (cancelled) return;

        if (!window.liff!.isLoggedIn()) {
          // ここでLINEログイン画面へリダイレクトされ、完了後にこのページへ戻ってくる
          window.liff!.login();
          return;
        }

        const idToken = window.liff!.getIDToken();
        if (!idToken) {
          router.replace("/mypage?lineLinked=error");
          return;
        }

        const link = httpsCallable<{ idToken: string }, { ok: boolean }>(
          getFunctions(),
          "linkLineViaLiff"
        );
        await link({ idToken });
        if (!cancelled) router.replace("/mypage?lineLinked=success");
      } catch (err) {
        console.error("LIFF連携でエラーが発生しました", err);
        if (!cancelled) router.replace("/mypage?lineLinked=error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, role, sdkReady, router]);

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onLoad={() => setSdkReady(true)}
      />
      <div className="p-8 text-center text-muted text-sm">{status}</div>
    </>
  );
}
