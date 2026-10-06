"use client";

// 茶道教室：木曜日・日曜日クラスの開催日・出欠状況（管理画面）。
// 土曜日クラス（予約制・chadoSaturdaySessions）と同じ見た目で、開催日ごとに担当講師と出欠を管理する。
// 木曜日・日曜日は予約制ではないため、そのクラスの在籍会員全員を並べ、
// 各枠は、マイページからの出欠回答を「出席者／欠席者／未回答」に分けて表示する
// （次回のお稽古日はrsvp、それ以外の日はその月の出欠＝members.attendance）。出欠の修正は出席簿で行う。
// データ：chadoClassSessions コレクション（doc id = "YYYY-MM-DD_木曜日" など）

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { CHADO_CLASS_LABEL, CHADO_CLASS_TIME, CHADO_FIXED_TEACHERS } from "@/lib/chadoClasses";
import { nextLessonKey, type NextLessonInfo } from "@/lib/nextLesson";
import type { ChadoKyoshitsuClass, Member } from "@/types";

type WeeklyClass = "木曜日" | "日曜日";
type Mark = "出席" | "欠席";

interface WeeklySession {
  id: string;
  date: string;
  chadoClass: WeeklyClass;
  amTeacher?: string;
  pmTeacher?: string;
  attendance?: Record<string, Mark>;
}

// 枠：木曜日は1枠、日曜日は午前（日曜日クラス）・午後（日曜日午後クラス）の2枠
const SLOTS: Record<WeeklyClass, { key: "am" | "pm"; label: string; cls: ChadoKyoshitsuClass }[]> = {
  "木曜日": [{ key: "am", label: CHADO_CLASS_TIME["木曜日"], cls: "木曜日" }],
  "日曜日": [
    { key: "am", label: `午前 ${CHADO_CLASS_TIME["日曜日"]}`, cls: "日曜日" },
    { key: "pm", label: `午後 ${CHADO_CLASS_TIME["日曜日午後"]}`, cls: "日曜日午後" },
  ],
};

const WEEKDAY_INDEX: Record<WeeklyClass, number> = { "木曜日": 4, "日曜日": 0 };

