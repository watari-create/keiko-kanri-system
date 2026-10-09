// 稽古管理システム データモデル
// 技術仕様書（4. データモデル設計）に対応

export type MemberStatus = "在籍" | "休会" | "退会";
export type PaymentMethod = "月謝" | "都度払い";
export type Rsvp = "出席" | "欠席" | "未回答";

export type GroupCategory = "宗徧流稽古" | "本部稽古" | "UCI";

// 茶道教室の曜日クラス（土曜日は月2回・午前午後の定員制、木曜日・日曜日は毎週・人数上限なし）
// 「日曜日」は日曜日の午前クラス（10:00〜12:00、既存データ互換のため値は据え置き）、「日曜日午後」は13:00〜15:00
export type ChadoKyoshitsuClass = "土曜日" | "木曜日" | "日曜日" | "日曜日午後";

// 茶道教室のクラス台帳（chadoClassLedger コレクション、doc id = 曜日クラス）。lib/chadoClassLedger.ts を参照
export type ChadoStage = "入門" | "風炉薄茶点前";
// 茶道教室の新規募集クラス（chadoRecruitClasses コレクション）。管理画面の「＋ 新規クラスを作成して募集」で作成し、
// 受付中（accepting）のクラスだけが入会フォーム（/enroll）の「ご希望のクラス」に表示される。
export interface ChadoRecruitClass {
  id: string;
  name: string; // クラス名（例：2027年1月期 土曜日クラス）
  weekday: string; // 曜日（例：土曜日）
  timeStart: string; // "HH:MM"
  timeEnd: string; // "HH:MM"
  teacher: string; // 講師
  startDate: string; // 開始日 "YYYY-MM-DD"
  schedule: string; // 日程（自由記述。例：1/10, 2/14, 3/14 …）
  capacity: number | null; // 定員（null = 上限なし）
  monthlyFee: number; // 月謝（円）
  paymentLink: string; // 月謝のSquare決済リンク（空なら「本部よりご案内」）
  note: string; // 入会フォームに表示する案内（任意）
  accepting: boolean; // 受付中
  createdAt?: unknown;
}

export interface ChadoClassLedgerEntry {
  id: ChadoKyoshitsuClass;
  startMonth: string; // 期の開始月（"YYYY-MM"、未設定は ""）
  stage: ChadoStage; // 期として現在取り組んでいる段階
  capacity: number | null; // 定員（null = 上限なし。土曜日は開催日ごとの枠定員とは別の、クラス全体の目安）
  accepting: boolean; // 入会受付中か（オンのクラスだけが /enroll の「ご希望のクラス」に表示される）
}

