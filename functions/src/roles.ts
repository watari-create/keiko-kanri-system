// 本部アカウントの権限レベル（2026-10-14〜）。
// Firebase Auth のカスタムクレーム role: "honbu" に加えて、honbuLevel で4段階に分ける。
//   admin  … アドミン（すべての編集＋バックアップ・操作ログ・ログイン履歴・権限管理）
//   editor … 編集できる（これまでの本部と同じ）
//   group  … お稽古ごとの編集者（honbuGroups に入っている会だけ編集できる。ほかの会は閲覧のみ）
//   viewer … 閲覧のみ（どの画面も見られるが、追加・変更・削除・送信はできない）
// honbuLevel が付いていない本部アカウント（この仕組みより前に作ったもの）は admin として扱う
// （firestore.rules の honbuLevel() と同じ扱い）。

import { HttpsError } from "firebase-functions/v2/https";

export type HonbuLevel = "admin" | "editor" | "group" | "viewer";
export const HONBU_LEVELS: HonbuLevel[] = ["admin", "editor", "group", "viewer"];
export const HONBU_LEVEL_LABEL: Record<HonbuLevel, string> = {
  admin: "アドミン",
  editor: "編集できる",
  group: "お稽古ごとの編集者",
  viewer: "閲覧のみ",
};

type Claims = Record<string, unknown> | undefined;

/** クレームから本部の権限レベルを取り出す。本部でなければ null。 */
export function honbuLevelOf(claims: Claims): HonbuLevel | null {
  if (!claims || claims.role !== "honbu") return null;
  const lv = claims.honbuLevel;
  return lv === "editor" || lv === "viewer" || lv === "group" || lv === "admin" ? lv : "admin";
}

/** お稽古ごとの編集者の担当の会（それ以外のレベルでは空） */
export function honbuGroupsOf(claims: Claims): string[] {
  if (honbuLevelOf(claims) !== "group") return [];
  const g = claims?.honbuGroups;
  return Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
}

type Req = { auth?: { token?: Record<string, unknown> } };

/** 本部（閲覧のみを含む）でなければエラー。読み取り専用の処理に使う。 */
export function requireHonbuAny(request: Req): HonbuLevel {
  const lv = honbuLevelOf(request.auth?.token);
  if (!lv) throw new HttpsError("permission-denied", "本部アカウントでログインしてください。");
  return lv;
}

/** すべての会を変更できる人（アドミン・編集できる）でなければエラー。 */
export function requireHonbuEditor(request: Req): HonbuLevel {
  const lv = requireHonbuAny(request);
  if (lv === "viewer") throw new HttpsError("permission-denied", "閲覧のみの権限のため、この操作はできません。");
  if (lv === "group") throw new HttpsError("permission-denied", "この操作は「編集できる」以上の権限が必要です。");
  return lv;
}

/** 指定した会（すべて）を変更できるか */
export function canHonbuEditGroups(claims: Claims, groups: string[]): boolean {
  const lv = honbuLevelOf(claims);
  if (lv === "admin" || lv === "editor") return true;
  if (lv !== "group" || groups.length === 0) return false;
  const mine = honbuGroupsOf(claims);
  return groups.every((g) => mine.includes(g));
}

/** 指定した会（すべて）を変更できる人でなければエラー。お稽古ごとの編集者は担当の会だけ。 */
export function requireHonbuEditorFor(request: Req, groups: string | string[]): HonbuLevel {
  const lv = requireHonbuAny(request);
  const list = (Array.isArray(groups) ? groups : [groups]).filter(Boolean);
  if (!canHonbuEditGroups(request.auth?.token, list)) {
    throw new HttpsError(
      "permission-denied",
      lv === "viewer" ? "閲覧のみの権限のため、この操作はできません。" : "担当の会ではないため、この操作はできません。"
    );
  }
  return lv;
}

/** アドミンでなければエラー。バックアップ・操作ログ・権限管理に使う。 */
export function requireHonbuAdmin(request: Req): HonbuLevel {
  const lv = requireHonbuAny(request);
  if (lv !== "admin") throw new HttpsError("permission-denied", "アドミンのみ実行できます。");
  return lv;
}