export default function ChadoWeeklySessions({
  chadoClass,
  month,
  members,
  onSelect,
}: {
  chadoClass: WeeklyClass;
  month: string; // "YYYY-MM"
  members: Member[];
  onSelect?: (m: Member) => void;
}) {
  const [sessions, setSessions] = useState<WeeklySession[]>([]);
  const [nextDates, setNextDates] = useState<Record<string, NextLessonInfo>>({});
  const [newDate, setNewDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "chadoClassSessions"), where("chadoClass", "==", chadoClass));
    return onSnapshot(q, (snap) => {
      setSessions(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as WeeklySession))
          .sort((a, b) => a.date.localeCompare(b.date))
      );
    });
  }, [chadoClass]);

  useEffect(() => {
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      setNextDates((snap.data()?.dates as Record<string, NextLessonInfo>) ?? {});
    });
  }, []);

  const monthSessions = sessions.filter((s) => s.date.startsWith(month));
  const slots = SLOTS[chadoClass];

  const rosters = useMemo(() => {
    const r: Record<string, Member[]> = {};
    for (const sl of slots) {
      r[sl.cls] = members
        .filter((m) => m.group === "茶道教室" && m.status === "在籍" && m.chadoClass === sl.cls)
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    return r;
  }, [members, slots]);

  async function addSession() {
    if (!newDate) return;
    setError(null);
    const id = `${newDate}_${chadoClass}`;
    if (sessions.some((s) => s.id === id)) {
      setError("その開催日はすでに登録されています。");
      return;
    }
    await setDoc(doc(db, "chadoClassSessions", id), {
      date: newDate,
      chadoClass,
      amTeacher: CHADO_FIXED_TEACHERS[slots[0].cls] ?? "",
      ...(slots[1] ? { pmTeacher: CHADO_FIXED_TEACHERS[slots[1].cls] ?? "" } : {}),
      attendance: {},
    });
    setNewDate("");
  }

  async function removeSession(s: WeeklySession) {
    if (!confirm(`${s.date} の開催日を削除しますか？（記録した出欠も削除されます。出席簿の記録はそのまま残ります）`)) return;
    await deleteDoc(doc(db, "chadoClassSessions", s.id));
  }

  const dateWarn =
    newDate && new Date(`${newDate}T00:00:00`).getDay() !== WEEKDAY_INDEX[chadoClass]
      ? `${chadoClass}ではない日付です`
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input type="date" className="input" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
        <button
          className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 disabled:opacity-50"
          disabled={!newDate}
          onClick={addSession}
        >
          ＋ 開催日を追加
        </button>
        {dateWarn && <span className="text-xs text-hanko">{dateWarn}</span>}
        {error && <span className="text-xs text-hanko">{error}</span>}
      </div>

      <div className="space-y-4">
        {monthSessions.map((s) => (
          <div key={s.id} className="border border-line rounded-md p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold">{s.date}</span>
              <button
                className="text-xs text-hanko underline decoration-dotted underline-offset-2"
                onClick={() => removeSession(s)}
              >
                この開催日を削除
              </button>
            </div>
            <div className={`grid gap-4 ${slots.length > 1 ? "md:grid-cols-2" : ""}`}>
              {slots.map((sl) => {
                const roster = rosters[sl.cls] ?? [];
                const teacherField = sl.key === "am" ? "amTeacher" : "pmTeacher";
                const next = nextDates[nextLessonKey("茶道教室", sl.cls)]?.date?.slice(0, 10);
                const isNext = next === s.date;
                // 次回のお稽古日はマイページの回答（rsvp）、それ以外の日はその月の出欠（マイページ回答時に記録される）
                const monthKey = s.date.slice(0, 7);
                const answerOf = (m: Member): "出席" | "欠席" | "未回答" =>
                  isNext ? m.rsvp ?? "未回答" : m.attendance?.[monthKey] ?? "未回答";
                return (
                  <div key={sl.key}>
                    <p className="text-xs font-bold text-matcha-deep mb-1">
                      {CHADO_CLASS_LABEL[sl.cls]}クラス　{sl.label}
                      {isNext && <span className="ml-2 text-[11px] font-normal text-muted">次回のお稽古</span>}
                    </p>
                    <input
                      key={`${s.id}-${teacherField}-${s[teacherField] ?? ""}`}
                      className="border border-line rounded px-2 py-1 text-xs w-full mb-1"
                      placeholder="担当講師名"
                      defaultValue={s[teacherField] ?? ""}
                      onBlur={(e) =>
                        e.target.value !== (s[teacherField] ?? "") &&
                        updateDoc(doc(db, "chadoClassSessions", s.id), { [teacherField]: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted mb-2">
                      マイページの出欠回答（在籍 {roster.length}名）
                    </p>
                    {([
                      ["出席", "出席者", "text-matcha-deep"],
                      ["欠席", "欠席者", "text-hanko"],
                      ["未回答", "未回答", "text-muted"],
                    ] as const).map(([key, label, color]) => {
                      const list = roster.filter((m) => answerOf(m) === key);
                      return (
                        <div key={key} className="mb-2">
                          <p className={`text-xs font-bold ${color}`}>
                            {label} {list.length}名
                          </p>
                          {list.length === 0 ? (
                            <p className="text-xs text-muted">—</p>
                          ) : (
                            <ul className="flex flex-wrap gap-1.5 mt-1">
                              {list.map((m) => (
                                <li key={m.id}>
                                  <button
                                    type="button"
                                    onClick={() => onSelect?.(m)}
                                    className="text-xs border border-line rounded px-2 py-1 bg-white hover:border-matcha-deep"
                                  >
                                    {m.name}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {monthSessions.length === 0 && (
          <p className="text-xs text-muted text-center py-4">この月の開催日はまだ登録されていません</p>
        )}
      </div>
    </div>
  );
}
