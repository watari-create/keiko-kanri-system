"use client";

export const dynamic = "force-dynamic";

// G1（Gマダムの茶の湯講座）の発送物リストページ。
// 管理画面・講師のページから別タブで開く共有ページ。
// meta/g1ShippingDoc を「見出し行＋データ行」の汎用テーブルとして表示・編集する。
// 発送チェックリスト（page3-checklist）だけは、実際の発送のたびに記入して
// g1ShippingLogs に記録として保存できる（記入・印刷・アーカイブ閲覧）。

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  collection,
  addDoc,
  updateDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import type {
  StaffAccount,
  G1ShippingDoc,
  G1ShippingSection,
  G1ShippingRow,
  G1ShippingLog,
  G1ShippingLogItem,
} from "@/types";

const G1_GROUP = "Gマダムの茶の湯講座";
const CHECKLIST_SECTION_ID = "page3-checklist";

interface LogDraft {
  id: string | null; // null = まだ保存されていない新規記録
  date: string;
  preparedBy: string;
  items: G1ShippingLogItem[];
}

function cloneSections(sections: G1ShippingSection[]): G1ShippingSection[] {
  return sections.map((s) => ({
    ...s,
    headers: [...s.headers],
    rows: s.rows.map((r) => ({ cells: [...r.cells] })),
  }));
}

