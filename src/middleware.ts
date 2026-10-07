import { NextResponse } from "next/server";

// お稽古ノート（/keiko-note）の合言葉チェックは、以前はここ（Cookieの有無）で行っていたが、
// 2026-10-07 から「ログイン済みの会員・スタッフ・本部は合言葉なしで開ける」ようにするため、
// 判定をページ側（src/app/keiko-note/page.tsx）に移した。
// データ自体は Firestore のルールで「ログイン中の人だけ読める」ように守っている。
// ログインしていない人は、ページ側で合言葉ページ（/keiko-note/access）へ案内され、
// 合言葉を入れると閲覧専用ゲストとしてログインする。
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/keiko-note/:path*"],
};
