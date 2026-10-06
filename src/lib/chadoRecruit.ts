// 茶道教室の新規募集クラス（chadoRecruitClasses）関連のユーティリティ
import type { ChadoRecruitClass } from "@/types";

export const CHADO_WEEKDAYS = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"];
export const CHADO_TEACHER_CHOICES = ["郷田家元教授", "阿部宗亜先生", "郷田家元教授・阿部宗亜先生"];
export const CHADO_DEFAULT_MONTHLY_FEE = 15000;

// クラス名の自動案（開始日と曜日から「2027年1月期 土曜日クラス」）
export function suggestRecruitName(startDate: string, weekday: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(startDate);
  const ki = m ? `${m[1]}年${Number(m[2])}月期` : "";
  return [ki, weekday ? `${weekday}クラス` : ""].filter(Boolean).join(" ");
}

export function recruitTimeLabel(c: Pick<ChadoRecruitClass, "weekday" | "timeStart" | "timeEnd">): string {
  const t = c.timeStart || c.timeEnd ? `${c.timeStart}〜${c.timeEnd}` : "";
  return [c.weekday, t].filter(Boolean).join(" ");
}

export function formatYenNum(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}
