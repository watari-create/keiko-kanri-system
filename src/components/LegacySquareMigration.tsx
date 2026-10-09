"use client";

// 管理画面（会員名簿タブ）：決済リンク（従来のSquareサブスク）でお支払い中の会員を、
// 本部の操作でカード自動払い（毎月25日・前払い）に切り替える。
// 会員がSquareに登録済みのカードをそのまま使い、旧契約は切り替え前月分の引き落とし後に自動で解約される。

import { useMemo, useState } from "react";
import { getFunctions, httpsCallable } from "firebase/functions";
import { cardLabel, formatJpDate, formatYm, yen } from "@/lib/squareBilling";
import { groupDisplayName } from "@/lib/areas";

interface Card {
  id: string;
  customerId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  expired: boolean;
}
interface LegacySub {
  id: string;
  status: string;
  customerId: string;
  cardId: string | null;
  amount: number | null;
  planName: string | null;
  startDate: string | null;
  chargedThroughDate: string | null;
}
interface Row {
  memberId: string;
  name: string;
  group: string;
  email: string;
  newAmount: number | null;
  newLabel: string;
  startMonth: string;
  schedule: { nextDate: string; nextMonth: string };
  problem: string | null;
  cards: Card[];
  subscriptions: LegacySub[];
}
type Result = { ok: boolean; message: string };

function defaultCardId(r: Row): string {
  const usable = r.cards.filter((c) => !c.expired);
  const used = r.subscriptions.map((s) => s.cardId).find((id) => id && usable.some((c) => c.id === id));
  return used ?? usable[0]?.id ?? "";
}

