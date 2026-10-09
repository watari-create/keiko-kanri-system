"use client";

// 運用ルール（本部の管理画面「運用ルール」タブ）。
// 「お稽古の形態整理と新規開講ルール」と、記入用テンプレートに沿った現行の各会の登録シートを表示する。
// 内容は静的データ（下のSHEETS等）。担当者や料金が変わったら、このファイルを直接書き換えてpushする。

import { useMemo, useState } from "react";
import {
  newGroupSetting,
  saveGroupSetting,
  useGroupSettings,
  type GroupArea,
  type GroupSetting,
  type RegistrationSheet,
} from "@/lib/groupSettings";

type Row = [label: string, value: string];
type Sheet = {
  name: string;
  tab: string;
  staff: Row[];
  settings: Row[];
  common: Row[];
};

const TBD = "要確認";
const UPDATED = "2026年10月8日";

const MANUAL_STD =
  "本部：本部用操作マニュアル（Word）・本部員ガイド（PowerPoint）\n経理：本部用マニュアル 第4章「経理タブ」\n講師：名月会・G1マダム講師用ガイド（PowerPoint）\n生徒：マイページ利用ガイド（全会共通）";
const STAFF_SCREEN_STD =
  "会員名簿（会員番号・氏名・許状段階・支払い方法・ステータス）を閲覧専用で公開。氏名クリックで保護者名・メール・入会日を表示\n出席簿・許状履歴の確認、許状申請の提出";
const HONBU_FIXED: Row[] = [
  ["会員区分", "宗徧流の会員（宗徧会会員番号を発行する）"],
  ["名簿の管理方法", "オンライン入会フォーム"],
  ["名簿項目", "会員番号・氏名・保護者名・登録メールアドレス・入会日・支払い方法・ステータス"],
  ["出席管理", "あり（月次マトリクス）"],
  ["許状申請ワークフロー", "対象（6段階＋Slack通知連携）"],
];

