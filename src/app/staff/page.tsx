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
  runTransaction,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db, auth } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { LICENSE_FEES, formatYearMonth } from "@/lib/licenseFees";
import { isHonbuKeikoGroup, isUciGroup, groupDisplayName, groupHasGuardianField } from "@/lib/areas";
import { useGroupSettings } from "@/lib/groupSettings";
import AttendanceGrid from "@/components/AttendanceGrid";
import DateAttendanceGrid from "@/components/DateAttendanceGrid";
import ShingetsuAttendanceGrid from "@/components/ShingetsuAttendanceGrid";
import { SHINGETSU_GROUP } from "@/lib/shingetsu";
import MakeupTicketList from "@/components/MakeupTicketList";
import LineMessageLogList from "@/components/LineMessageLogList";
import { formatNextLessons, nextLessonsForGroup, type NextLessonInfo } from "@/lib/nextLesson";
import { currentMonthKey } from "@/lib/fiscalMonths";
import { isChadoSaturdayMember } from "@/lib/chadoClasses";
import { LICENSE_STATUS_EMOJI } from "@/types";
import MonthSelect from "@/components/MonthSelect";
import type { StaffAccount, Member, LicenseRequest, ChadoStudentNote, ChadoSaturdaySession, LineMessageLog } from "@/types";

