// 公開の入会フォーム（/enroll）で使う、会ごとの入力項目・料金・Square決済リンクの設定。
// もともとはモックアップ（マイページ.html）にハードコードされていた内容を移植したもの。
// 会や料金が変わったときは、このファイルだけを更新すればよい。

export type EnrollFieldType = "text" | "email" | "tel" | "date" | "select";

export interface EnrollField {
  id: string; // Memberドキュメントに保存する際のキー（paymentMethodのみ特別扱い）
  label: string;
  type: EnrollFieldType;
  placeholder?: string;
  options?: string[]; // type === "select" のとき
  required?: boolean;
}

// 会ごとの入会ページ上部の案内文（任意）。「入会の手引き」等の事前配布物への
// ダウンロードリンクをまとめて表示するのに使う。設定しない会には何も表示されない。
export interface EnrollGroupNotice {
  body: string; // 改行込みの案内文（\nで改行）
  guideUrl: string; // 「入会の手引き」等のダウンロードリンク（Dropbox/Google Driveの共有URLなど）
  guideLabel?: string; // ダウンロードボタンの文言。省略時は「入会の手引きをダウンロード」
}

export interface EnrollGroupConfig {
  key: string;
  title: string; // Firestore上の group 名と一致させる（会員データの group フィールドに使うため変更しないこと）
  label?: string; // 入会ページの選択肢に表示する名称。省略時は title を表示する（例：表示だけ「G1マダムの茶の湯講座」としたい場合に使う）
  amounts: { subscription: string; onetime: string };
  links: { subscription: string; onetime: string };
  fields: EnrollField[];
  notice?: EnrollGroupNotice;
}

export const ENROLL_GROUPS: Record<string, EnrollGroupConfig> = {
  meigetsu: {
    key: "meigetsu",
    title: "名月会",
    amounts: { subscription: "¥12,000", onetime: "¥15,000" },
    links: {
      subscription: "https://checkout.square.site/merchant/MLX6H1BZAD14K/checkout/63FIWTMF4GKEBR35VEPGHC2A",
      onetime: "https://checkout.square.site/merchant/MLX6H1BZAD14K/checkout/INUH7BL7UTWK5JCBJEMFWR2I",
    },
    notice: {
      body:
        "この度は名月会にご興味お持ちいただきありがとうございます。\n" +
        "下記の入会申込フォームより、入会手続きを行っていただきますようお願いいたします。\n" +
        "入会の前に、下記より「入会の手引き」をダウンロードいただき、必ずお読みください。",
      guideUrl:
        "https://www.dropbox.com/scl/fi/hghqn5u0v7725b5h6yf7k/2025ver.pdf?rlkey=th6jyc9t5u6luqqdfr1vehr3n&st=0gbgwirb&dl=1",
      guideLabel: "入会の手引きをダウンロード",
    },
    fields: [
      { id: "name", label: "お子様のお名前", type: "text", placeholder: "山田 太郎", required: true },
      { id: "nameKana", label: "お子様のお名前（フリガナ）", type: "text", placeholder: "ヤマダ タロウ", required: true },
      { id: "birthDate", label: "生年月日", type: "date" },
      {
        id: "gender",
        label: "性別",
        type: "select",
        options: ["男の子", "女の子"],
        required: true,
      },
      { id: "grade", label: "学年", type: "text", placeholder: "小学3年生" },
      { id: "otherLessons", label: "他のお稽古事", type: "text" },
      { id: "healthNotes", label: "アレルギーなど健康上の留意点", type: "text" },
      { id: "guardian", label: "保護者氏名", type: "text", required: true },
      { id: "guardianKana", label: "保護者氏名（フリガナ）", type: "text" },
      { id: "email", label: "メールアドレス", type: "email", required: true },
      { id: "phone", label: "電話番号", type: "tel", required: true },
      { id: "address", label: "ご住所", type: "text" },
      { id: "emergencyContact", label: "緊急連絡先", type: "tel" },
      { id: "expectations", label: "お稽古に期待すること", type: "text" },
      {
        id: "paymentMethod",
        label: "お支払い方法",
        type: "select",
        options: ["月謝（自動払い）", "都度払い"],
        required: true,
      },
    ],
  },
  gmadam: {
    key: "gmadam",
    title: "Gマダムの茶の湯講座",
    label: "G1マダムの茶の湯講座",
    amounts: { subscription: "¥20,000", onetime: "¥20,000" },
    links: {
      subscription: "https://square.link/u/PdnF0sNj",
      onetime: "https://square.link/u/PdnF0sNj",
    },
    fields: [
      { id: "name", label: "氏名", type: "text", placeholder: "山田 花子", required: true },
      { id: "nameKana", label: "氏名（フリガナ）", type: "text", placeholder: "ヤマダ ハナコ", required: true },
      { id: "birthDate", label: "生年月日", type: "date" },
      { id: "email", label: "メールアドレス", type: "email", placeholder: "example@mail.com", required: true },
      { id: "phone", label: "電話番号", type: "tel", placeholder: "090-0000-0000", required: true },
      { id: "address", label: "ご住所", type: "text" },
      { id: "occupation", label: "ご職業", type: "text" },
      {
        id: "paymentMethod",
        label: "お支払い方法",
        type: "select",
        options: ["月謝（自動払い）", "都度払い"],
        required: true,
      },
    ],
  },
};

// マイページの出欠登録で、都度払いの会員が「出席する」を押したときに開く
// Squareの決済リンクを、会員の group（Firestore上の値、= 上のtitle）から逆引きする。
// 対応するSquareリンクが設定されていない会（茶道教室など）の場合は undefined を返す。
export function getOnetimeLinkForGroup(groupTitle: string): string | undefined {
  const config = Object.values(ENROLL_GROUPS).find((g) => g.title === groupTitle);
  return config?.links.onetime;
}

// 会員番号の自動採番の開始値。firestore.rules 側の counters/members 検証と対にしてある。
// 実際の現行の最大会員番号が変わった場合は、両方を合わせて更新すること。
// 2026-09-11: counters/membersドキュメントが存在しない状態でテスト入会が行われ、
// 既存の会員（30000070）が上書きされる事故があったため、実際の最大会員番号（30000071）
// より後ろの30000073から始まるよう修正した。
export const MEMBER_COUNTER_START = 30000073;
