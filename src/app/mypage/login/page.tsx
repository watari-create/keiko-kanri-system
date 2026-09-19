"use client";

export const dynamic = "force-dynamic";

// マイページ（会員）専用のログインページ。
// 会員番号＋メールアドレスの組み合わせをCloud Functions（verifyMemberLogin）で確認する。
// 同じ関数はスタッフの組み合わせも確認できるため、万一スタッフの情報が入力された場合は
// /staff に振り分ける。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "@/lib/firebase";

export default function MemberLoginPage() {
  const router = useRouter();
  const [memberNo, setMemberNo] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lineNotice, setLineNotice] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("lineNotLinked") === "1") {
      setLineNotice(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const functions = getFunctions();
      const verify = httpsCallable<{ memberNo: string; email: string }, { token: string; role: string }>(
        functions,
        "verifyMemberLogin"
      );
      const result = await verify({ memberNo, email });
      await signInWithCustomToken(auth, result.data.token);
      router.push(result.data.role === "staff" ? "/staff" : "/mypage");
    } catch {
      setError("会員番号とメールアドレスの組み合わせが確認できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16 p-6">
      <div className="bg-paper border border-line rounded-md p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/nozoki-ume.png"
            alt="のぞき梅"
            className="w-20 h-20 mx-auto mb-3"
          />
          <div className="text-[11px] text-[#B8934A] tracking-widest mb-2">茶道宗徧流不審庵</div>
          <h1 className="text-xl font-bold text-matcha-deep">お稽古マイページ</h1>
        </div>
        <p className="text-sm text-muted text-center mb-6">会員番号とメールアドレスでログインします</p>
        {lineNotice && (
          <p className="text-xs text-matcha-deep bg-matcha-pale rounded-md p-3 mb-4">
            LINEでの自動ログインには、一度こちらからログインした上で、マイページの「公式LINEとの連携」から連携してください。次回からはLINEのメニューからすぐに開けるようになります。
          </p>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">会員番号</label>
            <input
              className="w-full border border-line rounded px-3 py-2 text-sm"
              value={memberNo}
              onChange={(e) => setMemberNo(e.target.value)}
              placeholder="例：30000001"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">メールアドレス</label>
            <input
              type="email"
              className="w-full border border-line rounded px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && <p className="text-hanko text-xs">{error}</p>}
          <button
            disabled={loading}
            className="w-full bg-matcha-deep text-white rounded py-3 text-sm disabled:opacity-50"
          >
            {loading ? "確認中…" : "ログイン"}
          </button>
          <a href="/enroll" className="block text-center text-xs text-muted underline mt-4">
            はじめての方・新しく入会される方はこちら
          </a>
        </form>
      </div>
    </div>
  );
}
