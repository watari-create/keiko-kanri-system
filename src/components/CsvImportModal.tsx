"use client";

// 宗徧流稽古タブ向けのCSV名簿インポート機能。
// 「①CSVを選ぶ → ②列を項目に割り当てる → ③反映内容を確認する → ④取り込む」の4ステップ。
// ・会員番号（id）をキーに、既存会員は更新（マッピングした項目のみ上書き。空欄の列は上書きしない）、
//   未登録の会員番号は新規追加する。CSVに載っていない既存会員には一切手を加えない。
// ・列の割り当てとステータスの読み替えは、見出し名から推測した上で必ず確認・修正できるようにしている。

import { useEffect, useMemo, useState } from "react";
import { collection, doc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { parseCsvWithHeader, normalizeDate } from "@/lib/csv";
import type { GroupCategory, Member, MemberStatus } from "@/types";

type Step = "upload" | "mapping" | "preview" | "result";

type TargetField =
  | "id"
  | "name"
  | "nameKana"
  | "sotomei"
  | "branch"
  | "shachu"
  | "age"
  | "license"
  | "joinDate"
  | "status"
  | "guardian"
  | "email"
  | "phone"
  | "address"
  | "occupation";

const TARGET_FIELDS: {
  key: TargetField;
  label: string;
  required?: boolean;
  aliases: string[];
}[] = [
  { key: "id", label: "会員番号（ID）", required: true, aliases: ["会員番号", "会員コード", "id", "ID"] },
  { key: "name", label: "氏名", required: true, aliases: ["氏名", "会員名", "名前", "name"] },
  { key: "nameKana", label: "氏名（フリガナ）", aliases: ["フリガナ", "氏名（フリガナ）", "ふりがな"] },
  { key: "sotomei", label: "宗名", aliases: ["宗名"] },
  { key: "branch", label: "支部", aliases: ["支部"] },
  { key: "shachu", label: "社中（代表）", aliases: ["社中", "社中代表", "師匠"] },
  { key: "age", label: "年齢", aliases: ["年齢", "age"] },
  { key: "license", label: "許状段階", aliases: ["許状段階", "許状"] },
  { key: "joinDate", label: "入会日", aliases: ["入会日", "入会年月日", "入会年"] },
  { key: "status", label: "ステータス", aliases: ["ステータス", "状態"] },
  { key: "guardian", label: "保護者名", aliases: ["保護者名", "保護者"] },
  { key: "email", label: "メールアドレス", aliases: ["メールアドレス", "メール", "email", "Email"] },
  { key: "phone", label: "電話番号", aliases: ["電話番号", "電話", "tel", "TEL"] },
  { key: "address", label: "ご住所", aliases: ["ご住所", "住所"] },
  { key: "occupation", label: "ご職業", aliases: ["ご職業", "職業"] },
];

type Mapping = Record<TargetField, number | null>;

function emptyMapping(): Mapping {
  const m = {} as Mapping;
  for (const f of TARGET_FIELDS) m[f.key] = null;
  return m;
}

function guessMapping(headers: string[]): Mapping {
  const m = emptyMapping();
  TARGET_FIELDS.forEach((f) => {
    const idx = headers.findIndex((h) => f.aliases.some((a) => h === a));
    if (idx !== -1) {
      m[f.key] = idx;
      return;
    }
    const partial = headers.findIndex((h) => f.aliases.some((a) => h.includes(a)));
    if (partial !== -1) m[f.key] = partial;
  });
  return m;
}

function guessStatus(raw: string): MemberStatus {
  if (raw.includes("退")) return "退会";
  if (raw.includes("休")) return "休会";
  return "在籍";
}

interface PreviewRow {
  rowIndex: number; // データ行の何行目か（0始まり）
  id: string;
  name: string;
  data: Partial<Member>;
  isNew: boolean;
  changedFields: string[];
  errors: string[];
}

interface ImportResult {
  successCount: number;
  failed: { id: string; name: string; error: string }[];
}

interface CsvImportModalProps {
  open: boolean;
  onClose: () => void;
  group: string; // インポート先のグループ（現在選択中の会）
  groupCategory: GroupCategory;
  existingMembers: Member[]; // 現在表示中の会の会員一覧（差分表示・上書き防止に使う）
}

export default function CsvImportModal({
  open,
  onClose,
  group,
  groupCategory,
  existingMembers,
}: CsvImportModalProps) {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping());
  const [statusValueMap, setStatusValueMap] = useState<Record<string, MemberStatus>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploadError, setUploadError] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const existingById = useMemo(() => {
    const map = new Map<string, Member>();
    existingMembers.forEach((m) => map.set(m.id, m));
    return map;
  }, [existingMembers]);

  const statusColIndex = mapping.status;
  const distinctStatusValues = useMemo(() => {
    if (statusColIndex === null) return [];
    const set = new Set<string>();
    dataRows.forEach((r) => {
      const v = (r[statusColIndex] ?? "").trim();
      if (v) set.add(v);
    });
    return Array.from(set);
  }, [statusColIndex, dataRows]);

  function reset() {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setDataRows([]);
    setMapping(emptyMapping());
    setStatusValueMap({});
    setSelected(new Set());
    setUploadError("");
    setImporting(false);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleFile(file: File) {
    setUploadError("");
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const parsed = parseCsvWithHeader(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setUploadError("CSVを読み取れませんでした。1行目に見出し、2行目以降にデータがあるファイルを選んでください。");
        return;
      }
      setFileName(file.name);
      setHeaders(parsed.headers);
      setDataRows(parsed.rows);
      setMapping(guessMapping(parsed.headers));
      setStep("mapping");
    };
    reader.onerror = () => setUploadError("ファイルの読み込みに失敗しました。");
    reader.readAsText(file, "utf-8");
  }

  function updateMapping(field: TargetField, value: string) {
    const idx = value === "-1" ? null : Number(value);
    setMapping((m) => ({ ...m, [field]: idx }));
  }

  function goToPreview() {
    if (mapping.id === null || mapping.name === null) {
      setUploadError("会員番号と氏名は必ず割り当ててください。");
      return;
    }
    setUploadError("");
    // ステータス列がある場合、見出しにない値は推測で初期化しておく
    if (mapping.status !== null) {
      setStatusValueMap((prev) => {
        const next = { ...prev };
        distinctStatusValues.forEach((v) => {
          if (!(v in next)) next[v] = guessStatus(v);
        });
        return next;
      });
    }
    setStep("preview");
  }

  const previewRows: PreviewRow[] = useMemo(() => {
    if (step !== "preview" && step !== "result") return [];
    return dataRows.map((row, rowIndex) => {
      const get = (field: TargetField): string => {
        const idx = mapping[field];
        if (idx === null) return "";
        return (row[idx] ?? "").trim();
      };

      const id = get("id");
      const name = get("name");
      const errors: string[] = [];
      if (!id) errors.push("会員番号が空です");
      if (!name) errors.push("氏名が空です");

      const data: Partial<Member> = {};
      if (id) data.id = id;
      if (name) data.name = name;
      const nameKana = get("nameKana");
      if (nameKana) data.nameKana = nameKana;
      const sotomei = get("sotomei");
      if (sotomei) data.sotomei = sotomei;
      const branch = get("branch");
      if (branch) data.branch = branch;
      const shachu = get("shachu");
      if (shachu) data.shachu = shachu;
      const ageRaw = get("age");
      if (ageRaw) {
        const ageNum = Number(ageRaw);
        if (!Number.isNaN(ageNum)) data.age = ageNum;
      }
      const license = get("license");
      if (license) data.license = license;
      const joinDateRaw = get("joinDate");
      if (joinDateRaw) data.joinDate = normalizeDate(joinDateRaw);
      const guardian = get("guardian");
      if (guardian) data.guardian = guardian;
      const email = get("email");
      if (email) data.email = email;
      const phone = get("phone");
      if (phone) data.phone = phone;
      const address = get("address");
      if (address) data.address = address;
      const occupation = get("occupation");
      if (occupation) data.occupation = occupation;
      const statusRaw = get("status");
      if (statusRaw) data.status = statusValueMap[statusRaw] ?? guessStatus(statusRaw);

      const existing = id ? existingById.get(id) : undefined;
      const isNew = !existing;
      const changedFields: string[] = [];
      (Object.keys(data) as (keyof Member)[]).forEach((key) => {
        if (key === "id") return;
        const newVal = data[key];
        const oldVal = existing ? existing[key] : undefined;
        if (newVal !== oldVal) changedFields.push(key);
      });

      if (!existing) {
        data.group = group;
        data.groupCategory = groupCategory;
        if (!data.status) data.status = "在籍";
      }

      return { rowIndex, id, name, data, isNew, changedFields, errors };
    });
  }, [step, dataRows, mapping, statusValueMap, existingById, group, groupCategory]);

  // プレビュー表示時：エラーのない行をデフォルトで選択状態にする
  useEffect(() => {
    if (step === "preview" && selected.size === 0 && previewRows.length > 0) {
      const initial = new Set<number>();
      previewRows.forEach((r) => {
        if (r.errors.length === 0) initial.add(r.rowIndex);
      });
      setSelected(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, previewRows.length]);

  const counts = useMemo(() => {
    let newCount = 0;
    let updateCount = 0;
    let sameCount = 0;
    let errorCount = 0;
    previewRows.forEach((r) => {
      if (r.errors.length > 0) errorCount++;
      else if (r.isNew) newCount++;
      else if (r.changedFields.length > 0) updateCount++;
      else sameCount++;
    });
    return { newCount, updateCount, sameCount, errorCount };
  }, [previewRows]);

  function toggleRow(rowIndex: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }

  async function runImport() {
    const rowsToImport = previewRows.filter((r) => selected.has(r.rowIndex) && r.errors.length === 0);
    if (rowsToImport.length === 0) return;
    setImporting(true);
    const failed: ImportResult["failed"] = [];
    let successCount = 0;
    const chunkSize = 400;
    for (let i = 0; i < rowsToImport.length; i += chunkSize) {
      const chunk = rowsToImport.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach((r) => {
        batch.set(doc(collection(db, "members"), r.id), r.data, { merge: true });
      });
      try {
        await batch.commit();
        successCount += chunk.length;
      } catch (err) {
        chunk.forEach((r) =>
          failed.push({ id: r.id, name: r.name, error: err instanceof Error ? err.message : String(err) })
        );
      }
    }
    setResult({ successCount, failed });
    setImporting(false);
    setStep("result");
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-40 p-4" onClick={handleClose}>
      <div
        className="bg-paper rounded-md max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-matcha-deep">CSVから名簿を更新（{group}）</h3>
            <p className="text-xs text-muted">
              会員番号をキーに、既存の会員は更新、新しい会員番号は追加します。CSVに載っていない既存の会員は変更されません。
            </p>
          </div>
          <button className="text-muted text-sm" onClick={handleClose}>
            閉じる ✕
          </button>
        </div>

        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm">
              1行目が見出し行のCSVファイルを選んでください（文字化けする場合はUTF-8で保存し直してください）。
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {uploadError && <p className="text-xs text-red-700">{uploadError}</p>}
          </div>
        )}

        {step === "mapping" && (
          <div className="space-y-5">
            <p className="text-xs text-muted">
              読み込んだファイル：{fileName}（{dataRows.length}行）
            </p>

            <div>
              <h4 className="font-semibold text-sm mb-2">列の割り当て</h4>
              <div className="grid grid-cols-2 gap-3">
                {TARGET_FIELDS.map((f) => (
                  <label key={f.key} className="block text-xs">
                    <span className="block text-muted mb-1">
                      {f.label}
                      {f.required && <span className="text-hanko"> *必須</span>}
                    </span>
                    <select
                      className="input"
                      value={mapping[f.key] === null ? "-1" : String(mapping[f.key])}
                      onChange={(e) => updateMapping(f.key, e.target.value)}
                    >
                      <option value="-1">（使用しない）</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `（${i + 1}列目）`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            {statusColIndex !== null && distinctStatusValues.length > 0 && (
              <div>
                <h4 className="font-semibold text-sm mb-2">ステータスの読み替え</h4>
                <p className="text-xs text-muted mb-2">
                  CSV内の値を、在籍・休会・退会のいずれかに対応させてください。
                </p>
                <div className="space-y-2">
                  {distinctStatusValues.map((v) => (
                    <div key={v} className="flex items-center gap-3">
                      <span className="text-sm w-40 truncate">{v}</span>
                      <span className="text-muted text-xs">→</span>
                      <select
                        className="input w-32"
                        value={statusValueMap[v] ?? guessStatus(v)}
                        onChange={(e) =>
                          setStatusValueMap((prev) => ({
                            ...prev,
                            [v]: e.target.value as MemberStatus,
                          }))
                        }
                      >
                        <option>在籍</option>
                        <option>休会</option>
                        <option>退会</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4 className="font-semibold text-sm mb-2">データのプレビュー（先頭3行）</h4>
              <div className="overflow-x-auto border border-line rounded">
                <table className="text-xs whitespace-nowrap">
                  <thead>
                    <tr className="bg-matcha-pale/40">
                      {headers.map((h, i) => (
                        <th key={i} className="px-2 py-1 text-left border-b border-line">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataRows.slice(0, 3).map((r, i) => (
                      <tr key={i} className="border-b border-line">
                        {headers.map((_, j) => (
                          <td key={j} className="px-2 py-1">
                            {r[j] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {uploadError && <p className="text-xs text-red-700">{uploadError}</p>}

            <div className="flex justify-end gap-3 pt-2">
              <button className="text-sm border border-line text-muted rounded px-4 py-2" onClick={reset}>
                ファイルを選び直す
              </button>
              <button className="text-sm bg-matcha-deep text-white rounded px-4 py-2" onClick={goToPreview}>
                内容を確認する
              </button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">新規追加：{counts.newCount}件</span>
              <span className="bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">更新：{counts.updateCount}件</span>
              <span className="bg-paper border border-line rounded-full px-3 py-1">変更なし：{counts.sameCount}件</span>
              {counts.errorCount > 0 && (
                <span className="bg-red-50 text-red-700 rounded-full px-3 py-1">
                  取り込み対象外（エラー）：{counts.errorCount}件
                </span>
              )}
            </div>

            <div className="overflow-x-auto border border-line rounded max-h-96">
              <table className="text-xs w-full whitespace-nowrap">
                <thead className="sticky top-0 bg-paper">
                  <tr className="text-left text-muted border-b border-line">
                    <th className="px-2 py-1"></th>
                    <th className="px-2 py-1">会員番号</th>
                    <th className="px-2 py-1">氏名</th>
                    <th className="px-2 py-1">状態</th>
                    <th className="px-2 py-1">内容</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r) => (
                    <tr key={r.rowIndex} className="border-b border-line">
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          disabled={r.errors.length > 0}
                          checked={selected.has(r.rowIndex)}
                          onChange={() => toggleRow(r.rowIndex)}
                        />
                      </td>
                      <td className="px-2 py-1 text-muted">{r.id || "—"}</td>
                      <td className="px-2 py-1">{r.name || "—"}</td>
                      <td className="px-2 py-1">
                        {r.errors.length > 0 ? (
                          <span className="text-red-700">エラー</span>
                        ) : r.isNew ? (
                          <span className="text-matcha-deep">新規</span>
                        ) : r.changedFields.length > 0 ? (
                          <span className="text-matcha-deep">更新</span>
                        ) : (
                          <span className="text-muted">変更なし</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-muted">
                        {r.errors.length > 0 ? r.errors.join("、") : r.changedFields.join("、") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                className="text-sm border border-line text-muted rounded px-4 py-2"
                onClick={() => setStep("mapping")}
              >
                列の割り当てに戻る
              </button>
              <button
                className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
                disabled={importing || selected.size === 0}
                onClick={runImport}
              >
                {importing ? "取り込み中…" : `選択した${selected.size}件を取り込む`}
              </button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-4">
            <p className="text-sm">
              {result.successCount}件を反映しました。
              {result.failed.length > 0 && `（失敗：${result.failed.length}件）`}
            </p>
            {result.failed.length > 0 && (
              <div className="border border-line rounded p-3 max-h-60 overflow-y-auto">
                {result.failed.map((f, i) => (
                  <div key={i} className="text-xs text-red-700 mb-1">
                    {f.id} {f.name}：{f.error}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button className="text-sm bg-matcha-deep text-white rounded px-4 py-2" onClick={handleClose}>
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
