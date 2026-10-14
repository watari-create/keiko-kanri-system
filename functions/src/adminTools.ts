// アドミン向けの機能（2026-10-14〜）
//   1. 全データのバックアップ（毎日 3:00 に自動＋管理画面から手動）
//   2. 操作ログ（Firestore の書き込みを検知して「誰が・いつ・何を」変えたかを記録）
// 閲覧はどちらもアドミンのみ（firestore.rules の isHonbuAdmin）。
// 本部アカウントの権限管理・ログイン履歴は、Slack通知やログイン記録と一緒に index.ts にある。

import * as admin from "firebase-admin";
import * as zlib from "zlib";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWrittenWithAuthContext, type FirestoreAuthEvent, type Change } from "firebase-functions/v2/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { requireHonbuAdmin, honbuLevelOf, HONBU_LEVEL_LABEL } from "./roles";

const db = () => admin.firestore();

// ============================================================================
// 1. バックアップ
// ============================================================================

// バックアップに含めないコレクション（バックアップ自身・ログ類・Squareの受信記録など、
// 復元しても意味がない／量が多いもの）。お稽古ノートは別途 keikoNoteBackups に週次で保存済み。
const BACKUP_EXCLUDE = new Set([
  "backups",
  "operationLogs",
  "keikoNoteBackups",
  "securityLogs",
  "securityCounters",
  "securityAlerts",
  "securityState",
  "squareWebhookEvents",
]);

const AUTO_BACKUP_KEEP_DAYS = 30; // 自動バックアップは30日分
const MANUAL_BACKUP_KEEP_DAYS = 180; // 手動バックアップは180日分
const OPERATION_LOG_KEEP_DAYS = 400; // 操作ログは約1年分（＋余裕）
const CHUNK_CHARS = 900_000; // Firestoreの1ドキュメント上限（1MiB）に収まる大きさに分割

/** Firestoreの値（Timestamp・参照など）を、JSONにそのまま書ける形に変換する */
function toJsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof admin.firestore.Timestamp) return { __type: "timestamp", value: v.toDate().toISOString() };
  if (v instanceof admin.firestore.GeoPoint) return { __type: "geopoint", latitude: v.latitude, longitude: v.longitude };
  if (v instanceof admin.firestore.DocumentReference) return { __type: "ref", path: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __type: "bytes", base64: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toJsonValue(val);
    return out;
  }
  return v;
}

/** 同時に動かす数を制限しながら、配列の各要素に処理を行う */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

type BackupDocs = Record<string, Record<string, unknown>>; // 各コレクション → { ドキュメントのパス: データ }

/** コレクションを（サブコレクションも含めて）すべて読み込む */
async function dumpCollection(
  col: admin.firestore.CollectionReference,
  groupKey: string,
  out: BackupDocs,
  counts: Record<string, number>
): Promise<void> {
  const snap = await col.get();
  out[groupKey] = out[groupKey] ?? {};
  for (const d of snap.docs) out[groupKey][d.ref.path] = toJsonValue(d.data());
  counts[groupKey] = (counts[groupKey] ?? 0) + snap.size;
  // サブコレクション（例：memberSubscriptions/{会員番号}/payments）
  await mapLimit(snap.docs, 40, async (d) => {
    const subs = await d.ref.listCollections();
    for (const sub of subs) {
      await dumpCollection(sub, `${groupKey}/${sub.id}`, out, counts);
    }
  });
}

