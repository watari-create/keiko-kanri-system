// 茶道教室の曜日クラス関連の定数。
// 木曜日・日曜日クラスは担当講師が固定（人数上限なし・出欠ボタンのみ）。
// 土曜日クラスは月2回開催・午前午後の2枠・各枠定員3名で、講師は交代制のため、
// 開催日ごとの担当講師・定員は管理画面（chadoSaturdaySessionsコレクション）で設定する。

import type { ChadoKyoshitsuClass } from "@/types";

export const CHADO_CLASSES: ChadoKyoshitsuClass[] = ["土曜日", "木曜日", "日曜日"];

// 固定の担当講師（土曜日は交代制のため含まない）
export const CHADO_FIXED_TEACHERS: Partial<Record<ChadoKyoshitsuClass, string>> = {
  "木曜日": "阿部宗亜先生",
  "日曜日": "郷田家元教授",
};

export const CHADO_CLASS_TIME: Record<ChadoKyoshitsuClass, string> = {
  "土曜日": "月2回・午前／午後より選択",
  "木曜日": "15:00〜17:00",
  "日曜日": "10:00〜12:00",
};

export const CHADO_SATURDAY_DEFAULT_CAPACITY = 3;