export default function LegacySquareMigration() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [env, setEnv] = useState<string>("");
  const [cardChoice, setCardChoice] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const fn = httpsCallable<void, { environment: string; rows: Row[] }>(getFunctions(), "listLegacySquareMembers", {
        timeout: 300000,
      });
      const res = (await fn()).data;
      setEnv(res.environment);
      setRows(res.rows);
      setCardChoice(Object.fromEntries(res.rows.map((r) => [r.memberId, defaultCardId(r)])));
      setSelected({});
      setResults({});
    } catch (e) {
      setError((e as Error).message || "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  const ready = useMemo(() => (rows ?? []).filter((r) => !r.problem && cardChoice[r.memberId]), [rows, cardChoice]);
  const blocked = useMemo(() => (rows ?? []).filter((r) => r.problem || !cardChoice[r.memberId]), [rows, cardChoice]);
  const selectedRows = ready.filter((r) => selected[r.memberId] && !results[r.memberId]?.ok);

  async function migrate() {
    if (!selectedRows.length) return;
    const ok = window.confirm(
      `${selectedRows.length}名を、登録済みのカードでカード自動払い（毎月25日・前払い）に切り替えます。\n` +
        `旧契約（決済リンク）は、切り替え前月分の引き落とし後に自動で解約されます。\nよろしいですか？`
    );
    if (!ok) return;
    setRunning(true);
    const fn = httpsCallable<
      { memberId: string; cardId: string; legacySubscriptionIds: string[] },
      { ok: boolean; startMonth: string; nextDate: string; cancelState: string }
    >(getFunctions(), "migrateLegacySquareMember");
    for (const r of selectedRows) {
      try {
        const res = (
          await fn({
            memberId: r.memberId,
            cardId: cardChoice[r.memberId],
            legacySubscriptionIds: r.subscriptions.map((s) => s.id),
          })
        ).data;
        setResults((p) => ({
          ...p,
          [r.memberId]: { ok: true, message: `切り替え済み（初回 ${formatJpDate(res.nextDate)}・旧契約：${res.cancelState}）` },
        }));
      } catch (e) {
        setResults((p) => ({ ...p, [r.memberId]: { ok: false, message: (e as Error).message || "失敗しました" } }));
      }
    }
    setRunning(false);
  }

  return (
    <div className="bg-bg border border-line rounded-md p-4 mb-4 print:hidden">
      <button className="text-sm font-bold text-matcha-deep" onClick={() => setOpen(!open)}>
        {open ? "▼" : "▶"} 決済リンクからカード自動払いへの切り替え（本部操作）
      </button>
      {open && (
        <div className="mt-3 text-sm">
          <ul className="text-xs text-muted list-disc pl-4 space-y-1 mb-3">
            <li>会員のメールアドレスでSquareの顧客を探し、登録済みのカードと決済リンクの契約を表示します。</li>
            <li>「切り替える」と、そのカードで新しい契約（毎月25日に翌月分）を作ります。会員のカード入力は不要です。</li>
            <li>旧契約は、切り替え前月分の引き落としが済んだ時点で自動解約します（毎朝6時に確認）。</li>
            <li>新しい金額と旧契約の金額が違う会員は赤字で表示します。家族割引などは先に会員詳細の「お月謝（個別設定）」を入力してください。</li>
          </ul>
          <button
            className="border border-matcha-deep text-matcha-deep rounded px-3 py-1.5 text-xs disabled:opacity-50"
            onClick={load}
            disabled={loading || running}
          >
            {loading ? "Squareに問い合わせ中…（1〜2分かかります）" : rows ? "読み込み直す" : "対象の会員を読み込む"}
          </button>
          {env && env !== "production" && <span className="ml-2 text-xs text-hanko">（テスト環境）</span>}
          {error && <p className="text-hanko text-xs mt-2">{error}</p>}

          {rows && (
            <>
              <p className="text-xs text-muted mt-3">
                切り替えできる会員：{ready.length}名　／　確認が必要な会員：{blocked.length}名
              </p>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted border-b border-line">
                      <th className="py-1.5 pr-2 font-normal">
                        <input
                          type="checkbox"
                          checked={ready.length > 0 && ready.every((r) => selected[r.memberId] || results[r.memberId]?.ok)}
                          onChange={(e) =>
                            setSelected(Object.fromEntries(ready.map((r) => [r.memberId, e.target.checked])))
                          }
                        />
                      </th>
                      <th className="py-1.5 pr-2 font-normal">会員</th>
                      <th className="py-1.5 pr-2 font-normal">旧契約（決済リンク）</th>
                      <th className="py-1.5 pr-2 font-normal">使うカード</th>
                      <th className="py-1.5 pr-2 font-normal">切り替え後</th>
                      <th className="py-1.5 font-normal">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...ready, ...blocked].map((r) => {
                      const usable = r.cards.filter((c) => !c.expired);
                      const legacyAmounts = r.subscriptions.map((s) => s.amount).filter((a): a is number => a !== null);
                      const amountDiffers = legacyAmounts.length > 0 && legacyAmounts.some((a) => a !== r.newAmount);
                      const result = results[r.memberId];
                      const canSelect = !r.problem && !!cardChoice[r.memberId] && !result?.ok;
                      return (
                        <tr key={r.memberId} className="border-b border-line align-top">
                          <td className="py-2 pr-2">
                            <input
                              type="checkbox"
                              disabled={!canSelect || running}
                              checked={!!selected[r.memberId] && canSelect}
                              onChange={(e) => setSelected({ ...selected, [r.memberId]: e.target.checked })}
                            />
                          </td>
                          <td className="py-2 pr-2 whitespace-nowrap">
                            <div>{r.name}</div>
                            <div className="text-muted">
                              {r.memberId}・{groupDisplayName(r.group)}
                            </div>
                            <div className="text-muted">{r.email || "メール未登録"}</div>
                          </td>
                          <td className="py-2 pr-2">
                            {r.subscriptions.length === 0 ? (
                              <span className="text-muted">見つかりません</span>
                            ) : (
                              r.subscriptions.map((s) => (
                                <div key={s.id} className={amountDiffers ? "text-hanko" : ""}>
                                  {s.planName ?? "プラン名不明"}　{s.amount !== null ? yen(s.amount) : "金額不明"}
                                  <div className="text-muted">
                                    {s.chargedThroughDate ? `${formatJpDate(s.chargedThroughDate)}まで支払い済み` : s.status}
                                  </div>
                                </div>
                              ))
                            )}
                            {r.subscriptions.length > 1 && <div className="text-hanko">旧契約が{r.subscriptions.length}件あります</div>}
                          </td>
                          <td className="py-2 pr-2">
                            {usable.length > 1 ? (
                              <select
                                className="border border-line rounded px-1 py-0.5"
                                value={cardChoice[r.memberId] ?? ""}
                                onChange={(e) => setCardChoice({ ...cardChoice, [r.memberId]: e.target.value })}
                              >
                                {usable.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {cardLabel(c.brand, c.last4)}（{c.expMonth}/{c.expYear}）
                                  </option>
                                ))}
                              </select>
                            ) : usable.length === 1 ? (
                              <span>
                                {cardLabel(usable[0].brand, usable[0].last4)}
                                <span className="text-muted">（{usable[0].expMonth}/{usable[0].expYear}）</span>
                              </span>
                            ) : (
                              <span className="text-hanko">使えるカードなし</span>
                            )}
                            {r.cards.some((c) => c.expired) && <div className="text-muted">期限切れのカードあり</div>}
                          </td>
                          <td className="py-2 pr-2 whitespace-nowrap">
                            <div className={amountDiffers ? "text-hanko font-bold" : ""}>
                              {yen(r.newAmount)}／月
                            </div>
                            <div className="text-muted">
                              {formatYm(r.startMonth)}分から・初回 {formatJpDate(r.schedule.nextDate)}
                            </div>
                          </td>
                          <td className="py-2">
                            {result ? (
                              <span className={result.ok ? "text-matcha-deep" : "text-hanko"}>{result.message}</span>
                            ) : r.problem ? (
                              <span className="text-hanko">{r.problem}</span>
                            ) : (
                              <span className="text-muted">切り替え可</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button
                className="mt-3 bg-matcha-deep text-white rounded px-4 py-2 text-xs disabled:opacity-50"
                onClick={migrate}
                disabled={running || selectedRows.length === 0}
              >
                {running ? "切り替え中…" : `選択した会員を切り替える（${selectedRows.length}名）`}
              </button>
              <p className="text-[11px] text-muted mt-2">
                「確認が必要な会員」は、会員のメールアドレスをSquareの顧客と同じにするか、マイページからカードを登録してもらってください。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