const SHEETS: Sheet[] = [
  {
    name: "名月会",
    tab: "本部稽古タブ",
    staff: [
      ["指導者／主宰", "山田宗里"],
      ["責任者", "山田宗里"],
      ["その他講師", "卯月宗文、小嶋宗裕"],
      ["世話人", "なし"],
      ["会員管理", "和多利月子"],
      ["会員コミュニケーション者", "小嶋宗裕"],
      ["本部責任者（責任者が本部にいない場合）", "—"],
    ],
    settings: [
      ...HONBU_FIXED,
      ["経理（入金管理）", "対象（経理タブ実装済み）"],
      ["－月謝", "固定制（12,000円／月）・都度払い（15,000円／回）\n※会員ごとに選択"],
      ["－許状代金の入金確認", "要"],
      ["－入会金", "有（33,000円）"],
      ["スタッフ画面の公開範囲", STAFF_SCREEN_STD],
      ["生徒向け専用ページの要否", "不要（共通のマイページを利用）"],
    ],
    common: [
      ["必要なマニュアル", MANUAL_STD],
      ["運営ルール", "頻度：日曜日・月1回\n振替：なし\nキャンセル：小嶋宗裕に連絡\n進級：宗里宗匠の判断"],
      ["開始", "2026年9月（システム運用開始）"],
    ],
  },
  {
    name: "茶道教室",
    tab: "本部稽古タブ",
    staff: [
      ["指導者／主宰", "郷田家元教授（日曜日・土曜日）\n阿部宗亜先生（木曜日・土曜日）"],
      ["責任者", "和多利 有"],
      ["その他講師", "なし"],
      ["世話人", "なし"],
      ["会員管理", "和多利 有"],
      ["会員コミュニケーション者", "和多利 有"],
      ["本部責任者（責任者が本部にいない場合）", "和多利 有"],
    ],
    settings: [
      ...HONBU_FIXED,
      ["経理（入金管理）", "対象（経理タブへの組み込みは未実装）"],
      ["－月謝", "固定制（月1回プラン 15,000円／月2回プラン 28,000円）\n※月2回プランは土曜日クラスのみ"],
      ["－許状代金の入金確認", "要"],
      ["－入会金", "有（15,000円：入会費・宗徧会費・入門許状代・扇子代）\n※経理がSquareの請求書で発行"],
      ["スタッフ画面の公開範囲", "会員名簿の閲覧\n生徒ごとの進捗申し送りの記入・閲覧（講師・本部のみ。生徒には非表示）"],
      [
        "生徒向け専用ページの要否",
        "要：マイページ内に土曜日クラスの予約（枠・定員制）、木曜日・日曜日クラスの出欠登録、振替チケット表示\nお稽古ノートページ（/keiko-note）",
      ],
    ],
    common: [
      [
        "必要なマニュアル",
        "本部：本部用操作マニュアル（共通）\n経理：必要（未作成）\n講師：必要（未作成）\n生徒：生徒配布マニュアル3種（全クラス共通／土曜日クラス／木曜日・日曜日クラス）＋送付状、ご入会ハンドブック（新システム版）",
      ],
      [
        "運営ルール",
        "土曜日クラス：月2回、午前・午後の2枠（各定員3名）、予約制。講師は郷田家元教授・阿部宗亜先生の交代制\n木曜日クラス：15:00〜17:00、阿部宗亜先生\n日曜日午前クラス：10:00〜12:00、郷田家元教授\n日曜日午後クラス：13:00〜15:00、郷田家元教授\n振替：欠席時に振替チケットを付与\nキャンセル：2日前までは予約画面、それ以降はLINEグループで連絡\n進級：入門（全6回）修了後、炭点前（全6回）・風炉薄茶点前（月謝15,000円、許状料14,000円）へ",
      ],
      ["開始", "開講済み（新システムの入会フォームは2026年10月5日公開）"],
    ],
  },
  {
    name: "G1マダムの茶の湯講座",
    tab: "本部稽古タブ",
    staff: [
      ["指導者／主宰", "山田宗里"],
      ["責任者", "山田宗里"],
      ["その他講師", "小嶋宗裕"],
      ["世話人", `堀瑞絵（${TBD}）`],
      ["会員管理", "和多利月子"],
      ["会員コミュニケーション者", "小嶋宗裕"],
      ["本部責任者（責任者が本部にいない場合）", "なし"],
    ],
    settings: [
      ...HONBU_FIXED,
      ["経理（入金管理）", "対象（経理タブ実装済み）"],
      ["－月謝", "固定制（20,000円／月）\n※高嶋様のみ例外"],
      ["－許状代金の入金確認", "要"],
      ["－入会金", "無"],
      ["スタッフ画面の公開範囲", STAFF_SCREEN_STD],
      ["生徒向け専用ページの要否", "不要（共通のマイページを利用）"],
    ],
    common: [
      ["必要なマニュアル", MANUAL_STD],
      ["運営ルール", "頻度：月1回\n振替：なし\nキャンセル：小嶋宗裕に連絡\n進級：宗里宗匠の判断"],
      ["開始", "2026年9月（システム運用開始）"],
    ],
  },
  {
    name: "新月会",
    tab: "本部稽古タブ",
    staff: [
      ["指導者／主宰", "山田宗囲"],
      ["責任者", "山田宗囲"],
      ["その他講師", "卯月宗文、佐々木宏、（堀哲人）"],
      ["世話人", "卯月宗文"],
      ["会員管理", "Excel、LINE"],
      ["会員コミュニケーション者", "卯月宗文"],
      ["本部責任者（責任者が本部にいない場合）", "山田宗囲"],
    ],
    settings: [
      ...HONBU_FIXED,
      ["経理（入金管理）", "対象（経理タブに追加済み）"],
      ["－月謝", "固定制（月額15,000円・毎月25日に翌月分をカード自動払い／2026年11月分から）"],
      ["－許状代金の入金確認", "要"],
      ["－入会金", "無"],
      ["スタッフ画面の公開範囲", "責任者、講師"],
      ["生徒向け専用ページの要否", "要"],
    ],
    common: [
      ["必要なマニュアル", "N/A"],
      [
        "運営ルール",
        "頻度：月2会開催だが会員の参加頻度は月1回\n振替：参加できない月の分は別の月もしくは不参加\nキャンセル：開催1週間前を目処に出欠確認\n進級：設定なし",
      ],
      ["開始", `2026年10月12日（入会フォームは${TBD}）`],
    ],
  },
];

