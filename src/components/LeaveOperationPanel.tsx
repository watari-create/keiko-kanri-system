"use client";

// 休会・退会・復会の手続き（講師画面・管理画面の会員詳細で使う）。
// 2026-10-14〜 会員本人はマイページから申請できなくなり、講師・本部がここで理由を記入して操作する。
//
// 仕組み：leaveRequests に { status: "pending", direct: true, operatedBy… } を作成する。
// Cloud Functions（onLeaveRequestCreated）が Slack に「○○さんが休会にしました」と通知したうえで
// 自動で approved にするので、これまでの承認後の処理（会員ステータスの反映・
// カード自動払いの解約／再開とスレッドへの結果返信）がそのまま動く。

import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { LeaveRequest, LeaveRequestType, Member } from "@/types";

type Props = {
  member: Member;
  operatorName: string;
  operatorRole: "講師" | "世話人" | "本部";
};

function typesFor(member: Member): LeaveRequestType[] {
  if (member.status === "休会") return ["復会", "退会"];
  if (member.status === "退会") return [];
  // 茶道教室は休会なし（退会のみ）
  return member.group === "茶道教室" ? ["退会"] : ["休会", "退会"];
}

export default function LeaveOperationPanel({ member, operatorName, operatorRole }: Props) {
  const options = typesFor(member);
  const [type, setType] = useState<LeaveRequestType | "">(options[0] ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<LeaveRequest[]>([]);

  useEffect(() => {
    setType(typesFor(member)[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id, member.status]);

  useEffect(() => {
    // ルール上、講師は担当の会の申請しか読めないため group でも絞る
    const q = query(
      collection(db, "leaveRequests"),
      where("group", "==", member.group),
      where("memberId", "==", member.id)
    );
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as LeaveRequest))
          .sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""));
        setHistory(list);
      },
      (err) => console.error("休会・退会の履歴の取得に失敗しました", err)
    );
  }, [member.id, member.group]);

  const pending = history.find((r) => r.status === "pending");

  async function submit() {
    if (!type) return;
    if (!reason.trim()) {
      setMsg("理由を記入してください。");
      return;
    }
    const label = type === "復会" ? "復会（在籍に戻す）" : type;
    if (!window.confirm(`${member.name}様を「${label}」にします。よろしいですか？`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await addDoc(collection(db, "leaveRequests"), {
        memberId: member.id,
        memberName: member.name,
        group: member.group,
        type,
        reason: reason.trim(),
        status: "pending",
        direct: true,
        operatedBy: operatorName,
        operatedByRole: operatorRole,
        requestedAt: new Date().toISOString(),
      });
      setReason("");
      setMsg(`${type}の手続きをしました。数秒でステータスが切り替わり、Slackに通知されます。`);
    } catch (err) {
      console.error(err);
      setMsg("手続きに失敗しました。時間をおいてもう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-line">
      <h4 className="text-sm font-bold mb-1">休会・退会の手続き</h4>
      <p className="text-xs text-muted mb-2">
        現在のステータス：<span className="text-ink font-bold">{member.status}</span>
        {member.status !== "退会" && (
          <>　／　カード自動払いの会員は、休会・退会で自動払いが止まり、復会で再開します。</>
        )}
      </p>

      {pending ? (
        <p className="text-xs text-ink bg-[#EAEEDF] rounded p-2 mb-2">
          {pending.type}の手続きを処理中です…
        </p>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted mb-2">退会済みの会員です。</p>
      ) : (
        <div className="space-y-2">
          <select
            className="input w-full"
            value={type}
            onChange={(e) => setType(e.target.value as LeaveRequestType)}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {o === "復会" ? "復会（在籍に戻す）" : o}
              </option>
            ))}
          </select>
          <textarea
            className="input w-full"
            rows={2}
            placeholder="理由（必須）　例：仕事の都合で半年ほどお休み"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="text-sm bg-matcha-deep text-white rounded px-3 py-2 disabled:opacity-50 w-full"
            onClick={submit}
            disabled={busy || !reason.trim()}
          >
            {type ? `${type === "復会" ? "復会" : type}にする` : "手続きする"}
          </button>
        </div>
      )}
      {msg && <p className="text-xs text-matcha-deep mt-2">{msg}</p>}

      {history.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-muted mb-1">これまでの手続き</p>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {history.map((r) => (
              <li key={r.id} className="text-xs border border-line rounded p-2">
                <span className="text-muted">{(r.requestedAt ?? "").slice(0, 10)}</span>　
                <span className="font-bold">{r.type}</span>
                {r.status === "rejected" && <span className="text-hanko">（却下）</span>}
                {r.status === "pending" && <span className="text-muted">（処理中）</span>}
                {r.operatedBy ? `　${r.operatedBy}（${r.operatedByRole ?? ""}）` : "　本人の申請"}
                {r.reason && <p className="mt-0.5 whitespace-pre-wrap">理由：{r.reason}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