export default function StaffPage() {
  useGroupSettings(); // 会の設定（表示名・エリア）の読み込み後に再描画する
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
  const [nextLessons, setNextLessons] = useState<{ label: string; info: NextLessonInfo }[]>([]);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [studentNotes, setStudentNotes] = useState<ChadoStudentNote[]>([]);
  const [newNoteDate, setNewNoteDate] = useState("");
  const [newNoteBody, setNewNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [saturdaySessions, setSaturdaySessions] = useState<ChadoSaturdaySession[]>([]);
  const [broadcastSelected, setBroadcastSelected] = useState<Set<string>>(new Set());
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [lineMessageLogs, setLineMessageLogs] = useState<LineMessageLog[]>([]);

  useEffect(() => {
    if (!loading && role !== "staff") router.replace("/staff/login");
  }, [loading, role, router]);

  useEffect(() => {
    setBroadcastSelected(new Set());
    setBroadcastMessage("");
    setBroadcastResult(null);
  }, [group]);

  useEffect(() => {
    if (!group) return;
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      const dates = snap.data()?.dates as Record<string, NextLessonInfo> | undefined;
      setNextLessons(nextLessonsForGroup(dates, group));
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

  // LINE送信履歴（プッシュ・マルチキャスト分。Cloud Functionsが送信のたびに記録している。茶道教室のみ）
  useEffect(() => {
    if (group !== "茶道教室") {
      setLineMessageLogs([]);
      return;
    }
    // group＋sentAtの並べ替えは複合インデックスが必要になるため、groupのみで取得してクライアント側で新しい順に並べる
    const q = query(collection(db, "lineMessageLogs"), where("group", "==", group));
    return onSnapshot(
      q,
      (snap) => {
        const logs = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as LineMessageLog))
          .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
          .slice(0, 300); // 一斉送信は宛先ごとに記録されるため多めに取得し、表示側で1回の送信ごとにまとめて30件に絞る
        setLineMessageLogs(logs);
      },
      (err) => console.error("LINE送信履歴の取得に失敗しました", err)
    );
  }, [group]);

  // 茶道教室：土曜日クラスの開催日・予約状況をリアルタイム購読。
  // 講師が開催後に出欠を付けられるよう、過去45日分の開催日も含める。
  useEffect(() => {
    if (group !== "茶道教室") {
      setSaturdaySessions([]);
      return;
    }
    const fromKey = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const q = query(
      collection(db, "chadoSaturdaySessions"),
      where("date", ">=", fromKey),
      orderBy("date")
    );
    return onSnapshot(q, (snap) => {
      setSaturdaySessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoSaturdaySession)));
    });
  }, [group]);

  useEffect(() => {
    // 許状申請は本部稽古（名月会・茶道教室・Gマダムの茶の湯講座・新月会）のグループのみ対象。
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
      where("memberId", "==", selectedMember.id)
    );
    // 並べ替えは画面側で行う（orderByを付けると複合インデックスが必要になり、未作成だと一覧が読めないため）
    return onSnapshot(
      q,
      (snap) => {
        const notes = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoStudentNote));
        notes.sort((a, b) =>
          a.date !== b.date ? b.date.localeCompare(a.date) : (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        );
        setStudentNotes(notes);
      },
      (err) => console.error("申し送りの読み込みに失敗しました", err)
    );
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
    } catch (err) {
      console.error(err);
      alert("申し送りを保存できませんでした。時間をおいて再度お試しください。");
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

  // 土曜日クラスの開催日ごとの出欠記録。「欠席」にすると振替チケットが1枚付与される
  // （付与・取消と出席簿への反映は Cloud Functions の onChadoSaturdaySessionAttendanceChanged が行う）。
  async function setSaturdayBookingAttendance(
    sessionId: string,
    slot: "am" | "pm",
    memberId: string,
    value: "出席" | "欠席" | undefined
  ) {
    const sessionRef = doc(db, "chadoSaturdaySessions", sessionId);
    await runTransaction(db, async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists()) return;
      const data = sessionSnap.data() as ChadoSaturdaySession;
      const field = slot === "am" ? "amBookings" : "pmBookings";
      const bookings = (slot === "am" ? data.amBookings : data.pmBookings) ?? [];
      const idx = bookings.findIndex((b) => b.memberId === memberId);
      if (idx === -1) return;
      const updated = bookings.slice();
      const next = { ...updated[idx] };
      if (value === undefined) delete next.attended;
      else next.attended = value;
      updated[idx] = next;
      tx.update(sessionRef, { [field]: updated });
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
          {isHonbuKeikoGroup(group) ? "本部稽古" : isUciGroup(group) ? "UCI" : "宗徧流稽古"}
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
          {group === "Gマダムの茶の湯講座" && (
            <Link
              href="/g1-shipping"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
            >
              G1発送物
            </Link>
          )}
          <button className="text-xs text-muted underline" onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>

      <div className="text-sm text-muted mb-1">
        {account.name}さんとしてログイン中（担当：{account.groups.map(groupDisplayName).join("・")}）
      </div>
      <div className="text-sm text-matcha-deep mb-4">
        {nextLessons.length > 0
          ? `${groupDisplayName(group)} 次回のお稽古：${formatNextLessons(nextLessons)}`
          : "\u00A0"}
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
              {group === "茶道教室" && (
                <th className="py-2 pr-2">
                  <input
                    type="checkbox"
                    checked={members.length > 0 && members.every((m) => broadcastSelected.has(m.id))}
                    onChange={(e) => {
                      if (e.target.checked) setBroadcastSelected(new Set(members.map((m) => m.id)));
                      else setBroadcastSelected(new Set());
                    }}
                  />
                </th>
              )}
              <th className="py-2 pr-3">会員番号</th>
              <th className="pr-3">氏名</th>
              <th className="pr-3">許状段階</th>
              {isHonbuKeikoGroup(group) && group !== "茶道教室" && <th className="pr-3">支払い方法</th>}
              <th>ステータス</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-line">
                {group === "茶道教室" && (
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={broadcastSelected.has(m.id)}
                      onChange={(e) => {
                        setBroadcastSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                )}
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
                {isHonbuKeikoGroup(group) && group !== "茶道教室" && (
                  <td className="pr-3">{m.paymentMethod ?? "—"}</td>
                )}
                <td>{m.status}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {group === "茶道教室" && (
        <div className="mt-4 pt-4 border-t border-line">
          <h3 className="text-sm font-bold mb-2">LINE一斉送信</h3>
          <p className="text-xs text-muted mb-2">
            チェックした{broadcastSelected.size}名（LINE未連携の生徒には届きません）にメッセージを送ります。
          </p>
          <textarea
            className="input w-full mb-2"
            rows={3}
            placeholder="例：来週のお稽古はお休みです。"
            value={broadcastMessage}
            onChange={(e) => setBroadcastMessage(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-sm bg-matcha-deep text-white rounded px-3 py-2 disabled:opacity-50"
              disabled={sendingBroadcast || broadcastSelected.size === 0 || !broadcastMessage.trim()}
              onClick={async () => {
                setSendingBroadcast(true);
                setBroadcastResult(null);
                try {
                  const send = httpsCallable<
                    { memberIds: string[]; message: string },
                    { sent: number; skipped: string[] }
                  >(getFunctions(), "sendStaffLineBroadcast");
                  const res = await send({
                    memberIds: Array.from(broadcastSelected),
                    message: broadcastMessage.trim(),
                  });
                  const { sent, skipped } = res.data;
                  setBroadcastResult(
                    skipped.length > 0
                      ? `${sent}名に送信しました（LINE未連携などで${skipped.length}名には届きませんでした）`
                      : `${sent}名に送信しました。`
                  );
                  setBroadcastMessage("");
                  setBroadcastSelected(new Set());
                } catch (err) {
                  setBroadcastResult(
                    err instanceof Error ? `送信に失敗しました：${err.message}` : "送信に失敗しました。"
                  );
                } finally {
                  setSendingBroadcast(false);
                }
              }}
            >
              {sendingBroadcast ? "送信中…" : "選択した生徒にLINE送信"}
            </button>
            {broadcastResult && <p className="text-xs text-muted">{broadcastResult}</p>}
          </div>
        </div>
        )}
      </section>

      {group === "茶道教室" && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6">
          <h2 className="font-bold mb-1">公式LINE送信履歴</h2>
          <p className="text-xs text-muted mb-3">
            自動リマインド・一斉送信で実際に送った内容です（LINE公式アカウントマネージャーの
            チャット画面には表示されないため、こちらで確認してください）。直近30件を表示しています。行をクリックすると全文を表示します。
          </p>
          <LineMessageLogList logs={lineMessageLogs} />
        </section>
      )}

      {group === "茶道教室" && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6">
          <h2 className="font-bold mb-1">土曜日クラスの予約状況・出欠</h2>
          <p className="text-xs text-muted mb-3">
            直近45日以降の開催日と、午前・午後それぞれの予約者です。お稽古のあと、予約者ごとに出席・欠席を付けてください。
            「欠席」にすると振替チケットが1枚付与されます（予約していない回はチケットになりません）。
          </p>
          <MakeupTicketList members={members} />
          <div className="space-y-3">
            {saturdaySessions.map((s) => (
              <div key={s.id} className="border border-line rounded p-3">
                <p className="text-sm font-semibold mb-2">{s.date}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {(["am", "pm"] as const).map((slot) => {
                    const teacher = slot === "am" ? s.amTeacher : s.pmTeacher;
                    const capacity = slot === "am" ? s.amCapacity : s.pmCapacity;
                    const bookings = slot === "am" ? s.amBookings : s.pmBookings;
                    return (
                      <div key={slot}>
                        <p className="font-semibold mb-1">
                          {slot === "am" ? "午前" : "午後"}
                          {teacher && `　${teacher}`}　（{bookings.length}/{capacity}名）
                        </p>
                        {bookings.length === 0 ? (
                          <p className="text-muted">予約なし</p>
                        ) : (
                          <ul className="space-y-0.5">
                            {bookings.map((b) => (
                              <li key={b.memberId} className="flex items-center justify-between gap-2">
                                <span>
                                  {b.memberName}
                                  {b.usedTicket && (
                                    <span className="text-muted">（振替チケット使用）</span>
                                  )}
                                </span>
                                <select
                                  className={`border border-line rounded px-1 py-0.5 text-xs ${
                                    b.attended === "欠席"
                                      ? "text-hanko"
                                      : b.attended === "出席"
                                      ? "text-matcha-deep font-bold"
                                      : ""
                                  }`}
                                  value={b.attended ?? ""}
                                  onChange={(e) =>
                                    setSaturdayBookingAttendance(
                                      s.id,
                                      slot,
                                      b.memberId,
                                      (e.target.value || undefined) as "出席" | "欠席" | undefined
                                    )
                                  }
                                >
                                  <option value="">未確認</option>
                                  <option value="出席">出席</option>
                                  <option value="欠席">欠席</option>
                                </select>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {saturdaySessions.length === 0 && (
              <p className="text-sm text-muted text-center py-4">
                直近の開催日はまだ登録されていません
              </p>
            )}
          </div>
        </section>
      )}

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
        {group === SHINGETSU_GROUP ? (
          // 新月会：会員×開催日（日付・場所）の出席簿。マイページの回答と同じデータを編集する
          <ShingetsuAttendanceGrid members={members} editable canEditSessions />
        ) : group === "茶道教室" ? (
          // 茶道教室：会員×お稽古日（日にち）の出席簿（名月会・G1などは月ごとのまま）。「月ごと」に切り替えるとこれまでの月単位の記録を表示
          <DateAttendanceGrid
            group={group}
            sections={[{ label: null, members }]}
            editable
            monthlyView={
              <AttendanceGrid
                members={members}
                editable
                isRowEditable={(m) => !isChadoSaturdayMember(m)}
                onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
              />
            }
          />
        ) : (
        <AttendanceGrid
          members={members}
          editable
          isRowEditable={(m) => !isChadoSaturdayMember(m)}
          onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
        />
        )}
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
          <MonthSelect
            className="mb-3"
            selectClassName="flex-1 border border-line rounded px-3 py-2 text-sm bg-white"
            value={applyIssueMonth}
            onChange={setApplyIssueMonth}
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
            className="bg-paper border border-line rounded-md p-6 max-w-md w-full max-h-[85vh] overflow-y-auto"
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
