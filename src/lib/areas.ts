// エリア（宗徧流稽古／本部稽古／UCI）とグループの対応。
// 許状申請の要否など、「スタッフの役割（世話人・講師）」ではなく
// 「担当グループがどちらのエリアか」で決まる仕様の判定に使う。
//
// 会の一覧・表示名・保護者欄の有無は、管理画面の「会の設定」タブ（Firestore の groupSettings、
// 既定値は src/lib/groupSettings.ts）で管理する。ここはその値を引くための窓口。

import { activeGroupsIn, groupSetting } from "@/lib/groupSettings";

// 稼働中の会（削除済みは除く）。呼ぶたびに最新の設定を返す
export const honbuKeikoGroups = () => activeGroupsIn("本部稽古");
export const sohenryuKeikoGroups = () => activeGroupsIn("宗徧流稽古");
export const uciGroups = () => activeGroupsIn("UCI");

export function isUciGroup(group: string): boolean {
  return groupSetting(group)?.area === "UCI";
}

// 本部稽古のグループかどうか（削除済みの会も含む）。
// 許状申請の提出・状況表示は、このエリアのグループでのみ行う
// （宗徧流稽古側は、スタッフの役割が「講師」であっても許状申請は対象外）。
export function isHonbuKeikoGroup(group: string): boolean {
  return groupSetting(group)?.area === "本部稽古";
}

// 画面表示用のグループ名。
// Firestoreのgroupフィールドやクエリ条件・許可判定などの内部的な値はそのまま（例：「Gマダムの茶の湯講座」）にし、
// ユーザーの目に触れる表示（タブ・見出し・Slack通知文など）だけ表示名（例：「G1マダムの茶の湯講座」）に置き換える。
export function groupDisplayName(group: string): string {
  return groupSetting(group)?.displayName || group;
}

// 保護者欄（保護者名）の入力・表示を使うか。設定の無い会は使う（従来どおり）。
export function groupHasGuardianField(group: string): boolean {
  return groupSetting(group)?.hasGuardian ?? true;
}
