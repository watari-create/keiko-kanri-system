"use client";

// 新月会の出席簿：会員×開催日（日付＋場所）のグリッド。
// 新月会は月2回の開催日のうち、どちらか1日を選んで出席する方式（src/lib/shingetsu.ts）。
// セルをクリックすると、その月の回答が「この日に出席 → 欠席 → 未回答」と切り替わる。
// マイページの回答と同じフィールド（members.shingetsuChoice）を読み書きするため、双方に即時反映される。
// canEditSessions のときは、開催日（日付・場所）の追加・変更・削除もできる（管理画面・講師画面）。
// 開催日の変更は Cloud Functions（syncShingetsuSessionToCalendar）が本部のGoogleカレンダーへ自動で書き込む。

import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, deleteField, doc, onSnapshot, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Member } from "@/types";
import {
  SHINGETSU_ABSENT,
  groupSessionsByMonth,
  setShingetsuChoice,
  shingetsuDateLabel,
  shingetsuMonthLabel,
  shingetsuShortLabel,
  todayKey,
  type ShingetsuSession,
} from "@/lib/shingetsu";

export function useShingetsuSessions(): ShingetsuSession[] {
  const [sessions, setSessions] = useState<ShingetsuSession[]>([]);
  useEffect(
    () =>
      onSnapshot(collection(db, "shingetsuSessions"), (snap) => {
        setSessions(
          snap.docs
            .map((d) => ({
              id: d.id,
              date: (d.data().date as string) ?? d.id,
              place: (d.data().place as string) ?? "",
              calendarEventId: d.data().calendarEventId as string | undefined,
            }))
            .sort((a, b) => a.date.localeCompare(b.date))
        );
      }),
    []
  );
  return sessions;
}

