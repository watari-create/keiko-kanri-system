"use client";

// 管理画面「システム管理」タブ（アドミンのみ表示。2026-10-14〜）
//   権限管理 … 本部アカウントの追加・権限（アドミン／編集できる／閲覧のみ）の変更・権限の解除
//   バックアップ … 毎日3:00の自動バックアップと手動バックアップの一覧・ダウンロード
//   操作ログ … 誰が・いつ・何を変えたか（Cloud Functions〈recordOperationLog〉が記録）
//   ログイン履歴 … 本部・スタッフ・会員のログインの成功／失敗
// データの読み取りは Firestore ルール（isHonbuAdmin）と Cloud Functions（requireHonbuAdmin）でアドミンに限定している。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  type QueryDocumentSnapshot,
  type Timestamp,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "@/lib/firebase";
import { useAuth, HONBU_LEVEL_LABEL, type HonbuLevel } from "@/lib/AuthContext";

type Section = "access" | "backup" | "oplog" | "login";
const SECTIONS: [Section, string][] = [
  ["access", "権限管理"],
  ["backup", "バックアップ"],
  ["oplog", "操作ログ"],
  ["login", "ログイン履歴"],
];

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function errMsg(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  return m.replace(/^FirebaseError:\s*/, "");
}

export default function SystemAdminPanel() {
  const [section, setSection] = useState<Section>("access");
  return (
    <div>
      <div className="flex gap-1 border-b border-line mb-5" role="tablist" aria-label="システム管理">
        {SECTIONS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={section === k}
            onClick={() => setSection(k)}
            className={`text-sm px-4 pb-3 -mb-px border-b-2 ${
              section === k ? "border-matcha-deep text-matcha-deep font-bold" : "border-transparent text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {section === "access" && <AccessSection />}
      {section === "backup" && <BackupSection />}
      {section === "oplog" && <OperationLogSection />}
      {section === "login" && <LoginHistorySection />}
    </div>
  );
}

// ============================================================================
// 権限管理
// ============================================================================

type Account = { uid: string; email: string; level: HonbuLevel; created: string; lastSignIn: string; disabled: boolean };
const LEVELS: HonbuLevel[] = ["admin", "editor", "viewer"];
const LEVEL_DESC: Record<HonbuLevel, string> = {
  admin: "すべての編集に加えて、バックアップ・操作ログ・ログイン履歴の確認と、本部アカウントの権限管理ができます。",
  editor: "会員・出席・入金・許状などのすべての画面を見て、編集・送信できます（これまでの本部と同じ）。バックアップ・ログ・権限管理は見られません。",
  viewer: "すべての画面を見ることができますが、追加・変更・削除・LINE送信などの操作はできません。",
};

function CopyLink({ link, note }: { link: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-matcha-deep bg-matcha-pale rounded p-3 text-sm mt-3">
      <p className="mb-2 text-ink">{note}</p>
      <div className="flex gap-2 items-center">
        <input readOnly className="flex-1 border border-line rounded px-2 py-1.5 text-xs bg-white" value={link} />
        <button
          type="button"
          className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
          onClick={() => {
            navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
    </div>
  );
}

function AccessSection() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newLevel, setNewLevel] = useState<HonbuLevel>("viewer");
  const [linkInfo, setLinkInfo] = useState<{ link: string; note: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await httpsCallable<unknown, { accounts: Account[] }>(getFunctions(), "listHonbuAccounts")();
      setAccounts(res.data.accounts);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function setAccess(email: string, level: HonbuLevel | "none") {
    const label = level === "none" ? "本部の権限を外す" : `「${HONBU_LEVEL_LABEL[level]}」にする`;
    if (!window.confirm(`${email} を${label}します。よろしいですか？`)) return;
    setBusy(email);
    setError(null);
    setMessage(null);
    setLinkInfo(null);
    try {
      const res = await httpsCallable<
        { email: string; level: HonbuLevel | "none" },
        { created: boolean; passwordLink?: string | null }
      >(getFunctions(), "setHonbuAccess")({ email, level });
      if (res.data.created && res.data.passwordLink) {
        setLinkInfo({
          link: res.data.passwordLink,
          note: `${email} のアカウントを作成しました。下のリンクをご本人に送り、パスワードを決めてもらってください（リンクはこの画面を閉じると再表示されません。必要なら一覧の「パスワード設定リンク」から再発行できます）。ログインは /login から行います。`,
        });
      } else {
        setMessage(`${email} の権限を変更しました。${level === "none" ? "" : "ご本人が次に画面を開いたときから反映されます。"}`);
      }
      setNewEmail("");
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function issueLink(email: string) {
    setBusy(email);
    setError(null);
    setLinkInfo(null);
    try {
      const res = await httpsCallable<{ email: string }, { passwordLink: string }>(getFunctions(), "issueHonbuPasswordLink")({ email });
      setLinkInfo({
        link: res.data.passwordLink,
        note: `${email} のパスワード設定リンクです。ご本人に送ってください（一定時間で無効になります）。`,
      });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-paper border border-line rounded-md p-5">
        <h2 className="font-bold mb-3">権限の種類</h2>
        <dl className="text-sm space-y-2">
          {LEVELS.map((lv) => (
            <div key={lv} className="flex gap-3">
              <dt className="w-24 shrink-0 font-bold text-matcha-deep">{HONBU_LEVEL_LABEL[lv]}</dt>
              <dd className="text-ink">{LEVEL_DESC[lv]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted mt-3">
          権限を変えるとセキュリティ通知のSlackにお知らせが届き、操作ログにも残ります。権限を下げた・外した場合は、その人はいったんログアウトされます。
          世話人・講師（スタッフ）の担当は「スタッフ管理」タブで設定します。
        </p>
      </section>

      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold">本部アカウント{accounts ? `（${accounts.length}件）` : ""}</h2>
          <button type="button" className="text-xs border border-line rounded px-3 py-1.5" onClick={load}>
            再読み込み
          </button>
        </div>
        {error && <p className="text-hanko text-sm mb-3">{error}</p>}
        {message && <p className="text-matcha-deep text-sm mb-3">{message}</p>}
        {linkInfo && <CopyLink link={linkInfo.link} note={linkInfo.note} />}
        {!accounts && !error && <p className="text-sm text-muted">読み込み中…</p>}
        {accounts && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm mt-3">
              <thead>
                <tr className="text-left text-muted border-b border-line">
                  <th className="py-2 pr-3">メールアドレス</th>
                  <th className="pr-3">権限</th>
                  <th className="pr-3">最終ログイン</th>
                  <th className="pr-3">作成日</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const self = a.uid === user?.uid;
                  return (
                    <tr key={a.uid} className="border-b border-line">
                      <td className="py-2 pr-3">
                        {a.email || a.uid}
                        {self && <span className="ml-2 text-xs text-muted">（あなた）</span>}
                        {a.disabled && <span className="ml-2 text-xs text-hanko">無効</span>}
                      </td>
                      <td className="pr-3">
                        {self ? (
                          <span className="font-bold text-matcha-deep">{HONBU_LEVEL_LABEL[a.level]}</span>
                        ) : (
                          <select
                            className="border border-line rounded px-2 py-1 text-sm bg-white"
                            value={a.level}
                            disabled={busy === a.email}
                            onChange={(e) => setAccess(a.email, e.target.value as HonbuLevel)}
                          >
                            {LEVELS.map((lv) => (
                              <option key={lv} value={lv}>
                                {HONBU_LEVEL_LABEL[lv]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="pr-3 whitespace-nowrap">{fmt(a.lastSignIn)}</td>
                      <td className="pr-3 whitespace-nowrap">{fmt(a.created)}</td>
                      <td className="py-2 whitespace-nowrap text-right">
                        {!self && a.email && (
                          <>
                            <button
                              type="button"
                              className="text-xs border border-line rounded px-2 py-1 mr-2"
                              disabled={busy === a.email}
                              onClick={() => issueLink(a.email)}
                            >
                              パスワード設定リンク
                            </button>
                            <button
                              type="button"
                              className="text-xs border border-line text-hanko rounded px-2 py-1"
                              disabled={busy === a.email}
                              onClick={() => setAccess(a.email, "none")}
                            >
                              権限を外す
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-paper border border-line rounded-md p-5">
        <h2 className="font-bold mb-1">本部アカウントを追加する</h2>
        <p className="text-xs text-muted mb-3">
          メールアドレスがまだ登録されていなければ新しく作り、パスワード設定用のリンクを表示します。登録済みのアカウントなら権限だけを付けます。
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (newEmail.trim()) setAccess(newEmail.trim(), newLevel);
          }}
        >
          <label className="block">
            <span className="block text-xs text-muted mb-1">メールアドレス</span>
            <input
              type="email"
              className="border border-line rounded px-3 py-2 text-sm w-72"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-muted mb-1">権限</span>
            <select
              className="border border-line rounded px-3 py-2 text-sm bg-white"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value as HonbuLevel)}
            >
              {LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {HONBU_LEVEL_LABEL[lv]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
            disabled={!newEmail.trim() || busy !== null}
          >
            追加する
          </button>
        </form>
      </section>
    </div>
  );
}

// ============================================================================
// バックアップ
// ============================================================================

type BackupDoc = {
  id: string;
  status: "running" | "done" | "failed";
  trigger: "auto" | "manual";
  by?: string;
  createdAt?: Timestamp;
  counts?: Record<string, number>;
  docCount?: number;
  gzipBytes?: number;
  rawBytes?: number;
  chunkCount?: number;
  error?: string;
};

type BackupJson = {
  format: string;
  createdAt: string;
  counts: Record<string, number>;
  collections: Record<string, Record<string, unknown>>;
};

function sizeLabel(bytes?: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadBackupText(b: BackupDoc): Promise<string> {
  const snap = await getDocs(query(collection(db, "backups", b.id, "chunks"), orderBy("index")));
  const b64 = snap.docs.map((d) => String(d.data().data ?? "")).join("");
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cellValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && (v as { __type?: string }).__type === "timestamp") return String((v as { value: string }).value);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function collectionCsv(docs: Record<string, unknown>): string {
  const entries = Object.entries(docs) as [string, Record<string, unknown>][];
  const keys = new Set<string>();
  entries.forEach(([, d]) => Object.keys(d ?? {}).forEach((k) => keys.add(k)));
  const cols = [...keys].sort();
  const header = ["ドキュメントID", "パス", ...cols];
  const lines = entries.map(([path, d]) =>
    [path.split("/").pop() ?? "", path, ...cols.map((c) => cellValue(d?.[c]))].map(csvCell).join(",")
  );
  return "﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n");
}

const COLLECTION_NAMES: Record<string, string> = {
  members: "会員",
  staff: "スタッフ",
  licenseRequests: "許状申請",
  leaveRequests: "休会・退会申請",
  groupSettings: "会の設定",
  lineMessageLogs: "LINE送信履歴",
  notifications: "通知",
  paymentEvents: "入金イベント",
  memberSubscriptions: "カード自動払い",
  "memberSubscriptions/payments": "カード自動払い（引き落とし履歴）",
  meta: "設定・在庫など",
  g1ShippingLogs: "G1発送記録",
  chadoClassLedger: "茶道教室クラス台帳",
  chadoRecruitClasses: "新規募集クラス",
  chadoClassSessions: "茶道教室（木・日）開催日",
  chadoSaturdaySessions: "茶道教室（土）開催日",
  lessonExtraDates: "追加した開催日",
  lessonChanges: "お稽古の日程変更",
  shingetsuSessions: "新月会 開催日",
  chadoStudentNotes: "生徒の申し送り",
  keikoNoteEntries: "お稽古ノート",
  counters: "会員番号の採番",
  securityReports: "セキュリティ週次レポート",
};
const colName = (k: string) => (COLLECTION_NAMES[k] ? `${COLLECTION_NAMES[k]}（${k}）` : k);

function BackupSection() {
  const [backups, setBackups] = useState<BackupDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; data: BackupJson } | null>(null);

  useEffect(() => {
    const q = query(collection(db, "backups"), orderBy("createdAt", "desc"), limit(60));
    return onSnapshot(
      q,
      (snap) => setBackups(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BackupDoc, "id">) }))),
      (e) => setError(errMsg(e))
    );
  }, []);

  async function runNow() {
    if (!window.confirm("今の全データをバックアップします（1〜2分かかることがあります）。よろしいですか？")) return;
    setRunning(true);
    setError(null);
    try {
      await httpsCallable(getFunctions(), "createBackupNow", { timeout: 540_000 })();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setRunning(false);
    }
  }

  async function open(b: BackupDoc): Promise<BackupJson | null> {
    if (opened?.id === b.id) return opened.data;
    setWorking(b.id);
    setError(null);
    try {
      const text = await loadBackupText(b);
      const data = JSON.parse(text) as BackupJson;
      setOpened({ id: b.id, data });
      return data;
    } catch (e) {
      setError(`バックアップを開けませんでした：${errMsg(e)}`);
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function downloadJson(b: BackupDoc) {
    setWorking(b.id);
    setError(null);
    try {
      const text = await loadBackupText(b);
      download(`backup_${b.id}.json`, text, "application/json");
    } catch (e) {
      setError(`ダウンロードできませんでした：${errMsg(e)}`);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold mb-1">全データのバックアップ</h2>
            <p className="text-xs text-muted">
              会員・出席・入金・許状・スタッフ・会の設定・開催日など、システムの全データを毎日 3:00 に自動で保存します（30日分）。
              大きな変更やCSV取り込みの前には「今すぐバックアップ」で手動保存してください（手動は180日保存）。
              復元は誤操作を防ぐため画面からは行わず、管理用スクリプト（scripts/restoreFromBackup.js）で必要な部分だけを戻します。
            </p>
          </div>
          <button
            type="button"
            className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50 whitespace-nowrap"
            onClick={runNow}
            disabled={running}
          >
            {running ? "バックアップ中…" : "今すぐバックアップ"}
          </button>
        </div>
        {error && <p className="text-hanko text-sm mt-3">{error}</p>}
      </section>

      <section className="bg-paper border border-line rounded-md p-5 overflow-x-auto">
        <h2 className="font-bold mb-3">保存済みのバックアップ</h2>
        {!backups && !error && <p className="text-sm text-muted">読み込み中…</p>}
        {backups && backups.length === 0 && (
          <p className="text-sm text-muted">まだバックアップはありません。最初の自動バックアップは翌日 3:00 に作られます。</p>
        )}
        {backups && backups.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">日時</th>
                <th className="pr-3">種類</th>
                <th className="pr-3">実行した人</th>
                <th className="pr-3 text-right">件数</th>
                <th className="pr-3 text-right">サイズ</th>
                <th className="pr-3">状態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-line">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmt(b.createdAt?.toDate())}</td>
                  <td className="pr-3">{b.trigger === "manual" ? "手動" : "自動"}</td>
                  <td className="pr-3">{b.by ?? "—"}</td>
                  <td className="pr-3 text-right">{b.docCount?.toLocaleString() ?? "—"}</td>
                  <td className="pr-3 text-right whitespace-nowrap">{sizeLabel(b.gzipBytes)}</td>
                  <td className="pr-3">
                    {b.status === "done" && <span className="text-matcha-deep">完了</span>}
                    {b.status === "running" && <span className="text-muted">作成中…</span>}
                    {b.status === "failed" && (
                      <span className="text-hanko" title={b.error}>
                        失敗
                      </span>
                    )}
                  </td>
                  <td className="py-2 whitespace-nowrap text-right">
                    {b.status === "done" && (
                      <>
                        <button
                          type="button"
                          className="text-xs border border-line rounded px-2 py-1 mr-2 disabled:opacity-50"
                          disabled={working !== null}
                          onClick={() => (opened?.id === b.id ? setOpened(null) : open(b))}
                        >
                          {working === b.id ? "読み込み中…" : opened?.id === b.id ? "閉じる" : "中身を見る・CSV"}
                        </button>
                        <button
                          type="button"
                          className="text-xs border border-line rounded px-2 py-1 disabled:opacity-50"
                          disabled={working !== null}
                          onClick={() => downloadJson(b)}
                        >
                          全データ（JSON）
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {opened && (
        <section className="bg-paper border border-line rounded-md p-5">
          <h2 className="font-bold mb-1">バックアップの中身（{fmt(opened.data.createdAt)}）</h2>
          <p className="text-xs text-muted mb-3">データの種類ごとにCSV（Excelで開けます）でダウンロードできます。</p>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(opened.data.counts)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([k, n]) => (
                  <tr key={k} className="border-b border-line">
                    <td className="py-2 pr-3">{colName(k)}</td>
                    <td className="pr-3 text-right">{n.toLocaleString()}件</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="text-xs border border-line rounded px-2 py-1 disabled:opacity-50"
                        disabled={n === 0}
                        onClick={() =>
                          download(
                            `backup_${opened.id}_${k.replace(/\//g, "-")}.csv`,
                            collectionCsv(opened.data.collections[k] ?? {}),
                            "text/csv;charset=utf-8"
                          )
                        }
                      >
                        CSV
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ============================================================================
// 操作ログ
// ============================================================================

type OpLog = {
  id: string;
  at?: Timestamp;
  op: "create" | "update" | "delete";
  collection: string;
  collectionLabel?: string;
  path: string;
  docId: string;
  targetLabel?: string;
  actorLabel?: string;
  actorRole?: string;
  changes?: { field: string; before: string; after: string }[];
  changeCount?: number;
  snapshot?: string | null;
};

const OP_LABEL: Record<OpLog["op"], string> = { create: "追加", update: "変更", delete: "削除" };
const OP_CLASS: Record<OpLog["op"], string> = {
  create: "bg-matcha-pale text-matcha-deep",
  update: "bg-[#F3EFE2] text-ink",
  delete: "bg-hanko-pale text-hanko",
};
const ACTOR_ROLE_LABEL: Record<string, string> = {
  honbu: "本部",
  staff: "スタッフ",
  member: "会員（マイページ）",
  public: "入会フォーム",
  console: "Firebaseコンソール",
};
const PAGE = 200;

function OperationLogSection() {
  const [logs, setLogs] = useState<OpLog[]>([]);
  const [last, setLast] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colFilter, setColFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const loadMore = useCallback(
    async (reset = false) => {
      setLoading(true);
      setError(null);
      try {
        const base = [orderBy("at", "desc"), limit(PAGE)] as const;
        const q =
          !reset && last
            ? query(collection(db, "operationLogs"), orderBy("at", "desc"), startAfter(last), limit(PAGE))
            : query(collection(db, "operationLogs"), ...base);
        const snap = await getDocs(q);
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OpLog, "id">) }));
        setLogs((prev) => (reset ? rows : [...prev, ...rows]));
        setLast(snap.docs[snap.docs.length - 1] ?? null);
        setHasMore(snap.size === PAGE);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [last]
  );

  useEffect(() => {
    loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const collections = useMemo(() => {
    const m = new Map<string, string>();
    logs.forEach((l) => m.set(l.collection, l.collectionLabel ?? l.collection));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [logs]);

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (!colFilter || l.collection === colFilter) &&
        (!roleFilter || (l.actorRole ?? "") === roleFilter) &&
        (!kw ||
          [l.targetLabel, l.docId, l.actorLabel, ...(l.changes ?? []).map((c) => c.field)]
            .join(" ")
            .toLowerCase()
            .includes(kw))
    );
  }, [logs, colFilter, roleFilter, keyword]);

  return (
    <section className="bg-paper border border-line rounded-md p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-bold">操作ログ</h2>
        <button type="button" className="text-xs border border-line rounded px-3 py-1.5" onClick={() => loadMore(true)}>
          最新に更新
        </button>
      </div>
      <p className="text-xs text-muted mb-3">
        管理画面・スタッフ画面・マイページ・入会フォームから行われた追加・変更・削除を記録しています（約1年分）。
        Cloud Functionsが自動で行った処理（Square連携・カレンダー同期など）は含みません。
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <select className="border border-line rounded px-2 py-1.5 bg-white" value={colFilter} onChange={(e) => setColFilter(e.target.value)}>
          <option value="">すべてのデータ</option>
          {collections.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select className="border border-line rounded px-2 py-1.5 bg-white" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">操作した人：すべて</option>
          {Object.entries(ACTOR_ROLE_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="border border-line rounded px-2 py-1.5 w-56"
          placeholder="氏名・会員番号・項目名で絞り込み"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span className="text-xs text-muted">
          {shown.length}件表示（読み込み済み {logs.length}件）
        </span>
      </div>
      {error && <p className="text-hanko text-sm mb-3">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="py-2 pr-3 whitespace-nowrap">日時</th>
              <th className="pr-3">操作した人</th>
              <th className="pr-3">操作</th>
              <th className="pr-3">対象</th>
              <th className="pr-3">変更内容</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const open = openId === l.id;
              const changes = l.changes ?? [];
              return (
                <tr key={l.id} className="border-b border-line align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmt(l.at?.toDate())}</td>
                  <td className="py-2 pr-3">{l.actorLabel ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-block text-xs rounded px-2 py-0.5 ${OP_CLASS[l.op]}`}>{OP_LABEL[l.op]}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-xs text-muted">{l.collectionLabel ?? l.collection}</div>
                    <div>
                      {l.targetLabel || l.docId}
                      {l.targetLabel && l.targetLabel !== l.docId && <span className="text-xs text-muted ml-1">（{l.docId}）</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {l.op === "update" && (
                      <ul className="space-y-0.5">
                        {(open ? changes : changes.slice(0, 3)).map((c, i) => (
                          <li key={i} className="break-all">
                            <span className="font-bold">{c.field}</span>：{c.before} → {c.after}
                          </li>
                        ))}
                      </ul>
                    )}
                    {l.op !== "update" && open && l.snapshot && (
                      <pre className="whitespace-pre-wrap break-all bg-bg border border-line rounded p-2 max-h-64 overflow-y-auto">
                        {prettySnapshot(l.snapshot)}
                      </pre>
                    )}
                    {((l.op === "update" && changes.length > 3) || (l.op !== "update" && l.snapshot)) && (
                      <button type="button" className="text-matcha-deep underline mt-1" onClick={() => setOpenId(open ? null : l.id)}>
                        {open
                          ? "閉じる"
                          : l.op === "update"
                          ? `ほか${changes.length - 3}件を表示`
                          : l.op === "delete"
                          ? "削除した内容を見る"
                          : "追加した内容を見る"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  記録はまだありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-center mt-4">
        {loading && <span className="text-sm text-muted">読み込み中…</span>}
        {!loading && hasMore && logs.length > 0 && (
          <button type="button" className="text-sm border border-line rounded px-4 py-2" onClick={() => loadMore()}>
            さらに古い記録を読み込む
          </button>
        )}
      </div>
    </section>
  );
}

function prettySnapshot(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ============================================================================
// ログイン履歴
// ============================================================================

type LoginRow = {
  at: string;
  method: string;
  result: string;
  memberNo: string;
  role: string;
  reason: string;
  email: string;
  ip: string;
  userAgent: string;
  name: string;
};

const REASON_LABEL: Record<string, string> = {
  empty: "未入力",
  locked: "ロック中（連続失敗）",
  "email-mismatch": "メールアドレス不一致",
  "unknown-memberNo": "会員番号が見つからない",
  "line-token-invalid": "LINE認証エラー",
  password: "パスワード誤り",
};

function whoLabel(r: LoginRow): string {
  if (r.method === "password") return r.email || "（メール未入力）";
  if (r.memberNo) return `${r.name ? r.name + " " : ""}${r.memberNo}`;
  return "—";
}
function kindLabel(r: LoginRow): string {
  if (r.method === "password") return "本部";
  const base = r.role === "staff" ? "スタッフ" : r.role === "member" ? "会員" : "会員・スタッフ";
  return r.method === "line" ? `${base}（LINE）` : base;
}
function deviceLabel(ua: string): string {
  if (!ua) return "—";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "その他";
  const br = /Line\//.test(ua) ? "LINE" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "";
  return br ? `${os}・${br}` : os;
}

function LoginHistorySection() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<LoginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFail, setOnlyFail] = useState(false);
  const [kind, setKind] = useState("");

  const load = useCallback(async (d: number) => {
    setRows(null);
    setError(null);
    try {
      const res = await httpsCallable<{ days: number }, { rows: LoginRow[] }>(getFunctions(), "getLoginHistory")({ days: d });
      setRows(res.data.rows);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load(days);
  }, [days, load]);

  const shown = (rows ?? []).filter(
    (r) => (!onlyFail || r.result === "fail") && (!kind || kindLabel(r).startsWith(kind))
  );
  const failCount = (rows ?? []).filter((r) => r.result === "fail").length;

  return (
    <section className="bg-paper border border-line rounded-md p-5">
      <h2 className="font-bold mb-1">ログイン履歴</h2>
      <p className="text-xs text-muted mb-3">
        本部（メールアドレス＋パスワード）・スタッフ・会員（会員番号／LINE）のログインの成功・失敗です（最大90日・1000件）。
        失敗が続いた場合はセキュリティ通知のSlackにもお知らせが届きます。
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <select className="border border-line rounded px-2 py-1.5 bg-white" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>直近7日</option>
          <option value={30}>直近30日</option>
          <option value={90}>直近90日</option>
        </select>
        <select className="border border-line rounded px-2 py-1.5 bg-white" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">すべての種類</option>
          <option value="本部">本部</option>
          <option value="スタッフ">スタッフ</option>
          <option value="会員">会員</option>
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={onlyFail} onChange={(e) => setOnlyFail(e.target.checked)} />
          失敗のみ（{failCount}件）
        </label>
        <button type="button" className="text-xs border border-line rounded px-3 py-1.5 ml-auto" onClick={() => load(days)}>
          最新に更新
        </button>
      </div>
      {error && <p className="text-hanko text-sm mb-3">{error}</p>}
      {!rows && !error && <p className="text-sm text-muted">読み込み中…</p>}
      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">日時</th>
                <th className="pr-3">結果</th>
                <th className="pr-3">種類</th>
                <th className="pr-3">ログインした人</th>
                <th className="pr-3">失敗の理由</th>
                <th className="pr-3">IPアドレス</th>
                <th className="pr-3">端末</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className={`border-b border-line ${r.result === "fail" ? "bg-hanko-pale/40" : ""}`}>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmt(r.at)}</td>
                  <td className="pr-3">
                    {r.result === "success" ? (
                      <span className="text-matcha-deep">成功</span>
                    ) : (
                      <span className="text-hanko font-bold">失敗</span>
                    )}
                  </td>
                  <td className="pr-3 whitespace-nowrap">{kindLabel(r)}</td>
                  <td className="pr-3">{whoLabel(r)}</td>
                  <td className="pr-3">{r.result === "fail" ? REASON_LABEL[r.reason] ?? r.reason ?? "—" : ""}</td>
                  <td className="pr-3 text-xs">{r.ip || "—"}</td>
                  <td className="pr-3 text-xs whitespace-nowrap" title={r.userAgent}>
                    {deviceLabel(r.userAgent)}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-muted">
                    該当する記録はありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
