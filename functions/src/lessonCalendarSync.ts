// お稽古の開催日を、本部の共有Googleカレンダーとシステムで双方向に共有する。
//
// 対象（本部稽古）
//   ・新月会            … shingetsuSessions/{YYYY-MM-DD}           日付・場所
//   ・茶道教室 土曜日    … chadoSaturdaySessions/{YYYY-MM-DD}       日付・午前／午後の担当の先生
//   ・茶道教室 木曜・日曜 … chadoClassSessions/{YYYY-MM-DD}_{木曜日|日曜日} 日付・担当の先生
//   （名月会・G1・茶道教室の日付と場所は meta/nextLessonDates の同期＋changeLessonSchedule／addLessonDate／deleteLessonDate が担当）
//
// 先生はカレンダーの予定タイトルの末尾に書く：
//   土曜日・日曜日 … 「茶道教室 土曜日（午前：中村先生／午後：加藤先生）」
//   木曜日         … 「茶道教室 木曜日（担当：阿部宗亜先生）」
//
// 仕組み
//   ・システム → カレンダー：各コレクションの書き込みトリガー（syncXxxToCalendar）が予定を作成・更新・削除
//   ・カレンダー → システム：pullCalendarToSystem（syncNextLessonDates から10分ごと）が予定を読み、ドキュメントへ反映
//   ・ドキュメントの calSig ＝「最後にカレンダーと一致していた内容」。
//       calSig と同じ内容の書き込み（カレンダーから取り込んだもの）はカレンダーへ書き戻さない（無限ループ防止）
//       両方が変わっていたら、後から直した方（カレンダーの updated とドキュメントの更新時刻）を優先
//   ・カレンダーで予定を消した場合：予約・出欠・回答がなければ開催日も削除。あれば開催日は残し、カレンダーとの紐付けだけ外す
//
// 事前準備：本部のGoogleカレンダーで、Cloud Functionsのサービスアカウント
// （69899565701-compute@developer.gserviceaccount.com）に「予定の変更」権限が必要。

import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineString } from "firebase-functions/params";
import { GoogleAuth } from "google-auth-library";

const hqCalendarId = defineString("HQ_CALENDAR_ID");
const db = () => admin.firestore();
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/calendar.events"] });

// ---------------------------------------------------------------- カレンダーAPI

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
export interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  updated?: string;
  start?: EventTime;
  end?: EventTime;
}