export interface Member {
  id: string; // Firestore document ID = 会員番号
  name: string;
  nameKana?: string; // 氏名（フリガナ）
  sotomei?: string; // 宗名
  branch?: string; // 支部
  subGroup?: string; // 組（雪月花内の雪組・月組・花組など。他の会では未使用）
  shachu?: string; // 社中（代表・師匠にあたる会員名。社中代表を師匠として扱う運用）
  age?: number; // 年齢
  birthDate?: string; // YYYY-MM-DD
  guardian?: string; // 保護者名（未成年会員のみ）
  guardianKana?: string;
  gender?: "男性" | "女性"; // 性別（現在は名月会の入会フォームでのみ収集。入門セット在庫の自動減算に使う）
  grade?: string; // 学年（未成年会員のみ）
  occupation?: string; // ご職業
  affiliation?: string; // 現在の所属（学校名・勤務先など、名月会のみ）
  isTestAccount?: boolean; // テスト・確認用のダミー会員（経理タブの集計からは除外する）
  otherLessons?: string; // 他のお稽古事
  healthNotes?: string; // アレルギーなど健康上の留意点
  emergencyContact?: string;
  expectations?: string; // お稽古に期待すること（入会時アンケート）
  group: string; // 所属する会（例：名月会、雪月花）
  groupCategory: GroupCategory;
  license?: string; // 許状段階
  // 茶歴（許状の取得履歴）。キーは許状名（LICENSE_FEESのnameと一致）、値は取得年月（"YYYY-MM"）。
  // 本部稽古のみで使用。許状申請が「完了」になると自動で追記される。
  licenseHistory?: Record<string, string>;
  joinDate: string; // YYYY-MM-DD
  status: MemberStatus;
  paymentMethod?: PaymentMethod; // 本部稽古のみ
  // 会員ごとの個別のお月謝（都度払いの場合は1回あたり）。未設定（またはnull）の場合は会の標準額（lib/memberFees.ts）を使う。
  // ご家族割引や、標準額の決まっていない宗徧流稽古の会などで設定する。
  monthlyFee?: number | null;
  paymentStatus?: "済" | "未納";
  nextBillingDate?: string;
  rsvp?: Rsvp;
  chadoClass?: ChadoKyoshitsuClass; // 茶道教室のみ。曜日クラス（土曜日／木曜日／日曜日〈午前〉／日曜日午後）
  chadoMonthlyQuota?: 1 | 2; // 茶道教室・土曜日クラスのみ。月の予約可能回数（未設定時は1回として扱う）
  chadoMakeupTickets?: number; // 茶道教室・土曜日クラスのみ。欠席時に付与される振替チケットの残数（未設定時は0枚として扱う）
  rsvpByDate?: Record<string, "出席" | "欠席">; // マイページの出欠回答を、お稽古日（YYYY-MM-DD）ごとに記録したもの（木曜日・日曜日クラスの開催日表示用）
  chadoCohortId?: string; // 茶道教室のみ。新規募集クラス（chadoRecruitClasses のdoc id）から入会した場合の所属クラス
  lineUserId?: string; // 公式LINEアカウントと連携した際のLINEユーザーID（Cloud Functions経由で設定）
  // お月謝のカード自動払い（Square）の申込みボタンをマイページに表示するか。未設定なら、入会日が
  // SQUARE_BILLING_FROM（functions側の設定）以降の会員にだけ表示する。true＝表示、false＝表示しない、null／未設定＝入会日で自動判定。
  squareBillingAllowed?: boolean | null;
  // 決済リンク（従来のSquareサブスク）の旧契約を、本部がSquareのダッシュボードで解約したか（切り替え会員の管理用）
  legacySquareCanceled?: boolean;
  lastAttended?: string;
  // 出席簿：会計年度の月（例："2026-04"）ごとの出欠記録
  attendance?: Record<string, "出席" | "欠席">;
  // 入会金の入金状況（名月会のみ対象、一律¥33,000。経理タブで管理）
  entryFeeStatus?: "済" | "未納";
  // 都度払い会員の、出席した月ごとの月謝入金状況（キーはattendanceと同じ会計年度の月）。経理タブで管理
  sessionPayments?: Record<string, "済" | "未納">;
  email: string;
  phone?: string;
  address?: string;
  authUid?: string; // Firebase AuthのUIDと紐づけ（ログイン後に設定）
  // ご家族の会員番号（双方向）。本部が管理画面で既存会員同士を連携するか、
  // 入会申し込み時に既存の家族会員の会員番号・メールアドレスが一致した場合に自動で設定される。
  // マイページの「家族を切り替える」機能はこのリストを参照する。
  linkedMemberIds?: string[];
}

