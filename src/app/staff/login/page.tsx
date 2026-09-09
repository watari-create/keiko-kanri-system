"use client";

export const dynamic = "force-dynamic";

// スタッフ（世話人・講師）専用のログインページ。
// ID（会員番号）＋メールアドレスの組み合わせをCloud Functions（verifyMemberLogin）で確認する。
// 同じ関数は会員の組み合わせも確認できるため、万一会員の情報が入力された場合は
// /mypage に振り分ける。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "@/lib/firebase";

export default function StaffLoginPage() {
  const router = useRouter();
  const [staffId, setStaffId] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      const result = await verify({ memberNo: staffId, email });
      await signInWithCustomToken(auth, result.data.token);
      router.push(result.data.role === "member" ? "/mypage" : "/staff");
    } catch {
      setError("IDとメールアドレスの組み合わせが確認できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16 p-6">
      <div className="bg-paper border border-line rounded-md p-8">
        <h1 className="text-xl font-bold text-matcha-deep text-center mb-1">スタッフ ログイン</h1>
        <p className="text-sm text-muted text-center mb-6">世話人・講師の方はこちらからログインします</p>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">ID（会員番号）</label>
            <input
              className="w-full border border-line rounded px-3 py-2 text-sm"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
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
        </form>

        <p className="text-center text-xs text-muted mt-6">
          会員の方（マイページ）は<a href="/mypage/login" className="underline">こちら</a>／本部の方は
          <a href="/login" className="underline">こちら</a>
        </p>
      </div>
    </div>
  );
}
