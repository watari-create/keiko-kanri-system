// エリア（宗徧流稽古／本部稽古）とグループの対応。
// 許状申請の要否など、「スタッフの役割（世話人・講師）」ではなく
// 「担当グループがどちらのエリアか」で決まる仕様の判定に使う。
//
// 管理画面（admin/page.tsx）側のAREA_GROUPSと対になっているので、
// グループ構成を変える場合はそちらも合わせて確認すること。

export const HONBU_KEIKO_GROUPS = ["名月会", "茶道教室", "Gマダムの茶の湯講座"];
export const SOHENRYU_KEIKO_GROUPS = ["雪月花", "一喝会", "星組", "不識会", "萌芽会", "紅月会"];

// 本部稽古（名月会・茶道教室・Gマダムの茶の湯講座）のグループかどうか。
// 許状申請の提出・状況表示は、このエリアのグループでのみ行う
// （宗徧流稽古側は、スタッフの役割が「講師」であっても許状申請は対象外）。
export function isHonbuKeikoGroup(group: string): boolean {
  return HONBU_KEIKO_GROUPS.includes(group);
}
