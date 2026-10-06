// 「次回のお稽古」表示用のユーティリティ。
// 実データは Cloud Functions（syncNextLessonDates）が本部の共有Googleカレンダーから
// 30分ごとに読み取り、meta/nextLessonDates ドキュメントに書き込んでいる。
// 各画面はそのドキュメントを onSnapshot で購読するだけでよい。

export interface NextLessonInfo {
  date: string; // 終日予定なら "YYYY-MM-DD"、時刻指定なら ISO日時
  title: string;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function formatLessonDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

// meta/nextLessonDates.dates のキー。茶道教室だけは木曜日・日曜日クラスで
// お稽古日が異なるため「茶道教室・木曜日」のようにクラスごとに分けて保存している
// （functions/src/index.ts の nextLessonKey と同じ規則）。
export function nextLessonKey(group: string, chadoClass?: string): string {
  return group === "茶道教室" && chadoClass ? `${group}・${chadoClass}` : group;
}

// 茶道教室のうち、次回のお稽古日を表示するクラス（土曜日クラスは予約制のため対象外）
export const CHADO_NEXT_LESSON_CLASSES = ["木曜日", "日曜日", "日曜日午後"] as const;
const CHADO_NEXT_LESSON_LABEL: Record<string, string> = { "日曜日": "日曜日午前" };

// 管理画面・スタッフ画面用：会単位で次回のお稽古を一覧にする。
// 茶道教室は木曜日・日曜日クラスをそれぞれ返す。
export function nextLessonsForGroup(
  dates: Record<string, NextLessonInfo> | undefined,
  group: string
): { label: string; info: NextLessonInfo }[] {
  if (!dates) return [];
  if (group === "茶道教室") {
    return CHADO_NEXT_LESSON_CLASSES.flatMap((c) => {
      const info = dates[nextLessonKey(group, c)];
      return info ? [{ label: `${CHADO_NEXT_LESSON_LABEL[c] ?? c}クラス`, info }] : [];
    });
  }
  const info = dates[group];
  return info ? [{ label: "", info }] : [];
}

export function formatNextLessons(list: { label: string; info: NextLessonInfo }[]): string {
  return list
    .map(({ label, info }) => (label ? `${label} ` : "") + formatLessonDate(info.date))
    .join("／");
}
