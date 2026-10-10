// 会の設定（料金・入会の申し込み・会の発足／削除）。
//
// Firestore の groupSettings/{会の名前} に保存し、管理画面の「会の設定」タブから変更する。
// ドキュメントがまだ無い会は、下の DEFAULT_GROUP_SETTINGS（2026-10-09時点の金額・設定）を使う。
// 管理画面で一度保存すると、その会はFirestoreの値が優先される。
//
// サーバー側（カード自動払い・都度払いの支払いページ・入会金の請求書）は
// functions/src/groupSettings.ts が同じドキュメントを読む。既定値を変えるときは両方を合わせること。
// 公開の入会フォームの受付可否は firestore.rules でも同じドキュメントを見て判定している。

import { useSyncExternalStore } from "react";
import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { ENROLL_GROUPS, type EnrollField } from "@/lib/enrollGroups";

export type GroupArea = "本部稽古" | "宗徧流稽古" | "UCI";

// 運用ルールの「記入用テンプレート」から発足した会の登録シート（会の設定タブの会の一覧「登録シート」に表示）
export type SheetRow = { label: string; value: string };
export interface RegistrationSheet {
  staff: SheetRow[];
  settings: SheetRow[];
  common: SheetRow[];
}
export const GROUP_AREAS: GroupArea[] = ["本部稽古", "宗徧流稽古", "UCI"];

export interface GroupSetting {
  name: string; // Firestore上の group の値（＝ドキュメントID）。会員データと結びつくため発足後は変更不可
  displayName: string; // 画面・通知に出す名前（例：G1マダムの茶の湯講座）
  area: GroupArea;
  order: number; // 並び順（小さいほど先）
  active: boolean; // false＝削除済み（タブ・入会フォーム・名簿の選択肢から外す。会員データは残る）
  hasGuardian: boolean; // 保護者欄を使うか（未成年向けの会）

  // ---- 料金 ----
  monthlyFee: number | null; // お月謝（月額）。茶道教室は月1回プラン
  monthlyFeeTwice: number | null; // 月2回プラン（茶道教室・土曜日クラス）。使わない会は null
  sessionFee: number | null; // 都度払い（1回あたり）。使わない会は null
  entryFee: number | null; // 入会金（初回のみ）。なしは null
  entryFeeNote: string; // 入会金の内訳の説明（入会フォーム・請求書に表示）
  cardAutoPay: boolean; // お月謝のカード自動払い（毎月25日に翌月分）の対象か

  // ---- 入会の申し込み（/enroll） ----
  enrollOpen: boolean; // 受付中か
  enrollKey: string; // 入会ページのURL（/enroll?group=○○）に使う英字の識別子
  allowSessionPay: boolean; // 入会フォームで「都度払い」を選べるか
  subscriptionLink: string; // カード自動払いを使わないときに表示するSquareの決済リンク（任意）
  enrollNotice: string; // 入会ページ上部の案内文
  guideUrl: string; // 入会の手引きのリンク
  guideLabel: string; // そのボタンの文言
  enrollFields: EnrollField[]; // 入力項目（お支払い方法は allowSessionPay から自動で付く）

