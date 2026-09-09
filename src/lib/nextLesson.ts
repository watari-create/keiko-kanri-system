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
