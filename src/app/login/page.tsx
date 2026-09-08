"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signInWithCustomToken } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "@/lib/firebase";

type Mode = "honbu" | "member";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("member");
  const [memberNo, setMemberNo] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleHonbuLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.push("/admin");
    } catch {
      setError("メールアドレスまたはパスワードが正しくありません。");
    } finally {
      setLoading(false);
    }
  }

  async function handleMemberLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // verifyMemberLogin: Cloud Functions側で会員番号+メールの組み合わせを確認し、
      // 一致すればカスタムトークン（role等のクレーム付き）を返す
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
        <h1 className="text-xl font-bold text-matcha-deep text-center mb-1">稽古管理システム</h1>
        <p className="text-sm text-muted text-center mb-6">ログイン方法を選んでください</p>

        <div className="flex bg-matcha-pale/40 rounded-full p-1 mb-6">
          <button
            className={`flex-1 py-2 rounded-full text-sm ${mode === "member" ? "bg-matcha-deep text-white" : "text-muted"}`}
            onClick={() => setMode("member")}
          >
            マイページ／スタッフ
          </button>
          <button
            className={`flex-1 py-2 rounded-full text-sm ${mode === "honbu" ? "bg-matcha-deep text-white" : "text-muted"}`}
            onClick={() => setMode("honbu")}
          >
            本部
          </button>
        </div>

        {mode === "member" ? (
          <form onSubmit={handleMemberLogin} className="space-y-4">
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
          </form>
        ) : (
          <form onSubmit={handleHonbuLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">メールアドレス</label>
              <input
                type="email"
                className="w-full border border-line rounded px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">パスワード</label>
              <input
                type="password"
                className="w-full border border-line rounded px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
        )}
      </div>
    </div>
  );
}
