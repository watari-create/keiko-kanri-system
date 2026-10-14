"use client";

// 「閲覧のみ」の本部アカウント用に、囲んだ範囲のボタン・入力欄・クリックで切り替わるセルを操作できなくする。
// 本当の制限は Firestore ルールと Cloud Functions 側で行っている（ここを外しても保存はできない）。
// この部品は「押せるように見えて、押すとエラーになる」状態を避けるための画面上のガード。
//
// 見る・切り替えるだけの操作（タブ、月の選択、詳細を開く、閉じる、印刷、CSV書き出しなど）は
// 要素に data-nav を付けると、閲覧のみでも使える。role="tab" / role="tablist" の中も使える。

import { useEffect, useRef, useState } from "react";

const CONTROL = 'button, input, select, textarea, label, summary, a[role="button"], .cursor-pointer, [data-edit]';
const NAV = '[data-nav], [role="tab"], [role="tablist"]';

function blockedControl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest(CONTROL) as HTMLElement | null;
  if (!control) return null;
  if (control.closest(NAV)) return null;
  return control;
}

export default function ReadOnlyGuard({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [notice, setNotice] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!enabled) return <>{children}</>;

  function flash() {
    setNotice(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(false), 2500);
  }

  function block(e: React.SyntheticEvent) {
    const c = blockedControl(e.target);
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    return c;
  }

  return (
    <div
      className="ro-zone"
      onClickCapture={(e) => {
        if (block(e)) flash();
      }}
      onMouseDownCapture={(e) => {
        // セレクトボックスはマウスを押した時点で開くため、ここでも止める
        block(e);
      }}
      onKeyDownCapture={(e) => {
        if (e.key === "Tab" || e.key === "Escape") return;
        if (block(e)) flash();
      }}
      onFocusCapture={(e) => {
        const c = blockedControl(e.target);
        if (c && (c instanceof HTMLInputElement || c instanceof HTMLSelectElement || c instanceof HTMLTextAreaElement)) {
          c.blur();
        }
      }}
    >
      {children}
      {notice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-ink text-white text-sm rounded-md px-4 py-2 shadow-lg"
        >
          閲覧のみの権限のため、追加・変更・削除・送信はできません
        </div>
      )}
    </div>
  );
}
