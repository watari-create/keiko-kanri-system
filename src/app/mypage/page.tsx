"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc, updateDoc, collection, addDoc } from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { currentMonthKey } from "@/lib/fiscalMonths";
import type { Member, LeaveRequestType } from "@/types";

export default function MyPage() {
  const { role, memberId, loading } = useAuth();
  const router = useRouter();
  const [member, setMember] = useState<Member | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [leaveType, setLeaveType] = useState<LeaveRequestType>("休会");
  const [reason, setReason] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && role !== "member") router.replace("/mypage/login");
  }, [loading, role, router]);

  useEffect(() => {
    if (!memberId) return;
    getDoc(doc(db, "members", memberId)).then((snap) => {
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as Member;
        setMember(data);
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
        setAddress(data.address ?? "");
        setLeaveType(data.status === "休会" ? "復会" : "休会");
      }
    });
  }, [memberId]);

  async function saveContact() {
    if (!memberId) return;
    await updateDoc(doc(db, "members", memberId), { email, phone, address });
    setSavedMsg("連絡先情報を更新しました。");
  }

  async function updateRsvp(value: "出席" | "欠席") {
    if (!memberId) return;
    const monthKey = currentMonthKey();
    await updateDoc(doc(db, "members", memberId), {
      rsvp: value,
      [`attendance.${monthKey}`]: value,
    });
    setMember((prev) =>
      prev
        ? { ...prev, rsvp: value, attendance: { ...prev.attendance, [monthKey]: value } }
        : prev
    );
    setSavedMsg(`次回のお稽古を「${value}」で登録しました。`);
  }

  async function submitLeave() {
    if (!memberId || !member) return;
    await addDoc(collection(db, "leaveRequests"), {
      memberId,
      memberName: member.name,
      group: member.group,
      type: leaveType,
      reason,
      status: "pending",
      requestedAt: new Date().toISOString(),
    });
    setSavedMsg(`${leaveType}の申請を受け付けました。本部の承認をお待ちください。`);
  }

  async function logout() {
    await auth.signOut();
    router.push("/mypage/login");
  }

  if (loading || !member) return <div className="p-8 text-muted">確認中…</div>;

  return (
    <div className="max-w-md mx-auto p-6">
      <button className="text-xs text-muted underline mb-4" onClick={logout}>
        ログアウト
      </button>

      <div className="bg-paper border border-line rounded-md p-6 mb-4 text-center">
        <div className="text-lg font-bold text-matcha-deep">{member.name} 様</div>
        <div className="text-xs text-muted mt-1">{member.group}</div>
        <div className="mt-4 text-sm space-y-1 text-left">
          <div className="flex justify-between border-b border-line py-1">
            <span className="text-muted">会員番号</span>
            <span>{member.id}</span>
          </div>
          <div className="flex justify-between border-b border-line py-1">
            <span className="text-muted">許状段階</span>
            <span>{member.license ?? "—"}</span>
          </div>
        </div>
      </div>

      {member.groupCategory === "本部稽古" && (
        <div className="bg-paper border border-line rounded-md p-6 mb-4">
          <h2 className="text-sm text-muted mb-3">次回のお稽古 出欠登録</h2>
          <p className="text-xs text-muted mb-3">現在の回答：{member.rsvp ?? "未回答"}</p>
          <div className="flex gap-2">
            <button
              className="flex-1 bg-matcha-deep text-white rounded py-2 text-sm"
              onClick={() => updateRsvp("出席")}
            >
              出席する
            </button>
            <button
              className="flex-1 border border-line text-muted rounded py-2 text-sm"
              onClick={() => updateRsvp("欠席")}
            >
              欠席する
            </button>
          </div>
        </div>
      )}

      <div className="bg-paper border border-line rounded-md p-6 mb-4">
        <h2 className="text-sm text-muted mb-3">連絡先情報の変更</h2>
        <input
          className="w-full border border-line rounded px-3 py-2 text-sm mb-2"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="メールアドレス"
        />
        <input
          className="w-full border border-line rounded px-3 py-2 text-sm mb-2"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="電話番号"
        />
        <input
          className="w-full border border-line rounded px-3 py-2 text-sm mb-3"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="ご住所"
        />
        <button
          className="w-full border border-matcha-deep text-matcha-deep rounded py-2 text-sm"
          onClick={saveContact}
        >
          この内容で保存する
        </button>
      </div>

      <div className="bg-paper border border-line rounded-md p-6">
        <h2 className="text-sm text-muted mb-3">
          {member.status === "休会" ? "復会・退会のお申請" : "休会・退会のお申請"}
        </h2>
        <select
          className="w-full border border-line rounded px-3 py-2 text-sm mb-2"
          value={leaveType}
          onChange={(e) => setLeaveType(e.target.value as LeaveRequestType)}
        >
          {member.status === "休会" ? (
            <>
              <option>復会</option>
              <option>退会</option>
            </>
          ) : (
            <>
              <option>休会</option>
              <option>退会</option>
            </>
          )}
        </select>
        <input
          className="w-full border border-line rounded px-3 py-2 text-sm mb-3"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="理由（任意）"
        />
        <button
          className="w-full border border-matcha-deep text-matcha-deep rounded py-2 text-sm"
          onClick={submitLeave}
        >
          申請する
        </button>
      </div>

      {savedMsg && <p className="text-center text-xs text-matcha-deep mt-4">{savedMsg}</p>}
    </div>
  );
}
