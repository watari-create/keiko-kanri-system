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

export interface EnrollGroupConfig {
  key: string;
  title: string; // Firestore上の group 名と一致させる
  amounts: { subscription: string; onetime: string };
  links: { subscription: string; onetime: string };
  fields: EnrollField[];
}

export const ENROLL_GROUPS: Record<string, EnrollGroupConfig> = {
  gmadam: {
    key: "gmadam",
    title: "Gマダムの茶の湯講座",
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
  meigetsu: {
    key: "meigetsu",
    title: "名月会",
    amounts: { subscription: "¥12,000", onetime: "¥15,000" },
    links: {
      subscription: "https://checkout.square.site/merchant/MLX6H1BZAD14K/checkout/63FIWTMF4GKEBR35VEPGHC2A",
      onetime: "https://checkout.square.site/merchant/MLX6H1BZAD14K/checkout/INUH7BL7UTWK5JCBJEMFWR2I",
    },
    fields: [
      { id: "name", label: "お子様のお名前", type: "text", placeholder: "山田 太郎", required: true },
      { id: "nameKana", label: "お子様のお名前（フリガナ）", type: "text", placeholder: "ヤマダ タロウ", required: true },
      { id: "birthDate", label: "生年月日", type: "date" },
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
};

// 会員番号の自動採番の開始値。firestore.rules 側の counters/members 検証と対にしてある。
// 実際の現行の最大会員番号が変わった場合は、両方を合わせて更新すること。
export const MEMBER_COUNTER_START = 30000070;
