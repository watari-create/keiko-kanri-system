"use client";

// 茶道教室：クラス台帳（管理画面・本部稽古／茶道教室）
// 曜日クラスごとの期・段階・在籍数・定員・入会受付を一覧で管理する。
// 「入会受付」をオンにしたクラスだけが入会フォーム（/enroll）の「ご希望のクラス」に表示される。

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { CHADO_CLASS_LABEL, CHADO_CLASS_TIME } from "@/lib/chadoClasses";
import {
  CHADO_STAGES,
  chadoKiLabel,
  chadoLedgerTeacher,
  mergeChadoLedger,
} from "@/lib/chadoClassLedger";
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
  const [selected, setSelected] = useState<ChadoKyoshitsuClass | null>(null);
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
    const list = active.filter((m) => m.chadoClass === e.id);
    const recent = list.filter((m) => (m.joinDate ?? "") >= recentSince).length;
    const follow = list.filter(
      (m) => Object.values(m.attendance ?? {}).filter((v) => v === "欠席").length >= 2
    ).length;
    const full = e.capacity != null && list.length >= e.capacity;
    return { e, list, recent, follow, full };
  });

  const openCount = rows.filter((r) => r.e.accepting).length;

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

  const sel = rows.find((r) => r.e.id === selected) ?? null;

  return (
    <section className="bg-paper border border-line rounded-md p-5 mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-bold">クラス台帳</h2>
        <span className="text-xs text-muted">
          入会受付中 {openCount} クラス ／ 在籍 {active.length} 名
        </span>
      </div>
      <p className="text-xs text-muted mb-3">
        曜日クラスごとの期（開始月）・段階・定員・入会受付を管理します。「入会受付」をオンにしたクラスだけが入会フォームの「ご希望のクラス」に表示されます（定員に達したクラスは表示されません）。
        在籍数は会員名簿の「曜日クラス」から自動で集計しています。
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-xs text-muted border-b border-line text-left">
              <th className="py-2 pr-3 font-normal">期 ／ クラス</th>
              <th className="py-2 pr-3 font-normal">時間</th>
              <th className="py-2 pr-3 font-normal">講師</th>
              <th className="py-2 pr-3 font-normal">段階</th>
              <th className="py-2 pr-3 font-normal">在籍 ／ 定員</th>
              <th className="py-2 pr-3 font-normal">要フォロー</th>
              <th className="py-2 font-normal">入会受付</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, list, recent, follow, full }) => (
              <tr
                key={e.id}
                className={`border-b border-line align-top ${selected === e.id ? "bg-matcha-pale" : ""}`}
              >
                <td className="py-3 pr-3">
                  <input
                    type="month"
                    className="text-xs border border-line rounded px-1.5 py-0.5 mb-1 bg-white"
                    value={e.startMonth}
                    aria-label={`${CHADO_CLASS_LABEL[e.id]}クラスの開始月`}
                    onChange={(ev) => save(e.id, { startMonth: ev.target.value })}
                  />
                  <div className="text-[11px] text-muted">{chadoKiLabel(e.startMonth)}</div>
                  <button
                    type="button"
                    className="font-bold text-matcha-deep underline-offset-2 hover:underline text-left"
                    onClick={() => setSelected(selected === e.id ? null : e.id)}
                  >
                    {CHADO_CLASS_LABEL[e.id]}クラス
                  </button>
                  {recent > 0 && (
                    <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-[#FBEEE3] text-[#7A3A0E] font-bold">
                      新規 {recent}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-3 whitespace-nowrap">{CHADO_CLASS_TIME[e.id]}</td>
                <td className="py-3 pr-3">{chadoLedgerTeacher(e.id)}</td>
                <td className="py-3 pr-3">
                  <select
                    className="text-sm border border-line rounded px-2 py-1 bg-white"
                    value={e.stage}
                    aria-label={`${CHADO_CLASS_LABEL[e.id]}クラスの段階`}
                    onChange={(ev) => save(e.id, { stage: ev.target.value as ChadoStage })}
                  >
                    {CHADO_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-3 pr-3 whitespace-nowrap">
                  <span className="font-bold text-base">{list.length}</span> ／{" "}
                  <input
                    key={`${e.id}-${e.capacity ?? ""}`}
                    type="number"
                    min={0}
                    className="w-16 text-sm border border-line rounded px-1.5 py-0.5 bg-white"
                    defaultValue={e.capacity ?? ""}
                    placeholder="上限なし"
                    aria-label={`${CHADO_CLASS_LABEL[e.id]}クラスの定員（空欄で上限なし）`}
                    onBlur={(ev) => {
                      const v = ev.target.value.trim();
                      const cap = v === "" ? null : Math.max(0, Number(v));
                      if (cap !== e.capacity) save(e.id, { capacity: cap });
                    }}
                  />
                  {full && <div className="text-[11px] font-bold mt-1">満席</div>}
                </td>
                <td className="py-3 pr-3">
                  {follow > 0 ? <span className="font-bold text-[#7A3A0E]">{follow}名</span> : <span className="text-muted">—</span>}
                </td>
                <td className="py-3">
                  <button
                    type="button"
                    aria-pressed={e.accepting}
                    disabled={saving === e.id}
                    onClick={() => save(e.id, { accepting: !e.accepting })}
                    className={`inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full text-xs font-bold border disabled:opacity-50 ${
                      e.accepting
                        ? "bg-matcha-deep border-matcha-deep text-white"
                        : "bg-white border-line text-ink"
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full ${e.accepting ? "bg-white" : "bg-line"}`} />
                    {e.accepting ? "受付中" : "停止"}
                  </button>
                  <div className="text-[11px] text-muted mt-1">
                    {!e.accepting ? "フォーム非表示" : full ? "満席のため非表示" : "フォームに表示中"}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-hanko text-xs mt-2">{error}</p>}
      {unassigned.length > 0 && (
        <p className="text-xs text-[#7A3A0E] mt-3">
          曜日クラスが未設定の在籍会員が {unassigned.length} 名います（{unassigned.map((m) => m.name).join("、")}）。会員詳細から設定すると台帳に反映されます。
        </p>
      )}
      <p className="text-[11px] text-muted mt-2">
        新規＝直近{RECENT_DAYS}日以内の入会／要フォロー＝出席簿の欠席が2回以上の会員
      </p>

      {sel && (
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="text-sm font-bold mb-2">
            {chadoKiLabel(sel.e.startMonth)}・{CHADO_CLASS_LABEL[sel.e.id]}クラスの在籍会員（{sel.list.length}名）
          </h3>
          {sel.list.length === 0 ? (
            <p className="text-xs text-muted">在籍会員はいません。</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {sel.list
                .slice()
                .sort((a, b) => (a.joinDate ?? "").localeCompare(b.joinDate ?? ""))
                .map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(m)}
                      className="text-xs border border-line rounded px-2.5 py-1.5 bg-white hover:border-matcha-deep"
                    >
                      {m.name}
                      <span className="text-muted ml-1">（入会 {m.joinDate || "—"}）</span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
