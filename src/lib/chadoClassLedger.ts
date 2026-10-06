// 茶道教室：クラス台帳（chadoClassLedger コレクション、doc id = 曜日クラスの値）。
// 曜日クラスごとに「期（開始月）」「現在の段階」「定員」「入会受付の可否」を本部が管理画面で設定する。
// 入会フォーム（/enroll）は「入会受付」がオンのクラスだけを「ご希望のクラス」に表示する（台帳と連動）。
// Firestoreにまだドキュメントが無いクラスは、下の既定値で表示する（入会受付はすべてオフ）。

import type { ChadoClassLedgerEntry, ChadoKyoshitsuClass, ChadoStage } from "@/types";
import { CHADO_CLASSES, CHADO_CLASS_LABEL, CHADO_CLASS_TIME, CHADO_FIXED_TEACHERS } from "@/lib/chadoClasses";

export const CHADO_STAGES: ChadoStage[] = ["入門", "風炉薄茶点前"];

export const CHADO_LEDGER_DEFAULTS: Record<ChadoKyoshitsuClass, Omit<ChadoClassLedgerEntry, "id">> = {
  "土曜日": { startMonth: "2026-04", stage: "風炉薄茶点前", capacity: null, accepting: false },
  "木曜日": { startMonth: "2026-09", stage: "入門", capacity: null, accepting: false },
  "日曜日": { startMonth: "2026-08", stage: "入門", capacity: null, accepting: false },
  "日曜日午後": { startMonth: "2026-08", stage: "入門", capacity: null, accepting: false },
};

// 台帳の講師表示（土曜日は交代制のため両名）
export function chadoLedgerTeacher(c: ChadoKyoshitsuClass): string {
  return CHADO_FIXED_TEACHERS[c] ?? "郷田家元教授・阿部宗亜先生";
}

// Firestoreのドキュメント（無いものは既定値）を曜日クラスの順に並べて返す
export function mergeChadoLedger(
  docs: Partial<Record<string, Partial<ChadoClassLedgerEntry>>>
): ChadoClassLedgerEntry[] {
  return CHADO_CLASSES.map((c) => ({ id: c, ...CHADO_LEDGER_DEFAULTS[c], ...(docs[c] ?? {}) }));
}

// 「2026-04」→「2026年4月期」
export function chadoKiLabel(startMonth: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(startMonth);
  return m ? `${m[1]}年${Number(m[2])}月期` : "開始月未設定";
}

// 入会フォームの選択肢の表示名
export function chadoEnrollOptionLabel(c: ChadoKyoshitsuClass): string {
  return `${CHADO_CLASS_LABEL[c]}クラス（${CHADO_CLASS_TIME[c]}）`;
}
