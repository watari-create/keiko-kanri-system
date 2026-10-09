"use client";

// 管理画面「会の設定」タブ。
// 会ごとの料金（お月謝・都度払い・入会金）と、入会の申し込み（受付中／停止・案内文・入力項目）を変更する。
// 新しい会の発足・会の削除（非表示化）もここで行う。保存先は Firestore の groupSettings/{会の名前}。
// 既定値・型は src/lib/groupSettings.ts。サーバー側は functions/src/groupSettings.ts が同じドキュメントを読む。

import { useMemo, useState } from "react";
import { collection, doc, getCountFromServer, query, setDoc, where } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import {
  CHADO_CLASS_FIELD_ID,
  GROUP_AREAS,
  LOCKED_FIELD_IDS,
  STANDARD_ENROLL_FIELDS,
  STANDARD_FIELD_IDS,
  newGroupSetting,
  useGroupSettings,
  type GroupArea,
  type GroupSetting,
} from "@/lib/groupSettings";
import type { EnrollField, EnrollFieldType } from "@/lib/enrollGroups";

const yen = (n: number | null | undefined) => (typeof n === "number" ? `¥${n.toLocaleString()}` : "—");
const FIELD_TYPE_LABEL: Record<EnrollFieldType, string> = {
  text: "文字",
  email: "メールアドレス",
  tel: "電話番号",
  date: "日付",
  select: "選択肢",
};

async function saveSetting(s: GroupSetting) {
  const { name, ...rest } = s;
  const clean = JSON.parse(JSON.stringify(rest)); // undefined を取り除く（Firestoreは undefined を保存できない）
  await setDoc(doc(db, "groupSettings", name), {
    ...clean,
    updatedAt: new Date().toISOString(),
    updatedBy: auth.currentUser?.email ?? "",
  });
}

async function countActiveMembers(group: string): Promise<number | null> {
  try {
    const snap = await getCountFromServer(
      query(collection(db, "members"), where("group", "==", group), where("status", "in", ["在籍", "休会"]))
    );
    return snap.data().count;
  } catch {
    return null;
  }
}

