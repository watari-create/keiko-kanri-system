"use client";

// ログイン状態と役割（本部／世話人／講師／会員）をアプリ全体で参照できるようにするContext。
// 役割はFirebase Authのカスタムクレーム（Cloud Functionsで設定する想定）から読み取る。
// カスタムクレームの設定方法はSETUP.mdを参照。
//
// 2026-10-14〜 本部は権限レベル（honbuLevel）で3段階に分かれる：
//   admin（アドミン）… すべての編集＋バックアップ・操作ログ・ログイン履歴・権限管理
//   editor（編集できる）… これまでの本部と同じ
//   group（お稽古ごとの編集者）… 担当の会（honbuGroups、複数可）だけ編集できる。ほかの会は閲覧のみ
//   viewer（閲覧のみ）… どの画面も見られるが、追加・変更・削除・送信はできない
// honbuLevel が付いていない本部アカウント（この仕組みより前に作ったもの）は admin として扱う。

import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { auth } from "./firebase";

type Role = "honbu" | "staff" | "member" | "keikoNoteGuest" | null;
export type HonbuLevel = "admin" | "editor" | "group" | "viewer";

export const HONBU_LEVEL_LABEL: Record<HonbuLevel, string> = {
  admin: "アドミン",
  editor: "編集できる",
  group: "お稽古ごとの編集者",
  viewer: "閲覧のみ",
};

interface AuthState {
  user: User | null;
  role: Role;
  /** 本部の権限レベル。本部でなければ null */
  honbuLevel: HonbuLevel | null;
  /** 本部として、すべての会のデータを変更できるか（アドミン・編集できる） */
  canEdit: boolean;
  /** お稽古ごとの編集者の担当の会（それ以外は空） */
  honbuGroups: string[];
  /** アドミンか */
  isAdmin: boolean;
  staffId?: string;
  memberId?: string;
  loading: boolean;
}

const EMPTY: AuthState = { user: null, role: null, honbuLevel: null, canEdit: false, honbuGroups: [], isAdmin: false, loading: false };

const AuthContext = createContext<AuthState>({ ...EMPTY, loading: true });

function honbuLevelOf(claims: Record<string, unknown>): HonbuLevel | null {
  if (claims.role !== "honbu") return null;
  const lv = claims.honbuLevel;
  return lv === "editor" || lv === "viewer" || lv === "group" || lv === "admin" ? lv : "admin";
}

/** その会のデータを変更できるか（アドミン・編集できる・その会のお稽古ごとの編集者） */
export function canEditGroupWith(state: Pick<AuthState, "canEdit" | "honbuGroups">, group: string | undefined | null): boolean {
  if (state.canEdit) return true;
  return !!group && state.honbuGroups.includes(group);
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
        honbuGroups:
          honbuLevel === "group" && Array.isArray(claims.honbuGroups)
            ? (claims.honbuGroups as unknown[]).filter((g): g is string => typeof g === "string")
            : [],
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
