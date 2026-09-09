// 稽古管理システム データモデル
// 技術仕様書（4. データモデル設計）に対応

export type MemberStatus = "在籍" | "休会" | "退会";
export type PaymentMethod = "月謝" | "都度払い";
export type Rsvp = "出席" | "欠席" | "未回答";

export type GroupCategory = "宗徧流稽古" | "本部稽古" | "UCI";

export interface Member {
  id: string; // Firestore document ID = 会員番号
  name: string;
  nameKana?: string; // 氏名（フリガナ）
  sotomei?: string; // 宗名
  birthDate?: string; // YYYY-MM-DD
  guardian?: string; // 保護者名（未成年会員のみ）
  guardianKana?: string;
  grade?: string; // 学年（未成年会員のみ）
  occupation?: string; // ご職業
  otherLessons?: string; // 他のお稽古事
  healthNotes?: string; // アレルギーなど健康上の留意点
  emergencyContact?: string;
  expectations?: string; // お稽古に期待すること（入会時アンケート）
  group: string; // 所属する会（例：名月会、雪月花）
  groupCategory: GroupCategory;
  license?: string; // 許状段階
  joinDate: string; // YYYY-MM-DD
  status: MemberStatus;
  paymentMethod?: PaymentMethod; // 本部稽古のみ
  paymentStatus?: "済" | "未納";
  nextBillingDate?: string;
  rsvp?: Rsvp;
  lastAttended?: string;
  // 出席簿：会計年度の月（例："2026-04"）ごとの出欠記録
  attendance?: Record<string, "出席" | "欠席">;
  email: string;
  phone?: string;
  address?: string;
  authUid?: string; // Firebase AuthのUIDと紐づけ（ログイン後に設定）
}

export type StaffRole = "sewanin" | "teacher";

export interface StaffAccount {
  id: string; // 会員番号
  name: string;
  role: StaffRole;
  groups: string[]; // 担当する会（複数可）
  email: string;
  authUid?: string;
}

export type LicenseStatus =
  | "受付"
  | "請求書発行依頼"
  | "請求書発行済"
  | "発行手続き中"
  | "発行済"
  | "お渡し済"
  | "完了"
  | "取消";

// 管理画面・講師画面で許状申請のステータスバッジに表示する絵文字。
export const LICENSE_STATUS_EMOJI: Record<LicenseStatus, string> = {
  "受付": "📨",
  "請求書発行依頼": "📄",
  "請求書発行済": "💰",
  "発行手続き中": "✍️",
  "発行済": "📜",
  "お渡し済": "🤝",
  "完了": "✅",
  "取消": "❌",
};

export interface LicenseRequest {
  id: string;
  memberId: string;
  memberName: string;
  group: string;
  licenseName: string;
  fee: number; // 申請料＋御礼の合計
  status: LicenseStatus;
  appliedDate: string;
  issueMonth?: string; // 許状に記載する月
  deliveryDate?: string; // お渡し予定日
  updatedAt?: string;
  updatedBy?: string; // 更新した人のUIDまたは会員番号
}

export type LeaveRequestType = "休会" | "退会" | "復会";

export interface LeaveRequest {
  id: string;
  memberId: string;
  memberName: string;
  group: string;
  type: LeaveRequestType;
  reason?: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface NotificationLogEntry {
  id: string;
  message: string;
  kind: "license_issued" | "leave_approved" | "new_enrollment";
  createdAt: string;
  read: boolean;
}

export interface PaymentEvent {
  id: string;
  memberId?: string;
  amount: number;
  squarePaymentId: string;
  receivedAt: string;
  matched: boolean;
}
