"use client";

export const dynamic = "force-dynamic";

// LIFF（LINE Front-end Framework）経由でのマイページ入口ページ。
// LIFFアプリのエンドポイントURL（https://liff.line.me/{LIFF_ID}）としてこのページが
// 登録されている想定で、2つの入口を1つのページで兼ねている。
//
// 1. LINE公式アカウントのリッチメニュー「マイページ」ボタン（未ログイン状態で開かれる）
//    → LINEアカウントが既に会員と連携済みなら、ID Tokenだけでそのままマイページに
//      自動ログインする（毎回会員番号・メールアドレスを入力しなくてよい）。
//    → まだ連携されていない場合は、通常のログイン画面へ案内する。
// 2. マイページ内「LINEでログインして連携する」リンク（会員としてログイン済みの状態で開かれる）
//    → LINEアカウントをこの会員に連携する（lineUserIdを保存する、従来通りの挙動）。
//
// LINEアプリ内ブラウザ・通常ブラウザのどちらで開かれても、LIFF SDKが必要に応じて
// LINEログインへリダイレクトし、戻ってきたときにこのページが再度読み込まれる。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { getFunctions, httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";
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
    if (!sdkReady || !window.liff) return;

    let cancelled = false;
    const alreadyMember = role === "member";

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
          router.replace(alreadyMember ? "/mypage?lineLinked=error" : "/mypage/login");
          return;
        }

        if (alreadyMember) {
          // マイページにログイン済み：LINEアカウントをこの会員に連携する
          const link = httpsCallable<{ idToken: string }, { ok: boolean }>(
            getFunctions(),
            "linkLineViaLiff"
          );
          await link({ idToken });
          if (!cancelled) router.replace("/mypage?lineLinked=success");
          return;
        }

        // 未ログイン（リッチメニューからの起動）：連携済みのLINEアカウントなら自動ログインする
        setStatus("マイページにログインしています…");
        const loginViaLine = httpsCallable<
          { idToken: string },
          { linked: boolean; token?: string }
        >(getFunctions(), "loginViaLine");
        const result = await loginViaLine({ idToken });
        if (cancelled) return;

        if (result.data.linked && result.data.token) {
          await signInWithCustomToken(auth, result.data.token);
          if (!cancelled) router.replace("/mypage");
        } else {
          // まだLINE連携されていない会員：通常のログイン画面へ
          // （ログイン後、マイページの「公式LINEとの連携」から連携すれば次回から自動ログインできる）
          if (!cancelled) router.replace("/mypage/login?lineNotLinked=1");
        }
      } catch (err) {
        console.error("LINE連携・ログインでエラーが発生しました", err);
        if (!cancelled) router.replace(alreadyMember ? "/mypage?lineLinked=error" : "/mypage/login");
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
