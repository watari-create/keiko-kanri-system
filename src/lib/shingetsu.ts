// 新月会：月2回の開催日から、会員がどちらか1日を選んで出席する方式の出欠管理。
//
// ・開催日：shingetsuSessions/{YYYY-MM-DD} = { date, place }（日付と場所だけを持つ。時刻は持たない）
// ・会員の回答：members/{id}.shingetsuChoice = { "YYYY-MM": "YYYY-MM-DD"（出席する開催日）| "欠席" }
//   マイページ・管理画面・講師画面はすべてこのフィールドを読み書きするので、どこで操作しても他の画面に反映される。
// ・月単位の出席簿・経理との整合のため、選択と同時に members.attendance["YYYY-MM"] も 出席／欠席 に揃える。

import { deleteField, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

export const SHINGETSU_GROUP = "新月会";

export interface ShingetsuSession {
  id: string; // = date（YYYY-MM-DD）
  date: string;
  place: string;
  calendarEventId?: string; // 本部のGoogleカレンダーに書き込んだ予定のID（Cloud Functionsが設定）
}

export type ShingetsuChoice = string; // "YYYY-MM-DD" または "欠席"
export const SHINGETSU_ABSENT = "欠席";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-10-12" → "10月12日(月)" */
export function shingetsuDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日(${wd})`;
}

/** "2026-10-12" → "10/12(月)"（表の見出しなど狭い場所用） */
export function shingetsuShortLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${wd})`;
}

/** "2026-10" → "2026年10月" */
export function shingetsuMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}年${m}月`;
}

/** 開催日を月（YYYY-MM）ごとにまとめる（月・日付とも昇順） */
export function groupSessionsByMonth(sessions: ShingetsuSession[]): { month: string; sessions: ShingetsuSession[] }[] {
  const map = new Map<string, ShingetsuSession[]>();
  for (const s of [...sessions].sort((a, b) => a.date.localeCompare(b.date))) {
    const mk = s.date.slice(0, 7);
    if (!map.has(mk)) map.set(mk, []);
    map.get(mk)!.push(s);
  }
  return [...map.entries()].map(([month, list]) => ({ month, sessions: list }));
}

/** 今日（端末の日付）を YYYY-MM-DD で返す */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 会員のその月の回答を保存する。value が undefined なら回答を取り消す（未回答に戻す）。
 * 出席簿（月単位）の attendance も同時に揃える。
 */
export async function setShingetsuChoice(memberId: string, monthKey: string, value: ShingetsuChoice | undefined) {
  await updateDoc(doc(db, "members", memberId), {
    [`shingetsuChoice.${monthKey}`]: value === undefined ? deleteField() : value,
    [`attendance.${monthKey}`]:
      value === undefined ? deleteField() : value === SHINGETSU_ABSENT ? "欠席" : "出席",
  });
}