const TEMPLATE = `会の名前：
タブ（本部稽古タブ／UCIタブ）：

【担当者】
指導者／主宰：
責任者：
その他講師：
世話人：
会員管理：
会員コミュニケーション者：
本部責任者（責任者が本部にいない場合）：

【本部稽古タブの場合】
月謝：固定制／都度払い（　　　円）
許状代金の入金確認：要／不要
入会金：有（　　　円）／無
スタッフ画面の公開範囲：
生徒向けページ：要／不要

【UCIタブの場合】
会の内容（扱うテーマ）：
単発／継続：
名簿の作り方：オンライン入会フォーム／既存名簿をCSVで登録
出席管理：要／不要
許状（山田長光名義）：発行する／しない
経理（入金管理）：要／不要
　－会費：固定制／都度払い（　　　円）
　－入会金：有（　　　円）／無

【共通】
必要なマニュアル（本部／経理／講師／生徒）：
運営ルール（頻度・振替・キャンセルポリシー・進級条件）：
開始予定日：`;

// ---- 記入した内容から会を発足する ----
// 記入用テンプレート（Slackに記入されたもの）を貼り付けると、会の名前・タブ・料金を読み取り、
// 会の設定（groupSettings）に新しい会として保存する。担当者・運営ルールなどは登録シートとして一緒に保存し、
// 下の「現行の会の登録シート」に表示する。入会の受付は停止中のまま（会の設定タブで開始する）。

type Entry = { section: string; label: string; value: string };

const SEC_STAFF = "担当者";
const SEC_HONBU = "本部稽古タブの場合";
const SEC_UCI = "UCIタブの場合";
const SEC_COMMON = "共通";

const toHalf = (s: string) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/，/g, ",");
const labelBase = (s: string) => s.split("（")[0].split("(")[0].trim();

function parseLines(text: string, canon?: (label: string) => string | null): Entry[] {
  const out: Entry[] = [];
  let section = "";
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^【(.+?)】$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    const m = line.match(/^([^：:]{1,40})[：:](.*)$/);
    const label = m ? m[1].replace(/^[\s　\-－ー・]+/, "").trim() : "";
    const known = m ? (canon ? canon(label) : label) : null;
    if (m && known) {
      out.push({ section, label: known, value: m[2].trim() });
    } else if (out.length) {
      // 「頻度：月1回」のような、項目の中身の続きの行
      const last = out[out.length - 1];
      last.value = last.value ? `${last.value}\n${line}` : line;
    }
  }
  return out;
}

const TEMPLATE_ENTRIES = parseLines(TEMPLATE);
const KNOWN_LABELS = [...new Set(TEMPLATE_ENTRIES.map((e) => e.label))];
const L = (prefix: string) => KNOWN_LABELS.find((k) => k.startsWith(prefix)) ?? prefix;

function canonicalLabel(label: string): string | null {
  if (label.length < 2) return null;
  return (
    KNOWN_LABELS.find((k) => k === label) ??
    KNOWN_LABELS.find((k) => labelBase(k) === labelBase(label)) ??
    KNOWN_LABELS.find((k) => k.startsWith(label)) ??
    null
  );
}

// テンプレートのまま（未記入）の値は空にする
function cleanValue(e: Entry): string {
  const def =
    TEMPLATE_ENTRIES.find((t) => t.label === e.label && t.section === e.section)?.value ??
    TEMPLATE_ENTRIES.find((t) => t.label === e.label)?.value ??
    "";
  const v = e.value.trim();
  if (!v || v === def) return "";
  if (/（[\s　]*円）/.test(v) && !/[0-9０-９]/.test(v)) return "";
  return v;
}

function yenIn(v: string): number | null {
  const m = toHalf(v).match(/(\d[\d,]*(?:\.\d+)?)\s*(万)?\s*円/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1));
  return n > 0 ? n : null;
}

// 「固定制（12,000円／月）・都度払い（15,000円／回）」などから月額と1回あたりを読み取る
function parseFees(v: string): { monthly: number | null; session: number | null } {
  const s = toHalf(v);
  let monthly: number | null = null;
  let session: number | null = null;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(万)?\s*円/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Math.round(parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1));
    if (!(n > 0)) continue;
    const after = s.slice(re.lastIndex, re.lastIndex + 4);
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    let isSession: boolean;
    if (/^[\s）)]*[／/]?\s*回/.test(after)) isSession = true;
    else if (/^[\s）)]*[／/]?\s*月/.test(after)) isSession = false;
    else {
      const iS = Math.max(before.lastIndexOf("都度"), before.lastIndexOf("1回"));
      const iM = Math.max(before.lastIndexOf("固定"), before.lastIndexOf("月謝"), before.lastIndexOf("月額"), before.lastIndexOf("会費"));
      isSession = iS > iM;
    }
    if (isSession) session ??= n;
    else monthly ??= n;
  }
  return { monthly, session };
}