  registrationSheet?: RegistrationSheet; // 記入用テンプレートから発足した会のみ
  registrationText?: string; // 発足時に貼り付けた記入内容（原文）
  legacyLink?: boolean; // 決済リンク（従来のSquareサブスク）を使っていた会か（サーバー側の切り替え処理用・画面では編集しない）
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// 入会フォームの標準項目。ここにある id は会員データの同名の項目に保存される。
// それ以外の項目（管理画面で追加した独自の項目）は会員データの enrollAnswers に「項目名：回答」で保存する。
export const STANDARD_ENROLL_FIELDS: EnrollField[] = [
  { id: "name", label: "氏名", type: "text", placeholder: "山田 花子", required: true },
  { id: "nameKana", label: "氏名（フリガナ）", type: "text", placeholder: "ヤマダ ハナコ", required: true },
  { id: "birthDate", label: "生年月日", type: "date" },
  { id: "gender", label: "性別", type: "select", options: ["女性", "男性"], required: true },
  { id: "grade", label: "学年", type: "text", placeholder: "小学3年生" },
  { id: "affiliation", label: "現在の所属（学校名・勤務先など）", type: "text" },
  { id: "occupation", label: "ご職業", type: "text" },
  { id: "otherLessons", label: "他のお稽古事", type: "text" },
  { id: "healthNotes", label: "アレルギーなど健康上の留意点", type: "text" },
  { id: "guardian", label: "保護者氏名", type: "text" },
  { id: "guardianKana", label: "保護者氏名（フリガナ）", type: "text" },
  { id: "email", label: "メールアドレス", type: "email", placeholder: "example@mail.com", required: true },
  { id: "phone", label: "電話番号", type: "tel", placeholder: "090-0000-0000", required: true },
  { id: "address", label: "ご住所", type: "text" },
  { id: "emergencyContact", label: "緊急連絡先", type: "tel" },
  { id: "expectations", label: "お稽古に期待すること", type: "text" },
];
export const STANDARD_FIELD_IDS = STANDARD_ENROLL_FIELDS.map((f) => f.id);
// 必ず入れておく項目（会員番号の発行・ログインに必要）
export const LOCKED_FIELD_IDS = ["name", "email"];
// 茶道教室のクラス選択（選択肢はクラス台帳・新規募集クラスから自動で入る）
export const CHADO_CLASS_FIELD_ID = "chadoClass";

const withoutPayment = (fields: EnrollField[]) => fields.filter((f) => f.id !== "paymentMethod");

function base(p: Partial<GroupSetting> & Pick<GroupSetting, "name" | "area" | "order">): GroupSetting {
  return {
    displayName: p.name,
    active: true,
    hasGuardian: true,
    monthlyFee: null,
    monthlyFeeTwice: null,
    sessionFee: null,
    entryFee: null,
    entryFeeNote: "",
    cardAutoPay: false,
    enrollOpen: false,
    enrollKey: "",
    allowSessionPay: false,
    subscriptionLink: "",
    enrollNotice: "",
    guideUrl: "",
    guideLabel: "",
    enrollFields: [],
    legacyLink: false,
    ...p,
  };
}

const ADULT_FIELDS = ["name", "nameKana", "birthDate", "gender", "email", "phone", "address", "occupation"].map(
  (id) => STANDARD_ENROLL_FIELDS.find((f) => f.id === id)!
);

export const DEFAULT_GROUP_SETTINGS: GroupSetting[] = [
  base({
    name: "名月会",
    area: "本部稽古",
    order: 10,
    hasGuardian: true,
    monthlyFee: 12000,
    sessionFee: 15000,
    entryFee: 33000,
    entryFeeNote: "名月会の入会金です。",
    cardAutoPay: true,
    enrollOpen: true,
    enrollKey: "meigetsu",
    allowSessionPay: true,
    subscriptionLink: ENROLL_GROUPS.meigetsu.links.subscription,
    enrollNotice: ENROLL_GROUPS.meigetsu.notice?.body ?? "",
    guideUrl: ENROLL_GROUPS.meigetsu.notice?.guideUrl ?? "",
    guideLabel: ENROLL_GROUPS.meigetsu.notice?.guideLabel ?? "",
    enrollFields: withoutPayment(ENROLL_GROUPS.meigetsu.fields),
    legacyLink: true,
  }),
  base({
    name: "茶道教室",
    area: "本部稽古",
    order: 20,
    hasGuardian: false,
    monthlyFee: 15000,
    monthlyFeeTwice: 28000,
    entryFee: 15000,
    entryFeeNote: "入会費・宗徧会費・入門許状代・扇子代を含みます。",
    cardAutoPay: true,
    enrollOpen: true,
    enrollKey: "chado",
    subscriptionLink: "https://square.link/u/Mt9gZ51b",
    enrollNotice: ENROLL_GROUPS.chado.notice?.body ?? "",
    guideUrl: ENROLL_GROUPS.chado.notice?.guideUrl ?? "",
    guideLabel: ENROLL_GROUPS.chado.notice?.guideLabel ?? "",
    enrollFields: withoutPayment(ENROLL_GROUPS.chado.fields),
    legacyLink: false, // 茶道教室はSquareではない別の仕組みでお月謝を払っていた
  }),
  base({
    name: "Gマダムの茶の湯講座",
    displayName: "G1マダムの茶の湯講座",
    area: "本部稽古",
    order: 30,
    hasGuardian: false,
    monthlyFee: 20000,
    sessionFee: 20000,
    cardAutoPay: true,
    enrollOpen: true,
    enrollKey: "gmadam",
    allowSessionPay: true,
    subscriptionLink: ENROLL_GROUPS.gmadam.links.subscription,
    enrollFields: withoutPayment(ENROLL_GROUPS.gmadam.fields),
    legacyLink: true,
  }),
  base({
    name: "新月会",
    area: "本部稽古",
    order: 40,
    monthlyFee: 15000,
    cardAutoPay: true,
    enrollOpen: false, // 入会フォームは保留中
    enrollKey: "shingetsu",
    enrollFields: ADULT_FIELDS,
  }),
  base({ name: "雪月花", area: "宗徧流稽古", order: 110, monthlyFee: 35000, entryFee: 250000 }),
  base({ name: "一喝会", area: "宗徧流稽古", order: 120, monthlyFee: 35000, entryFee: 150000 }),
  base({ name: "星組", area: "宗徧流稽古", order: 130, monthlyFee: 35000, entryFee: 150000 }),
  base({ name: "不識会", area: "宗徧流稽古", order: 140, monthlyFee: 35000, entryFee: 250000 }),
  base({ name: "萌芽会", area: "宗徧流稽古", order: 150, monthlyFee: 15000 }),
  base({ name: "紅月会", area: "宗徧流稽古", order: 160, monthlyFee: 20000, entryFee: 30000 }),
  base({ name: "侘び数寄道", area: "UCI", order: 210 }),
];

// 新しく発足する会の初期値
export function newGroupSetting(name: string, area: GroupArea, order: number): GroupSetting {
  return base({
    name,
    area,
    order,
    enrollKey: "",
    enrollFields: ADULT_FIELDS,
    createdAt: new Date().toISOString(),
  });
}

/** 会の設定を保存する（groupSettings/{会の名前}） */
export async function saveGroupSetting(s: GroupSetting) {
  const { name, ...rest } = s;
  const clean = JSON.parse(JSON.stringify(rest)); // undefined を取り除く（Firestoreは undefined を保存できない）
  await setDoc(doc(db, "groupSettings", name), {
    ...clean,
    updatedAt: new Date().toISOString(),
    updatedBy: auth.currentUser?.email ?? "",
  });
}

// ---- Firestoreとの同期（アプリ全体で1つの購読を共有する） ----

let current: GroupSetting[] = DEFAULT_GROUP_SETTINGS;
let loaded = false;
let started = false;
const listeners = new Set<() => void>();

function merge(docs: Record<string, Partial<GroupSetting>>): GroupSetting[] {
  const byName = new Map<string, GroupSetting>();
  DEFAULT_GROUP_SETTINGS.forEach((d) => byName.set(d.name, d));
  Object.entries(docs).forEach(([id, data]) => {
    const def = byName.get(id) ?? base({ name: id, area: "本部稽古", order: 999 });
    byName.set(id, { ...def, ...data, name: id } as GroupSetting);
  });
  return [...byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ja"));
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  onSnapshot(
    collection(db, "groupSettings"),
    (snap) => {
      const docs: Record<string, Partial<GroupSetting>> = {};
      snap.docs.forEach((d) => (docs[d.id] = d.data() as Partial<GroupSetting>));
      current = merge(docs);
      loaded = true;
      listeners.forEach((l) => l());
    },
    (err) => {
      console.warn("会の設定（groupSettings）を読み込めませんでした。既定値を使います", err);
      loaded = true;
      listeners.forEach((l) => l());
    }
  );
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 会の設定一覧（Firestoreの更新で再描画される）。読み込み前は既定値を返す */
export function useGroupSettings(): GroupSetting[] {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_GROUP_SETTINGS);
}

/** Firestoreから読み込み済みか（入会フォームで既定値のまま送信しないために使う） */
export function useGroupSettingsLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded, () => false);
}

// ---- 同期的に参照するためのヘルパー（直近に読み込んだ値。画面側は useGroupSettings() で再描画させる） ----

export function allGroupSettings(): GroupSetting[] {
  start();
  return current;
}

export function groupSetting(name: string | undefined | null): GroupSetting | undefined {
  if (!name) return undefined;
  return allGroupSettings().find((g) => g.name === name);
}

/** エリアごとの稼働中の会（削除済みは除く） */
export function activeGroupsIn(area: GroupArea): string[] {
  return allGroupSettings()
    .filter((g) => g.area === area && g.active)
    .map((g) => g.name);
}

/** お月謝のカード自動払いの対象の会 */
export function cardAutoPayGroups(): string[] {
  return allGroupSettings()
    .filter((g) => g.cardAutoPay)
    .map((g) => g.name);
}