function backupId(trigger: "auto" | "manual", now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}-${p(jst.getUTCHours())}${p(
    jst.getUTCMinutes()
  )}${p(jst.getUTCSeconds())}-${trigger}`;
}

/** 全データのバックアップを作る。backups/{id}（概要）と backups/{id}/chunks/{連番}（中身）に保存する。 */
export async function runFullBackup(trigger: "auto" | "manual", by: string): Promise<{ id: string; docCount: number }> {
  const id = backupId(trigger);
  const ref = db().collection("backups").doc(id);
  const startedAt = admin.firestore.Timestamp.now();
  await ref.set({ status: "running", trigger, by, createdAt: startedAt });
  try {
    const cols = (await db().listCollections()).filter((c) => !BACKUP_EXCLUDE.has(c.id));
    const docs: BackupDocs = {};
    const counts: Record<string, number> = {};
    for (const c of cols) await dumpCollection(c, c.id, docs, counts);

    const docCount = Object.values(counts).reduce((a, b) => a + b, 0);
    const json = JSON.stringify({
      format: "keiko-app-backup/1",
      project: process.env.GCLOUD_PROJECT ?? "",
      createdAt: startedAt.toDate().toISOString(),
      trigger,
      by,
      counts,
      collections: docs,
    });
    const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
    const b64 = gz.toString("base64");
    const chunkCount = Math.ceil(b64.length / CHUNK_CHARS);
    for (let i = 0; i < chunkCount; i++) {
      await ref
        .collection("chunks")
        .doc(String(i).padStart(4, "0"))
        .set({ index: i, data: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
    }
    await ref.set({
      status: "done",
      trigger,
      by,
      createdAt: startedAt,
      finishedAt: admin.firestore.Timestamp.now(),
      counts,
      docCount,
      rawBytes: Buffer.byteLength(json, "utf8"),
      gzipBytes: gz.length,
      chunkCount,
      encoding: "gzip+base64",
    });
    return { id, docCount };
  } catch (e) {
    console.error("バックアップに失敗しました", e);
    await ref.set({ status: "failed", error: String((e as Error)?.message ?? e).slice(0, 500) }, { merge: true });
    throw e;
  }
}

/** 古いバックアップ・操作ログを削除する */
async function cleanupOld(): Promise<{ backups: number; logs: number }> {
  const now = Date.now();
  let deletedBackups = 0;
  const snap = await db().collection("backups").get();
  for (const d of snap.docs) {
    const created = (d.data().createdAt as admin.firestore.Timestamp | undefined)?.toMillis() ?? 0;
    const keepDays = d.data().trigger === "manual" ? MANUAL_BACKUP_KEEP_DAYS : AUTO_BACKUP_KEEP_DAYS;
    if (created && now - created > keepDays * 24 * 60 * 60 * 1000) {
      await db().recursiveDelete(d.ref);
      deletedBackups++;
    }
  }
  let deletedLogs = 0;
  const cutoff = admin.firestore.Timestamp.fromMillis(now - OPERATION_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000);
  while (true) {
    const old = await db().collection("operationLogs").where("at", "<", cutoff).limit(400).get();
    if (old.empty) break;
    const batch = db().batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deletedLogs += old.size;
    if (old.size < 400) break;
  }
  return { backups: deletedBackups, logs: deletedLogs };
}

/** 毎日 3:00（日本時間）に全データをバックアップし、古いバックアップ・操作ログを整理する */
export const dailyFullBackup = onSchedule(
  { schedule: "every day 03:00", timeZone: "Asia/Tokyo", memory: "1GiB", timeoutSeconds: 540 },
  async () => {
    const r = await runFullBackup("auto", "自動");
    const c = await cleanupOld();
    console.log(`自動バックアップ ${r.id}（${r.docCount}件）。古いバックアップ${c.backups}件・操作ログ${c.logs}件を削除`);
  }
);

/** 管理画面「システム管理 → バックアップ」の「今すぐバックアップ」（アドミンのみ） */
export const createBackupNow = onCall({ memory: "1GiB", timeoutSeconds: 540 }, async (request) => {
  requireHonbuAdmin(request);
  const by = (request.auth?.token?.email as string | undefined) ?? request.auth?.uid ?? "本部";
  const r = await runFullBackup("manual", by);
  return r;
});

// ============================================================================
// 2. 操作ログ
// ============================================================================

// 操作ログを取らないコレクション（ログ自身・バックアップ・セキュリティ記録・採番カウンターなど）
const OPLOG_EXCLUDE = new Set([
  "operationLogs",
  "backups",
  "keikoNoteBackups",
  "securityLogs",
  "securityCounters",
  "securityAlerts",
  "securityState",
  "securityReports",
  "squareWebhookEvents",
  "counters",
  "notifications",
]);

// 画面に出すコレクション名
export const COLLECTION_LABEL: Record<string, string> = {
  members: "会員",
  staff: "スタッフ",
  licenseRequests: "許状申請",
  leaveRequests: "休会・退会申請",
  groupSettings: "会の設定",
  meta: "設定・在庫など",
  g1ShippingLogs: "G1発送記録",
  chadoClassLedger: "茶道教室クラス台帳",
  chadoRecruitClasses: "新規募集クラス",
  chadoClassSessions: "茶道教室（木・日）開催日",
  chadoSaturdaySessions: "茶道教室（土）開催日",
  lessonExtraDates: "追加した開催日",
  shingetsuSessions: "新月会 開催日",
  chadoStudentNotes: "生徒の申し送り",
  keikoNoteEntries: "お稽古ノート",
  memberSubscriptions: "カード自動払い",
};

// 操作した人の表示名（同じ人を何度も調べないよう、しばらく覚えておく）
const actorCache = new Map<string, { label: string; role: string; at: number }>();
const ACTOR_CACHE_MS = 10 * 60 * 1000;

async function resolveActor(authType: string, authId: string | undefined): Promise<{ label: string; role: string }> {
  if (authType === "unauthenticated") return { label: "未ログイン（入会フォームなど）", role: "public" };
  if (!authId) return { label: authType, role: authType };
  // Googleアカウント（メールアドレス）での書き込み＝Firebaseコンソールや管理スクリプトからの直接編集
  if (authId.includes("@") || authType === "admin") return { label: authId, role: "console" };
  const cached = actorCache.get(authId);
  if (cached && Date.now() - cached.at < ACTOR_CACHE_MS) return cached;
  let result = { label: authId, role: "unknown" };
  try {
    if (authId.startsWith("member_")) {
      const no = authId.slice("member_".length);
      const s = await db().collection("members").doc(no).get();
      result = { label: `${s.data()?.name ?? "会員"}（会員 ${no}）`, role: "member" };
    } else if (authId.startsWith("staff_")) {
      const no = authId.slice("staff_".length);
      const s = await db().collection("staff").doc(no).get();
      const r = s.data()?.role === "teacher" ? "講師" : "世話人";
      result = { label: `${s.data()?.name ?? "スタッフ"}（${r}）`, role: "staff" };
    } else if (authId === "keikonote_guest") {
      result = { label: "お稽古ノート閲覧ゲスト", role: "guest" };
    } else {
      const u = await admin.auth().getUser(authId);
      const lv = honbuLevelOf(u.customClaims);
      result = lv
        ? { label: `${u.email ?? authId}（本部・${HONBU_LEVEL_LABEL[lv]}）`, role: "honbu" }
        : { label: u.email ?? authId, role: String(u.customClaims?.role ?? "unknown") };
    }
  } catch (e) {
    console.warn("操作した人の確認に失敗しました", authId, e);
  }
  actorCache.set(authId, { ...result, at: Date.now() });
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function short(v: unknown, max = 200): string {
  if (v === undefined) return "（なし）";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

type FieldChange = { field: string; before: string; after: string };

/** 変更前後の差分（マップは2段目まで分けて記録。例：attendance.2026-10） */
function diffData(before: Record<string, unknown>, after: Record<string, unknown>, prefix = "", depth = 0): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    if (k === "updatedAt") continue;
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    if (depth < 1 && isPlainObject(b) && isPlainObject(a)) {
      out.push(...diffData(b, a, `${prefix}${k}.`, depth + 1));
    } else {
      out.push({ field: prefix + k, before: short(b), after: short(a) });
    }
  }
  return out;
}

function targetLabelOf(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  for (const k of ["name", "memberName", "title", "displayName", "date", "email"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return "";
}

async function writeOperationLog(
  event: FirestoreAuthEvent<Change<DocumentSnapshot> | undefined, Record<string, string>>,
  collection: string
): Promise<void> {
  if (OPLOG_EXCLUDE.has(collection)) return;
  // Cloud Functions自身（Admin SDK）の自動処理は量が多く、人の操作ではないので記録しない
  if (event.authType === "service_account" || event.authType === "system") return;
  const change = event.data;
  if (!change) return;
  const beforeExists = change.before.exists;
  const afterExists = change.after.exists;
  const op = !beforeExists ? "create" : !afterExists ? "delete" : "update";
  const before = (toJsonValue(change.before.data() ?? {}) as Record<string, unknown>) ?? {};
  const after = (toJsonValue(change.after.data() ?? {}) as Record<string, unknown>) ?? {};

  let changes: FieldChange[] = [];
  let snapshot: string | null = null;
  if (op === "update") {
    changes = diffData(before, after);
    if (changes.length === 0) return; // 実質的な変更なし（updatedAtのみ等）
  } else {
    // 作成・削除は、内容をまるごと残す（削除されたデータを後から確認できるように）
    snapshot = JSON.stringify(op === "create" ? after : before);
    if (snapshot.length > 20000) snapshot = snapshot.slice(0, 20000) + "…（以下省略）";
  }
  const actor = await resolveActor(event.authType, event.authId);
  const path = (op === "delete" ? change.before : change.after).ref.path;
  const docId = path.split("/").pop() ?? "";
  await db()
    .collection("operationLogs")
    .add({
      at: admin.firestore.Timestamp.fromDate(new Date(event.time)),
      op,
      collection,
      collectionLabel: COLLECTION_LABEL[collection] ?? collection,
      path,
      docId,
      targetLabel: targetLabelOf(op === "delete" ? before : after) || targetLabelOf(before),
      actorType: event.authType,
      actorUid: event.authId ?? "",
      actorLabel: actor.label,
      actorRole: actor.role,
      changes: changes.slice(0, 60),
      changeCount: changes.length,
      snapshot,
    });
}

/** トップレベルのドキュメント（例：members/30000012）の書き込みを記録する */
export const recordOperationLog = onDocumentWrittenWithAuthContext("{col}/{docId}", async (event) => {
  await writeOperationLog(event, event.params.col);
});

/** サブコレクションのドキュメント（例：memberSubscriptions/…/payments/…）の書き込みを記録する */
export const recordOperationLogSub = onDocumentWrittenWithAuthContext("{col}/{docId}/{sub}/{subId}", async (event) => {
  await writeOperationLog(event, event.params.col);
});