type LaunchDraft = {
  name: string;
  displayName: string;
  area: GroupArea;
  monthlyFee: number | null;
  sessionFee: number | null;
  entryFee: number | null;
  cardAutoPay: boolean;
  enrollKey: string;
  sheet: RegistrationSheet;
  warnings: string[];
  text: string;
};

function buildDraft(text: string, forceArea?: GroupArea): LaunchDraft {
  const entries = parseLines(text, canonicalLabel).map((e) => ({ ...e, value: cleanValue(e) }));
  const get = (label: string, section?: string) => {
    const hit =
      (section !== undefined && entries.find((e) => e.label === label && e.section === section && e.value)) ||
      entries.find((e) => e.label === label && (section === undefined || e.section === "") && e.value);
    return hit ? hit.value : "";
  };
  const orTbd = (v: string) => v || TBD;
  const warnings: string[] = [];

  const name = get(L("会の名前")).split("\n")[0].trim();
  if (!name) warnings.push("会の名前が読み取れませんでした。下の欄に入力してください。");
  const tab = get(L("タブ"));
  const area: GroupArea = forceArea ?? (/UCI/i.test(tab) ? "UCI" : "本部稽古");
  if (forceArea) {
    /* タブを画面で選び直したときは警告を出さない */
  } else if (!tab) warnings.push("タブが未記入のため「本部稽古」にしています。");
  else if (/UCI/i.test(tab) && /本部/.test(tab)) warnings.push("タブに本部稽古とUCIの両方が書かれています。どちらか確認してください。");

  const sec = area === "UCI" ? SEC_UCI : SEC_HONBU;
  const feeText = area === "UCI" ? get(L("会費"), SEC_UCI) : get(L("月謝"), SEC_HONBU);
  const fees = parseFees(feeText);
  const entryText = get(L("入会金"), sec);
  const entryFee = /[0-9０-９]/.test(entryText) ? yenIn(entryText) : null;
  if (feeText && fees.monthly === null && fees.session === null)
    warnings.push(`料金の金額を読み取れませんでした（記入：${feeText}）。下の欄に入力してください。`);
  if (/有/.test(entryText) && entryFee === null) warnings.push("入会金「有」ですが金額が読み取れませんでした。");

  const staffLabels = TEMPLATE_ENTRIES.filter((e) => e.section === SEC_STAFF).map((e) => e.label);
  const staff = staffLabels.map((label) => ({ label, value: orTbd(get(label, SEC_STAFF)) }));
  if (!get(L("責任者"), SEC_STAFF)) warnings.push("責任者が未記入です。");

  const settings =
    area === "本部稽古"
      ? [
          ...HONBU_FIXED.map(([label, value]) => ({ label, value })),
          { label: "経理（入金管理）", value: "対象" },
          { label: "－月謝", value: orTbd(feeText) },
          { label: "－許状代金の入金確認", value: orTbd(get(L("許状代金"), SEC_HONBU)) },
          { label: "－入会金", value: orTbd(entryText) },
          { label: "スタッフ画面の公開範囲", value: orTbd(get(L("スタッフ画面"), SEC_HONBU)) },
          { label: "生徒向け専用ページの要否", value: orTbd(get(L("生徒向け"), SEC_HONBU)) },
        ]
      : [
          { label: "会員区分", value: "山田家の会員（宗徧会会員番号は発行しない・宗徧流の許状は出さない）" },
          ...TEMPLATE_ENTRIES.filter((e) => e.section === SEC_UCI).map((e) => ({
            label: e.label === L("会費") || e.label === L("入会金") ? `－${e.label}` : e.label,
            value: orTbd(get(e.label, SEC_UCI)),
          })),
        ];

  const common = [
    { label: "必要なマニュアル", value: orTbd(get(L("必要なマニュアル"), SEC_COMMON)) },
    { label: "運営ルール", value: orTbd(get(L("運営ルール"), SEC_COMMON)) },
    { label: "開始", value: orTbd(get(L("開始予定日"), SEC_COMMON)) },
  ];

  const tbdCount = [...staff, ...settings, ...common].filter((r) => r.value === TBD).length;
  if (tbdCount) warnings.push(`未記入の項目が${tbdCount}件あります（登録シートに赤字で「${TBD}」と表示されます。あとから書き足せます）。`);

  return {
    name,
    displayName: name,
    area,
    monthlyFee: fees.monthly,
    sessionFee: fees.session,
    entryFee,
    cardAutoPay: area === "本部稽古" && fees.monthly !== null,
    enrollKey: "",
    sheet: { staff, settings, common },
    warnings,
    text,
  };
}

