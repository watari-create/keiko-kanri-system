// 許状申請の料金表（技術仕様書に対応）。
// fee = 申請料＋御礼の合計、rei = そのうち御礼（宗里宗匠）分。

export interface LicenseFee {
  name: string;
  rank: string;
  fee: number;
  rei: number;
}

export const LICENSE_FEES: LicenseFee[] = [
  { name: "入門", rank: "", fee: 0, rei: 0 },
  { name: "名月点", rank: "準会員Ⅱ", fee: 7000, rei: 7000 },
  { name: "風炉薄茶点前", rank: "準会員Ⅱ", fee: 7000, rei: 7000 },
  { name: "炭点前", rank: "準会員Ⅱ", fee: 7000, rei: 7000 },
  { name: "丸香台", rank: "準会員Ⅱ", fee: 7000, rei: 7000 },
  { name: "長板", rank: "準会員Ⅱ", fee: 7000, rei: 7000 },
  { name: "風炉濃茶点前", rank: "準会員Ⅱ", fee: 8000, rei: 8000 },
  { name: "唐物", rank: "準会員Ⅰ", fee: 10000, rei: 8000 },
  { name: "盆点", rank: "普通会員", fee: 20000, rei: 0 },
  { name: "台天目", rank: "普通会員", fee: 25000, rei: 0 },
  { name: "真台子", rank: "普通会員", fee: 40000, rei: 0 },
  { name: "命名", rank: "普通会員", fee: 100000, rei: 0 },
  { name: "庵名", rank: "普通会員", fee: 100000, rei: 0 },
  { name: "教授補", rank: "普通会員", fee: 70000, rei: 0 },
  { name: "教授職", rank: "正会員", fee: 100000, rei: 0 },
];


// "YYYY-MM" 形式の年月を「2026年9月」のような表示用文字列に変換する。
// 許状申請の申請月（issueMonth）・会員の茶歴（licenseHistory）の両方で使う。
export function formatYearMonth(value?: string): string {
  if (!value) return "";
  const [y, m] = value.split("-");
  if (!y || !m) return value;
  return `${y}年${parseInt(m, 10)}月`;
}
