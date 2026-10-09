// 「次回のお稽古」表示用のユーティリティ。
// 実データは Cloud Functions（syncNextLessonDates）が本部の共有Googleカレンダーから
// 30分ごとに読み取り、meta/nextLessonDates ドキュメントに書き込んでいる。
// 各画面はそのドキュメントを onSnapshot で購読するだけでよい。

export interface NextLessonInfo {
  date: string; // 終日予定なら "YYYY-MM-DD"、時刻指定なら ISO日時（管理画面で日程変更していれば変更後）
  title: string;
  place?: string; // 開催場所（管理画面で変更した場所、なければカレンダーの「場所」欄）
  eventId?: string; // Googleカレンダーの予定ID
  originalDate?: string; // 管理画面で日程変更した場合の元の日付（YYYY-MM-DD）
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
    .map(
      ({ label, info }) =>
        (label ? `${label} ` : "") + formatLessonDate(info.date) + (info.place ? `（${info.place}）` : "")
    )
    .join("／");
}

// 管理画面の「日程・場所の変更」用：会の今後のお稽古（meta/nextLessonDates.upcoming）を一覧にする。
// 日曜日の午前・午後のように1つの予定を複数クラスで兼ねる場合は1行にまとめ、クラス名を並べる。
export function upcomingLessonsForGroup(
  upcoming: Record<string, NextLessonInfo[]> | undefined,
  group: string
): { labels: string[]; info: NextLessonInfo }[] {
  if (!upcoming) return [];
  const keys =
    group === "茶道教室"
      ? CHADO_NEXT_LESSON_CLASSES.map((c) => ({ key: nextLessonKey(group, c), label: `${CHADO_NEXT_LESSON_LABEL[c] ?? c}クラス` }))
      : [{ key: group, label: "" }];
  const byEvent = new Map<string, { labels: string[]; info: NextLessonInfo }>();
  for (const { key, label } of keys) {
    for (const info of upcoming[key] ?? []) {
      const id = info.eventId ?? `${key}-${info.date}`;
      const row = byEvent.get(id) ?? { labels: [], info };
      if (label && !row.labels.includes(label)) row.labels.push(label);
      byEvent.set(id, row);
    }
  }
  return Array.from(byEvent.values()).sort((a, b) => a.info.date.localeCompare(b.info.date));
}
