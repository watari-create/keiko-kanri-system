"use client";

export const dynamic = "force-dynamic";

// スタッフ画面（骨組み）。
// staffId のドキュメントから role と groups を読み、
// Firestoreルール側でも同じ条件で制限しているので、二重の安全網になっている。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  addDoc,
  deleteDoc,
  deleteField,
} from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { LICENSE_FEES, formatYearMonth } from "@/lib/licenseFees";
import { isHonbuKeikoGroup, groupDisplayName, groupHasGuardianField } from "@/lib/areas";
import AttendanceGrid from "@/components/AttendanceGrid";
import { formatLessonDate, type NextLessonInfo } from "@/lib/nextLesson";
import { currentMonthKey } from "@/lib/fiscalMonths";
import { LICENSE_STATUS_EMOJI } from "@/types";
import type { StaffAccount, Member, LicenseRequest, ChadoStudentNote } from "@/types";

export default function StaffPage() {
  const { role, staffId, loading } = useAuth();
  const router = useRouter();
  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [group, setGroup] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<LicenseRequest[]>([]);
  const [applyMemberId, setApplyMemberId] = useState("");
  const [applyLicenseName, setApplyLicenseName] = useState(LICENSE_FEES[0].name);
  const [applyIssueMonth, setApplyIssueMonth] = useState(currentMonthKey());
  const [showLicenseHistory, setShowLicenseHistory] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [nextLesson, setNextLesson] = useState<NextLessonInfo | null>(null);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [studentNotes, setStudentNotes] = useState<ChadoStudentNote[]>([]);
  const [newNoteDate, setNewNoteDate] = useState("");
  const [newNoteBody, setNewNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);

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
    // 許状申請は本部稽古（名月会・茶道教室・Gマダムの茶の湯講座）のグループのみ対象。
    // 宗徧流稽古側のグループでは、スタッフの役割（世話人・講師）に関わらず対象外。
    if (!group || !isHonbuKeikoGroup(group)) return;
    const q = query(collection(db, "licenseRequests"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LicenseRequest)));
    });
  }, [group, account]);

  // 茶道教室：生徒詳細で選択中の生徒の申し送りをリアルタイム購読
  useEffect(() => {
    if (!selectedMember || group !== "茶道教室") {
      setStudentNotes([]);
      return;
    }
    setNewNoteDate(new Date().toISOString().slice(0, 10));
    setNewNoteBody("");
    const q = query(
      collection(db, "chadoStudentNotes"),
      where("memberId", "==", selectedMember.id),
      orderBy("date", "desc"),
      orderBy("createdAt", "desc")
    );
    return onSnapshot(q, (snap) => {
      setStudentNotes(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoStudentNote)));
    });
  }, [selectedMember, group]);

  async function addStudentNote() {
    if (!selectedMember || !account || !newNoteBody.trim() || !newNoteDate) return;
    setSavingNote(true);
    try {
      await addDoc(collection(db, "chadoStudentNotes"), {
        memberId: selectedMember.id,
        memberName: selectedMember.name,
        date: newNoteDate,
        body: newNoteBody.trim(),
        authorName: account.name,
        createdAt: new Date().toISOString(),
      });
      setNewNoteBody("");
    } finally {
      setSavingNote(false);
    }
  }

  async function deleteStudentNote(noteId: string) {
    await deleteDoc(doc(db, "chadoStudentNotes", noteId));
  }

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
      fee: licenseFee.fee + licenseFee.rei, // 申請料＋御礼の合計
      status: "受付",
      appliedDate: new Date().toISOString(),
      issueMonth: applyIssueMonth,
    });
    setApplyMsg(`${member.name}様の「${licenseFee.name}」許状申請を提出しました。`);
    setApplyMemberId("");
    setApplyIssueMonth(currentMonthKey());
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
          {isHonbuKeikoGroup(group) ? "本部稽古" : "宗徧流稽古"}
          （{account.role === "sewanin" ? "世話人" : "講師"}）
        </h1>
        <div className="flex items-center gap-3">
          {account.groups.includes("茶道教室") && (
            <Link
              href="/keiko-note"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
            >
              お稽古ノート
            </Link>
          )}
          <Link
            href="/g1-shipping"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
          >
            G1発送物
          </Link>
          <button className="text-xs text-muted underline" onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>

      <div className="text-sm text-muted mb-1">
        {account.name}さんとしてログイン中（担当：{account.groups.map(groupDisplayName).join("・")}）
      </div>
      <div className="text-sm text-matcha-deep mb-4">
        {nextLesson ? `${groupDisplayName(group)} 次回のお稽古：${formatLessonDate(nextLesson.date)}` : "\u00A0"}
      </div>

      {account.groups.length > 1 && (
        <select
          className="border border-line rounded px-3 py-2 mb-4 text-sm"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          {account.groups.map((g) => (
            <option key={g} value={g}>
              {groupDisplayName(g)}
            </option>
          ))}
        </select>
      )}

      <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto">
        <h2 className="font-bold mb-1">会員名簿</h2>
        <p className="text-xs text-muted mb-3">氏名をクリックすると詳細を見られます</p>
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="py-2 pr-3">会員番号</th>
              <th className="pr-3">氏名</th>
              <th className="pr-3">許状段階</th>
              {isHonbuKeikoGroup(group) && <th className="pr-3">支払い方法</th>}
              <th>ステータス</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-line">
                <td className="py-2 pr-3">{m.id}</td>
                <td className="pr-3">
                  <button
                    type="button"
                    className="text-matcha-deep underline underline-offset-2"
                    onClick={() => setSelectedMember(m)}
                  >
                    {m.name}
                  </button>
                </td>
                <td className="pr-3">{m.license ?? "—"}</td>
                {isHonbuKeikoGroup(group) && (
                  <td className="pr-3">{m.paymentMethod ?? "—"}</td>
                )}
                <td>{m.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isHonbuKeikoGroup(group) && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">許状履歴</h2>
            <button
              className="text-xs border border-line text-ink rounded px-3 py-1.5"
              onClick={() => setShowLicenseHistory((v) => !v)}
            >
              {showLicenseHistory ? "隠す" : "許状履歴を見る"}
            </button>
          </div>
          {showLicenseHistory && (
            <div className="mt-3 space-y-3">
              {members.map((m) => {
                const acquired = LICENSE_FEES.filter((l) => m.licenseHistory?.[l.name]);
                return (
                  <div key={m.id} className="border-b border-line pb-2">
                    <div className="text-sm font-semibold mb-1">{m.name}</div>
                    {acquired.length === 0 ? (
                      <p className="text-xs text-muted">茶歴の記録がありません</p>
                    ) : (
                      <p className="text-xs leading-relaxed">
                        {acquired.map((l, i) => (
                          <span key={l.name}>
                            <span
                              className={
                                l.name === m.license
                                  ? "bg-matcha-pale text-matcha-deep font-semibold rounded px-1.5 py-0.5"
                                  : ""
                              }
                            >
                              {l.name}（{formatYearMonth(m.licenseHistory?.[l.name])}）
                            </span>
                            {i < acquired.length - 1 && <span className="text-muted mx-1">→</span>}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                );
              })}
              {members.length === 0 && (
                <p className="text-sm text-muted text-center py-4">会員がいません</p>
              )}
            </div>
          )}
        </section>
      )}

      <section className="bg-paper border border-line rounded-md p-5 mb-6">
        <h2 className="font-bold mb-2">出席簿</h2>
        <AttendanceGrid
          members={members}
          editable
          onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
        />
      </section>

      {isHonbuKeikoGroup(group) && (
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
            className="w-full border border-line rounded px-3 py-2 text-sm mb-2"
            value={applyLicenseName}
            onChange={(e) => setApplyLicenseName(e.target.value)}
          >
            {LICENSE_FEES.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name}（¥{(l.fee + l.rei).toLocaleString()}）
              </option>
            ))}
          </select>
          <label className="block text-xs text-muted mb-1">申請月（許状に記載する月）</label>
          <input
            type="month"
            className="w-full border border-line rounded px-3 py-2 text-sm mb-3"
            value={applyIssueMonth}
            onChange={(e) => setApplyIssueMonth(e.target.value)}
          />
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

      {isHonbuKeikoGroup(group) && (
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
                      {LICENSE_STATUS_EMOJI[r.status]} {r.status}
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

      {selectedMember && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={() => setSelectedMember(null)}
        >
          <div
            className="bg-paper border border-line rounded-md p-6 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-bold text-matcha-deep">{selectedMember.name}</h3>
                <p className="text-xs text-muted">会員番号：{selectedMember.id}</p>
              </div>
              <button
                type="button"
                className="text-muted text-sm"
                onClick={() => setSelectedMember(null)}
              >
                閉じる
              </button>
            </div>
            <dl className="text-sm space-y-2">
              {groupHasGuardianField(group) && (
                <div className="flex justify-between border-b border-line pb-2">
                  <dt className="text-muted">保護者名</dt>
                  <dd>{selectedMember.guardian ?? "—"}</dd>
                </div>
              )}
              <div className="flex justify-between border-b border-line pb-2">
                <dt className="text-muted">登録メールアドレス</dt>
                <dd>{selectedMember.email || "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">入会日</dt>
                <dd>{selectedMember.joinDate || "—"}</dd>
              </div>
            </dl>

            {group === "茶道教室" && (
              <div className="mt-4 pt-4 border-t border-line">
                <h4 className="text-sm font-bold mb-1">生徒の申し送り</h4>
                <p className="text-xs text-muted mb-2">
                  講師間・本部の引き継ぎ用の内部メモです（生徒本人には表示されません）。
                </p>
                <div className="space-y-2 mb-3 max-h-56 overflow-y-auto">
                  {studentNotes.length === 0 && (
                    <p className="text-xs text-muted">まだ記録がありません。</p>
                  )}
                  {studentNotes.map((n) => (
                    <div key={n.id} className="border border-line rounded p-2 text-xs">
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-muted">
                          {n.date}　{n.authorName}
                        </span>
                        <button
                          className="text-muted hover:text-red-700"
                          onClick={() => deleteStudentNote(n.id)}
                        >
                          削除
                        </button>
                      </div>
                      <p className="whitespace-pre-wrap">{n.body}</p>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <input
                    type="date"
                    className="input"
                    value={newNoteDate}
                    onChange={(e) => setNewNoteDate(e.target.value)}
                  />
                  <textarea
                    className="input w-full"
                    rows={2}
                    placeholder="例：割稽古の柄杓の扱いを中心に。次回は総稽古から。"
                    value={newNoteBody}
                    onChange={(e) => setNewNoteBody(e.target.value)}
                  />
                  <button
                    className="text-sm bg-matcha-deep text-white rounded px-3 py-2 disabled:opacity-50 w-full"
                    onClick={addStudentNote}
                    disabled={savingNote || !newNoteBody.trim()}
                  >
                    記録する
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
