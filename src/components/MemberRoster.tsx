"use client";
import { CHADO_CLASS_LABEL } from "@/lib/chadoClasses";

// 会員名簿（全会横断）。本部の管理画面「会員名簿」タブで使う。
// membersコレクションを全件購読し、氏名・年齢・入会日・所属の会・クラス／組・状態と、
// ご家族（linkedMemberIds）の所属を一覧表示する。ご家族が別の会に所属している場合は強調表示する。
// お月謝（lib/memberFees.ts：会の標準額 or 会員ごとの個別設定）と入会金も表示する。
// 絞り込み（会・状態・キーワード）、CSV書き出し、印刷に対応。

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { groupDisplayName, HONBU_KEIKO_GROUPS, SOHENRYU_KEIKO_GROUPS, UCI_GROUPS } from "@/lib/areas";
import { memberFee, entryFeeFor, formatYen } from "@/lib/memberFees";
import type { Member } from "@/types";

// 表示順（宗徧流稽古 → 本部稽古 → UCI → その他）
const GROUP_ORDER = [...SOHENRYU_KEIKO_GROUPS, ...HONBU_KEIKO_GROUPS, ...UCI_GROUPS];
const SUBGROUP_ORDER = ["雪組", "月組", "花組"];
const CHADO_CLASS_ORDER = ["土曜日", "木曜日", "日曜日", "日曜日午後"];


// 年齢：生年月日があれば今日時点で計算し、なければ登録済みの年齢を使う
export function memberAge(m: Pick<Member, "birthDate" | "age">, today = new Date()): number | null {
  if (m.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(m.birthDate)) {
    const [y, mo, d] = m.birthDate.split("-").map(Number);
    let age = today.getFullYear() - y;
    const beforeBirthday =
      today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d);
    if (beforeBirthday) age -= 1;
    return age >= 0 && age < 130 ? age : null;
  }
  return typeof m.age === "number" ? m.age : null;
}

// クラス・組の表示（茶道教室は曜日クラス、雪月花は雪組・月組・花組）
export function memberClassLabel(m: Pick<Member, "chadoClass" | "subGroup">): string {
  if (m.chadoClass) return `${CHADO_CLASS_LABEL[m.chadoClass] ?? m.chadoClass}クラス`;
  return m.subGroup ?? "";
}

function groupRank(g: string) {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
}

function classRank(m: Member) {
  if (m.chadoClass) return CHADO_CLASS_ORDER.indexOf(m.chadoClass);
  if (m.subGroup) {
    const i = SUBGROUP_ORDER.indexOf(m.subGroup);
    return i === -1 ? SUBGROUP_ORDER.length : i;
  }
  return 99;
}

