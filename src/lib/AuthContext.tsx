"use client";

// ログイン状態と役割（本部／世話人／講師／会員）をアプリ全体で参照できるようにするContext。
// 役割はFirebase Authのカスタムクレーム（Cloud Functionsで設定する想定）から読み取る。
// カスタムクレームの設定方法はSETUP.mdを参照。
//
// 2026-10-14〜 本部は権限レベル（honbuLevel）で3段階に分かれる：
//   admin（アドミン）… すべての編集＋バックアップ・操作ログ・ログイン履歴・権限管理
//   editor（編集できる）… これまでの本部と同じ
//   viewer（閲覧のみ）… どの画面も見られるが、追加・変更・削除・送信はできない
// honbuLevel が付いていない本部アカウント（この仕組みより前に作ったもの）は admin として扱う。

import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { auth } from "./firebase";

type Role = "honbu" | "staff" | "member" | "keikoNoteGuest" | null;
export type HonbuLevel = "admin" | "editor" | "viewer";

export const HONBU_LEVEL_LABEL: Record<HonbuLevel, string> = {
  admin: "アドミン",
  editor: "編集できる",
  viewer: "閲覧のみ",
};

interface AuthState {
  user: User | null;
  role: Role;
  /** 本部の権限レベル。本部でなければ null */
  honbuLevel: HonbuLevel | null;
  /** 本部として、データを変更できるか（アドミン・編集できる） */
  canEdit: boolean;
  /** アドミンか */
  isAdmin: boolean;
  staffId?: string;
  memberId?: string;
  loading: boolean;
}

const EMPTY: AuthState = { user: null, role: null, honbuLevel: null, canEdit: false, isAdmin: false, loading: false };

const AuthContext = createContext<AuthState>({ ...EMPTY, loading: true });

function honbuLevelOf(claims: Record<string, unknown>): HonbuLevel | null {
  if (claims.role !== "honbu") return null;
  const lv = claims.honbuLevel;
  return lv === "editor" || lv === "viewer" || lv === "admin" ? lv : "admin";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...EMPTY, loading: true });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState(EMPTY);
        return;
      }
      // カスタムクレームを読む（role, staffId, memberId をCloud Functions側で設定しておく）
      let tokenResult = await user.getIdTokenResult();
      // 本部は、アドミンが権限を変えたらすぐ反映されるよう、最新のクレームを取り直す
      if ((tokenResult.claims as Record<string, unknown>).role === "honbu") {
        try {
          tokenResult = await user.getIdTokenResult(true);
        } catch (e) {
          // アドミンが権限を下げた・外したときはログインが無効になっているので、ログアウトして入り直してもらう
          if ((e as { code?: string })?.code === "auth/user-token-expired" || (e as { code?: string })?.code === "auth/user-disabled") {
            await signOut(auth);
            return;
          }
          // 通信エラーなどで取り直せなくても、手元のクレームで続ける（サーバー側でも権限を確認している）
        }
      }
      const claims = tokenResult.claims as Record<string, unknown>;
      const honbuLevel = honbuLevelOf(claims);
      setState({
        user,
        role: (claims.role as Role) ?? null,
        honbuLevel,
        canEdit: honbuLevel === "admin" || honbuLevel === "editor",
        isAdmin: honbuLevel === "admin",
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
