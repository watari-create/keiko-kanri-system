"use client";

// 出席簿（日にち表示）：会員×お稽古日のグリッド。本部稽古の会（名月会・茶道教室・G1など）で使う。
// 新月会は ShingetsuAttendanceGrid、宗徧流稽古・UCIは月ごとの AttendanceGrid のまま。
//
// 列（お稽古日）は次を合わせたもの：
//   ・本部の共有Googleカレンダーのお稽古日（Cloud Functionsが meta/lessonDateLog に蓄積。過ぎた日も残る）
//     ※デプロイ前・同期前でも表示できるよう、meta/nextLessonDates.upcoming（今後の予定）も合わせて使う
//   ・出席簿から手で追加した日（lessonExtraDates）
//   ・茶道教室：開催日・予約状況に登録した日（木曜日・日曜日＝chadoClassSessions、土曜日＝chadoSaturdaySessions）
//   ・その会員に出欠の記録・マイページの回答がある日
// 茶道教室は、会員のクラス（曜日）のお稽古日だけを入力できる（他のクラスの日は空白）。
//
// セルをクリックすると 未記録 → 出席 → 欠席 → 未記録。記録は members.attendanceByDate[日付]。
// あわせて members.attendance[月] を、その月の日にちの記録から自動で更新する（経理の都度払いなどは月の記録を使う）。
// 土曜日クラスの会員は、開催日・予約状況の出欠（予約ごとの記録）をそのまま表示する（ここでは変更不可）。
// 9月以前など、日にちの記録がない月の出欠は「月ごと」表示で確認する。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { currentMonthKey, fiscalYearMonths, monthLabel } from "@/lib/fiscalMonths";
import { CHADO_CLASS_LABEL } from "@/lib/chadoClasses";
import type { NextLessonInfo } from "@/lib/nextLesson";
import type { ChadoSaturdaySession, Member } from "@/types";

type Mark = "出席" | "欠席";
type Section = { label: string | null; members: Member[] };
const CHADO = "茶道教室";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 会員が出欠を付けられるお稽古日のキー（meta/nextLessonDates と同じ規則：茶道教室はクラスごと）
function memberKeys(m: Member): string[] {
  if (m.group !== CHADO) return [m.group];
  return m.chadoClass ? [`${CHADO}・${m.chadoClass}`, CHADO] : [CHADO];
}
function groupOfKey(key: string): string {
  return key.split("・")[0];
}
function dateLabel(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return `${dt.getMonth() + 1}/${dt.getDate()}(${WEEKDAYS[dt.getDay()]})`;
}

// 手で追加するときのクラスの選択肢（茶道教室のみ。土曜日クラスは「開催日・予約状況」から追加する）
const CHADO_ADD_OPTIONS: { key: string; label: string }[] = [
  { key: `${CHADO}・木曜日`, label: `${CHADO_CLASS_LABEL["木曜日"]}クラス` },
  { key: `${CHADO}・日曜日`, label: `${CHADO_CLASS_LABEL["日曜日"]}クラス` },
  { key: `${CHADO}・日曜日午後`, label: `${CHADO_CLASS_LABEL["日曜日午後"]}クラス` },
  { key: CHADO, label: "全クラス" },
];

interface ExtraDate {
  id: string;
  group: string;
  key: string;
  date: string;
}

