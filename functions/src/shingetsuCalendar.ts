// 新月会の開催日（shingetsuSessions）を、本部の共有Googleカレンダーへ自動で書き込む。
// 開催日・場所の正はシステム側（管理画面・講師画面の「開催日の追加・変更」）。カレンダーは表示用の写し。
//
// ・開催日を追加 → 終日の予定「新月会（場所）」を作成（同じ日にすでに「新月会」を含む予定があれば、それを引き継いで更新）
// ・場所を変更 → 予定のタイトル・場所を更新
// ・日付を変更 → 画面側で新しい日付のドキュメントを作り calendarEventId を引き継ぐので、同じ予定の日付を動かす
// ・削除 → 予定を削除（日付変更で別のドキュメントが同じ予定を引き継いでいる場合は削除しない）
//
// 事前準備：本部のGoogleカレンダーの共有設定で、Cloud Functionsのサービスアカウント
// （例：69899565701-compute@developer.gserviceaccount.com）の権限を
// 「予定の変更」に上げておくこと（読み取りだけの権限では書き込めない）。

import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineString } from "firebase-functions/params";
import { GoogleAuth } from "google-auth-library";

const hqCalendarId = defineString("HQ_CALENDAR_ID");
const db = () => admin.firestore();

interface SessionDoc {
  date?: string;
  place?: string;
  calendarEventId?: string;
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

async function calendarFetch(path: string, init: { method: string; body?: unknown } = { method: "GET" }) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/calendar.events"] });
  const token = (await (await auth.getClient()).getAccessToken()).token;
  if (!token) throw new Error("Googleカレンダーへのアクセストークンを取得できませんでした。");
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(hqCalendarId.value())}/events`;
  return fetch(base + path, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function eventBody(date: string, place: string) {
  return {
    summary: `新月会（${place || "場所未定"}）`,
    location: place || "",
    description:
      "稽古管理システムから自動で登録された予定です。\n" +
      "日付・場所の変更は、管理画面または講師画面の「新月会 出席簿」→「開催日（日付・場所）を追加・変更する」から行ってください。\n" +
      "（このカレンダー上で直接変更しても、システムやマイページには反映されません）",
    start: { date },
    end: { date: nextDay(date) },
  };
}

/** 同じ日に、タイトルに「新月会」を含む既存の予定があればそのIDを返す（手入力済みの予定の重複作成を防ぐ） */
async function findExistingEvent(date: string): Promise<string | null> {
  const timeMin = new Date(`${date}T00:00:00+09:00`).toISOString();
  const timeMax = new Date(`${nextDay(date)}T00:00:00+09:00`).toISOString();
  const res = await calendarFetch(
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&q=${encodeURIComponent("新月会")}`
  );
  if (!res.ok) throw new Error(`予定の検索に失敗しました：${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: { id: string; summary?: string }[] };
  return data.items?.find((e) => (e.summary ?? "").includes("新月会"))?.id ?? null;
}

export const syncShingetsuSessionToCalendar = onDocumentWritten("shingetsuSessions/{sessionId}", async (event) => {
  const before = event.data?.before.exists ? (event.data.before.data() as SessionDoc) : null;
  const after = event.data?.after.exists ? (event.data.after.data() as SessionDoc) : null;

  // 削除
  if (before && !after) {
    if (!before.calendarEventId) return;
    // 日付変更で新しいドキュメントが同じ予定を引き継いでいれば、予定は消さない
    const moved = await db().collection("shingetsuSessions").where("calendarEventId", "==", before.calendarEventId).limit(1).get();
    if (!moved.empty) return;
    const res = await calendarFetch(`/${encodeURIComponent(before.calendarEventId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error(`新月会の予定の削除に失敗しました：${res.status} ${await res.text()}`);
    }
    return;
  }
  if (!after?.date) return;

  // calendarEventId の書き戻しだけの更新は何もしない（無限ループ防止）
  if (before && before.date === after.date && (before.place ?? "") === (after.place ?? "") && before.calendarEventId) return;

  const ref = event.data!.after.ref;
  const body = eventBody(after.date, after.place ?? "");
  try {
    let eventId = after.calendarEventId ?? null;
    if (eventId) {
      const res = await calendarFetch(`/${encodeURIComponent(eventId)}`, { method: "PATCH", body });
      if (res.ok) return; // 更新できた（IDは変わらない）
      if (res.status !== 404 && res.status !== 410) {
        throw new Error(`予定の更新に失敗しました：${res.status} ${await res.text()}`);
      }
      eventId = null; // 予定が消えていたら作り直す
    }
    eventId = await findExistingEvent(after.date);
    if (eventId) {
      const res = await calendarFetch(`/${encodeURIComponent(eventId)}`, { method: "PATCH", body });
      if (!res.ok) throw new Error(`既存の予定の更新に失敗しました：${res.status} ${await res.text()}`);
    } else {
      const res = await calendarFetch("", { method: "POST", body });
      if (!res.ok) throw new Error(`予定の作成に失敗しました：${res.status} ${await res.text()}`);
      eventId = ((await res.json()) as { id: string }).id;
    }
    await ref.update({ calendarEventId: eventId });
  } catch (err) {
    console.error(`新月会の開催日 ${after.date} のカレンダー反映に失敗しました`, err);
  }
});
