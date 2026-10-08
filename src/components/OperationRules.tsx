"use client";

// 運用ルール（本部の管理画面「運用ルール」タブ）。
// 「お稽古の形態整理と新規開講ルール」と、記入用テンプレートに沿った現行の各会の登録シートを表示する。
// 内容は静的データ（下のSHEETS等）。担当者や料金が変わったら、このファイルを直接書き換えてpushする。

import { useState } from "react";

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
      ["－月謝", `固定制（金額は${TBD}）`],
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
  const sheet = SHEETS.find((s) => s.name === selected) ?? SHEETS[0];

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
          新しい会を発足するときは、発足者にこの項目を記入してもらいます（Slackにそのまま貼れます）。
        </p>
        <pre className="text-xs bg-matcha-pale border border-line rounded p-4 whitespace-pre-wrap">{TEMPLATE}</pre>
      </section>

      {/* 3. 現行の会の登録シート */}
      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="font-bold">3. 現行の会の登録シート</h2>
          <div className="flex gap-2 flex-wrap">
            {SHEETS.map((s) => (
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
