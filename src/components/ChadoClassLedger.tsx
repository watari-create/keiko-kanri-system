"use client";

// 茶道教室：クラス台帳（管理画面・本部稽古／茶道教室）
// 一覧は見るだけ（期・クラス・時間・講師・段階・在籍・要フォロー・入会受付）にし、
// 開始月・段階・定員の編集はクラスを選んだときの右側パネルで行う。
// 「入会受付」をオンにしたクラスだけが入会フォーム（/enroll）の「ご希望のクラス」に表示される。

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { CHADO_CLASS_LABEL, CHADO_CLASS_TIME } from "@/lib/chadoClasses";
import { CHADO_STAGES, chadoKiLabel, chadoLedgerTeacher, mergeChadoLedger } from "@/lib/chadoClassLedger";
import type { ChadoClassLedgerEntry, ChadoKyoshitsuClass, ChadoStage, Member } from "@/types";

const RECENT_DAYS = 30;

export default function ChadoClassLedger({
  members,
  onSelect,
}: {
  members: Member[];
  onSelect?: (m: Member) => void;
}) {
  const [docs, setDocs] = useState<Record<string, Partial<ChadoClassLedgerEntry>>>({});
  const [selected, setSelected] = useState<ChadoKyoshitsuClass>("土曜日");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(collection(db, "chadoClassLedger"), (snap) => {
      const next: Record<string, Partial<ChadoClassLedgerEntry>> = {};
      snap.docs.forEach((d) => (next[d.id] = d.data() as Partial<ChadoClassLedgerEntry>));
      setDocs(next);
    });
  }, []);

  const ledger = useMemo(() => mergeChadoLedger(docs), [docs]);
  const active = useMemo(
    () => members.filter((m) => m.group === "茶道教室" && m.status === "在籍" && !m.isTestAccount),
    [members]
  );
  const recentSince = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - RECENT_DAYS);
    return d.toISOString().slice(0, 10);
  }, []);
  const unassigned = active.filter((m) => !m.chadoClass);

  const rows = ledger.map((e) => {
    const list = active
      .filter((m) => m.chadoClass === e.id)
      .sort((a, b) => (a.joinDate ?? "").localeCompare(b.joinDate ?? ""));
    const recent = list.filter((m) => (m.joinDate ?? "") >= recentSince).length;
    const follow = list.filter(
      (m) => Object.values(m.attendance ?? {}).filter((v) => v === "欠席").length >= 2
    ).length;
    const full = e.capacity != null && list.length >= e.capacity;
    return { e, list, recent, follow, full };
  });
  const openCount = rows.filter((r) => r.e.accepting).length;
  const followTotal = rows.reduce((t, r) => t + r.follow, 0);
  const sel = rows.find((r) => r.e.id === selected) ?? rows[0];

  async function save(id: ChadoKyoshitsuClass, patch: Partial<ChadoClassLedgerEntry>) {
    const current = ledger.find((e) => e.id === id)!;
    setSaving(id);
    setError(null);
    try {
      const { id: _omit, ...rest } = { ...current, ...patch };
      void _omit;
      await setDoc(doc(db, "chadoClassLedger", id), { ...rest, updatedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
      setError(`保存できませんでした：${(err as Error).message}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
        <div>
          <h2 className="text-lg font-bold">クラス台帳</h2>
          <p className="text-xs text-muted mt-0.5">「入会受付」をオンにしたクラスだけが入会フォームに表示されます。</p>
        </div>
      </div>

      {/* 概況 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: "入会受付中", value: openCount, unit: "クラス" },
          { label: "在籍", value: active.length, unit: "名" },
          { label: `新規（直近${RECENT_DAYS}日）`, value: rows.reduce((t, r) => t + r.recent, 0), unit: "名" },
          { label: "要フォロー（欠席2回以上）", value: followTotal, unit: "名" },
        ].map((k) => (
          <div key={k.label} className="bg-paper border border-line rounded-lg px-4 py-3">
            <div className="text-xs text-muted">{k.label}</div>
            <div className="text-2xl font-bold">
              {k.value}
              <span className="text-sm font-normal ml-1">{k.unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 items-start">
        {/* 一覧 */}
        <div className="flex-[999_1_560px] min-w-0 bg-paper border border-line rounded-lg overflow-hidden">
          <ul>
            {rows.map(({ e, list, recent, follow, full }) => {
              const isSel = sel.e.id === e.id;
              return (
                <li
                  key={e.id}
                  className={`flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 border-b border-line last:border-b-0 ${
                    isSel ? "bg-matcha-pale" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(e.id)}
                    className="flex-[1_1_220px] min-w-0 text-left"
                  >
                    <div className="text-xs text-muted">{chadoKiLabel(e.startMonth)}</div>
                    <div className="text-base font-bold">
                      {CHADO_CLASS_LABEL[e.id]}クラス
                      {recent > 0 && (
                        <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-[#FBEEE3] text-[#7A3A0E] align-middle">
                          新規 {recent}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted mt-0.5">
                      {CHADO_CLASS_TIME[e.id]}　{chadoLedgerTeacher(e.id)}
                    </div>
                  </button>

                  <div className="w-28">
                    <div className="text-xs text-muted">段階</div>
                    <div className="text-sm font-bold">{e.stage}</div>
                  </div>

                  <div className="w-28">
                    <div className="text-xs text-muted">在籍</div>
                    <div className="text-sm">
                      <span className="text-lg font-bold">{list.length}</span>
                      {e.capacity != null && <span className="text-muted"> / {e.capacity}</span>}
                      {full && <span className="ml-1 text-xs font-bold">満席</span>}
                    </div>
                    {e.id === "土曜日" && list.length > 0 && (
                      <div className="text-[11px] text-muted">
                        月2回 {list.filter((m) => m.chadoMonthlyQuota === 2).length}・月1回{" "}
                        {list.filter((m) => m.chadoMonthlyQuota !== 2).length}
                      </div>
                    )}
                  </div>

                  <div className="w-20">
                    <div className="text-xs text-muted">要フォロー</div>
                    <div className={`text-sm ${follow > 0 ? "font-bold text-[#7A3A0E]" : "text-muted"}`}>
                      {follow > 0 ? `${follow}名` : "—"}
                    </div>
                  </div>

                  <button
                    type="button"
                    aria-pressed={e.accepting}
                    aria-label={`${CHADO_CLASS_LABEL[e.id]}クラスの入会受付`}
                    disabled={saving === e.id}
                    onClick={() => save(e.id, { accepting: !e.accepting })}
                    className={`inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full text-xs font-bold border disabled:opacity-50 ${
                      e.accepting ? "bg-matcha-deep border-matcha-deep text-white" : "bg-white border-line text-ink"
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full ${e.accepting ? "bg-white" : "bg-line"}`} />
                    {e.accepting ? "受付中" : "受付停止"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 選択中のクラス */}
        <aside className="flex-[1_1_300px] min-w-0 bg-paper border border-line rounded-lg p-5 space-y-4">
          <div>
            <div className="text-xs text-muted">{chadoKiLabel(sel.e.startMonth)}</div>
            <h3 className="text-lg font-bold">{CHADO_CLASS_LABEL[sel.e.id]}クラス</h3>
            <div className="text-xs text-muted">
              {CHADO_CLASS_TIME[sel.e.id]}　{chadoLedgerTeacher(sel.e.id)}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="col-span-2 block">
              <span className="block text-xs text-muted mb-1">開始月（期）</span>
              <input
                type="month"
                className="w-full border border-line rounded px-2 py-1.5 bg-white"
                value={sel.e.startMonth}
                onChange={(ev) => save(sel.e.id, { startMonth: ev.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">段階</span>
              <select
                className="w-full border border-line rounded px-2 py-1.5 bg-white"
                value={sel.e.stage}
                onChange={(ev) => save(sel.e.id, { stage: ev.target.value as ChadoStage })}
              >
                {CHADO_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">定員（空欄＝上限なし）</span>
              <input
                key={`${sel.e.id}-${sel.e.capacity ?? ""}`}
                type="number"
                min={0}
                className="w-full border border-line rounded px-2 py-1.5 bg-white"
                defaultValue={sel.e.capacity ?? ""}
                placeholder="上限なし"
                onBlur={(ev) => {
                  const v = ev.target.value.trim();
                  const cap = v === "" ? null : Math.max(0, Number(v));
                  if (cap !== sel.e.capacity) save(sel.e.id, { capacity: cap });
                }}
              />
            </label>
          </div>

          <div>
            <div className="text-xs text-muted mb-2">在籍会員（{sel.list.length}名）</div>
            {sel.list.length === 0 ? (
              <p className="text-xs text-muted">在籍会員はいません。</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {sel.list.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(m)}
                      className="text-xs border border-line rounded px-2.5 py-1.5 bg-white hover:border-matcha-deep"
                    >
                      {m.name}
                      {sel.e.id === "土曜日" && (
                        <span className="ml-1 text-muted">（月{m.chadoMonthlyQuota === 2 ? 2 : 1}回）</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {error && <p className="text-hanko text-xs mt-2">{error}</p>}
      {unassigned.length > 0 && (
        <p className="text-xs text-[#7A3A0E] mt-3">
          曜日クラス未設定の在籍会員：{unassigned.map((m) => m.name).join("、")}（会員詳細で設定すると台帳に入ります）
        </p>
      )}
    </section>
  );
}