export default function ShingetsuAttendanceGrid({
  members,
  editable,
  canEditSessions = false,
}: {
  members: Member[];
  editable: boolean;
  canEditSessions?: boolean;
}) {
  const sessions = useShingetsuSessions();
  const months = useMemo(() => groupSessionsByMonth(sessions), [sessions]);
  const thisMonth = todayKey().slice(0, 7);
  const [selected, setSelected] = useState<string>("upcoming");

  const shown =
    selected === "all"
      ? months
      : selected === "upcoming"
      ? months.filter((m) => m.month >= thisMonth)
      : months.filter((m) => m.month === selected);
  const shownSessions = shown.flatMap((m) => m.sessions);
  const activeMembers = members.filter((m) => (m.status ?? "在籍") === "在籍" && !m.isTestAccount);

  function onCellClick(m: Member, s: ShingetsuSession) {
    if (!editable) return;
    const mk = s.date.slice(0, 7);
    const cur = m.shingetsuChoice?.[mk];
    const next = cur === s.date ? SHINGETSU_ABSENT : cur === SHINGETSU_ABSENT ? undefined : s.date;
    setShingetsuChoice(m.id, mk, next).catch((e) => {
      console.error(e);
      alert("保存できませんでした。時間をおいて再度お試しください。");
    });
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <label className="text-muted">表示：</label>
        <select className="border border-line rounded px-2 py-1 text-xs" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="upcoming">今月以降</option>
          <option value="all">全期間</option>
          {months.map((m) => (
            <option key={m.month} value={m.month}>
              {shingetsuMonthLabel(m.month)}のみ
            </option>
          ))}
        </select>
      </div>

      {shownSessions.length === 0 ? (
        <p className="text-sm text-muted py-4 text-center">開催日が登録されていません</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-sm border-collapse">
            <thead>
              <tr className="text-muted">
                <th className="sticky left-0 bg-paper w-20 sm:w-28" />
                {shown.map((m) => (
                  <th key={m.month} colSpan={m.sessions.length} className="px-1 pt-1 text-center text-xs font-bold text-matcha-deep border-x border-line">
                    {shingetsuMonthLabel(m.month)}
                  </th>
                ))}
              </tr>
              <tr className="text-muted border-b border-line">
                <th className="py-2 pr-2 text-left sticky left-0 bg-paper w-20 sm:w-28">氏名</th>
                {shownSessions.map((s) => (
                  <th key={s.id} className="px-1 text-center font-medium text-xs leading-tight whitespace-nowrap border-x border-line">
                    {shingetsuShortLabel(s.date)}
                    <br />
                    <span className="text-[11px]">{s.place || "場所未定"}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeMembers.map((m) => (
                <tr key={m.id} className="border-b border-line">
                  <td className="py-2 pr-2 sticky left-0 bg-paper w-20 sm:w-28">
                    <span className="block truncate" title={m.name}>{m.name}</span>
                  </td>
                  {shownSessions.map((s) => {
                    const cur = m.shingetsuChoice?.[s.date.slice(0, 7)];
                    const mark = cur === s.date ? "○" : cur === SHINGETSU_ABSENT ? "×" : cur ? "" : "－";
                    const cls =
                      cur === s.date
                        ? "text-matcha-deep font-bold bg-matcha-pale"
                        : cur === SHINGETSU_ABSENT
                        ? "text-hanko bg-hanko-pale"
                        : "text-muted";
                    return (
                      <td
                        key={s.id}
                        className={`w-14 h-9 text-center border border-line ${cls} ${editable ? "cursor-pointer hover:bg-matcha-pale/40" : ""}`}
                        onClick={() => onCellClick(m, s)}
                      >
                        {mark}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="text-xs text-muted">
                <td className="py-2 pr-2 sticky left-0 bg-paper">出席人数</td>
                {shownSessions.map((s) => (
                  <td key={s.id} className="text-center font-bold text-matcha-deep">
                    {activeMembers.filter((m) => m.shingetsuChoice?.[s.date.slice(0, 7)] === s.date).length}名
                  </td>
                ))}
              </tr>
              {activeMembers.length === 0 && (
                <tr>
                  <td colSpan={1 + shownSessions.length} className="py-4 text-center text-muted">会員がいません</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted">
        <span>○ この日に出席</span>
        <span>× その月は欠席</span>
        <span>空欄 その月の別の日に出席</span>
        <span>－ 未回答</span>
      </div>
      {editable && (
        <p className="mt-1 text-xs text-muted">
          セルをクリックすると「この日に出席 → 欠席 → 未回答」と切り替わります。会員のマイページにもそのまま反映されます。
        </p>
      )}

      {canEditSessions && <SessionEditor sessions={sessions} members={members} />}
    </div>
  );
}

// 開催日（日付・場所）の追加・変更・削除
function SessionEditor({ sessions, members }: { sessions: ShingetsuSession[]; members: Member[] }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [place, setPlace] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setMsg("日付を選んでください。");
    if (sessions.some((s) => s.date === date)) return setMsg("その日付はすでに登録されています。");
    await setDoc(doc(db, "shingetsuSessions", date), { date, place: place.trim() });
    setDate("");
    setPlace("");
    setMsg(`${shingetsuDateLabel(date)}を追加しました。`);
  }

  // 日付の変更：新しい日付のドキュメントを作ってカレンダーの予定IDを引き継ぎ、古い日付を削除する。
  // 古い日付を選んでいた会員の回答も新しい日付に付け替える（別の月に移る場合、移動先の月が未回答の会員だけ付け替え）。
  async function move(s: ShingetsuSession, newDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || newDate === s.date) return;
    if (sessions.some((x) => x.date === newDate)) return setMsg("変更先の日付はすでに登録されています。");
    const oldMonth = s.date.slice(0, 7);
    const newMonth = newDate.slice(0, 7);
    const batch = writeBatch(db);
    batch.set(doc(db, "shingetsuSessions", newDate), {
      date: newDate,
      place: s.place,
      ...(s.calendarEventId ? { calendarEventId: s.calendarEventId } : {}),
    });
    batch.delete(doc(db, "shingetsuSessions", s.id));
    let moved = 0;
    for (const m of members) {
      if (m.shingetsuChoice?.[oldMonth] !== s.date) continue;
      if (oldMonth === newMonth) {
        batch.update(doc(db, "members", m.id), { [`shingetsuChoice.${oldMonth}`]: newDate });
      } else {
        const updates: Record<string, unknown> = {
          [`shingetsuChoice.${oldMonth}`]: deleteField(),
          [`attendance.${oldMonth}`]: deleteField(),
        };
        if (!m.shingetsuChoice?.[newMonth]) {
          updates[`shingetsuChoice.${newMonth}`] = newDate;
          updates[`attendance.${newMonth}`] = "出席";
        }
        batch.update(doc(db, "members", m.id), updates);
      }
      moved++;
    }
    await batch.commit();
    setMsg(`${shingetsuDateLabel(s.date)}を${shingetsuDateLabel(newDate)}に変更しました（出席予定の${moved}名も付け替え）。カレンダーにも自動で反映されます。`);
  }

  async function remove(s: ShingetsuSession) {
    if (!confirm(`${shingetsuDateLabel(s.date)}（${s.place}）を削除しますか？\nこの日を選んでいた会員の回答は「未回答」には戻りません。必要に応じて出席簿で直してください。`)) return;
    await deleteDoc(doc(db, "shingetsuSessions", s.id));
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <button type="button" className="text-xs text-matcha-deep underline" onClick={() => setOpen(!open)}>
        {open ? "開催日の編集を閉じる" : "開催日（日付・場所）を追加・変更する"}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">日付</label>
              <input type="date" className="border border-line rounded px-2 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">場所</label>
              <input className="border border-line rounded px-2 py-1 text-sm w-32" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="例：鎌倉" />
            </div>
            <button type="button" className="border border-matcha-deep text-matcha-deep rounded px-3 py-1 text-sm" onClick={add}>
              追加
            </button>
          </div>
          {msg && <p className="text-xs text-matcha-deep">{msg}</p>}
          <table className="text-sm">
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b border-line">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    <input
                      type="date"
                      className="border border-line rounded px-2 py-0.5 text-sm"
                      defaultValue={s.date}
                      title="日付を変更すると、出席予定の会員の回答とカレンダーの予定も付け替わります"
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v && v !== s.date) move(s, v).catch((err) => {
                          console.error(err);
                          setMsg("日付を変更できませんでした。");
                        });
                      }}
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      className="border border-line rounded px-2 py-0.5 text-sm w-32"
                      defaultValue={s.place}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== s.place) updateDoc(doc(db, "shingetsuSessions", s.id), { place: v });
                      }}
                    />
                  </td>
                  <td className="py-1">
                    <button type="button" className="text-xs text-hanko underline" onClick={() => remove(s)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted">
            日付・場所は入力欄から離れると保存されます。日付を変えると、その日に出席予定だった会員の回答も新しい日付に付け替わります。
            変更は本部のGoogleカレンダーにも自動で反映されます（カレンダー側で直接変更しても、システムには反映されません）。
          </p>
        </div>
      )}
    </div>
  );
}
