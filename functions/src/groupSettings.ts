/**
 * 会の設定（料金・カード自動払いの対象など）をサーバー側で読む。
 *
 * 管理画面の「会の設定」タブで変更した値は Firestore の groupSettings/{会の名前} に保存される。
 * ドキュメントがまだ無い会は、下の DEFAULTS（2026-10-09時点の金額）を使う。
 * 画面側の既定値は src/lib/groupSettings.ts。既定値を変えるときは両方を合わせること。
 *
 * 使い方：処理の最初に `await refreshGroupSettings()` を呼んでから、同期の参照関数（monthlyFeeStd など）を使う。
 * 読み込みは1分間キャッシュする。読み込めなかったときは直前の値（初回は既定値）を使う。
 */
import * as admin from "firebase-admin";

export interface ServerGroupSetting {
  name: string;
  displayName: string;
  area: string;
  active: boolean;
  monthlyFee: number | null;
  monthlyFeeTwice: number | null;
  sessionFee: number | null;
  entryFee: number | null;
  entryFeeNote: string;
  cardAutoPay: boolean;
  legacyLink: boolean; // 決済リンク（従来のSquareサブスク）を使っていた会
}

function def(p: Partial<ServerGroupSetting> & { name: string; area: string }): ServerGroupSetting {
  return {
    displayName: p.name,
    active: true,
    monthlyFee: null,
    monthlyFeeTwice: null,
    sessionFee: null,
    entryFee: null,
    entryFeeNote: "",
    cardAutoPay: false,
    legacyLink: false,
    ...p,
  };
}

const DEFAULTS: ServerGroupSetting[] = [
  def({
    name: "名月会",
    area: "本部稽古",
    monthlyFee: 12000,
    sessionFee: 15000,
    entryFee: 33000,
    entryFeeNote: "名月会の入会金です。",
    cardAutoPay: true,
    legacyLink: true,
  }),
  def({
    name: "茶道教室",
    area: "本部稽古",
    monthlyFee: 15000,
    monthlyFeeTwice: 28000,
    entryFee: 15000,
    entryFeeNote: "入会費・宗徧会費・入門許状代・扇子代を含みます。",
    cardAutoPay: true,
    legacyLink: false, // 茶道教室はSquareではない別の仕組みでお月謝を払っていた（2026-10-10 ゆちゃ）
  }),
  def({
    name: "Gマダムの茶の湯講座",
    displayName: "G1マダムの茶の湯講座",
    area: "本部稽古",
    monthlyFee: 20000,
    sessionFee: 20000,
    cardAutoPay: true,
    legacyLink: true,
  }),
  def({ name: "新月会", area: "本部稽古", monthlyFee: 15000, cardAutoPay: true }),
  def({ name: "雪月花", area: "宗徧流稽古", monthlyFee: 35000, entryFee: 250000 }),
  def({ name: "一喝会", area: "宗徧流稽古", monthlyFee: 35000, entryFee: 150000 }),
  def({ name: "星組", area: "宗徧流稽古", monthlyFee: 35000, entryFee: 150000 }),
  def({ name: "不識会", area: "宗徧流稽古", monthlyFee: 35000, entryFee: 250000 }),
  def({ name: "萌芽会", area: "宗徧流稽古", monthlyFee: 15000 }),
  def({ name: "紅月会", area: "宗徧流稽古", monthlyFee: 20000, entryFee: 30000 }),
  def({ name: "侘び数寄道", area: "UCI" }),
];

let cache: Map<string, ServerGroupSetting> = new Map(DEFAULTS.map((d) => [d.name, d]));
let loadedAt = 0;
const TTL_MS = 60 * 1000;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export async function refreshGroupSettings(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  try {
    const snap = await admin.firestore().collection("groupSettings").get();
    const next = new Map(DEFAULTS.map((d) => [d.name, d]));
    snap.docs.forEach((doc) => {
      const d = doc.data();
      const base = next.get(doc.id) ?? def({ name: doc.id, area: String(d.area ?? "本部稽古") });
      next.set(doc.id, {
        ...base,
        displayName: typeof d.displayName === "string" && d.displayName ? d.displayName : base.displayName,
        area: typeof d.area === "string" ? d.area : base.area,
        active: d.active !== false,
        monthlyFee: "monthlyFee" in d ? numOrNull(d.monthlyFee) : base.monthlyFee,
        monthlyFeeTwice: "monthlyFeeTwice" in d ? numOrNull(d.monthlyFeeTwice) : base.monthlyFeeTwice,
        sessionFee: "sessionFee" in d ? numOrNull(d.sessionFee) : base.sessionFee,
        entryFee: "entryFee" in d ? numOrNull(d.entryFee) : base.entryFee,
        entryFeeNote: typeof d.entryFeeNote === "string" ? d.entryFeeNote : base.entryFeeNote,
        cardAutoPay: typeof d.cardAutoPay === "boolean" ? d.cardAutoPay : base.cardAutoPay,
        legacyLink: base.legacyLink, // 画面では編集しない項目なので、コードの設定だけを使う
      });
    });
    cache = next;
    loadedAt = Date.now();
  } catch (err) {
    console.warn("会の設定（groupSettings）を読み込めませんでした。直前の値を使います", err);
  }
}

export function groupSettingOf(group: string | undefined | null): ServerGroupSetting | undefined {
  return group ? cache.get(group) : undefined;
}

/** お月謝のカード自動払いの対象の会か */
export function isCardAutoPayGroup(group: string | undefined | null): boolean {
  return !!groupSettingOf(group)?.cardAutoPay;
}

/** 決済リンク（従来のSquareサブスク）を使っていない会か（旧契約の検索・自動解約をしない） */
export function isNoLegacyLinkGroup(group: string | undefined | null): boolean {
  return !groupSettingOf(group)?.legacyLink;
}

/** 標準のお月謝（月額）。monthlyFeeTwice があり twice=true なら月2回プラン */
export function monthlyFeeStd(group: string | undefined | null, twice = false): number | null {
  const s = groupSettingOf(group);
  if (!s) return null;
  if (twice && s.monthlyFeeTwice != null) return s.monthlyFeeTwice;
  return s.monthlyFee;
}

/** 月2回プランのある会か（茶道教室） */
export function hasTwicePlan(group: string | undefined | null): boolean {
  return groupSettingOf(group)?.monthlyFeeTwice != null;
}

/** 都度払いの1回あたりの標準額 */
export function sessionFeeStd(group: string | undefined | null): number | null {
  return groupSettingOf(group)?.sessionFee ?? null;
}

/** 入会金（金額と内訳の説明）。入会金のない会は null */
export function entryFeeConf(group: string | undefined | null): { amount: number; note: string } | null {
  const s = groupSettingOf(group);
  if (!s || s.entryFee == null) return null;
  // 入会金を自動でいただく（カード登録時・支払いページ・請求書）のは本部稽古の会のみ。
  // 宗徧流稽古・UCIの会の入会金は名簿の表示用（入会の通知・入会金の「未納」設定が本部稽古の会のみのため）
  if (s.area !== "本部稽古") return null;
  return { amount: s.entryFee, note: s.entryFeeNote || `${s.displayName}の入会金です。` };
}

export function groupDisplayNameServer(group: string | undefined | null): string {
  if (!group) return "";
  return groupSettingOf(group)?.displayName || group;
}
