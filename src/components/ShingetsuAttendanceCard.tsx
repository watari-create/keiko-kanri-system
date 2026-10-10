"use client";

// マイページ（新月会の会員）：月ごとのタブで、その月の2つの開催日（日付・場所）から出席する日を選ぶ。
// 回答は members.shingetsuChoice に保存され、管理画面・講師画面の出席簿と同じデータを使う。
// 管理画面側で変更された回答もリアルタイムで反映されるよう、会員ドキュメントを購読している。

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useShingetsuSessions } from "@/components/ShingetsuAttendanceGrid";
import {
  SHINGETSU_ABSENT,
  groupSessionsByMonth,
  setShingetsuChoice,
  shingetsuDateLabel,
  todayKey,
} from "@/lib/shingetsu";

export default function ShingetsuAttendanceCard({ memberId }: { memberId: string }) {
  const sessions = useShingetsuSessions();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const today = todayKey();

  useEffect(
    () =>
      onSnapshot(doc(db, "members", memberId), (snap) => {
        setChoices((snap.data()?.shingetsuChoice as Record<string, string> | undefined) ?? {});
      }),
    [memberId]
  );

  // 今月以降の月だけをタブに出す
  const months = useMemo(
    () => groupSessionsByMonth(sessions).filter((m) => m.month >= today.slice(0, 7)),
    [sessions, today]
  );
  const [tab, setTab] = useState<string | null>(null);
  const active = months.find((m) => m.month === tab) ?? months[0];

  if (months.length === 0) {
    return (
      <div className="bg-paper border border-line rounded-lg p-5 mb-4">
        <h2 className="text-base font-bold text-ink mb-2 pl-2 border-l-4 border-matcha">お稽古の出欠登録</h2>
        <p className="text-xs text-muted">今後の開催日はまだ登録されていません。</p>
      </div>
    );
  }

  const current = choices[active.month];
  const allPassed = active.sessions.every((s) => s.date < today);
  const chosen = active.sessions.find((s) => s.date === current);

  async function choose(value: string) {
    setSaving(true);
    setMsg(null);
    try {
      await setShingetsuChoice(memberId, active.month, value);
      const s = active.sessions.find((x) => x.date === value);
      setMsg(s ? `${shingetsuDateLabel(s.date)}（${s.place}）に出席で登録しました。` : `${Number(active.month.slice(5))}月は欠席で登録しました。`);
    } catch (e) {
      console.error(e);
      setMsg("保存できませんでした。時間をおいて再度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-paper border border-line rounded-lg p-5 mb-4">
      <h2 className="text-base font-bold text-ink mb-1 pl-2 border-l-4 border-matcha">お稽古の出欠登録</h2>
      <p className="text-xs text-muted mb-3">毎月2日の開催日のうち、ご都合のよい1日をお選びください。</p>

      <div className="flex gap-1 overflow-x-auto border-b border-line mb-4" role="tablist" aria-label="月">
        {months.map((m) => {
          const on = m.month === active.month;
          const answered = !!choices[m.month];
          return (
            <button
              key={m.month}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setTab(m.month);
                setMsg(null);
              }}
              className={`text-sm px-3 pb-2 -mb-px border-b-2 whitespace-nowrap ${
                on ? "border-matcha-deep text-matcha-deep font-bold" : "border-transparent text-muted"
              }`}
            >
              {Number(m.month.slice(5))}月{answered ? "" : "・未"}
            </button>
          );
        })}
      </div>

      <div className="mb-3">
        {chosen ? (
          <span className="inline-block text-xs font-bold text-matcha-deep bg-matcha-pale rounded-full px-3 py-1">
            ✓ {shingetsuDateLabel(chosen.date)}（{chosen.place}）に出席
          </span>
        ) : current === SHINGETSU_ABSENT ? (
          <span className="inline-block text-xs font-bold text-hanko bg-hanko-pale rounded-full px-3 py-1">✓ この月は欠席</span>
        ) : (
          <span className="inline-block text-xs text-muted bg-bg border border-line rounded-full px-3 py-1">未回答</span>
        )}
      </div>

      <div className="space-y-2">
        {active.sessions.map((s) => {
          const on = current === s.date;
          const passed = s.date < today;
          return (
            <button
              key={s.id}
              type="button"
              disabled={saving || passed || on}
              onClick={() => choose(s.date)}
              className={`w-full flex items-center justify-between rounded px-4 py-3 text-sm text-left transition ${
                on
                  ? "bg-btn text-btn-ink ring-1 ring-matcha"
                  : "border border-line text-ink disabled:opacity-50"
              }`}
            >
              <span>
                <span className="font-bold">{shingetsuDateLabel(s.date)}</span>
                <span className="ml-2">{s.place || "場所未定"}</span>
              </span>
              <span className="text-xs">{on ? "✓ 出席" : passed ? "終了" : "この日に出席"}</span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={saving || allPassed || current === SHINGETSU_ABSENT}
          onClick={() => choose(SHINGETSU_ABSENT)}
          className={`w-full rounded py-2 text-sm transition ${
            current === SHINGETSU_ABSENT
              ? "bg-hanko text-white"
              : "border border-line text-muted disabled:opacity-50"
          }`}
        >
          {current === SHINGETSU_ABSENT ? "✓ この月は欠席" : "この月は欠席する"}
        </button>
      </div>
      <p className="text-xs text-muted mt-3">出欠は、各お稽古の1週間前までにご回答ください。振替は別の月へのご参加、または不参加となります。</p>
      {msg && <p className="text-xs text-matcha-deep mt-2">{msg}</p>}
    </div>
  );
}