function csvCell(v: string | number | null | undefined) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function MemberRoster({ onSelect }: { onSelect?: (m: Member) => void }) {
  const [all, setAll] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [groupFilter, setGroupFilter] = useState("すべて");
  const [keyword, setKeyword] = useState("");
  const [familyOnly, setFamilyOnly] = useState(false);
  const [includeTest, setIncludeTest] = useState(false);

  useEffect(() => {
    return onSnapshot(collection(db, "members"), (snap) => {
      setAll(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Member)));
      setLoaded(true);
    });
  }, []);

  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);

  const groupOptions = useMemo(() => {
    const set = new Set(all.map((m) => m.group).filter(Boolean));
    return Array.from(set).sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b, "ja"));
  }, [all]);

  // ご家族の一覧（会員番号から引けない＝削除済みなどは番号のみ表示）
  function familyOf(m: Member) {
    return (m.linkedMemberIds ?? [])
      .filter((id) => id !== m.id)
      // 在籍していないご家族は表示しない（削除済みなどで引けない会員は番号のみ表示）
      .filter((id) => { const f = byId.get(id); return !f || f.status === "在籍"; })
      .map((id) => {
        const f = byId.get(id);
        return {
          id,
          name: f?.name ?? "（不明）",
          group: f?.group ?? "",
          otherGroup: !!f && f.group !== m.group,
        };
      });
  }

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return all
      .filter((m) => includeTest || !m.isTestAccount)
      .filter((m) => groupFilter === "すべて" || m.group === groupFilter)
      // 名簿は在籍会員のみ（休会・退会は表示しない）
      .filter((m) => m.status === "在籍")
      .filter((m) => {
        if (!familyOnly) return true;
        return (m.linkedMemberIds ?? []).some((id) => {
          const f = byId.get(id);
          return f && f.status === "在籍";
        });
      })
      .filter((m) => {
        if (!kw) return true;
        return [m.name, m.nameKana, m.sotomei, m.id, m.email]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(kw));
      })
      .sort(
        (a, b) =>
          groupRank(a.group) - groupRank(b.group) ||
          a.group.localeCompare(b.group, "ja") ||
          classRank(a) - classRank(b) ||
          (a.joinDate ?? "").localeCompare(b.joinDate ?? "") ||
          a.id.localeCompare(b.id)
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, byId, groupFilter, keyword, familyOnly, includeTest]);

  // 会ごとの人数（絞り込み後）
  const countsByGroup = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((m) => map.set(m.group, (map.get(m.group) ?? 0) + 1));
    return Array.from(map.entries());
  }, [rows]);

  // 表示中の在籍会員のお月謝合計（月額のみ。都度払い・金額未設定は除く）
  const feeSummary = useMemo(() => {
    let monthlyTotal = 0;
    let perSessionCount = 0;
    let unsetCount = 0;
    rows.forEach((m) => {
        const f = memberFee(m);
        if (f.amount === null) unsetCount += 1;
        else if (f.unit === "回") perSessionCount += 1;
        else monthlyTotal += f.amount;
      });
    return { monthlyTotal, perSessionCount, unsetCount };
  }, [rows]);

  function downloadCsv() {
    const header = [
      "会員番号", "氏名", "フリガナ", "年齢", "生年月日", "入会日",
      "所属の会", "お支払い方法", "お月謝（円）", "単位", "お月謝の区分",
      "入会金（円）", "入会金の入金", "ご家族（会員番号・氏名・所属）", "ご家族が他の会に所属",
    ];
    const lines = rows.map((m) => {
      const fam = familyOf(m);
      const fee = memberFee(m);
      return [
        m.id, m.name, m.nameKana, memberAge(m), m.birthDate, m.joinDate,
        groupDisplayName(m.group),
        m.paymentMethod ?? "", fee.amount, fee.amount === null ? "" : `${fee.unit}`, fee.label,
        entryFeeFor(m.group), m.entryFeeStatus ?? "",
        fam.map((f) => `${f.id} ${f.name}（${groupDisplayName(f.group)}）`).join(" / "),
        fam.some((f) => f.otherGroup) ? "あり" : "",
      ].map(csvCell).join(",");
    });
    const csv = "﻿" + [header.join(","), ...lines].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `会員名簿_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="bg-paper border border-line rounded-md p-5 mb-6 member-roster">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="font-bold">
          会員名簿<span className="text-sm text-muted font-normal">　{rows.length}名</span>
        </h2>
        <div className="flex gap-2 print:hidden">
          <button className="text-xs bg-paper border border-line rounded px-3 py-1.5" onClick={downloadCsv}>
            CSVで書き出す
          </button>
          <button className="text-xs bg-paper border border-line rounded px-3 py-1.5" onClick={() => window.print()}>
            印刷
          </button>
        </div>
      </div>

      {/* 絞り込み */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm print:hidden">
        <select className="border border-line rounded px-2 py-1.5" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="すべて">すべての会</option>
          {groupOptions.map((g) => (
            <option key={g} value={g}>{groupDisplayName(g)}</option>
          ))}
        </select>
        <input
          className="border border-line rounded px-2 py-1.5 w-56"
          placeholder="氏名・フリガナ・会員番号で検索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={familyOnly} onChange={(e) => setFamilyOnly(e.target.checked)} />
          ご家族がいる会員のみ
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
          テスト会員を含める
        </label>
      </div>

      {countsByGroup.length > 0 && (
        <p className="text-xs text-muted mb-3">
          {countsByGroup.map(([g, n]) => `${groupDisplayName(g)} ${n}名`).join("　／　")}
        </p>
      )}

      {rows.length > 0 && (
        <p className="text-xs mb-3">
          在籍会員のお月謝合計（月額）：
          <span className="font-bold text-matcha-deep">{formatYen(feeSummary.monthlyTotal)}</span>
          {feeSummary.perSessionCount > 0 && (
            <span className="text-muted">　※都度払い{feeSummary.perSessionCount}名は含みません</span>
          )}
          {feeSummary.unsetCount > 0 && (
            <span className="text-hanko">　※金額未設定{feeSummary.unsetCount}名</span>
          )}
        </p>
      )}

      {!loaded ? (
        <p className="text-sm text-muted py-4">読み込み中…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted text-center py-4">該当する会員はいません</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left border-b border-line text-xs">
                <th className="py-2 pr-3 font-normal">会員番号</th>
                <th className="py-2 pr-3 font-normal">氏名</th>
                <th className="py-2 pr-3 font-normal text-right">年齢</th>
                <th className="py-2 pr-3 font-normal">入会日</th>
                <th className="py-2 pr-3 font-normal">所属の会</th>
                <th className="py-2 pr-3 font-normal text-right">お月謝</th>
                <th className="py-2 font-normal">ご家族</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const age = memberAge(m);
                const fam = familyOf(m);
                const fee = memberFee(m);
                const entryFee = entryFeeFor(m.group);
                return (
                  <tr key={m.id} className="border-b border-line last:border-0 align-top">
                    <td className="py-2 pr-3 text-muted whitespace-nowrap">{m.id}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {onSelect ? (
                        <button
                          className="text-matcha-deep underline decoration-dotted underline-offset-2 text-left"
                          onClick={() => onSelect(m)}
                        >
                          {m.name}
                        </button>
                      ) : (
                        m.name
                      )}
                      {m.nameKana && <div className="text-[11px] text-muted">{m.nameKana}</div>}
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{age === null ? "—" : `${age}歳`}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{m.joinDate || "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{groupDisplayName(m.group)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      {fee.amount === null ? (
                        <span className="text-xs text-muted">未設定</span>
                      ) : (
                        <span className={fee.custom ? "font-semibold text-matcha-deep" : ""}>
                          {formatYen(fee.amount)}
                          <span className="text-xs text-muted">／{fee.unit}</span>
                        </span>
                      )}
                      <div className="text-[11px] text-muted">
                        {fee.label}
                        {m.paymentStatus === "未納" && <span className="ml-1 text-hanko">未納</span>}
                      </div>
                      {entryFee !== null && (
                        <div className="text-[11px] text-muted">
                          入会金 {formatYen(entryFee)}
                          {m.entryFeeStatus && (
                            <span className={m.entryFeeStatus === "未納" ? "ml-1 text-hanko" : "ml-1"}>
                              {m.entryFeeStatus}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {fam.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {fam.map((f) => (
                            <li key={f.id} className={f.otherGroup ? "text-hanko font-semibold" : ""}>
                              {f.name}
                              <span className={f.otherGroup ? "" : "text-muted"}>
                                （{f.group ? groupDisplayName(f.group) : "所属不明"}
）
                              </span>
                              {f.otherGroup && (
                                <span className="ml-1 text-[10px] bg-hanko-pale text-hanko rounded px-1 py-0.5 font-normal">
                                  他の会
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted mt-3 print:hidden">
        ご家族は会員詳細の「ご家族との連携」で登録された会員を表示しています。別の会に所属するご家族は赤字で表示します。
        年齢は生年月日から本日時点で計算し、生年月日が未登録の場合は登録済みの年齢を表示します。
        お月謝は会の標準額を表示し、会員詳細で「お月謝（個別設定）」を入力した会員はその金額を緑の太字で表示します。
        名簿は在籍会員のみ表示します（休会・退会の会員とご家族は表示しません）。
      </p>
    </section>
  );
}
