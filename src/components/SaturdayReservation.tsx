"use client";

// 茶道教室：土曜日クラスの予約UI（マイページに埋め込む）。
// 月2回開催、開催日ごとに午前・午後の2枠、各枠定員3名（定員は管理画面で開催日ごとに変更可）。
// 定員チェックはCloud Functions（bookChadoSaturdaySlot）側のトランザクションで行うため、
// この画面は表示と呼び出しに専念する（クライアント側では定員を判定に使うだけで、書き込みはしない）。

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "@/lib/firebase";
import { formatLessonDate } from "@/lib/nextLesson";
import { CHADO_SATURDAY_DEFAULT_CAPACITY } from "@/lib/chadoClasses";
import type { ChadoSaturdaySession } from "@/types";

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function SaturdayReservation({
  memberId,
  quota,
  tickets,
}: {
  memberId: string;
  quota: 1 | 2;
  tickets: number;
}) {
  const [sessions, setSessions] = useState<ChadoSaturdaySession[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // "date-slot" 処理中
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const q = query(
      collection(db, "chadoSaturdaySessions"),
      where("date", ">=", todayKey()),
      orderBy("date")
    );
    return onSnapshot(q, (snap) => {
      setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoSaturdaySession)));
    });
  }, []);

  async function handle(date: string, slot: "am" | "pm", action: "book" | "cancel") {
    setBusy(`${date}-${slot}`);
    setMsg(null);
    try {
      const fn = httpsCallable<
        { date: string; slot: "am" | "pm"; action: "book" | "cancel" },
        { ok: boolean }
      >(getFunctions(), "bookChadoSaturdaySlot");
      await fn({ date, slot, action });
      setMsg(
        action === "book"
          ? `${formatLessonDate(date)}の${slot === "am" ? "午前" : "午後"}で予約しました。`
          : "予約をキャンセルしました。"
      );
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setMsg(
        err.code === "resource-exhausted" && err.message
          ? err.message
          : "処理に失敗しました。時間をおいて再度お試しください。"
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-paper border border-line rounded-md p-6 mb-4">
      <h2 className="text-sm text-muted mb-1">講師名</h2>
      <p className="text-xs text-muted mb-3">
        月の予約可能回数：月{quota}回　／　振替チケット：{tickets}枚
      </p>
      {sessions.length === 0 && (
        <p className="text-xs text-muted">現在、予約可能な開催日はありません。本部にお問い合わせください。</p>
      )}
      <div className="space-y-4">
        {sessions.map((s) => {
          const amBookings = s.amBookings ?? [];
          const pmBookings = s.pmBookings ?? [];
          const amCapacity = s.amCapacity ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
          const pmCapacity = s.pmCapacity ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
          const myAm = amBookings.some((b) => b.memberId === memberId);
          const myPm = pmBookings.some((b) => b.memberId === memberId);
          const amFull = amBookings.length >= amCapacity;
          const pmFull = pmBookings.length >= pmCapacity;

          return (
            <div key={s.id} className="border border-line rounded-md p-3">
              <p className="text-sm font-semibold text-matcha-deep mb-2">
                {formatLessonDate(s.date)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(["am", "pm"] as const).map((slot) => {
                  const isAm = slot === "am";
                  const mine = isAm ? myAm : myPm;
                  const full = isAm ? amFull : pmFull;
                  const bookings = isAm ? amBookings : pmBookings;
                  const capacity = isAm ? amCapacity : pmCapacity;
                  const teacher = isAm ? s.amTeacher : s.pmTeacher;
                  const disabled = busy === `${s.id}-${slot}` || (full && !mine);
                  const myBooking = bookings.find((b) => b.memberId === memberId);
                  return (
                    <button
                      key={slot}
                      disabled={disabled}
                      onClick={() => handle(s.id, slot, mine ? "cancel" : "book")}
                      className={`text-left rounded-md border px-3 py-2 text-xs disabled:opacity-50 ${
                        mine
                          ? "bg-matcha-deep text-white border-matcha-deep"
                          : full
                          ? "bg-paper border-line text-muted"
                          : "border-matcha-deep text-matcha-deep"
                      }`}
                    >
                      <div className="font-bold">{isAm ? "午前" : "午後"}</div>
                      {teacher && <div className="opacity-80">担当：{teacher}</div>}
                      <div className="opacity-80">
                        {bookings.length}/{capacity}名
                        {full && !mine ? "（満席）" : ""}
                      </div>
                      {mine && myBooking?.usedTicket && (
                        <div className="opacity-80">振替チケットを使用</div>
                      )}
                      <div className="mt-1 underline">
                        {mine ? "キャンセルする" : full ? "満席" : "この枠を予約する"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {msg && <p className="text-xs text-matcha-deep mt-3">{msg}</p>}
    </div>
  );
}
