import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "お稽古ノート｜稽古管理システム",
  description: "茶道教室（土曜日・日曜日・火曜日クラス）のお稽古の記録",
};

// お稽古ノートページ専用のフォント読み込み。
// このレイアウト配下（/keiko-note）だけに適用され、他ページには影響しない。
export default function KeikoNoteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;500;600&family=Noto+Sans+JP:wght@400;500;700&display=swap"
        rel="stylesheet"
      />
      {children}
    </>
  );
}
