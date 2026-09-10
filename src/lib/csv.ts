// 汎用CSVパーサー。
// ダブルクォートで囲まれたフィールド（内部のカンマ・改行・エスケープされた""を含む）に対応。
// Excel等からエクスポートしたCSV（先頭にBOMが付くことが多い）を想定している。

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  // 完全に空の行（末尾の空行など）は除去する
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][]; // ヘッダーを除いたデータ行
}

export function parseCsvWithHeader(text: string): ParsedCsv {
  const all = parseCsv(text);
  if (all.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = all;
  return { headers: headers.map((h) => h.trim()), rows };
}

// "2022/01/22" のようなスラッシュ区切りの日付をYYYY-MM-DD形式に正規化する。
// すでにハイフン区切りの場合や、想定外の形式の場合はできる範囲でそのまま返す。
export function normalizeDate(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  const m = v.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return v;
}
