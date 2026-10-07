import { NextRequest, NextResponse } from "next/server";

// /keiko-note/access の合言葉フォームから呼ばれるAPI。
// 環境変数 KEIKO_NOTE_ACCESS_CODE と一致すれば、Cookie（keikoNoteAccess）を発行する。
// このCookieはmiddleware（src/middleware.ts）が/keiko-noteへのアクセス時にチェックする。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  const expected = process.env.KEIKO_NOTE_ACCESS_CODE;

  if (!expected || code !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("keikoNoteAccess", expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1年間保持（ブラウザを閉じても再入力不要）
  });
  return res;
}

// 以前に合言葉を入力してCookie（keikoNoteAccess）を持っている人を、再入力なしで
// 閲覧専用ゲストとしてログインさせるために使う。Cookieが正しければ合言葉を返す
// （Cookieを持っている＝すでに合言葉を知っている人なので、返しても問題ない）。
export async function GET(req: NextRequest) {
  const expected = process.env.KEIKO_NOTE_ACCESS_CODE;
  const cookie = req.cookies.get("keikoNoteAccess")?.value;
  if (!expected || cookie !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, code: expected });
}
