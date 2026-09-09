"use client";

export const dynamic = "force-dynamic";

// 本部専用のログインページ。
// マイページ（会員）は /mypage/login、スタッフ（世話人・講師）は /staff/login に分離している。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function LoginPage() {
  const router = useRouter();
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

  return (
    <div className="max-w-md mx-auto mt-16 p-6">
      <div className="bg-paper border border-line rounded-md p-8">
        <h1 className="text-xl font-bold text-matcha-deep text-center mb-1">本部 ログイン</h1>
        <p className="text-sm text-muted text-center mb-6">メールアドレスとパスワードでログインします</p>

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

        <p className="text-center text-xs text-muted mt-6">
          会員の方（マイページ）は<a href="/mypage/login" className="underline">こちら</a>／
          世話人・講師の方は<a href="/staff/login" className="underline">こちら</a>
        </p>
      </div>
    </div>
  );
}