// LINE公式アカウントからの送信履歴（プッシュ・マルチキャストのみ。応答メッセージは対象外）。
// LINE Official Account ManagerのチャットBoxには、応答モード「Bot」時はAPI経由の送信内容が
// 表示されないため、こちら側で記録して後から確認できるようにしている。
export interface LineMessageLog {
  id: string;
  memberId: string;
  memberName: string;
  group: string;
  message: string;
  kind: "予約リマインド" | "出欠リマインド" | "一斉送信";
  sentBy?: string; // 一斉送信のときの送信者（スタッフ名／本部のメールアドレス）。リマインドは未設定
  sentAt: string; // ISO日時
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
  | "発行手続き中"
  | "発行済"
  | "お渡し済"
  | "完了"
  | "取消";

// 管理画面・講師画面で許状申請のステータスバッジに表示する絵文字。
export const LICENSE_STATUS_EMOJI: Record<LicenseStatus, string> = {
  "受付": "📨",
  "請求書発行依頼": "📄",
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
  // 経理タブ用の入金確認（許状の進行ステータスとは独立して経理側で管理する）
  accountingPaymentStatus?: "済" | "未納";
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

// ---- G1（Gマダムの茶の湯講座）発送物リスト ----
// meta/g1ShippingDoc に保存する、編集可能な表形式のドキュメント。
// 道具・消耗品・発送チェックリストなど、性質の異なる複数の表を
// 汎用的な「見出し行＋データ行」の構造で表現している。
// Firestoreは配列の中に配列を直接ネストできない（invalid nested entity）ため、
// 各行を { cells: [...] } という形でオブジェクトに包んでいる。
export interface G1ShippingRow {
  cells: string[];
}

export interface G1ShippingSection {
  id: string;
  title: string;
  headers: string[];
  rows: G1ShippingRow[];
}

export interface G1ShippingDoc {
  sections: G1ShippingSection[];
  updatedAt?: string;
  updatedBy?: string;
}

// 発送記録（アーカイブ）。発送チェックリストを実際の発送のたびに記入して保存したもの。
// g1ShippingLogs コレクションの1件が1回の発送に対応する。
// items はテンプレート（G1ShippingSection "page3-checklist"）の内容をその時点でコピーしたスナップショット。
export interface G1ShippingLogItem {
  name: string;
  qty: string;
  note: string;
  sent: boolean;
  returned: boolean;
}

export interface G1ShippingLog {
  id: string;
  date: string; // 発送日（YYYY-MM-DD想定、自由入力）
  preparedBy: string;
  items: G1ShippingLogItem[];
  createdAt: string;
  updatedAt?: string;
}

// ---- 名月会 入門セット在庫管理 ----
// meta/nyumonSetInventory に保存する、入門セット（扇子・懐紙・服紗など）の残数。
// items は「品名 → 残数」のマップ（品目を増減しても型を変えずに対応できるようにしている）。
// 名月会で新規入門があるたびに、Cloud Functions（onMemberCreated）が items の全品目を
// 自動的に1ずつ減らす（0未満にはしない。0になった品目はSlack通知で在庫不足として知らせる）。
export interface NyumonSetInventory {
  items: Record<string, number>;
  updatedAt?: string;
  updatedBy?: string;
}

// ---- お稽古ノート（茶道教室：土曜日・日曜日・火曜日クラスの記録） ----
export interface KeikoNoteToriawaseItem {
  label: string;
  value: string;
}

export interface KeikoNoteVideo {
  label: string;
  url: string;
  caption?: string;
}

export type KeikoNoteBlock =
  | { type: "text"; text: string }
  | { type: "section"; title?: string; text: string }
  | { type: "bullets"; title?: string; items: string[] }
  | { type: "tools"; title?: string; items: { name: string; desc: string }[] }
  | { type: "toriawase"; title?: string; items: KeikoNoteToriawaseItem[] }
  | { type: "link"; label: string; url: string }
  | { type: "videos"; title?: string; emphasize?: boolean; items: KeikoNoteVideo[] }
  | {
      type: "videoGroup";
      title?: string;
      groups: { title?: string; note?: string; variants: { label: string; url: string }[] }[];
    };

export type KeikoNoteBlockType = KeikoNoteBlock["type"];

export interface KeikoNoteClass {
  id: string;
  main: string; // 例：土曜日クラス
  sub: string; // 例：風炉薄茶平点前
}

// 1件のお稽古記録。シンプルフォーム（topic/tools/notes/video(s)）と
// ブロック編集（blocks）のどちらの形式も持ちうる（blocksがあればそちらを優先表示）。
export interface KeikoNoteEntry {
  id: string;
  classId: string;
  date: string; // YYYY-MM-DD
  title?: string;
  teacher?: string;
  toriawase?: KeikoNoteToriawaseItem[];
  topic?: string;
  tools?: string;
  notes?: string;
  content?: string;
  video?: KeikoNoteVideo;
  videos?: KeikoNoteVideo[];
  blocks?: KeikoNoteBlock[];
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// ---- 茶道教室：土曜日クラスの予約枠（月2回開催、午前・午後の2枠、各枠定員3名） ----
// 木曜日・日曜日クラスは1枠のみ・人数上限なしのため、既存のrsvp/attendanceで管理する。
// 土曜日クラスのみ、この専用コレクション（chadoSaturdaySessions、doc id = 開催日）で予約状況を管理する。
export interface ChadoSaturdayBooking {
  memberId: string;
  memberName: string;
  bookedAt: string;
  usedTicket?: boolean; // この予約が振替チケットを消費して確保されたもの（月の通常予約可能回数を超えた分）かどうか
  attended?: "出席" | "欠席"; // 本部が開催後に記録する出欠。「欠席」にすると振替チケットが1枚付与される
}

export interface ChadoSaturdaySession {
  id: string; // 開催日（YYYY-MM-DD）。Firestoreのドキュメント名と一致
  date: string; // YYYY-MM-DD
  amTeacher?: string; // 午前の担当講師（交代制のため開催日ごとに管理画面で設定）
  pmTeacher?: string; // 午後の担当講師
  amCapacity: number; // 午前枠の定員（デフォルト3）
  pmCapacity: number; // 午後枠の定員（デフォルト3）
  amBookings: ChadoSaturdayBooking[];
  pmBookings: ChadoSaturdayBooking[];
}

// 茶道教室：生徒ごとの進捗申し送り（講師間・本部との引き継ぎ用の内部メモ。
// お稽古のたびに1件ずつ記録する時系列ログで、生徒本人には見せない）。
export interface ChadoStudentNote {
  id: string;
  memberId: string;
  memberName: string; // 一覧表示用に非正規化して保持
  date: string; // お稽古日（YYYY-MM-DD）
  body: string;
  authorName: string; // 記入者名（講師名、本部の場合は「本部」）
  createdAt: string; // ISO日時（記入日時。同じdateが複数あっても記入順が分かるように）
}
