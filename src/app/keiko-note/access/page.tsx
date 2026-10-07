"use client";

export const dynamic = "force-dynamic";

// お稽古ノート（/keiko-note）用の合言葉入力ページ。
// お稽古ノートのページ（src/app/keiko-note/page.tsx）が、ログインしていない人をここへ誘導する。

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getFunctions, httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";
import "../keiko-note.css";

function AccessForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/keiko-note-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (data.ok) {
        // 会員・スタッフ・本部としてログインしていなければ、閲覧専用ゲストとしてログインする
        // （お稽古ノートのデータはログイン中の人しか読めないため）
        if (!auth.currentUser) {
          const guestLogin = httpsCallable<{ code: string }, { token: string }>(getFunctions(), "keikoNoteGuestLogin");
          const result = await guestLogin({ code });
          await signInWithCustomToken(auth, result.data.token);
        }
        const next = searchParams.get("next") || "/keiko-note";
        window.location.href = next; // Cookie発行直後なので確実に再取得させる
      } else {
        setError("合言葉が正しくありません。");
      }
    } catch {
      setError("確認できませんでした。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="keiko-note-page">
      <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 20px" }}>
        <div className="form-panel">
          <p className="form-title">お稽古ノート</p>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 18, lineHeight: 1.6 }}>
            こちらは会員限定のページです。お配りした合言葉を入力してください。
          </p>
          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <label>合言葉</label>
              <input
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </div>
            {error && <p style={{ color: "#b3453b", fontSize: 13, marginBottom: 12 }}>{error}</p>}
            <button type="submit" className="btn-primary" disabled={loading} style={{ width: "100%" }}>
              {loading ? "確認中…" : "入る"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function KeikoNoteAccessPage() {
  return (
    <Suspense fallback={null}>
      <AccessForm />
    </Suspense>
  );
}
