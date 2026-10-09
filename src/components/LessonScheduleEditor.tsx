"use client";

// 管理画面：名月会・茶道教室（木曜日・日曜日クラス）・G1マダムの茶の湯講座の「日程変更・開催場所変更」。
// お稽古日の元データは本部の共有Googleカレンダー（30分ごとに meta/nextLessonDates に同期）。
// ここで変更すると Cloud Functions（changeLessonSchedule）が
//   ・カレンダーの予定の日付・場所欄を書き換え（権限がなく書けない場合も、システム上は変更後の内容で表示）
//   ・元の日付に出欠回答していた会員の回答と、茶道教室の開催日を新しい日付へ付け替え
//   ・マイページ・講師画面・LINE/Slack通知の「次回のお稽古」をすぐ更新
// する。新月会は出席簿の「開催日（日付・場所）を追加・変更する」から、土曜日クラスは開催日・予約状況から変更する。

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "@/lib/firebase";
import { formatLessonDate, upcomingLessonsForGroup, type NextLessonInfo } from "@/lib/nextLesson";

type Draft = { date: string; place: string };

export default function LessonScheduleEditor({ group }: { group: string }) {
  const [open, setOpen] = useState(false);
  const [upcoming, setUpcoming] = useState<Record<string, NextLessonInfo[]> | undefined>();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!open) return;
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      setUpcoming(snap.data()?.upcoming as Record<string, NextLessonInfo[]> | undefined);
      setUpdatedAt((snap.data()?.updatedAt as string | undefined) ?? null);
    });
  }, [open]);

  useEffect(() => {
    setDrafts({});
    setMsg(null);
  }, [group]);

  const rows = useMemo(() => upcomingLessonsForGroup(upcoming, group), [upcoming, group]);

  function draftOf(info: NextLessonInfo): Draft {
    return drafts[info.eventId ?? info.date] ?? { date: info.date.slice(0, 10), place: info.place ?? "" };
  }

  async function save(info: NextLessonInfo) {
    if (!info.eventId) return;
    const d = draftOf(info);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return setMsg({ text: "日付を選んでください。", error: true });
    const dateChanged = d.date !== info.date.slice(0, 10);
    setBusyId(info.eventId);
    setMsg(null);
    try {
      const call = httpsCallable<
        { eventId: string; date: string; place: string },
        { calendarUpdated: boolean; calendarError: string | null }
      >(getFunctions(), "changeLessonSchedule");
      const res = await call({ eventId: info.eventId, date: d.date, place: d.place.trim() });
      const what = [
        dateChanged ? `日程を${formatLessonDate(info.date)}→${formatLessonDate(d.date)}に` : "",
        d.place.trim() !== (info.place ?? "") ? `場所を「${d.place.trim() || "未設定"}」に` : "",
      ]
        .filter(Boolean)
        .join("、");
      setMsg(
        res.data.calendarUpdated
          ? { text: `${what}変更しました。Googleカレンダーにも反映しました。` }
          : {
              text:
                `${what}変更しました（マイページ・講師画面・通知には反映済み）。` +
                `ただしGoogleカレンダーには書き込めなかったため、カレンダー側は元のままです` +
                (res.data.calendarError ? `：${res.data.calendarError}` : "。"),
              error: true,
            }
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[info.eventId!];
        return next;
      });
    } catch (err) {
      console.error(err);
      setMsg({ text: `変更できませんでした：${err instanceof Error ? err.message : String(err)}`, error: true });
    } finally {
      setBusyId(null);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setMsg(null);
    try {
      await httpsCallable(getFunctions(), "syncNextLessonDatesNow")();
      setMsg({ text: "Googleカレンダーから読み込み直しました。" });
    } catch (err) {
      console.error(err);
      setMsg({ text: "カレンダーの読み込みに失敗しました。", error: true });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mb-6">
      <button type="button" className="text-xs text-matcha-deep underline" onClick={() => setOpen(!open)}>
        {open ? "日程・場所の変更を閉じる" : "お稽古の日程変更・開催場所の変更"}
      </button>
      {open && (
        <section className="mt-2 bg-paper border border-line rounded-md p-5 overflow-x-auto">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h2 className="font-bold">お稽古の日程・開催場所</h2>
            <button
              type="button"
              className="text-xs border border-line rounded px-2 py-1 text-muted disabled:opacity-50"
              onClick={syncNow}
              disabled={syncing}
            >
              {syncing ? "読み込み中…" : "カレンダーから読み込み直す"}
            </button>
          </div>
          <p className="text-xs text-muted mb-3">
            日付・場所を書き換えて「変更する」を押すと、マイページ・講師画面・LINE/Slackの通知にすぐ反映され、本部のGoogleカレンダーの予定も書き換わります。
            日付を変えると、元の日付に出欠を回答していた会員の回答も新しい日付へ移ります。
            {updatedAt && `（最終読み込み：${new Date(updatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）`}
          </p>
          {msg && <p className={`text-xs mb-3 ${msg.error ? "text-hanko" : "text-matcha-deep"}`}>{msg.text}</p>}
          {upcoming === undefined ? (
            <p className="text-sm text-muted">読み込み中…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted">
              今後のお稽古がカレンダーに見つかりません。本部のGoogleカレンダーに、タイトルに会の名前を含む予定を登録してください。
            </p>
          ) : (
            <table className="text-sm border-collapse">
              <thead>
                <tr className="text-left text-muted border-b border-line">
                  <th className="py-2 pr-3 font-medium">現在の予定</th>
                  <th className="py-2 pr-3 font-medium">日付</th>
                  <th className="py-2 pr-3 font-medium">場所</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ labels, info }) => {
                  const id = info.eventId ?? info.date;
                  const d = draftOf(info);
                  const changed = d.date !== info.date.slice(0, 10) || d.place.trim() !== (info.place ?? "");
                  return (
                    <tr key={id} className="border-b border-line align-top">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <div>{formatLessonDate(info.date)}</div>
                        {labels.length > 0 && <div className="text-[11px] text-muted">{labels.join("・")}</div>}
                        {info.originalDate && (
                          <div className="text-[11px] text-hanko">変更済み（元：{formatLessonDate(info.originalDate)}）</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          type="date"
                          className="border border-line rounded px-2 py-1 text-sm"
                          value={d.date}
                          disabled={!info.eventId}
                          onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, date: e.target.value } }))}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          className="border border-line rounded px-2 py-1 text-sm w-40"
                          value={d.place}
                          placeholder="例：本部茶室"
                          disabled={!info.eventId}
                          onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, place: e.target.value } }))}
                        />
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="border border-matcha-deep text-matcha-deep rounded px-3 py-1 text-sm disabled:opacity-40"
                          disabled={!changed || busyId !== null || !info.eventId}
                          onClick={() => save(info)}
                        >
                          {busyId === info.eventId ? "変更中…" : "変更する"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted mt-3">
            新月会は出席簿の「開催日（日付・場所）を追加・変更する」から、茶道教室の土曜日クラスは「開催日・予約状況」から変更してください。
          </p>
        </section>
      )}
    </div>
  );
}