export default function DateAttendanceGrid({
  group,
  sections,
  editable,
  monthlyView,
}: {
  group: string;
  sections: Section[];
  editable: boolean;
  monthlyView?: ReactNode; // 「月ごと」表示（これまでの月単位の記録）
}) {
  const months = fiscalYearMonths();
  const [view, setView] = useState<"date" | "month">("date");
  const [month, setMonth] = useState(() => {
    const cur = currentMonthKey();
    return months.includes(cur) ? cur : months[0];
  });
  const [calendarLog, setCalendarLog] = useState<Record<string, Record<string, { date: string; place?: string }>>>({});
  const [upcoming, setUpcoming] = useState<Record<string, NextLessonInfo[]>>({});
  const [extra, setExtra] = useState<ExtraDate[]>([]);
  const [weeklySessions, setWeeklySessions] = useState<{ date: string; chadoClass: string }[]>([]);
  const [saturday, setSaturday] = useState<ChadoSaturdaySession[]>([]);
  const [newDate, setNewDate] = useState("");
  const [newKey, setNewKey] = useState(CHADO_ADD_OPTIONS[0].key);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onSnapshot(doc(db, "meta", "lessonDateLog"), (snap) => {
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        const out: Record<string, Record<string, { date: string; place?: string }>> = {};
        for (const [k, v] of Object.entries(data)) if (v && typeof v === "object") out[k] = v as never;
        setCalendarLog(out);
      }),
    []
  );
  useEffect(
    () =>
      onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
        setUpcoming((snap.data()?.upcoming as Record<string, NextLessonInfo[]>) ?? {});
      }),
    []
  );
  useEffect(
    () =>
      onSnapshot(query(collection(db, "lessonExtraDates"), where("group", "==", group)), (snap) => {
        setExtra(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ExtraDate, "id">) })));
      }),
    [group]
  );
  useEffect(() => {
    if (group !== CHADO) {
      setWeeklySessions([]);
      setSaturday([]);
      return;
    }
    const u1 = onSnapshot(collection(db, "chadoClassSessions"), (snap) => {
      setWeeklySessions(snap.docs.map((d) => d.data() as { date: string; chadoClass: string }));
    });
    const u2 = onSnapshot(collection(db, "chadoSaturdaySessions"), (snap) => {
      setSaturday(snap.docs.map((d) => ({ ...(d.data() as ChadoSaturdaySession), id: d.id })));
    });
    return () => {
      u1();
      u2();
    };
  }, [group]);

  // 日付 → その日がお稽古日になっているキー（会・クラス）。場所はカレンダーのもの
  const dateKeys = useMemo(() => {
    const map = new Map<string, { keys: Set<string>; places: Set<string>; manualIds: string[] }>();
    const add = (date: string, key: string, place?: string, manualId?: string) => {
      if (groupOfKey(key) !== group || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const e = map.get(date) ?? { keys: new Set<string>(), places: new Set<string>(), manualIds: [] };
      e.keys.add(key);
      if (place) e.places.add(place);
      if (manualId) e.manualIds.push(manualId);
      map.set(date, e);
    };
    for (const [key, byId] of Object.entries(calendarLog)) for (const v of Object.values(byId)) add(v.date, key, v.place);
    for (const [key, list] of Object.entries(upcoming)) for (const v of list) add(v.date.slice(0, 10), key, v.place);
    for (const x of extra) add(x.date, x.key, undefined, x.id);
    for (const s of weeklySessions) {
      if (s.chadoClass === "日曜日") {
        add(s.date, `${CHADO}・日曜日`);
        add(s.date, `${CHADO}・日曜日午後`);
      } else add(s.date, `${CHADO}・${s.chadoClass}`);
    }
    for (const s of saturday) add(s.date, `${CHADO}・土曜日`);
    return map;
  }, [calendarLog, upcoming, extra, weeklySessions, saturday, group]);

  // 土曜日クラス：会員ID → 日付 → 予約と出欠
  const saturdayMarks = useMemo(() => {
    const out: Record<string, Record<string, Mark | "予約">> = {};
    for (const s of saturday) {
      for (const b of [...(s.amBookings ?? []), ...(s.pmBookings ?? [])]) {
        const cur = (out[b.memberId] ??= {})[s.date];
        const v: Mark | "予約" = b.attended ?? "予約";
        // 午前・午後の両方を予約している場合：出席が1つでもあれば出席
        if (!cur || v === "出席" || (v === "欠席" && cur === "予約")) out[b.memberId][s.date] = v;
      }
    }
    return out;
  }, [saturday]);

  const isSaturdayMember = (m: Member) => m.group === CHADO && m.chadoClass === "土曜日";

  function applicable(m: Member, d: string): boolean {
    if (m.attendanceByDate?.[d] || m.rsvpByDate?.[d]) return true;
    if (isSaturdayMember(m)) return !!saturdayMarks[m.id]?.[d];
    const keys = dateKeys.get(d)?.keys;
    if (!keys) return false;
    return memberKeys(m).some((k) => keys.has(k));
  }

  function columnsFor(members: Member[]): string[] {
    const set = new Set<string>();
    for (const d of Array.from(dateKeys.keys())) if (d.startsWith(month) && members.some((m) => applicable(m, d))) set.add(d);
    for (const m of members) {
      for (const d of Object.keys(m.attendanceByDate ?? {})) if (d.startsWith(month)) set.add(d);
      for (const d of Object.keys(m.rsvpByDate ?? {})) if (d.startsWith(month)) set.add(d);
      if (isSaturdayMember(m)) for (const d of Object.keys(saturdayMarks[m.id] ?? {})) if (d.startsWith(month)) set.add(d);
    }
    return Array.from(set).sort();
  }

  async function setMark(m: Member, date: string, value: Mark | undefined) {
    setError(null);
    const byDate: Record<string, Mark> = { ...(m.attendanceByDate ?? {}) };
    if (value) byDate[date] = value;
    else delete byDate[date];
    const mk = date.slice(0, 7);
    const vals = Object.entries(byDate)
      .filter(([d]) => d.startsWith(mk))
      .map(([, v]) => v);
    const monthVal: Mark | undefined = vals.includes("出席") ? "出席" : vals.includes("欠席") ? "欠席" : undefined;
    try {
      await updateDoc(doc(db, "members", m.id), {
        [`attendanceByDate.${date}`]: value ?? deleteField(),
        [`attendance.${mk}`]: monthVal ?? deleteField(),
      });
    } catch (e) {
      console.error(e);
      setError("保存できませんでした。権限またはネットワークをご確認ください。");
    }
  }

  async function addDate() {
    if (!newDate) return;
    setError(null);
    const key = group === CHADO ? newKey : group;
    try {
      await setDoc(doc(db, "lessonExtraDates", `${key}_${newDate}`), {
        group,
        key,
        date: newDate,
        createdAt: new Date().toISOString(),
      });
      setMonth(newDate.slice(0, 7));
      setNewDate("");
    } catch (e) {
      console.error(e);
      setError("開催日を追加できませんでした。");
    }
  }

  async function removeManual(date: string, ids: string[]) {
    if (!confirm(`${dateLabel(date)} を出席簿の開催日から外しますか？（記録した出欠は残ります）`)) return;
    await Promise.all(ids.map((id) => deleteDoc(doc(db, "lessonExtraDates", id))));
  }

  const total = sections.reduce((n, s) => n + s.members.length, 0);
  const hasSaturday = sections.some((s) => s.members.some(isSaturdayMember));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex rounded border border-line overflow-hidden text-xs" role="tablist" aria-label="表示の単位">
          {([
            ["date", "日にち"],
            ["month", "月ごと（これまでの記録）"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={view === k}
              onClick={() => setView(k)}
              className={`px-3 py-1.5 ${view === k ? "bg-matcha-deep text-white font-bold" : "bg-white text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "date" && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="月">
            {months.map((mk) => (
              <button
                key={mk}
                type="button"
                role="tab"
                aria-selected={month === mk}
                onClick={() => setMonth(mk)}
                className={`text-xs rounded-full px-3 py-1 border ${
                  month === mk ? "bg-matcha-deep border-matcha-deep text-white font-bold" : "bg-white border-line text-ink"
                }`}
              >
                {monthLabel(mk)}
              </button>
            ))}
          </div>
        )}
      </div>

      {view === "month" ? (
        monthlyView ?? null
      ) : (
        <>
          {sections.map((section, sIdx) => {
            const cols = columnsFor(section.members);
            return (
              <div key={`${section.label ?? "all"}-${sIdx}`} className="mb-4">
                {section.label && (
                  <p className="pt-2 pb-1 text-xs font-bold text-matcha-deep">
                    {section.label}（{section.members.length}名）
                  </p>
                )}
                {cols.length === 0 ? (
                  <p className="text-xs text-muted py-2">{monthLabel(month)}のお稽古日はまだありません。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="text-sm border-collapse">
                      <thead>
                        <tr className="text-left text-muted border-b border-line">
                          <th className="py-2 pr-2 sticky left-0 bg-paper w-16 sm:w-24">氏名</th>
                          {cols.map((d) => {
                            const info = dateKeys.get(d);
                            const place = info ? Array.from(info.places).join("・") : "";
                            const manual = info?.manualIds ?? [];
                            const onlyManual = !!info && manual.length > 0 && info.keys.size === manual.length;
                            return (
                              <th key={d} className="px-1 text-center font-medium whitespace-nowrap align-bottom" title={place || undefined}>
                                <span className="block text-xs">{dateLabel(d)}</span>
                                {editable && onlyManual && (
                                  <button
                                    type="button"
                                    className="text-[10px] text-muted hover:text-hanko"
                                    onClick={() => removeManual(d, manual)}
                                  >
                                    外す
                                  </button>
                                )}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {section.members.map((m) => {
                          const sat = isSaturdayMember(m);
                          return (
                            <tr key={m.id} className="border-b border-line">
                              <td className="py-2 pr-2 sticky left-0 bg-paper w-16 sm:w-24">
                                <span className="block truncate" title={m.name}>
                                  {m.name}
                                  {sat && <span className="text-muted">※</span>}
                                </span>
                              </td>
                              {cols.map((d) => {
                                if (!applicable(m, d)) {
                                  return <td key={d} className="w-10 h-9 border border-line bg-black/[0.03]" />;
                                }
                                const val: Mark | "予約" | undefined = sat ? saturdayMarks[m.id]?.[d] : m.attendanceByDate?.[d];
                                const hint = !val && !sat ? m.rsvpByDate?.[d] : undefined;
                                const cellEditable = editable && !sat;
                                const color =
                                  val === "出席"
                                    ? "text-matcha-deep font-bold bg-matcha-pale"
                                    : val === "欠席"
                                    ? "text-hanko bg-hanko-pale"
                                    : "text-muted";
                                return (
                                  <td
                                    key={d}
                                    className={`w-10 h-9 text-center border border-line ${color} ${
                                      cellEditable ? "cursor-pointer hover:bg-matcha-pale/40" : ""
                                    }`}
                                    title={
                                      sat
                                        ? "土曜日クラスは「開催日・予約状況」の出欠を表示しています"
                                        : hint
                                        ? `マイページの回答：${hint}（未確定）`
                                        : undefined
                                    }
                                    onClick={() => {
                                      if (!cellEditable) return;
                                      const cur = val as Mark | undefined;
                                      const next: Mark | undefined = cur === undefined ? "出席" : cur === "出席" ? "欠席" : undefined;
                                      setMark(m, d, next);
                                    }}
                                  >
                                    {val === "出席" ? "○" : val === "欠席" ? "×" : val === "予約" ? (
                                      <span className="text-[10px]">予約</span>
                                    ) : hint ? (
                                      <span className="text-[10px] opacity-70">{hint === "出席" ? "(○)" : "(×)"}</span>
                                    ) : (
                                      "－"
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
          {total === 0 && <p className="py-4 text-center text-muted text-sm">会員がいません</p>}

          <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted">
            <span>○ 出席</span>
            <span>× 欠席</span>
            <span>－ 未記録</span>
            <span>(○)(×) マイページの回答（未確定）</span>
            <span>網掛け：その方のクラスのお稽古日ではない日</span>
          </div>
          {hasSaturday && (
            <p className="mt-1 text-xs text-muted">
              ※ 土曜日クラスの方は「開催日・予約状況」の予約と出欠を表示しています（変更はそちらから）。
            </p>
          )}

          {editable && (
            <div className="flex flex-wrap items-end gap-2 mt-4 pt-3 border-t border-line text-xs">
              <span className="text-muted">カレンダーにないお稽古日を追加：</span>
              <input
                type="date"
                className="border border-line rounded px-2 py-1"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
              {group === CHADO && (
                <select className="border border-line rounded px-2 py-1" value={newKey} onChange={(e) => setNewKey(e.target.value)}>
                  {CHADO_ADD_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="border border-matcha-deep text-matcha-deep rounded px-3 py-1 disabled:opacity-40"
                disabled={!newDate}
                onClick={addDate}
              >
                追加
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-hanko">{error}</p>}
        </>
      )}
    </div>
  );
}
