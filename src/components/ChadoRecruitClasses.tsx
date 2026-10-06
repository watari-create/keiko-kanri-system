"use client";

// 茶道教室：新規クラスの募集（管理画面・本部稽古／茶道教室）
// 既存のクラスでは新規入会を受けず、新しく募集するときは「＋ 新規クラスを作成して募集」から
// 曜日・時間・講師・開始日・日程・定員・月謝を入力してクラスを作る。
// 受付中のクラスだけが入会フォーム（/enroll）の「ご希望のクラス」に表示され、
// 申し込んだ会員には chadoCohortId（このクラスのID）が付く。

import { useState } from "react";
import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  CHADO_DEFAULT_MONTHLY_FEE,
  CHADO_TEACHER_CHOICES,
  CHADO_WEEKDAYS,
  formatYenNum,
  recruitTimeLabel,
  suggestRecruitName,
} from "@/lib/chadoRecruit";
import type { ChadoRecruitClass, Member } from "@/types";

type Draft = Omit<ChadoRecruitClass, "id" | "createdAt" | "capacity" | "monthlyFee"> & {
  capacity: string;
  monthlyFee: string;
};

const EMPTY: Draft = {
  name: "",
  weekday: "土曜日",
  timeStart: "10:00",
  timeEnd: "12:00",
  teacher: "",
  startDate: "",
  schedule: "",
  capacity: "",
  monthlyFee: String(CHADO_DEFAULT_MONTHLY_FEE),
  paymentLink: "",
  note: "",
  accepting: true,
};