export default function GroupSettingsPanel() {
  const settings = useGroupSettings();
  const [editing, setEditing] = useState<GroupSetting | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [creating, setCreating] = useState<{ name: string; area: GroupArea } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const visible = settings.filter((s) => showDeleted || s.active);
  const deletedCount = settings.filter((s) => !s.active).length;

  async function toggleEnroll(s: GroupSetting) {
    if (!s.enrollKey) {
      window.alert("入会ページのURL（英字の識別子）が未設定です。「編集」から設定してください。");
      return;
    }
    if (!s.enrollFields.some((f) => f.id === "name") || !s.enrollFields.some((f) => f.id === "email")) {
      window.alert("入力項目に「氏名」と「メールアドレス」が必要です。「編集」から追加してください。");
      return;
    }
    setBusy(s.name);
    try {
      await saveSetting({ ...s, enrollOpen: !s.enrollOpen });
      setMessage(`${s.displayName}：入会の受付を${s.enrollOpen ? "停止" : "開始"}しました`);
    } catch (e) {
      window.alert(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function createGroup() {
    if (!creating) return;
    const name = creating.name.trim();
    if (!name) return window.alert("会の名前を入力してください。");
    if (/[/]/.test(name)) return window.alert("会の名前に「/」は使えません。");
    if (settings.some((s) => s.name === name || s.displayName === name))
      return window.alert("同じ名前の会がすでにあります（削除済みの会を含みます）。");
    if (
      !window.confirm(
        `「${name}」（${creating.area}）を発足します。\n会の名前は会員データと結びつくため、あとから変更できません（表示名は変更できます）。よろしいですか？`
      )
    )
      return;
    const maxOrder = Math.max(0, ...settings.filter((s) => s.area === creating.area).map((s) => s.order));
    const s = newGroupSetting(name, creating.area, maxOrder + 10);
    setBusy(name);
    try {
      await saveSetting(s);
      setCreating(null);
      setEditing(s);
      setMessage(`「${name}」を発足しました。続けて料金と入会の申し込みを設定してください（入会の受付はまだ停止中です）。`);
    } catch (e) {
      window.alert(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function deleteGroup(s: GroupSetting) {
    setBusy(s.name);
    const count = await countActiveMembers(s.name);
    setBusy(null);
    const countText =
      count === null ? "（在籍者数を確認できませんでした）" : count > 0 ? `在籍・休会中の会員が${count}名います。` : "在籍・休会中の会員はいません。";
    if (
      !window.confirm(
        `「${s.displayName}」を削除します。${countText}\n\n` +
          "・管理画面のタブ・入会フォームから外れ、入会の受付も停止します\n" +
          "・会員・出席・入金の記録は消えません（会員名簿・経理からは引き続き確認できます）\n" +
          "・あとから「削除済みの会も表示」→「復活」で元に戻せます\n\nよろしいですか？"
      )
    )
      return;
    setBusy(s.name);
    try {
      await saveSetting({ ...s, active: false, enrollOpen: false });
      setEditing(null);
      setMessage(`「${s.displayName}」を削除しました（記録は残っています）`);
    } catch (e) {
      window.alert(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function restoreGroup(s: GroupSetting) {
    setBusy(s.name);
    try {
      await saveSetting({ ...s, active: true });
      setMessage(`「${s.displayName}」を復活しました（入会の受付は停止中のままです）`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-paper border border-line rounded-md p-5">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="font-bold">会の一覧</h2>
          <button
            className="text-sm bg-matcha-deep text-white rounded px-3 py-1.5"
            onClick={() => setCreating({ name: "", area: "本部稽古" })}
          >
            ＋ 新しい会を発足する
          </button>
          {deletedCount > 0 && (
            <label className="text-xs text-muted flex items-center gap-1 ml-auto">
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
              削除済みの会も表示（{deletedCount}）
            </label>
          )}
        </div>
        <p className="text-xs text-muted mb-3 leading-relaxed">
          料金を変えると、入会フォーム・会員名簿・経理の表示と、これからのカード登録・都度払いの支払いページ・入会金の請求に使われます。
          すでにカード自動払いをご利用中の会員の毎月の金額は変わりません（Square側の契約の金額のまま）。
          ご家族割引など会員ごとに違う金額は、会員詳細の「お月謝（個別設定）」で設定してください。
        </p>
        {message && <p className="text-sm text-matcha-deep bg-matcha-pale rounded px-3 py-2 mb-3">{message}</p>}

        {creating && (
          <div className="border border-matcha-deep rounded p-4 mb-4 bg-matcha-pale">
            <h3 className="font-bold text-sm mb-2">新しい会を発足する</h3>
            <div className="grid sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
              <label className="block">
                <span className="block text-xs text-muted mb-1">会の名前（あとから変更できません）</span>
                <input
                  className="input"
                  value={creating.name}
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  placeholder="例：花月会"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-muted mb-1">タブ</span>
                <select
                  className="input"
                  value={creating.area}
                  onChange={(e) => setCreating({ ...creating, area: e.target.value as GroupArea })}
                >
                  {GROUP_AREAS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  className="text-sm bg-matcha-deep text-white rounded px-3 py-2 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={createGroup}
                >
                  発足する
                </button>
                <button className="text-sm border border-line rounded px-3 py-2 bg-white" onClick={() => setCreating(null)}>
                  やめる
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted mt-2 leading-relaxed">
              新しく発足する会は「本部稽古」か「UCI」を選びます（「宗徧流稽古」は紙名簿から移行した既存の会の管理用）。
              発足後は、名簿・出席簿・入会フォーム・経理・カード自動払いが使えます。茶道教室の曜日クラスや新月会の開催日など、特定の会だけの機能は付きません。
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="text-sm w-full border-collapse">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">会</th>
                <th className="pr-3">タブ</th>
                <th className="pr-3">お月謝</th>
                <th className="pr-3">都度払い</th>
                <th className="pr-3">入会金</th>
                <th className="pr-3">カード自動払い</th>
                <th className="pr-3">入会の受付</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.name} className={`border-b border-line ${s.active ? "" : "opacity-50"}`}>
                  <td className="py-2 pr-3">
                    <div className="font-semibold">{s.displayName}</div>
                    {s.displayName !== s.name && <div className="text-[11px] text-muted">内部名：{s.name}</div>}
                    {!s.active && <span className="text-[11px] text-hanko">削除済み</span>}
                  </td>
                  <td className="pr-3 text-xs">{s.area}</td>
                  <td className="pr-3">
                    {yen(s.monthlyFee)}
                    {s.monthlyFeeTwice != null && <div className="text-[11px] text-muted">月2回 {yen(s.monthlyFeeTwice)}</div>}
                  </td>
                  <td className="pr-3">{yen(s.sessionFee)}</td>
                  <td className="pr-3">{yen(s.entryFee)}</td>
                  <td className="pr-3 text-xs">{s.cardAutoPay ? "対象" : "—"}</td>
                  <td className="pr-3">
                    {s.active && (
                      <button
                        className={`text-xs rounded-full px-3 py-1 border disabled:opacity-50 ${
                          s.enrollOpen ? "bg-matcha-pale border-matcha-deep text-matcha-deep" : "bg-white border-line text-muted"
                        }`}
                        disabled={busy !== null}
                        onClick={() => toggleEnroll(s)}
                        title="クリックで切り替え"
                      >
                        {s.enrollOpen ? "受付中" : "停止中"}
                      </button>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {s.active ? (
                      <button className="text-xs border border-line rounded px-3 py-1 bg-white" onClick={() => setEditing(s)}>
                        編集
                      </button>
                    ) : (
                      <button
                        className="text-xs border border-line rounded px-3 py-1 bg-white"
                        disabled={busy !== null}
                        onClick={() => restoreGroup(s)}
                      >
                        復活
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <GroupEditor
          key={editing.name}
          initial={editing}
          all={settings}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            setEditing(null);
            setMessage(`「${s.displayName}」の設定を保存しました`);
          }}
          onDelete={deleteGroup}
        />
      )}
    </div>
  );
}

// ---------------- 1つの会の編集 ----------------

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null; // 0円は「なし」と同じ扱い
}

function YenInput({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      <div className="flex items-center gap-1">
        <span className="text-sm">¥</span>
        <input
          className="input"
          inputMode="numeric"
          value={value ?? ""}
          placeholder="なし"
          onChange={(e) => onChange(numOrNull(e.target.value))}
        />
      </div>
      {hint && <span className="block text-[11px] text-muted mt-1">{hint}</span>}
    </label>
  );
}

function GroupEditor({
  initial,
  all,
  onClose,
  onSaved,
  onDelete,
}: {
  initial: GroupSetting;
  all: GroupSetting[];
  onClose: () => void;
  onSaved: (s: GroupSetting) => void;
  onDelete: (s: GroupSetting) => void;
}) {
  const [s, setS] = useState<GroupSetting>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof GroupSetting>(k: K, v: GroupSetting[K]) => setS((p) => ({ ...p, [k]: v }));
  const isChado = s.name === "茶道教室";

  const unusedStandard = useMemo(
    () => STANDARD_ENROLL_FIELDS.filter((f) => !s.enrollFields.some((x) => x.id === f.id)),
    [s.enrollFields]
  );

  function updateField(i: number, patch: Partial<EnrollField>) {
    set(
      "enrollFields",
      s.enrollFields.map((f, j) => (j === i ? { ...f, ...patch } : f))
    );
  }
  function moveField(i: number, d: -1 | 1) {
    const arr = [...s.enrollFields];
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    set("enrollFields", arr);
  }
  function removeField(i: number) {
    set(
      "enrollFields",
      s.enrollFields.filter((_, j) => j !== i)
    );
  }
  function addStandard(id: string) {
    const f = STANDARD_ENROLL_FIELDS.find((x) => x.id === id);
    if (f) set("enrollFields", [...s.enrollFields, { ...f, required: f.required ?? false }]);
  }
  function addCustom() {
    const id = `custom_${Date.now().toString(36)}`;
    set("enrollFields", [...s.enrollFields, { id, label: "", type: "text", required: false }]);
  }

  function validate(): string | null {
    if (!s.displayName.trim()) return "表示名を入力してください。";
    if (s.enrollKey && !/^[a-z0-9-]+$/.test(s.enrollKey))
      return "入会ページのURLの識別子は、半角の小文字英字・数字・ハイフンで入力してください。";
    if (s.enrollKey && all.some((g) => g.name !== s.name && g.enrollKey === s.enrollKey))
      return `入会ページのURLの識別子「${s.enrollKey}」は、ほかの会で使われています。`;
    if (s.enrollOpen) {
      if (!s.enrollKey) return "入会を受け付けるには、入会ページのURLの識別子を設定してください。";
      for (const id of LOCKED_FIELD_IDS)
        if (!s.enrollFields.some((f) => f.id === id))
          return `入会を受け付けるには、入力項目に「${STANDARD_ENROLL_FIELDS.find((f) => f.id === id)?.label}」が必要です。`;
      if (s.monthlyFee == null && s.sessionFee == null)
        return "入会を受け付けるには、お月謝か都度払いの金額を設定してください。";
      if (s.allowSessionPay && s.sessionFee == null) return "「都度払いを選べる」にする場合は、都度払いの金額を設定してください。";
    }
    const labels = new Set<string>();
    for (const f of s.enrollFields) {
      if (!f.label.trim()) return "入力項目の名前が空欄のものがあります。";
      if (labels.has(f.label)) return `入力項目「${f.label}」が重複しています。`;
      labels.add(f.label);
      if (f.type === "select" && f.id !== CHADO_CLASS_FIELD_ID && !(f.options ?? []).length)
        return `入力項目「${f.label}」の選択肢を入力してください。`;
    }
    return null;
  }

  async function save() {
    const err = validate();
    if (err) return setError(err);
    if (s.area !== initial.area && !window.confirm(`タブを「${initial.area}」から「${s.area}」に移します。よろしいですか？`)) return;
    setSaving(true);
    setError(null);
    try {
      // 選択肢の前後の空白を除く
      const cleaned: GroupSetting = {
        ...s,
        displayName: s.displayName.trim(),
        enrollFields: s.enrollFields.map((f) =>
          f.type === "select" && f.options ? { ...f, options: f.options.map((o) => o.trim()).filter(Boolean) } : f
        ),
      };
      await saveSetting(cleaned);
      onSaved(cleaned);
    } catch (e) {
      setError(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const enrollUrl =
    typeof window !== "undefined" && s.enrollKey ? `${window.location.origin}/enroll?group=${s.enrollKey}` : "";

  return (
    <section className="bg-paper border-2 border-matcha-deep rounded-md p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="font-bold">{initial.displayName} の設定</h2>
        <button className="ml-auto text-sm text-muted underline" onClick={onClose}>
          閉じる（保存しない）
        </button>
      </div>

      {/* 基本 */}
      <h3 className="text-sm font-bold border-b border-line pb-1 mb-3">基本</h3>
      <div className="grid sm:grid-cols-4 gap-3 mb-6">
        <label className="block sm:col-span-2">
          <span className="block text-xs text-muted mb-1">表示名（画面・通知・入会フォームに出る名前）</span>
          <input className="input" value={s.displayName} onChange={(e) => set("displayName", e.target.value)} />
          <span className="block text-[11px] text-muted mt-1">内部名：{s.name}（会員データと結びつくため変更不可）</span>
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">タブ</span>
          <select className="input" value={s.area} onChange={(e) => set("area", e.target.value as GroupArea)}>
            {GROUP_AREAS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">並び順（小さいほど先）</span>
          <input
            className="input"
            inputMode="numeric"
            value={s.order}
            onChange={(e) => set("order", Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-4">
          <input type="checkbox" checked={s.hasGuardian} onChange={(e) => set("hasGuardian", e.target.checked)} />
          保護者欄を使う（未成年向けの会）
        </label>
      </div>

      {/* 料金 */}
      <h3 className="text-sm font-bold border-b border-line pb-1 mb-3">料金</h3>
      <div className="grid sm:grid-cols-4 gap-3 mb-2">
        <YenInput
          label={isChado ? "お月謝（月1回プラン）" : "お月謝（月額）"}
          value={s.monthlyFee}
          onChange={(v) => set("monthlyFee", v)}
        />
        {(isChado || s.monthlyFeeTwice != null) && (
          <YenInput
            label="お月謝（月2回プラン）"
            value={s.monthlyFeeTwice}
            onChange={(v) => set("monthlyFeeTwice", v)}
            hint="土曜日クラス"
          />
        )}
        <YenInput label="都度払い（1回あたり）" value={s.sessionFee} onChange={(v) => set("sessionFee", v)} />
        <YenInput label="入会金（初回のみ）" value={s.entryFee} onChange={(v) => set("entryFee", v)} />
      </div>
      {s.entryFee != null && (
        <label className="block mb-2">
          <span className="block text-xs text-muted mb-1">入会金の内訳の説明（入会フォーム・請求書に表示）</span>
          <input className="input" value={s.entryFeeNote} onChange={(e) => set("entryFeeNote", e.target.value)} />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm mb-1">
        <input type="checkbox" checked={s.cardAutoPay} onChange={(e) => set("cardAutoPay", e.target.checked)} />
        お月謝をカード自動払い（毎月25日に翌月分）でいただく
      </label>
      <p className="text-[11px] text-muted mb-6 leading-relaxed">
        本部稽古の会で入会金を設定すると、カード登録時（都度払いは最初の支払いページ）にお月謝と一緒にいただき、入会から3日たっても未払いならSquareの請求書を自動で送ります（宗徧流稽古・UCIの会は名簿の表示用）。
        変更後の金額は、すでにカード自動払いをご利用中の会員には適用されません。
      </p>

      {/* 入会の申し込み */}
      <h3 className="text-sm font-bold border-b border-line pb-1 mb-3">入会の申し込み（入会フォーム）</h3>
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.enrollOpen} onChange={(e) => set("enrollOpen", e.target.checked)} />
          入会を受け付ける
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.allowSessionPay} onChange={(e) => set("allowSessionPay", e.target.checked)} />
          お支払い方法で「都度払い」も選べる
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">入会ページのURLの識別子（半角英字）</span>
          <input
            className="input"
            value={s.enrollKey}
            placeholder="例：kagetsu"
            onChange={(e) => set("enrollKey", e.target.value.trim().toLowerCase())}
          />
          {enrollUrl && (
            <span className="block text-[11px] text-muted mt-1 break-all">
              {enrollUrl}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => navigator.clipboard?.writeText(enrollUrl)}
              >
                コピー
              </button>
            </span>
          )}
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">Squareの決済リンク（カード自動払いを使わないときに表示・任意）</span>
          <input className="input" value={s.subscriptionLink} onChange={(e) => set("subscriptionLink", e.target.value)} />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs text-muted mb-1">入会ページ上部の案内文</span>
          <textarea
            className="input"
            rows={3}
            value={s.enrollNotice}
            onChange={(e) => set("enrollNotice", e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">入会の手引きのリンク（任意）</span>
          <input className="input" value={s.guideUrl} onChange={(e) => set("guideUrl", e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">そのボタンの文言</span>
          <input
            className="input"
            value={s.guideLabel}
            placeholder="入会の手引きをダウンロード"
            onChange={(e) => set("guideLabel", e.target.value)}
          />
        </label>
      </div>

      <h4 className="text-xs font-bold text-muted mt-4 mb-2">入力項目（上から順に表示）</h4>
      <div className="space-y-2 mb-3">
        {s.enrollFields.map((f, i) => {
          const standard = STANDARD_FIELD_IDS.includes(f.id);
          const locked = LOCKED_FIELD_IDS.includes(f.id);
          const isChadoClass = f.id === CHADO_CLASS_FIELD_ID;
          return (
            <div key={f.id} className="border border-line rounded p-2 bg-[#FCFBF8]">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-col">
                  <button type="button" className="text-xs leading-none px-1" onClick={() => moveField(i, -1)} title="上へ">
                    ▲
                  </button>
                  <button type="button" className="text-xs leading-none px-1" onClick={() => moveField(i, 1)} title="下へ">
                    ▼
                  </button>
                </div>
                <input
                  className="input !w-56"
                  value={f.label}
                  placeholder="項目名"
                  onChange={(e) => updateField(i, { label: e.target.value })}
                />
                {standard || isChadoClass ? (
                  <span className="text-[11px] text-muted">
                    {isChadoClass ? "クラス選択（選択肢はクラス台帳から自動）" : `標準項目・${FIELD_TYPE_LABEL[f.type]}`}
                  </span>
                ) : (
                  <select
                    className="input !w-36"
                    value={f.type}
                    onChange={(e) => updateField(i, { type: e.target.value as EnrollFieldType })}
                  >
                    {(Object.keys(FIELD_TYPE_LABEL) as EnrollFieldType[]).map((t) => (
                      <option key={t} value={t}>
                        {FIELD_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                )}
                <label className="text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={!!f.required || locked}
                    disabled={locked}
                    onChange={(e) => updateField(i, { required: e.target.checked })}
                  />
                  必須
                </label>
                {!locked && !isChadoClass && (
                  <button type="button" className="text-xs text-hanko ml-auto" onClick={() => removeField(i)}>
                    削除
                  </button>
                )}
              </div>
              {f.type === "select" && !isChadoClass && (
                <label className="block mt-2">
                  <span className="block text-[11px] text-muted mb-1">選択肢（「、」区切り）</span>
                  <input
                    className="input"
                    value={(f.options ?? []).join("、")}
                    onChange={(e) => updateField(i, { options: e.target.value.split(/[、,，]/), optionLabels: undefined })}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 mb-1">
        {unusedStandard.length > 0 && (
          <select
            className="input !w-64"
            value=""
            onChange={(e) => {
              if (e.target.value) addStandard(e.target.value);
            }}
          >
            <option value="">＋ 標準項目を追加…</option>
            {unusedStandard.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="text-sm border border-line rounded px-3 py-1.5 bg-white" onClick={addCustom}>
          ＋ 独自の項目を追加
        </button>
      </div>
      <p className="text-[11px] text-muted mb-6 leading-relaxed">
        標準項目は会員データの同じ欄に保存されます。独自の項目の回答は、会員詳細の「入会フォームの追加項目の回答」に表示されます。
        「お支払い方法」は上の「都度払いも選べる」をオンにすると自動で付きます。
      </p>

      {error && <p className="text-hanko text-sm mb-3">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="bg-matcha-deep text-white rounded px-5 py-2 text-sm disabled:opacity-50"
          disabled={saving}
          onClick={save}
        >
          {saving ? "保存中…" : "この内容で保存する"}
        </button>
        <button className="text-sm border border-line rounded px-4 py-2 bg-white" onClick={onClose}>
          やめる
        </button>
        <button
          className="ml-auto text-sm border border-hanko text-hanko rounded px-4 py-2 bg-white"
          onClick={() => onDelete(initial)}
        >
          この会を削除する
        </button>
      </div>
      {initial.updatedAt && (
        <p className="text-[11px] text-muted mt-3">
          最終更新：{new Date(initial.updatedAt).toLocaleString("ja-JP")}
          {initial.updatedBy ? `（${initial.updatedBy}）` : ""}
        </p>
      )}
    </section>
  );
}