export async function calendarFetch(path: string, init: { method: string; body?: unknown } = { method: "GET" }) {
  const token = (await (await auth.getClient()).getAccessToken()).token;
  if (!token) throw new Error("Googleカレンダーへのアクセストークンを取得できませんでした。");
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(hqCalendarId.value())}/events`;
  return fetch(base + path, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** 期間内の予定を全件（繰り返し予定は1回ずつに展開して）取得する */
export async function listEvents(fromDate: string, toDate: string): Promise<CalEvent[]> {
  const timeMin = new Date(`${fromDate}T00:00:00+09:00`).toISOString();
  const timeMax = new Date(`${toDate}T00:00:00+09:00`).toISOString();
  const out: CalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendarFetch(
      `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=2500` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
    );
    if (!res.ok) throw new Error(`Googleカレンダーの取得に失敗しました：${res.status} ${await res.text()}`);
    const data = (await res.json()) as { items?: CalEvent[]; nextPageToken?: string };
    out.push(...(data.items ?? []).filter((e) => e.status !== "cancelled"));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function getEvent(eventId: string): Promise<CalEvent | null> {
  const res = await calendarFetch(`/${encodeURIComponent(eventId)}`);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`予定の取得に失敗しました：${res.status} ${await res.text()}`);
  const ev = (await res.json()) as CalEvent;
  return ev.status === "cancelled" ? null : ev;
}

export async function deleteEvent(eventId: string) {
  const res = await calendarFetch(`/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`予定の削除に失敗しました：${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------- 日付

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
export function todayJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
/** 予定の開催日（日本時間の YYYY-MM-DD） */
export function eventDateKey(ev: Pick<CalEvent, "start">): string | null {
  if (ev.start?.date) return ev.start.date;
  if (ev.start?.dateTime) {
    const t = Date.parse(ev.start.dateTime);
    if (!Number.isNaN(t)) return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return null;
}
/** 予定を newDate へ動かすときの start/end（時刻・長さはそのまま） */
export function shiftedTimes(ev: CalEvent, newDate: string): { start?: EventTime; end?: EventTime } {
  const cur = eventDateKey(ev);
  if (!cur || cur === newDate) return {};
  const delta = diffDays(cur, newDate);
  const shift = (t?: EventTime): EventTime | undefined => {
    if (!t) return t;
    if (t.date) return { date: addDays(t.date, delta) };
    if (t.dateTime) {
      const d = addDays(t.dateTime.slice(0, 10), delta);
      return { dateTime: d + t.dateTime.slice(10), ...(t.timeZone ? { timeZone: t.timeZone } : {}) };
    }
    return t;
  };
  return { start: shift(ev.start), end: shift(ev.end) };
}

// ---------------------------------------------------------------- タイトルの先生

// 「（午前：中村先生／午後：加藤先生）」「（担当：阿部宗亜先生）」の部分
const TEACHER_PART = /[（(][^（）()]*?(?:担当|午前|午後)\s*[：:][^（）()]*[）)]/g;

export function parseTeachers(title: string): { am?: string; pm?: string; single?: string } {
  const m = title.match(TEACHER_PART);
  if (!m) return {};
  const inner = m[m.length - 1];
  const pick = (label: string) => {
    const r = inner.match(new RegExp(`${label}\\s*[：:]\\s*([^／/、,，）)]*)`));
    return r ? r[1].trim() : undefined;
  };
  return { am: pick("午前"), pm: pick("午後"), single: pick("担当") };
}

export function withTeachers(title: string, parts: [string, string | undefined][]): string {
  const base = title.replace(TEACHER_PART, "").trim();
  const list = parts.filter(([, n]) => (n ?? "").trim()).map(([l, n]) => `${l}：${(n ?? "").trim()}`);
  return list.length ? `${base}（${list.join("／")}）` : base;
}

// ---------------------------------------------------------------- 予定の種類の判定

type Kind = "shingetsu" | "saturday" | "weekly";

/** 茶道教室の予定がどのクラスか（index.ts の chadoClassOfEvent ＋ 土曜日） */
export function chadoKindOf(title: string, date: string): "土曜日" | "木曜日" | "日曜日" | null {
  if (!title.includes("茶道教室")) return null;
  const wd = weekdayOf(date);
  if (wd === 4) return "木曜日";
  if (wd === 0) return "日曜日";
  const thu = title.includes("木曜");
  const sun = title.includes("日曜");
  if (title.includes("土曜")) return "土曜日";
  // 土曜の「茶道教室」の予定は土曜日クラス。ただし「名月会/茶道教室」のような他の会との合同の予定は除く
  const joint = ["名月会", "新月会", "Gマダム"].some((g) => title.includes(g));
  if (wd === 6 && !thu && !sun && !joint) return "土曜日";
  if (thu && !sun) return "木曜日";
  if (sun && !thu) return "日曜日";
  return null;
}

const SYNC_NOTE =
  "稽古管理システムと同期しています。日付・場所・担当の先生（タイトル末尾の（午前：○○／午後：○○）（担当：○○））は、" +
  "このカレンダーで直しても、システムの管理画面で直しても、両方に反映されます（カレンダー→システムは最大10分後）。";

// ---------------------------------------------------------------- 種類ごとの設定

interface Vals {
  date: string;
  place?: string;
  am?: string;
  pm?: string;
}
type DocData = Record<string, unknown> & {
  date?: string;
  calendarEventId?: string;
  calSig?: string;
};

interface Adapter {
  kind: Kind;
  collection: string;
  docId(v: Vals, ev?: CalEvent): string;
  /** この予定がこの種類か（予定の開催日つき） */
  matches(ev: CalEvent, date: string): boolean;
  fromEvent(ev: CalEvent, date: string): Vals;
  fromDoc(d: DocData, id: string): Vals;
  toDoc(v: Vals): Record<string, unknown>;
  /** カレンダーの予定から新しくドキュメントを作るときの初期値。null なら作らない */
  newDoc(v: Vals, ev: CalEvent): Record<string, unknown> | null;
  /** カレンダーで予定が消えたとき、ドキュメントも消してよいか */
  canDelete(d: DocData, id: string): Promise<boolean>;
  /** カレンダーで日付が動いたときの付随処理 */
  onMoved?(oldDate: string, newDate: string): Promise<void>;
  /** 既存の予定への変更内容 */
  patch(v: Vals, ev: CalEvent): Record<string, unknown>;
  /** 新しく作る予定 */
  create(v: Vals, d: DocData): Record<string, unknown>;
}

const sig = (v: Vals) => JSON.stringify([v.date, v.place ?? "", v.am ?? "", v.pm ?? ""]);
const str = (x: unknown) => (typeof x === "string" ? x : "");

const shingetsu: Adapter = {
  kind: "shingetsu",
  collection: "shingetsuSessions",
  docId: (v) => v.date,
  matches: (ev) => (ev.summary ?? "").includes("新月会"),
  fromEvent: (ev, date) => {
    const fromTitle = (ev.summary ?? "").match(/新月会\s*[（(]([^）)]+)[）)]/)?.[1];
    const place = (ev.location ?? "").trim() || (fromTitle && fromTitle !== "場所未定" ? fromTitle.trim() : "");
    return { date, place };
  },
  fromDoc: (d, id) => ({ date: str(d.date) || id, place: str(d.place) }),
  toDoc: (v) => ({ date: v.date, place: v.place ?? "" }),
  newDoc: (v) => ({ date: v.date, place: v.place ?? "" }),
  canDelete: async (_d, id) => {
    const month = id.slice(0, 7);
    const snap = await db().collection("members").where(`shingetsuChoice.${month}`, "==", id).limit(1).get();
    return snap.empty;
  },
  onMoved: moveShingetsuChoices,
  patch: (v, ev) => ({
    summary: `新月会（${v.place || "場所未定"}）`,
    location: v.place ?? "",
    ...shiftedTimes(ev, v.date),
  }),
  create: (v) => ({
    summary: `新月会（${v.place || "場所未定"}）`,
    location: v.place ?? "",
    description: SYNC_NOTE,
    start: { date: v.date },
    end: { date: addDays(v.date, 1) },
  }),
};

const saturday: Adapter = {
  kind: "saturday",
  collection: "chadoSaturdaySessions",
  docId: (v) => v.date,
  matches: (ev, date) => chadoKindOf(ev.summary ?? "", date) === "土曜日",
  fromEvent: (ev, date) => {
    const t = parseTeachers(ev.summary ?? "");
    return { date, am: t.am ?? t.single ?? "", pm: t.pm ?? t.single ?? "" };
  },
  fromDoc: (d, id) => ({ date: str(d.date) || id, am: str(d.amTeacher), pm: str(d.pmTeacher) }),
  toDoc: (v) => ({ date: v.date, amTeacher: v.am ?? "", pmTeacher: v.pm ?? "" }),
  newDoc: (v) => ({
    date: v.date,
    amTeacher: v.am ?? "",
    pmTeacher: v.pm ?? "",
    amCapacity: 3,
    pmCapacity: 3,
    amBookings: [],
    pmBookings: [],
  }),
  canDelete: async (d) =>
    !((d.amBookings as unknown[] | undefined)?.length || (d.pmBookings as unknown[] | undefined)?.length),
  patch: (v, ev) => ({
    summary: withTeachers(ev.summary ?? "茶道教室 土曜日", [["午前", v.am], ["午後", v.pm]]),
    ...shiftedTimes(ev, v.date),
  }),
  create: (v) => ({
    summary: withTeachers("茶道教室 土曜日", [["午前", v.am], ["午後", v.pm]]),
    description: SYNC_NOTE,
    start: { date: v.date },
    end: { date: addDays(v.date, 1) },
  }),
};

const WEEKLY_TIME: Record<string, [string, string]> = { "木曜日": ["15:00", "17:00"], "日曜日": ["10:00", "15:00"] };

function weeklyClassOf(d: DocData, id: string): "木曜日" | "日曜日" {
  const c = str(d.chadoClass) || id.split("_")[1];
  return c === "日曜日" ? "日曜日" : "木曜日";
}
function weeklyTeacherParts(cls: string, v: Vals): [string, string | undefined][] {
  return cls === "日曜日" ? [["午前", v.am], ["午後", v.pm]] : [["担当", v.am]];
}

const weekly: Adapter = {
  kind: "weekly",
  collection: "chadoClassSessions",
  docId: (v, ev) => `${v.date}_${ev ? chadoKindOf(ev.summary ?? "", eventDateKey(ev) ?? v.date) : ""}`,
  matches: (ev, date) => {
    const k = chadoKindOf(ev.summary ?? "", date);
    return k === "木曜日" || k === "日曜日";
  },
  fromEvent: (ev, date) => {
    const t = parseTeachers(ev.summary ?? "");
    const cls = chadoKindOf(ev.summary ?? "", date);
    return cls === "日曜日"
      ? { date, am: t.am ?? t.single ?? "", pm: t.pm ?? t.single ?? "" }
      : { date, am: t.single ?? t.am ?? "" };
  },
  fromDoc: (d, id) => {
    const cls = weeklyClassOf(d, id);
    return cls === "日曜日"
      ? { date: str(d.date) || id.slice(0, 10), am: str(d.amTeacher), pm: str(d.pmTeacher) }
      : { date: str(d.date) || id.slice(0, 10), am: str(d.amTeacher) };
  },
  toDoc: (v) => ({ date: v.date, amTeacher: v.am ?? "", ...(v.pm !== undefined ? { pmTeacher: v.pm } : {}) }),
  // 先生の書かれていない予定からは作らない（開催日は「次回のお稽古」の同期で表示される）
  newDoc: (v, ev) => {
    const t = parseTeachers(ev.summary ?? "");
    if (!t.am && !t.pm && !t.single) return null;
    const cls = chadoKindOf(ev.summary ?? "", v.date);
    return { date: v.date, chadoClass: cls, amTeacher: v.am ?? "", ...(cls === "日曜日" ? { pmTeacher: v.pm ?? "" } : {}), attendance: {} };
  },
  canDelete: async (d) => Object.keys((d.attendance as Record<string, unknown> | undefined) ?? {}).length === 0,
  patch: (v, ev) => {
    const cls = chadoKindOf(ev.summary ?? "", eventDateKey(ev) ?? v.date) ?? "木曜日";
    return { summary: withTeachers(ev.summary ?? `茶道教室 ${cls}`, weeklyTeacherParts(cls, v)), ...shiftedTimes(ev, v.date) };
  },
  create: (v, d) => {
    const cls = weeklyClassOf(d, `${v.date}_`);
    const [s, e] = WEEKLY_TIME[cls];
    return {
      summary: withTeachers(`茶道教室 ${cls}`, weeklyTeacherParts(cls, v)),
      description: SYNC_NOTE,
      start: { dateTime: `${v.date}T${s}:00+09:00`, timeZone: "Asia/Tokyo" },
      end: { dateTime: `${v.date}T${e}:00+09:00`, timeZone: "Asia/Tokyo" },
    };
  },
};

const ADAPTERS: Adapter[] = [shingetsu, saturday, weekly];

/** 新月会：日付が変わったとき、その日を選んでいた会員の回答を付け替える（画面側の move() と同じ規則） */
async function moveShingetsuChoices(oldDate: string, newDate: string) {
  const oldMonth = oldDate.slice(0, 7);
  const newMonth = newDate.slice(0, 7);
  const snap = await db().collection("members").where(`shingetsuChoice.${oldMonth}`, "==", oldDate).get();
  for (const d of snap.docs) {
    const choice = (d.data().shingetsuChoice ?? {}) as Record<string, string>;
    if (oldMonth === newMonth) {
      await d.ref.update({ [`shingetsuChoice.${oldMonth}`]: newDate });
      continue;
    }
    const del = admin.firestore.FieldValue.delete();
    await d.ref.update({
      [`shingetsuChoice.${oldMonth}`]: del,
      [`attendance.${oldMonth}`]: del,
      ...(choice[newMonth] ? {} : { [`shingetsuChoice.${newMonth}`]: newDate, [`attendance.${newMonth}`]: "出席" }),
    });
  }
}

// ---------------------------------------------------------------- システム → カレンダー

/** その日の、この種類の予定を探す（手入力済みの予定を引き継ぎ、二重に作らない） */
async function findEventOnDate(a: Adapter, v: Vals, d: DocData, id: string): Promise<CalEvent | null> {
  const events = await listEvents(v.date, addDays(v.date, 1));
  const taken = new Set(
    (await db().collection(a.collection).where("date", "==", v.date).get()).docs
      .filter((x) => x.id !== id)
      .map((x) => x.data().calendarEventId as string | undefined)
      .filter(Boolean)
  );
  return (
    events.find((ev) => {
      if (taken.has(ev.id) || eventDateKey(ev) !== v.date || !a.matches(ev, v.date)) return false;
      if (a.kind === "weekly") return chadoKindOf(ev.summary ?? "", v.date) === weeklyClassOf(d, id);
      return true;
    }) ?? null
  );
}

/** ドキュメントの最新の内容をカレンダーへ書き込み、calSig を更新する */
async function pushDoc(a: Adapter, id: string, known?: CalEvent): Promise<void> {
  const ref = db().collection(a.collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data() as DocData;
  const v = a.fromDoc(d, id);
  if (!v.date) return;
  if (sig(v) === d.calSig && d.calendarEventId) return;

  let ev: CalEvent | null = known ?? null;
  if (!ev && d.calendarEventId) ev = await getEvent(d.calendarEventId);
  if (!ev) ev = await findEventOnDate(a, v, d, id);

  let eventId: string;
  if (ev) {
    const res = await calendarFetch(`/${encodeURIComponent(ev.id)}`, { method: "PATCH", body: a.patch(v, ev) });
    if (!res.ok) throw new Error(`予定の更新に失敗しました：${res.status} ${await res.text()}`);
    eventId = ev.id;
  } else {
    const res = await calendarFetch("", { method: "POST", body: a.create(v, d) });
    if (!res.ok) throw new Error(`予定の作成に失敗しました：${res.status} ${await res.text()}`);
    eventId = ((await res.json()) as { id: string }).id;
  }
  await ref.update({ calendarEventId: eventId, calSig: sig(v), calendarDeletedAt: admin.firestore.FieldValue.delete() });
}

function makeTrigger(a: Adapter) {
  return onDocumentWritten(`${a.collection}/{id}`, async (event) => {
    const id = event.params.id as string;
    const before = event.data?.before.exists ? (event.data.before.data() as DocData) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as DocData) : null;
    try {
      if (before && !after) {
        if (!before.calendarEventId) return;
        // 日付変更で別のドキュメントが同じ予定を引き継いでいれば消さない
        const moved = await db().collection(a.collection).where("calendarEventId", "==", before.calendarEventId).limit(1).get();
        if (!moved.empty) return;
        await deleteEvent(before.calendarEventId);
        return;
      }
      if (!after) return;
      // カレンダーから取り込んだ内容（calSig と同じ）や、予約・出欠だけの変更は書き戻さない
      if (sig(a.fromDoc(after, id)) === after.calSig && after.calendarEventId) return;
      if (after.calendarDeletedAt && before && sig(a.fromDoc(before, id)) === sig(a.fromDoc(after, id))) return;
      await pushDoc(a, id);
    } catch (err) {
      console.error(`${a.collection}/${id} のカレンダー反映に失敗しました`, err);
    }
  });
}

export const syncShingetsuSessionToCalendar = makeTrigger(shingetsu);
export const syncChadoSaturdaySessionToCalendar = makeTrigger(saturday);
export const syncChadoClassSessionToCalendar = makeTrigger(weekly);

// ---------------------------------------------------------------- カレンダー → システム

const PULL_PAST_DAYS = 60;
const PULL_FUTURE_DAYS = 400;

async function pullKind(a: Adapter, events: CalEvent[], today: string, windowEnd: string) {
  const col = db().collection(a.collection);
  const snap = await col.get();
  const docs = new Map(snap.docs.map((d) => [d.id, d]));
  const byEvent = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const d of snap.docs) {
    const eid = d.data().calendarEventId as string | undefined;
    if (eid) byEvent.set(eid, d);
  }
  const handled = new Set<string>();
  const stats = { created: 0, updated: 0, moved: 0, pushed: 0, deleted: 0, unlinked: 0, errors: 0 };

  for (const ev of events) {
    const date = eventDateKey(ev);
    if (!date || !a.matches(ev, date)) continue;
    try {
      const calV = a.fromEvent(ev, date);
      const wantId = a.docId(calV, ev);
      let docSnap = byEvent.get(ev.id);
      if (!docSnap) {
        const same = docs.get(wantId);
        if (same && !same.data().calendarEventId && !handled.has(same.id)) docSnap = same;
      }

      if (!docSnap) {
        if (date < today || docs.has(wantId)) continue; // 過去の予定・同じ日の二重予定からは作らない
        const init = a.newDoc(calV, ev);
        if (!init) continue;
        await col.doc(wantId).set({ ...init, calendarEventId: ev.id, calSig: sig(calV) });
        handled.add(wantId);
        stats.created++;
        continue;
      }

      handled.add(docSnap.id);
      const d = docSnap.data() as DocData;
      const docV = a.fromDoc(d, docSnap.id);
      // 木曜・日曜クラスは、日付が動いてもクラスはそのまま（元の予定のクラス）
      const targetId = a.kind === "weekly" ? `${calV.date}_${weeklyClassOf(d, docSnap.id)}` : wantId;
      const calChanged = sig(calV) !== d.calSig;
      const sysChanged = sig(docV) !== d.calSig;

      if (!calChanged && !sysChanged) {
        if (d.calendarEventId !== ev.id) await docSnap.ref.update({ calendarEventId: ev.id });
        continue;
      }
      if (sig(calV) === sig(docV)) {
        await docSnap.ref.update({ calendarEventId: ev.id, calSig: sig(calV) });
        continue;
      }
      const calTime = ev.updated ? Date.parse(ev.updated) : 0;
      const docTime = docSnap.updateTime.toMillis();
      // 初めて紐付けるとき（calSig なし）は、システムに先生・場所が入っていればシステムを優先
      const hasContent = !!(docV.place || docV.am || docV.pm);
      const calendarWins =
        d.calSig === undefined ? !hasContent : calChanged && (!sysChanged || calTime >= docTime);

      if (!calendarWins) {
        await pushDoc(a, docSnap.id, ev);
        stats.pushed++;
        continue;
      }

      const fields = { ...a.toDoc(calV), calendarEventId: ev.id, calSig: sig(calV) };
      if (targetId !== docSnap.id) {
        if (docs.has(targetId)) {
          console.warn(`${a.collection}：${docSnap.id} の予定が ${targetId} に動きましたが、その日はすでに登録があるため取り込みませんでした`);
          continue;
        }
        await col.doc(targetId).set({ ...d, ...fields });
        await docSnap.ref.delete();
        docs.set(targetId, docSnap); // 以降の重複判定用
        handled.add(targetId);
        if (a.onMoved && docV.date !== calV.date) await a.onMoved(docV.date, calV.date);
        stats.moved++;
      } else {
        await docSnap.ref.update(fields);
        stats.updated++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`${a.collection}：予定 ${ev.id} の取り込みに失敗しました`, err);
    }
  }

  // カレンダーに見つからなかったドキュメント
  for (const d of snap.docs) {
    if (handled.has(d.id)) continue;
    const data = d.data() as DocData;
    const v = a.fromDoc(data, d.id);
    if (!v.date || v.date < today || v.date >= windowEnd) continue;
    try {
      if (data.calendarEventId) {
        // カレンダーで予定が消された（または別の種類のタイトルに変えられた）
        if (await a.canDelete(data, d.id)) {
          await d.ref.delete();
          stats.deleted++;
        } else {
          await d.ref.update({
            calendarEventId: admin.firestore.FieldValue.delete(),
            calendarDeletedAt: new Date().toISOString(),
          });
          stats.unlinked++;
        }
      } else if (sig(v) !== data.calSig) {
        // システムで追加し、まだカレンダーに入っていない開催日
        await pushDoc(a, d.id);
        stats.pushed++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`${a.collection}/${d.id} のカレンダー反映に失敗しました`, err);
    }
  }
  console.log(`カレンダー同期（${a.collection}）`, stats);
}

/** カレンダーの予定を、新月会・土曜日クラス・木曜／日曜クラスの開催日と先生へ取り込む */
export async function pullCalendarToSystem(): Promise<void> {
  const today = todayJST();
  const windowEnd = addDays(today, PULL_FUTURE_DAYS);
  const events = await listEvents(addDays(today, -PULL_PAST_DAYS), windowEnd);
  for (const a of ADAPTERS) await pullKind(a, events, today, windowEnd);
}
