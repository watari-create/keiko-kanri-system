"use client";

export const dynamic = "force-dynamic";

// G1（Gマダムの茶の湯講座）の発送物リストページ。
// 管理画面・講師のページから別タブで開く共有ページ。
// meta/g1ShippingDoc を「見出し行＋データ行」の汎用テーブルとして表示・編集する。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import type { StaffAccount, G1ShippingDoc, G1ShippingSection } from "@/types";

const G1_GROUP = "Gマダムの茶の湯講座";

function cloneSections(sections: G1ShippingSection[]): G1ShippingSection[] {
  return sections.map((s) => ({ ...s, headers: [...s.headers], rows: s.rows.map((r) => [...r]) }));
}

export default function G1ShippingPage() {
  const { role, staffId, loading } = useAuth();
  const router = useRouter();

  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [accountChecked, setAccountChecked] = useState(false);
  const [sections, setSections] = useState<G1ShippingSection[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<G1ShippingSection[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && role !== "honbu" && role !== "staff") router.replace("/login");
  }, [loading, role, router]);

  useEffect(() => {
    if (role !== "staff" || !staffId) {
      setAccountChecked(true);
      return;
    }
    getDoc(doc(db, "staff", staffId)).then((snap) => {
      if (snap.exists()) setAccount({ id: snap.id, ...snap.data() } as StaffAccount);
      setAccountChecked(true);
    });
  }, [role, staffId]);

  useEffect(() => {
    return onSnapshot(doc(db, "meta", "g1ShippingDoc"), (snap) => {
      const data = snap.data() as G1ShippingDoc | undefined;
      setSections(data?.sections ?? []);
      setUpdatedAt(data?.updatedAt ?? null);
      setUpdatedBy(data?.updatedBy ?? null);
    });
  }, []);

  const canEdit = role === "honbu" || (role === "staff" && !!account?.groups.includes(G1_GROUP));

  function startEdit() {
    if (!sections) return;
    setDraft(cloneSections(sections));
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
  }

  function updateTitle(si: number, value: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      next[si].title = value;
      return next;
    });
  }

  function updateHeader(si: number, ci: number, value: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      next[si].headers[ci] = value;
      return next;
    });
  }

  function updateCell(si: number, ri: number, ci: number, value: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      next[si].rows[ri][ci] = value;
      return next;
    });
  }

  function addRow(si: number) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      next[si].rows.push(next[si].headers.map(() => ""));
      return next;
    });
  }

  function removeRow(si: number, ri: number) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      next[si].rows.splice(ri, 1);
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await setDoc(doc(db, "meta", "g1ShippingDoc"), {
        sections: draft,
        updatedAt: new Date().toISOString(),
        updatedBy: account?.name ?? (role === "honbu" ? "本部" : "スタッフ"),
      });
      setEditing(false);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  if (loading || (role === "staff" && !accountChecked) || sections === null) {
    return <div className="p-8 text-muted">確認中…</div>;
  }
  if (role !== "honbu" && role !== "staff") return null;

  const view = editing && draft ? draft : sections;

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex justify-between items-start mb-1">
        <div>
          <h1 className="text-lg font-bold text-matcha-deep">G1 発送物リスト</h1>
          <p className="text-xs text-muted mt-1">
            Gマダムの茶の湯講座（G1）の道具・消耗品と、毎回の発送チェックリストです。
          </p>
        </div>
        {canEdit && !editing && (
          <button
            className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 shrink-0"
            onClick={startEdit}
          >
            編集する
          </button>
        )}
        {editing && (
          <div className="flex gap-2 shrink-0">
            <button
              className="text-xs border border-line rounded px-3 py-1.5"
              onClick={cancelEdit}
              disabled={saving}
            >
              キャンセル
            </button>
            <button
              className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 disabled:opacity-50"
              onClick={save}
              disabled={saving}
            >
              {saving ? "保存中…" : "保存する"}
            </button>
          </div>
        )}
      </div>

      {updatedAt && !editing && (
        <p className="text-xs text-muted mb-4">
          最終更新：{new Date(updatedAt).toLocaleString("ja-JP")}
          {updatedBy ? "（" + updatedBy + "）" : ""}
        </p>
      )}
      {!updatedAt && !editing && <div className="mb-4" />}

      {view.length === 0 && (
        <p className="text-sm text-muted">まだデータがありません。</p>
      )}

      {view.map((section, si) => (
        <section key={section.id} className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto">
          {editing ? (
            <input
              className="font-bold mb-3 border border-line rounded px-2 py-1 text-sm w-full max-w-md"
              value={section.title}
              onChange={(e) => updateTitle(si, e.target.value)}
            />
          ) : (
            <h2 className="font-bold mb-3">{section.title}</h2>
          )}

          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                {section.headers.map((h, ci) => (
                  <th key={ci} className="py-2 pr-3 align-bottom">
                    {editing ? (
                      <input
                        className="border border-line rounded px-1.5 py-1 text-xs w-full"
                        value={h}
                        onChange={(e) => updateHeader(si, ci, e.target.value)}
                      />
                    ) : (
                      h
                    )}
                  </th>
                ))}
                {editing && <th className="py-2 w-8" />}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-line align-top">
                  {row.map((cell, ci) => (
                    <td key={ci} className="py-1.5 pr-3">
                      {editing ? (
                        <input
                          className="border border-line rounded px-1.5 py-1 text-xs w-full"
                          value={cell}
                          onChange={(e) => updateCell(si, ri, ci, e.target.value)}
                        />
                      ) : (
                        cell || "—"
                      )}
                    </td>
                  ))}
                  {editing && (
                    <td className="py-1.5">
                      <button
                        className="text-xs text-hanko"
                        onClick={() => removeRow(si, ri)}
                      >
                        削除
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {editing && (
            <button
              className="text-xs border border-line rounded px-3 py-1.5 mt-3"
              onClick={() => addRow(si)}
            >
              ＋ 行を追加
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