const numOrNull = (v: string): number | null => {
  const n = Number(toHalf(v).replace(/[,円\s]/g, ""));
  return v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

function LaunchFromTemplate({ onCreated }: { onCreated: (displayName: string) => void }) {
  const settings = useGroupSettings();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<LaunchDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const set = <K extends keyof LaunchDraft>(k: K, v: LaunchDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  function read() {
    if (!text.trim()) return window.alert("記入済みのテンプレートを貼り付けてください。");
    setDraft(buildDraft(text));
    setMessage(null);
  }

  async function launch() {
    if (!draft) return;
    const name = draft.name.trim();
    const displayName = draft.displayName.trim() || name;
    if (!name) return window.alert("会の名前を入力してください。");
    if (/[/]/.test(name)) return window.alert("会の名前に「/」は使えません。");
    if (settings.some((s) => [s.name, s.displayName].includes(name) || [s.name, s.displayName].includes(displayName)))
      return window.alert("同じ名前の会がすでにあります（削除済みの会を含みます）。");
    const key = draft.enrollKey.trim();
    if (key && !/^[a-z0-9-]+$/.test(key)) return window.alert("入会ページのURLの識別子は半角英小文字・数字・ハイフンで入力してください。");
    if (key && settings.some((s) => s.enrollKey === key)) return window.alert(`識別子「${key}」はほかの会で使われています。`);
    if (
      !window.confirm(
        `「${displayName}」（${draft.area}タブ）を発足します。\n\n` +
          `お月謝：${draft.monthlyFee ? `${draft.monthlyFee.toLocaleString()}円` : "なし"}／都度払い：${draft.sessionFee ? `${draft.sessionFee.toLocaleString()}円` : "なし"}／入会金：${draft.entryFee ? `${draft.entryFee.toLocaleString()}円` : "なし"}\n\n` +
          "会の名前は会員データと結びつくため、あとから変更できません（表示名は変更できます）。入会の受付は停止中のまま発足します。よろしいですか？"
      )
    )
      return;
    const maxOrder = Math.max(0, ...settings.filter((s) => s.area === draft.area).map((s) => s.order));
    const s: GroupSetting = {
      ...newGroupSetting(name, draft.area, maxOrder + 10),
      displayName,
      monthlyFee: draft.monthlyFee,
      sessionFee: draft.sessionFee,
      entryFee: draft.entryFee,
      cardAutoPay: draft.cardAutoPay,
      allowSessionPay: draft.sessionFee !== null,
      enrollKey: key,
      registrationSheet: draft.sheet,
      registrationText: draft.text,
    };
    setBusy(true);
    try {
      await saveGroupSetting(s);
      setMessage(
        `「${displayName}」を発足しました。${draft.area}タブに表示されます。入会フォームを公開するときは「会の設定」タブで案内文・入力項目を確認して「受付を開始」してください。`
      );
      setDraft(null);
      setText("");
      onCreated(displayName);
    } catch (e) {
      window.alert(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const input = "border border-line rounded px-2 py-1 text-sm bg-white";

  return (
    <div className="mt-5 border-t border-line pt-4">
      {message && <p className="text-sm bg-matcha-pale border border-line rounded p-3 mb-3">{message}</p>}
      {!open ? (
        <button className="text-sm bg-matcha-deep text-white rounded px-3 py-1.5" onClick={() => setOpen(true)}>
          記入した内容から会を発足する
        </button>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-sm">記入した内容から会を発足する</h3>
            <button className="text-xs text-muted underline" onClick={() => { setOpen(false); setDraft(null); }}>
              閉じる
            </button>
          </div>
          <p className="text-sm text-muted">
            発足者が記入したテンプレート（Slackに貼られたもの）をそのまま貼り付けて「読み取る」を押してください。会の名前・タブ・料金を読み取り、担当者や運営ルールは登録シートとして保存します。
          </p>
          <textarea
            className="w-full h-64 border border-line rounded p-3 text-xs font-mono bg-white"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={TEMPLATE}
          />
          <div className="flex gap-2">
            <button className="text-sm bg-matcha-deep text-white rounded px-3 py-1.5" onClick={read}>
              読み取る
            </button>
            <button className="text-sm border border-line rounded px-3 py-1.5" onClick={() => setText(TEMPLATE)}>
              空のテンプレートを入れる
            </button>
          </div>

          {draft && (
            <div className="border border-line rounded-md p-4 space-y-4 bg-white">
              <h4 className="font-bold text-sm">読み取った内容（発足前に確認・修正できます）</h4>
              {draft.warnings.length > 0 && (
                <ul className="text-sm text-red-700 list-disc pl-5 space-y-1">
                  {draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="grid md:grid-cols-2 gap-3 text-sm">
                <label className="block">
                  <span className="block text-xs text-muted mb-1">会の名前（内部名・発足後は変更不可）</span>
                  <input className={`${input} w-full`} value={draft.name} onChange={(e) => set("name", e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">表示名</span>
                  <input className={`${input} w-full`} value={draft.displayName} onChange={(e) => set("displayName", e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">タブ</span>
                  <select
                    className={`${input} w-full`}
                    value={draft.area}
                    onChange={(e) => {
                      const area = e.target.value as GroupArea;
                      setDraft((d) =>
                        d ? { ...buildDraft(d.text, area), name: d.name, displayName: d.displayName, enrollKey: d.enrollKey } : d
                      );
                    }}
                  >
                    <option value="本部稽古">本部稽古</option>
                    <option value="UCI">UCI</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">入会ページのURL（/enroll?group=○○・任意・あとで設定可）</span>
                  <input className={`${input} w-full`} value={draft.enrollKey} placeholder="例：hougakai" onChange={(e) => set("enrollKey", e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">お月謝（月額・円）</span>
                  <input className={`${input} w-full`} inputMode="numeric" value={draft.monthlyFee ?? ""} onChange={(e) => set("monthlyFee", numOrNull(e.target.value))} />
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">都度払い（1回・円）</span>
                  <input className={`${input} w-full`} inputMode="numeric" value={draft.sessionFee ?? ""} onChange={(e) => set("sessionFee", numOrNull(e.target.value))} />
                </label>
                <label className="block">
                  <span className="block text-xs text-muted mb-1">入会金（円・なしは空欄）</span>
                  <input className={`${input} w-full`} inputMode="numeric" value={draft.entryFee ?? ""} onChange={(e) => set("entryFee", numOrNull(e.target.value))} />
                </label>
                <label className="flex items-center gap-2 mt-5">
                  <input type="checkbox" checked={draft.cardAutoPay} onChange={(e) => set("cardAutoPay", e.target.checked)} />
                  <span>お月謝をカード自動払い（毎月25日に翌月分）の対象にする</span>
                </label>
              </div>
              <SheetTable title="担当者" rows={draft.sheet.staff.map((r) => [r.label, r.value] as Row)} />
              <SheetTable title="設定" rows={draft.sheet.settings.map((r) => [r.label, r.value] as Row)} />
              <SheetTable title="共通" rows={draft.sheet.common.map((r) => [r.label, r.value] as Row)} />
              <button
                className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
                disabled={busy}
                onClick={launch}
              >
                {busy ? "発足しています…" : "この内容で会を発足する"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Value({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <div key={i} className={line.includes(TBD) ? "text-red-700 font-bold" : ""}>
          {line}
        </div>
      ))}
    </>
  );
}

function SheetTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="mb-5">
      <h4 className="text-sm font-bold text-matcha-deep mb-2">{title}</h4>
      <table className="w-full text-sm border border-line">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-line align-top">
              <th className="w-56 text-left font-bold bg-matcha-pale px-3 py-2 border-r border-line">
                {label}
              </th>
              <td className="px-3 py-2">
                <Value text={value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OperationRules() {
  const [selected, setSelected] = useState(SHEETS[0].name);
  const [copied, setCopied] = useState(false);
  const groupSettings = useGroupSettings();
  // 静的な登録シート＋「記入した内容から会を発足する」で発足した会の登録シート
  const sheets = useMemo<Sheet[]>(() => {
    const extra = groupSettings
      .filter((g) => g.active && g.registrationSheet && !SHEETS.some((s) => s.name === g.name || s.name === g.displayName))
      .map((g) => ({
        name: g.displayName,
        tab: `${g.area}タブ`,
        staff: g.registrationSheet!.staff.map((r) => [r.label, r.value] as Row),
        settings: g.registrationSheet!.settings.map((r) => [r.label, r.value] as Row),
        common: g.registrationSheet!.common.map((r) => [r.label, r.value] as Row),
      }));
    return [...SHEETS, ...extra];
  }, [groupSettings]);
  const sheet = sheets.find((s) => s.name === selected) ?? sheets[0];

  async function copyTemplate() {
    try {
      await navigator.clipboard.writeText(TEMPLATE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* クリップボードが使えない環境では何もしない */
    }
  }

  return (
    <div className="space-y-6">
      {/* 1. 稽古形態の分類 */}
      <section className="bg-paper border border-line rounded-md p-5">
        <h2 className="font-bold mb-1">1. 稽古形態の分類</h2>
        <p className="text-xs text-muted mb-4">{UPDATED}更新</p>
        <div className="grid md:grid-cols-2 gap-4 text-sm">
          <div className="border border-line rounded-md p-4">
            <h3 className="font-bold text-matcha-deep mb-2">本部稽古タブ（宗徧流タイプ）</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>点前を指導する会</li>
              <li>参加者は宗徧流の会員になり、宗徧会会員番号を設定する</li>
              <li>単発ではなく、許状を取りながら積み重ねていく（入会・休会・退会あり）</li>
              <li>オンライン入会フォームから申込み。出席管理あり</li>
              <li>許状申請は6段階のワークフロー（Slack通知付き）</li>
              <li>経理管理あり（月謝・許状代金・入会金）</li>
            </ul>
            <p className="text-xs text-muted mt-3">対象：名月会・茶道教室・G1マダムの茶の湯講座・新月会</p>
          </div>
          <div className="border border-line rounded-md p-4">
            <h3 className="font-bold text-matcha-deep mb-2">UCIタブ（UCIタイプ）</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>参加者は宗徧会員ではなく、山田家の会員</li>
              <li>点前は指導しない。宗徧流の許状は出さない</li>
              <li>UCIなどで山田長光名義の許状を出す場合は、点前の許状とは別の体系</li>
              <li>名簿の作り方・出席管理・経理は会ごとに決める</li>
            </ul>
            <p className="text-xs text-muted mt-3">対象：侘び数寄道</p>
          </div>
        </div>
        <p className="text-sm mt-4">
          新しく発足する会は「本部稽古タブ」または「UCIタブ」に登録します。宗徧流稽古タブは、紙名簿から移行した既存の会（直門・萌芽会・紅月会）を管理するためのものです。
        </p>
      </section>

      {/* 2. 新規開講テンプレート */}
      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold">2. 新規お稽古の会：記入用テンプレート</h2>
          <button
            className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
            onClick={copyTemplate}
          >
            {copied ? "コピーしました" : "テンプレートをコピー"}
          </button>
        </div>
        <p className="text-sm text-muted mb-3">
          新しい会を発足するときは、発足者にこの項目を記入してもらいます（Slackにそのまま貼れます）。記入済みの内容を下の「記入した内容から会を発足する」に貼り付けると、そのまま会を発足できます。
        </p>
        <pre className="text-xs bg-matcha-pale border border-line rounded p-4 whitespace-pre-wrap">{TEMPLATE}</pre>
        <LaunchFromTemplate onCreated={(n) => setSelected(n)} />
      </section>

      {/* 3. 現行の会の登録シート */}
      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="font-bold">3. 現行の会の登録シート</h2>
          <div className="flex gap-2 flex-wrap">
            {sheets.map((s) => (
              <button
                key={s.name}
                className={`text-sm rounded-md px-3 py-1.5 border ${
                  selected === s.name
                    ? "bg-matcha-deep text-white border-matcha-deep"
                    : "bg-paper text-ink border-line"
                }`}
                onClick={() => setSelected(s.name)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm mb-4">
          <span className="font-bold">{sheet.name}</span>　／　{sheet.tab}
        </p>
        <SheetTable title="担当者" rows={sheet.staff} />
        <SheetTable title="設定" rows={sheet.settings} />
        <SheetTable title="共通" rows={sheet.common} />
        <p className="text-xs text-muted">赤字は未確定の項目です。</p>
      </section>
    </div>
  );
}
