"use client";

export const dynamic = "force-dynamic";

// スタッフ画面（骨組み）。
// staffId のドキュメントから role と groups を読み、
// Firestoreルール側でも同じ条件で制限しているので、二重の安全網になっている。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  addDoc,
  deleteField,
} from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { LICENSE_FEES } from "@/lib/licenseFees";
import AttendanceGrid from "@/components/AttendanceGrid";
import { formatLessonDate, type NextLessonInfo } from "@/lib/nextLesson";
import type { StaffAccount, Member, LicenseRequest } from "@/types";

export default function StaffPage() {
  const { role, staffId, loading } = useAuth();
  const router = useRouter();
  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [group, setGroup] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<LicenseRequest[]>([]);
  const [applyMemberId, setApplyMemberId] = useState("");
  const [applyLicenseName, setApplyLicenseName] = useState(LICENSE_FEES[0].name);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [nextLesson, setNextLesson] = useState<NextLessonInfo | null>(null);

  useEffect(() => {
    if (!loading && role !== "staff") router.replace("/staff/login");
  }, [loading, role, router]);

  useEffect(() => {
    if (!group) return;
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      const dates = snap.data()?.dates as Record<string, NextLessonInfo> | undefined;
      setNextLesson(dates?.[group] ?? null);
    });
  }, [group]);

  useEffect(() => {
    if (!staffId) return;
    getDoc(doc(db, "staff", staffId)).then((snap) => {
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as StaffAccount;
        setAccount(data);
        setGroup(data.groups[0] ?? "");
      }
    });
  }, [staffId]);

  useEffect(() => {
    if (!group) return;
    const q = query(collection(db, "members"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Member)));
    });
  }, [group]);

  useEffect(() => {
    if (!group || account?.role !== "teacher") return;
    const q = query(collection(db, "licenseRequests"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LicenseRequest)));
    });
  }, [group, account]);

  async function markDelivered(reqId: string) {
    // Firestoreルール側で「発行済→お渡し済」以外への変更は拒否される
    await updateDoc(doc(db, "licenseRequests", reqId), {
      status: "お渡し済",
      updatedAt: new Date().toISOString(),
    });
  }

  async function setAttendance(
    memberId: string,
    monthKey: string,
    value: "出席" | "欠席" | undefined
  ) {
    await updateDoc(doc(db, "members", memberId), {
      [`attendance.${monthKey}`]: value === undefined ? deleteField() : value,
    });
  }

  async function submitLicenseRequest() {
    const member = members.find((m) => m.id === applyMemberId);
    const licenseFee = LICENSE_FEES.find((l) => l.name === applyLicenseName);
    if (!member || !licenseFee) return;
    await addDoc(collection(db, "licenseRequests"), {
      memberId: member.id,
      memberName: member.name,
      group: member.group,
      licenseName: licenseFee.name,
      fee: licenseFee.fee,
      status: "受付",
      appliedDate: new Date().toISOString(),
    });
    setApplyMsg(`${member.name}様の「${licenseFee.name}」許状申請を提出しました。`);
    setApplyMemberId("");
  }

  async function logout() {
    await auth.signOut();
    router.push("/staff/login");
  }

  if (loading || !account) return <div className="p-8 text-muted">確認中…</div>;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-lg font-bold text-matcha-deep">
          {account.role === "sewanin" ? "宗徧流稽古（世話人）" : "本部稽古（講師）"}
        </h1>
        <button className="text-xs text-muted underline" onClick={logout}>
          ログアウト
        </button>
      </div>

      <div className="text-sm text-muted mb-1">
        {account.name}さんとしてログイン中（担当：{account.groups.join("・")}）
      </div>
      <div className="text-sm text-matcha-deep mb-4">
        {nextLesson ? `${group} 次回のお稽古：${formatLessonDate(nextLesson.date)}` : "\u00A0"}
      </div>

      {account.groups.length > 1 && (
        <select
          className="border border-line rounded px-3 py-2 mb-4 text-sm"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          {account.groups.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      )}

      <section className="bg-paper border border-line rounded-md p-5 mb-6">
        <h2 className="font-bold mb-3">会員名簿</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="py-2">氏名</th>
              <th>許状段階</th>
              <th>ステータス</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-line">
                <td className="py-2">{m.name}</td>
                <td>{m.license ?? "—"}</td>
                <td>{m.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bg-paper border border-line rounded-md p-5 mb-6">
        <h2 className="font-bold mb-2">出席簿</h2>
        <AttendanceGrid
          members={members}
          editable
          onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
        />
      </section>

      {account.role === "teacher" && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6">
          <h2 className="font-bold mb-3">許状申請の提出</h2>
          <select
            className="w-full border border-line rounded px-3 py-2 text-sm mb-2"
            value={applyMemberId}
            onChange={(e) => setApplyMemberId(e.target.value)}
          >
            <option value="">会員を選択してください</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            className="w-full border border-line rounded px-3 py-2 text-sm mb-3"
            value={applyLicenseName}
            onChange={(e) => setApplyLicenseName(e.target.value)}
          >
            {LICENSE_FEES.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name}（¥{l.fee.toLocaleString()}）
              </option>
            ))}
          </select>
          <button
            className="w-full border border-matcha-deep text-matcha-deep rounded py-2 text-sm disabled:opacity-50"
            disabled={!applyMemberId}
            onClick={submitLicenseRequest}
          >
            この内容で申請する
          </button>
          {applyMsg && <p className="text-xs text-matcha-deep mt-3">{applyMsg}</p>}
        </section>
      )}

      {account.role === "teacher" && (
        <section className="bg-paper border border-line rounded-md p-5">
          <h2 className="font-bold mb-1">許状申請の状況</h2>
          <p className="text-xs text-muted mb-3">
            「お渡し済にする」以外は表示のみです
          </p>
          <div className="space-y-3">
            {requests
              .filter((r) => r.status !== "完了" && r.status !== "取消")
              .map((r) => (
                <div key={r.id} className="flex justify-between items-center border-b border-line pb-3">
                  <div>
                    <div className="text-sm font-semibold">{r.memberName}</div>
                    <div className="text-xs text-muted">{r.licenseName}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                      {r.status}
                    </span>
                    {r.status === "発行済" && (
                      <button
                        className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                        onClick={() => markDelivered(r.id)}
                      >
                        お渡し済にする
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