function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  const [printingId, setPrintingId] = useState<string | null>(null);

  const [logs, setLogs] = useState<G1ShippingLog[] | null>(null);
  const [logDraft, setLogDraft] = useState<LogDraft | null>(null);
  const [savingLog, setSavingLog] = useState(false);
  const [printingLog, setPrintingLog] = useState(false);

  const canEdit = role === "honbu" || (role === "staff" && !!account?.groups.includes(G1_GROUP));

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

  // 発送記録（アーカイブ）の一覧。Firestoreルール上、読めるのは
  // 本部か「Gマダムの茶の湯講座」担当スタッフ（＝canEdit）だけなので、それ以外は購読しない。
  useEffect(() => {
    if (!canEdit) {
      setLogs(null);
      return;
    }
    const q = query(collection(db, "g1ShippingLogs"), orderBy("date", "desc"));
    return onSnapshot(q, (snap) => {
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() } as G1ShippingLog)));
    });
  }, [canEdit]);

  // 印刷ボタンが押されたら、対象（表 or 発送記録）だけを表示した状態で印刷ダイアログを開く。
  // ダイアログが閉じたら（afterprint）通常表示に戻す。
  useEffect(() => {
    function handleAfterPrint() {
      setPrintingId(null);
      setPrintingLog(false);
    }
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, []);

  useEffect(() => {
    if (!printingId && !printingLog) return;
    const frame = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(frame);
  }, [printingId, printingLog]);

  function printSection(id: string) {
    setPrintingId(id);
  }

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
      next[si].rows[ri].cells[ci] = value;
      return next;
    });
  }

  function addRow(si: number) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSections(prev);
      const row: G1ShippingRow = { cells: next[si].headers.map(() => "") };
      next[si].rows.push(row);
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

  // ---- 発送記録（アーカイブ） ----

  function startNewLog() {
    const template = (sections ?? []).find((s) => s.id === CHECKLIST_SECTION_ID);
    const items: G1ShippingLogItem[] = (template?.rows ?? []).map((row) => ({
      name: row.cells[1] ?? "",
      qty: row.cells[2] ?? "",
      note: "",
      sent: false,
      returned: false,
    }));
    setLogDraft({
      id: null,
      date: todayDateKey(),
      preparedBy: account?.name ?? (role === "honbu" ? "本部" : ""),
      items,
    });
  }

  function openLog(log: G1ShippingLog) {
    setLogDraft({
      id: log.id,
      date: log.date,
      preparedBy: log.preparedBy,
      items: log.items.map((i) => ({ ...i })),
    });
  }

  function closeLog() {
    setLogDraft(null);
  }

  function updateLogMeta(field: "date" | "preparedBy", value: string) {
    setLogDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  function updateLogItem(index: number, patch: Partial<G1ShippingLogItem>) {
    setLogDraft((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
      return { ...prev, items };
    });
  }

  function addLogItem() {
    setLogDraft((prev) =>
      prev
        ? { ...prev, items: [...prev.items, { name: "", qty: "", note: "", sent: false, returned: false }] }
        : prev
    );
  }

  function removeLogItem(index: number) {
    setLogDraft((prev) => (prev ? { ...prev, items: prev.items.filter((_, i) => i !== index) } : prev));
  }

  async function saveLog() {
    if (!logDraft) return;
    setSavingLog(true);
    try {
      const now = new Date().toISOString();
      const payload = {
        date: logDraft.date,
        preparedBy: logDraft.preparedBy,
        items: logDraft.items,
        updatedAt: now,
      };
      if (logDraft.id) {
        await updateDoc(doc(db, "g1ShippingLogs", logDraft.id), payload);
      } else {
        const ref = await addDoc(collection(db, "g1ShippingLogs"), { ...payload, createdAt: now });
        setLogDraft((prev) => (prev ? { ...prev, id: ref.id } : prev));
      }
    } finally {
      setSavingLog(false);
    }
  }

  function printLog() {
    setPrintingLog(true);
  }

  if (loading || (role === "staff" && !accountChecked) || sections === null) {
    return <div className="p-8 text-muted">確認中…</div>;
  }
  if (role !== "honbu" && role !== "staff") return null;

  // ---- 発送記録の記入・閲覧画面（一覧とは別画面として表示） ----
  if (logDraft) {
    return (
      <div className="max-w-5xl mx-auto p-6 print:p-0 print:max-w-none">
        {!printingLog && (
          <div className="flex justify-between items-start mb-4 print:hidden">
            <div>
              <h1 className="text-lg font-bold text-matcha-deep">
                発送記録{logDraft.id ? "" : "（新規）"}
              </h1>
              <p className="text-xs text-muted mt-1">
                G1 発送チェックリストの記入用フォームです。保存すると一覧（アーカイブ）に残ります。
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="text-xs border border-line rounded px-3 py-1.5" onClick={closeLog}>
                一覧に戻る
              </button>
              <button className="text-xs border border-line rounded px-3 py-1.5" onClick={printLog}>
                🖨 印刷
              </button>
              {canEdit && (
                <button
                  className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 disabled:opacity-50"
                  onClick={saveLog}
                  disabled={savingLog}
                >
                  {savingLog ? "保存中…" : "保存する"}
                </button>
              )}
            </div>
          </div>
        )}

        <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto print:border-0 print:shadow-none print:overflow-visible">
          <h2 className="font-bold mb-3">発送チェックリスト</h2>

          <div className="flex flex-wrap gap-x-6 gap-y-2 mb-4 text-sm">
            <label className="flex items-center gap-2">
              発送日：
              {canEdit ? (
                <input
                  type="date"
                  className="border border-line rounded px-2 py-1 text-sm"
                  value={logDraft.date}
                  onChange={(e) => updateLogMeta("date", e.target.value)}
                />
              ) : (
                <span>{logDraft.date || "—"}</span>
              )}
            </label>
            <label className="flex items-center gap-2">
              記入者：
              {canEdit ? (
                <input
                  className="border border-line rounded px-2 py-1 text-sm"
                  value={logDraft.preparedBy}
                  onChange={(e) => updateLogMeta("preparedBy", e.target.value)}
                />
              ) : (
                <span>{logDraft.preparedBy || "—"}</span>
              )}
            </label>
          </div>

          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">品名</th>
                <th className="py-2 pr-3">数量</th>
                <th className="py-2 pr-3 text-center">発送時確認</th>
                <th className="py-2 pr-3 text-center">返送時確認</th>
                <th className="py-2 pr-3">備考</th>
                {canEdit && <th className="py-2 w-8 print:hidden" />}
              </tr>
            </thead>
            <tbody>
              {logDraft.items.map((item, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="py-1.5 pr-3">
                    {canEdit ? (
                      <input
                        className="border border-line rounded px-1.5 py-1 text-xs w-full"
                        value={item.name}
                        onChange={(e) => updateLogItem(i, { name: e.target.value })}
                      />
                    ) : (
                      item.name || "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {canEdit ? (
                      <input
                        className="border border-line rounded px-1.5 py-1 text-xs w-full"
                        value={item.qty}
                        onChange={(e) => updateLogItem(i, { qty: e.target.value })}
                      />
                    ) : (
                      item.qty || "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-center">
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={item.sent}
                      disabled={!canEdit}
                      onChange={(e) => updateLogItem(i, { sent: e.target.checked })}
                    />
                  </td>
                  <td className="py-1.5 pr-3 text-center">
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={item.returned}
                      disabled={!canEdit}
                      onChange={(e) => updateLogItem(i, { returned: e.target.checked })}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    {canEdit ? (
                      <input
                        className="border border-line rounded px-1.5 py-1 text-xs w-full"
                        value={item.note}
                        onChange={(e) => updateLogItem(i, { note: e.target.value })}
                      />
                    ) : (
                      item.note || "—"
                    )}
                  </td>
                  {canEdit && (
                    <td className="py-1.5 print:hidden">
                      <button className="text-xs text-hanko" onClick={() => removeLogItem(i)}>
                        削除
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {canEdit && (
            <button
              className="text-xs border border-line rounded px-3 py-1.5 mt-3 print:hidden"
              onClick={addLogItem}
            >
              ＋ 項目を追加
            </button>
          )}
        </section>
      </div>
    );
  }

  const view = editing && draft ? draft : sections;

  const printedView = printingId ? view.filter((s) => s.id === printingId) : view;

  return (
    <div className="max-w-5xl mx-auto p-6 print:p-0 print:max-w-none">
      {!printingId && (
        <>
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
        </>
      )}

      {printedView.map((section, si) => (
        <Fragment key={section.id}>
          <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto print:border-0 print:shadow-none print:overflow-visible print:break-inside-avoid">
            <div className="flex items-center justify-between gap-3 mb-3">
              {editing ? (
                <input
                  className="font-bold border border-line rounded px-2 py-1 text-sm w-full max-w-md"
                  value={section.title}
                  onChange={(e) => updateTitle(si, e.target.value)}
                />
              ) : (
                <h2 className="font-bold">{section.title}</h2>
              )}
              {!editing && !printingId && (
                <button
                  className="text-xs border border-line rounded px-3 py-1.5 shrink-0"
                  onClick={() => printSection(section.id)}
                >
                  🖨 この表を印刷
                </button>
              )}
            </div>

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
                    {row.cells.map((cell, ci) => {
                      const isCheckColumn = section.headers[ci]?.includes("確認");
                      return (
                        <td key={ci} className="py-1.5 pr-3">
                          {editing ? (
                            <input
                              className="border border-line rounded px-1.5 py-1 text-xs w-full"
                              value={cell}
                              onChange={(e) => updateCell(si, ri, ci, e.target.value)}
                            />
                          ) : isCheckColumn ? (
                            cell || "☐"
                          ) : (
                            cell || "—"
                          )}
                        </td>
                      );
                    })}
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

          {section.id === CHECKLIST_SECTION_ID && canEdit && !editing && !printingId && (
            <section className="bg-paper border border-line rounded-md p-5 mb-6 print:hidden">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="font-bold">発送記録（アーカイブ）</h2>
                <button
                  className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 shrink-0"
                  onClick={startNewLog}
                >
                  ＋ 新しい記録を作成
                </button>
              </div>
              <p className="text-xs text-muted mb-3">
                発送のたびに記入して保存すると、ここに記録として残ります。クリックすると内容を確認・編集・印刷できます。
              </p>
              {logs === null && <p className="text-sm text-muted">読み込み中…</p>}
              {logs !== null && logs.length === 0 && (
                <p className="text-sm text-muted">まだ記録がありません。</p>
              )}
              {logs !== null && logs.length > 0 && (
                <ul className="divide-y divide-line">
                  {logs.map((log) => (
                    <li key={log.id}>
                      <button
                        className="w-full text-left py-2.5 text-sm hover:bg-matcha-pale/40 flex justify-between items-center"
                        onClick={() => openLog(log)}
                      >
                        <span>{log.date || "（日付未設定）"}</span>
                        <span className="text-xs text-muted">{log.preparedBy || "—"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </Fragment>
      ))}
    </div>
  );
}
