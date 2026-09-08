"use client";

// ログイン状態と役割（本部／世話人／講師／会員）をアプリ全体で参照できるようにするContext。
// 役割はFirebase Authのカスタムクレーム（Cloud Functionsで設定する想定）から読み取る。
// カスタムクレームの設定方法はSETUP.mdを参照。

import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "./firebase";

type Role = "honbu" | "staff" | "member" | null;

interface AuthState {
  user: User | null;
  role: Role;
  staffId?: string;
  memberId?: string;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  role: null,
  loading: true,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, role: null, loading: true });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState({ user: null, role: null, loading: false });
        return;
      }
      // カスタムクレームを読む（role, staffId, memberId をCloud Functions側で設定しておく）
      const tokenResult = await user.getIdTokenResult();
      const claims = tokenResult.claims as Record<string, unknown>;
      setState({
        user,
        role: (claims.role as Role) ?? null,
        staffId: claims.staffId as string | undefined,
        memberId: claims.memberId as string | undefined,
        loading: false,
      });
    });
    return () => unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