export default function ChadoRecruitClasses({
  classes,
  members,
  onSelect,
}: {
  classes: ChadoRecruitClass[];
  members: Member[];
  onSelect?: (m: Member) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null); // "new" = 新規作成
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openNew() {
    setDraft(EMPTY);
    setEditingId("new");
    setError(null);
  }
  function openEdit(c: ChadoRecruitClass) {
    setDraft({
      name: c.name,
      weekday: c.weekday,
      timeStart: c.timeStart,
      timeEnd: c.timeEnd,
      teacher: c.teacher,
      startDate: c.startDate,
      schedule: c.schedule,
      capacity: c.capacity == null ? "" : String(c.capacity),
      monthlyFee: String(c.monthlyFee ?? CHADO_DEFAULT_MONTHLY_FEE),
      paymentLink: c.paymentLink ?? "",
      note: c.note ?? "",
      accepting: c.accepting,
    });
    setEditingId(c.id);
    setError(null);
  }
  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function save() {
    if (!draft.weekday || !draft.teacher.trim() || !draft.startDate) {
      setError("曜日・講師・開始日は必須です。");
      return;
    }
    const data = {
      name: draft.name.trim() || suggestRecruitName(draft.startDate, draft.weekday),
      weekday: draft.weekday,
      timeStart: draft.timeStart,
      timeEnd: draft.timeEnd,
      teacher: draft.teacher.trim(),
      startDate: draft.startDate,
      schedule: draft.schedule.trim(),
      capacity: draft.capacity.trim() === "" ? null : Math.max(1, Number(draft.capacity)),
      monthlyFee: Number(draft.monthlyFee) || CHADO_DEFAULT_MONTHLY_FEE,
      paymentLink: draft.paymentLink.trim(),
      note: draft.note.trim(),
      accepting: draft.accepting,
    };
    setSaving(true);
    setError(null);
    try {
      if (editingId === "new") {
        await addDoc(collection(db, "chadoRecruitClasses"), { ...data, createdAt: serverTimestamp() });
      } else if (editingId) {
        await updateDoc(doc(db, "chadoRecruitClasses", editingId), data);
      }
      setEditingId(null);
    } catch (err) {
      setError(`保存できませんでした：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(c: ChadoRecruitClass) {
    await updateDoc(doc(db, "chadoRecruitClasses", c.id), { accepting: !c.accepting });
  }
  async function remove(c: ChadoRecruitClass) {
    if (!confirm(`「${c.name}」を削除しますか？`)) return;
    await deleteDoc(doc(db, "chadoRecruitClasses", c.id));
  }

  const applicantsOf = (id: string) =>
    members
      .filter((m) => m.group === "茶道教室" && m.chadoCohortId === id && m.status !== "退会")
      .sort((a, b) => (a.joinDate ?? "").localeCompare(b.joinDate ?? ""));

  const suggested = suggestRecruitName(draft.startDate, draft.weekday);

  return (
    <section className="bg-paper border border-line rounded-md p-5 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-bold">新規クラスの募集</h2>
        <button
          type="button"
          onClick={openNew}
          className="text-sm bg-matcha-deep text-white rounded px-4 py-2 font-bold"
        >
          ＋ 新規クラスを作成して募集
        </button>
      </div>
      <p className="text-xs text-muted mb-4">
        既存のクラスでは新規入会を受け付けません。新しく募集するときはクラスを作成してください。
        「受付中」のクラスだけが入会フォームに表示されます。
      </p>

      {editingId && (
        <div className="border border-matcha-deep rounded-md p-4 mb-4 bg-white">
          <h3 className="text-sm font-bold mb-3">{editingId === "new" ? "新規クラスの作成" : "クラスの編集"}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label className="block">
              <span className="block text-xs text-muted mb-1">曜日 *</span>
              <select className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.weekday} onChange={(e) => set("weekday", e.target.value)}>
                {CHADO_WEEKDAYS.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <label className="block flex-1">
                <span className="block text-xs text-muted mb-1">開始時刻</span>
                <input type="time" className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.timeStart} onChange={(e) => set("timeStart", e.target.value)} />
              </label>
              <label className="block flex-1">
                <span className="block text-xs text-muted mb-1">終了時刻</span>
                <input type="time" className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.timeEnd} onChange={(e) => set("timeEnd", e.target.value)} />
              </label>
            </div>
            <label className="block">
              <span className="block text-xs text-muted mb-1">講師 *</span>
              <input
                className="w-full border border-line rounded px-2 py-1.5 bg-white"
                list="chado-teacher-choices"
                value={draft.teacher}
                placeholder="選択または入力"
                onChange={(e) => set("teacher", e.target.value)}
              />
              <datalist id="chado-teacher-choices">
                {CHADO_TEACHER_CHOICES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">開始日 *</span>
              <input type="date" className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.startDate} onChange={(e) => set("startDate", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <span className="block text-xs text-muted mb-1">クラス名（空欄なら「{suggested || "2027年1月期 土曜日クラス"}」）</span>
              <input className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.name} placeholder={suggested} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <span className="block text-xs text-muted mb-1">日程（入会フォームに表示）</span>
              <textarea
                className="w-full border border-line rounded px-2 py-1.5 bg-white"
                rows={2}
                value={draft.schedule}
                placeholder="例：1/10, 2/14, 3/14, 4/11, 5/9, 6/13（全6回）"
                onChange={(e) => set("schedule", e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">定員（空欄＝上限なし）</span>
              <input type="number" min={1} className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.capacity} onChange={(e) => set("capacity", e.target.value)} />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">月謝（円）</span>
              <input type="number" min={0} className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.monthlyFee} onChange={(e) => set("monthlyFee", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <span className="block text-xs text-muted mb-1">月謝のSquare決済リンク（空欄なら「本部よりご案内」と表示）</span>
              <input className="w-full border border-line rounded px-2 py-1.5 bg-white" value={draft.paymentLink} placeholder="https://square.link/u/…" onChange={(e) => set("paymentLink", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <span className="block text-xs text-muted mb-1">案内文（任意・入会フォームに表示）</span>
              <textarea className="w-full border border-line rounded px-2 py-1.5 bg-white" rows={2} value={draft.note} onChange={(e) => set("note", e.target.value)} />
            </label>
            <label className="flex items-center gap-2 md:col-span-2 text-sm">
              <input type="checkbox" checked={draft.accepting} onChange={(e) => set("accepting", e.target.checked)} />
              入会フォームで受付する（受付中）
            </label>
          </div>
          {error && <p className="text-hanko text-xs mt-2">{error}</p>}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
            >
              {saving ? "保存中…" : editingId === "new" ? "作成する" : "保存する"}
            </button>
            <button type="button" onClick={() => setEditingId(null)} className="text-sm border border-line rounded px-4 py-2">
              キャンセル
            </button>
          </div>
        </div>
      )}

      {classes.length === 0 ? (
        <p className="text-xs text-muted text-center py-4">募集中・募集予定のクラスはありません</p>
      ) : (
        <ul className="space-y-3">
          {classes.map((c) => {
            const apps = applicantsOf(c.id);
            const full = c.capacity != null && apps.length >= c.capacity;
            return (
              <li key={c.id} className="border border-line rounded-md p-4 bg-white">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-bold">{c.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {recruitTimeLabel(c)}　{c.teacher}　開始 {c.startDate}　月謝 {formatYenNum(c.monthlyFee)}
                    </div>
                    {c.schedule && <div className="text-xs text-muted">日程：{c.schedule}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      申込 <b className="text-base">{apps.length}</b>
                      {c.capacity != null && <span className="text-muted"> / {c.capacity}名</span>}
                      {full && <b className="ml-1 text-xs text-hanko">満席</b>}
                    </span>
                    <button
                      type="button"
                      aria-pressed={c.accepting}
                      onClick={() => toggle(c)}
                      className={`inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full text-xs font-bold border ${
                        c.accepting ? "bg-matcha-deep border-matcha-deep text-white" : "bg-white border-line text-ink"
                      }`}
                    >
                      <span className={`w-6 h-6 rounded-full ${c.accepting ? "bg-white" : "bg-line"}`} />
                      {c.accepting ? "受付中" : "受付停止"}
                    </button>
                    <button type="button" onClick={() => openEdit(c)} className="text-xs border border-line rounded px-3 py-1.5">
                      編集
                    </button>
                    {apps.length === 0 && (
                      <button type="button" onClick={() => remove(c)} className="text-xs text-hanko underline decoration-dotted underline-offset-2">
                        削除
                      </button>
                    )}
                  </div>
                </div>
                {full && c.accepting && (
                  <p className="text-xs text-hanko mt-2">定員に達しました。受付を停止してください。</p>
                )}
                {apps.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5 mt-3">
                    {apps.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => onSelect?.(m)}
                          className="text-xs border border-line rounded px-2 py-1 hover:border-matcha-deep"
                        >
                          {m.name}
                          <span className="text-muted ml-1">（{m.joinDate}）</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
