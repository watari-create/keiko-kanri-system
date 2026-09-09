"use client";

export const dynamic = "force-dynamic";

// 本部用の管理画面。
// 上部タブで「宗徧流稽古／本部稽古／UCI／スタッフ管理」の4エリアを切り替える。
// ①名簿の閲覧・編集 ②許状申請の進行 ③退会・休会・復会申請の承認 ④新着通知（申請中の案件一覧）
// ⑤スタッフ（世話人・講師）アカウントの管理 をFirestore連携で実装している。
// 出席簿・入金確認などは、同じパターン（Firestoreのコレクションを読み書きするだけ）で追加できる。

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  deleteDoc,
  deleteField,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import AttendanceGrid from "@/components/AttendanceGrid";
import { formatLessonDate, type NextLessonInfo } from "@/lib/nextLesson";
import type {
  Member,
  LicenseRequest,
  LicenseStatus,
  LeaveRequest,
  PaymentMethod,
  Rsvp,
  StaffAccount,
  StaffRole,
} from "@/types";

type Area = "宗徧流稽古" | "本部稽古" | "UCI" | "スタッフ管理";
const AREA_LIST: Area[] = ["宗徧流稽古", "本部稽古", "UCI", "スタッフ管理"];

// エリアごとの対象グループ。UCI・スタッフ管理はグループ選択なし（下のコードで分岐）。
const AREA_GROUPS: Record<string, string[]> = {
  "宗徧流稽古": ["雪月花", "一喝会", "星組", "不識会", "萌芽会", "紅月会"],
  "本部稽古": ["名月会", "茶道教室", "Gマダムの茶の湯講座"],
};

const AREA_DESCRIPTION: Record<Area, string> = {
  "宗徧流稽古":
    "直門（雪月花・一喝会・星組・不識会）・萌芽会・紅月会が対象。世話人が名簿と出席を管理します。",
  "本部稽古":
    "名月会・茶道教室・Gマダムの茶の湯講座が対象。管理画面（本部・世話人向け）とお客様ページ（生徒向け）の2面構成です。",
  "UCI": "UCIの会員名簿です。グループ構成が決まり次第、グループ別の表示に対応します。",
  "スタッフ管理": "世話人・講師のアカウントを登録・編集します。",
};

const LICENSE_STAGES: LicenseStatus[] = [
  "受付",
  "請求書発行済",
  "発行手続き中",
  "発行済",
  "お渡し済",
  "完了",
];
const LEAVE_STATUS_LABEL: Record<LeaveRequest["status"], string> = {
  pending: "申請中",
  approved: "承認済",
  rejected: "却下",
};
const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  sewanin: "世話人",
  teacher: "講師",
};

// 会員詳細モーダルで編集する項目。group / groupCategory / id は表示のみ（変更不可）。
type MemberDraft = Omit<Member, "id" | "group" | "groupCategory">;

function toDraft(m: Member): MemberDraft {
  const { id, group, groupCategory, ...rest } = m;
  return rest;
}

function areaForGroup(g: string): Area {
  if (AREA_GROUPS["本部稽古"].includes(g)) return "本部稽古";
  if (AREA_GROUPS["宗徧流稽古"].includes(g)) return "宗徧流稽古";
  return "UCI";
}

interface StaffDraft {
  mode: "new" | "edit";
  id: string;
  name: string;
  role: StaffRole;
  groupsText: string;
  email: string;
}

export default function AdminPage() {
  const { role, loading } = useAuth();
  const router = useRouter();

  const [area, setArea] = useState<Area>("本部稽古");
  const [group, setGroup] = useState(AREA_GROUPS["本部稽古"][0]);

  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<LicenseRequest[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [staffList, setStaffList] = useState<StaffAccount[]>([]);

  // 通知バッジ用：グループを問わず、対応が必要な申請をすべて購読する
  const [allLicenseRequests, setAllLicenseRequests] = useState<LicenseRequest[]>([]);
  const [allLeaveRequests, setAllLeaveRequests] = useState<LeaveRequest[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  // 会員詳細・編集モーダル
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [savingDetail, setSavingDetail] = useState(false);

  // スタッフ編集モーダル
  const [staffDraft, setStaffDraft] = useState<StaffDraft | null>(null);
  const [savingStaff, setSavingStaff] = useState(false);

  // 次回のお稽古（Googleカレンダー同期）
  const [nextLesson, setNextLesson] = useState<NextLessonInfo | null>(null);

  // 権限チェック：本部以外はログインページへ
  useEffect(() => {
    if (!loading && role !== "honbu") router.replace("/login");
  }, [loading, role, router]);

  useEffect(() => {
    if (area !== "本部稽古") {
      setNextLesson(null);
      return;
    }
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      const dates = snap.data()?.dates as Record<string, NextLessonInfo> | undefined;
      setNextLesson(dates?.[group] ?? null);
    });
  }, [area, group]);

  function switchArea(a: Area) {
    setArea(a);
    setShowNotifications(false);
    if (AREA_GROUPS[a]) setGroup(AREA_GROUPS[a][0]);
  }

  // 会員一覧をリアルタイム購読
  useEffect(() => {
    if (area === "スタッフ管理") {
      setMembers([]);
      return;
    }
    const q =
      area === "UCI"
        ? query(collection(db, "members"), where("groupCategory", "==", "UCI"))
        : query(collection(db, "members"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Member)));
    });
  }, [area, group]);

  // 許状申請をリアルタイム購読（本部稽古のみ。宗徧流稽古は許状申請の仕組みを使わない）
  useEffect(() => {
    if (area !== "本部稽古") {
      setRequests([]);
      return;
    }
    const q = query(collection(db, "licenseRequests"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LicenseRequest)));
    });
  }, [area, group]);

  // 退会・休会・復会申請をリアルタイム購読（本部稽古のみ）
  useEffect(() => {
    if (area !== "本部稽古") {
      setLeaveRequests([]);
      return;
    }
    const q = query(collection(db, "leaveRequests"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setLeaveRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LeaveRequest)));
    });
  }, [area, group]);

  // スタッフ一覧をリアルタイム購読（スタッフ管理エリアのみ）
  useEffect(() => {
    if (area !== "スタッフ管理") return;
    return onSnapshot(collection(db, "staff"), (snap) => {
      setStaffList(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StaffAccount)));
    });
  }, [area]);

  // 通知バッジ：全ての会をまたいで、対応中の許状申請・退会等申請を購読
  useEffect(() => {
    const unsubLicense = onSnapshot(collection(db, "licenseRequests"), (snap) => {
      setAllLicenseRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LicenseRequest)));
    });
    const unsubLeave = onSnapshot(collection(db, "leaveRequests"), (snap) => {
      setAllLeaveRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LeaveRequest)));
    });
    return () => {
      unsubLicense();
      unsubLeave();
    };
  }, []);

  const pendingLicense = useMemo(
    () => allLicenseRequests.filter((r) => r.status !== "完了" && r.status !== "取消"),
    [allLicenseRequests]
  );
  const pendingLeave = useMemo(
    () => allLeaveRequests.filter((r) => r.status === "pending"),
    [allLeaveRequests]
  );
  const notificationCount = pendingLicense.length + pendingLeave.length;

  const showBilling = area === "本部稽古";
  const showAffiliation = area === "UCI";
  const colCount = 6 + (showAffiliation ? 1 : 0) + (showBilling ? 4 : 0);

  async function updateMemberField<K extends keyof Member>(
    memberId: string,
    field: K,
    value: Member[K]
  ) {
    await updateDoc(doc(db, "members", memberId), { [field]: value });
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

  async function advanceLicense(req: LicenseRequest) {
    if (req.status === "取消") return;
    const idx = LICENSE_STAGES.indexOf(req.status);
    if (idx === -1 || idx >= LICENSE_STAGES.length - 1) return;
    const nextStatus = LICENSE_STAGES[idx + 1];
    await updateDoc(doc(db, "licenseRequests", req.id), {
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });
    // 許状段階の反映・通知はCloud Functions（onLicenseIssued）が自動で行う
  }

  async function revertLicense(req: LicenseRequest) {
    if (req.status === "取消") return;
    const idx = LICENSE_STAGES.indexOf(req.status);
    if (idx <= 0) return;
    const prevStatus = LICENSE_STAGES[idx - 1];
    await updateDoc(doc(db, "licenseRequests", req.id), {
      status: prevStatus,
      updatedAt: new Date().toISOString(),
    });
  }

  async function cancelLicenseRequest(req: LicenseRequest) {
    if (!confirm(`${req.memberName}さんの許状申請（${req.licenseName}）を取り消しますか？`)) return;
    await updateDoc(doc(db, "licenseRequests", req.id), {
      status: "取消",
      updatedAt: new Date().toISOString(),
    });
  }

  async function decideLeave(req: LeaveRequest, decision: "approved" | "rejected") {
    await updateDoc(doc(db, "leaveRequests", req.id), {
      status: decision,
      approvedAt: new Date().toISOString(),
    });
    // 承認時の会員ステータス反映はCloud Functions（onLeaveRequestApproved）が自動で行う
  }

  function openMemberDetail(m: Member) {
    setSelectedMember(m);
    setDraft(toDraft(m));
  }

  function closeMemberDetail() {
    setSelectedMember(null);
    setDraft(null);
  }

  async function saveMemberDetail() {
    if (!selectedMember || !draft) return;
    setSavingDetail(true);
    try {
      await updateDoc(doc(db, "members", selectedMember.id), { ...draft });
      closeMemberDetail();
    } finally {
      setSavingDetail(false);
    }
  }

  function jumpToNotification(g: string) {
    setArea(areaForGroup(g));
    setGroup(g);
    setShowNotifications(false);
  }

  function openNewStaff() {
    setStaffDraft({ mode: "new", id: "", name: "", role: "sewanin", groupsText: "", email: "" });
  }

  function openEditStaff(s: StaffAccount) {
    setStaffDraft({
      mode: "edit",
      id: s.id,
      name: s.name,
      role: s.role,
      groupsText: s.groups.join("、"),
      email: s.email,
    });
  }

  function closeStaffModal() {
    setStaffDraft(null);
  }

  async function saveStaff() {
    if (!staffDraft) return;
    const id = staffDraft.id.trim();
    const name = staffDraft.name.trim();
    const email = staffDraft.email.trim();
    if (!id || !name || !email) {
      alert("会員番号・氏名・メールアドレスは必須です。");
      return;
    }
    const groups = staffDraft.groupsText
      .split(/[、,]/)
      .map((g) => g.trim())
      .filter(Boolean);
    setSavingStaff(true);
    try {
      await setDoc(doc(db, "staff", id), {
        name,
        role: staffDraft.role,
        groups,
        email,
      });
      closeStaffModal();
    } finally {
      setSavingStaff(false);
    }
  }

  async function removeStaff(s: StaffAccount) {
    if (!confirm(`${s.name}さん（${s.id}）のスタッフアカウントを削除しますか？`)) return;
    await deleteDoc(doc(db, "staff", s.id));
  }

  if (loading || role !== "honbu") return <div className="p-8 text-muted">確認中…</div>;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-matcha-deep">稽古管理システム</h1>
          <p className="text-xs text-muted">会員・出席・入金・許状の一元管理</p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs bg-matcha-deep text-white rounded-full px-3 py-1.5">
            本部として見る
          </span>

          {/* 新着通知 */}
          <div className="relative">
            <button
              className="flex items-center gap-1.5 text-xs bg-paper border border-line rounded-full px-3 py-1.5"
              onClick={() => setShowNotifications((v) => !v)}
            >
              <span>🔔 新着</span>
              {notificationCount > 0 && (
                <span className="bg-hanko text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none">
                  {notificationCount}
                </span>
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 bg-paper border border-line rounded-md shadow-lg z-20 max-h-96 overflow-y-auto">
                {notificationCount === 0 && (
                  <p className="text-xs text-muted text-center py-6">新着の申請はありません</p>
                )}
                {pendingLicense.map((r) => (
                  <button
                    key={r.id}
                    className="w-full text-left px-4 py-3 border-b border-line hover:bg-matcha-pale/40"
                    onClick={() => jumpToNotification(r.group)}
                  >
                    <div className="text-xs text-muted">許状申請</div>
                    <div className="text-sm font-semibold">
                      {r.memberName}（{r.group}）
                    </div>
                    <div className="text-xs text-muted">
                      {r.licenseName} 申請 ・ {r.status}
                    </div>
                  </button>
                ))}
                {pendingLeave.map((r) => (
                  <button
                    key={r.id}
                    className="w-full text-left px-4 py-3 border-b border-line hover:bg-matcha-pale/40"
                    onClick={() => jumpToNotification(r.group)}
                  >
                    <div className="text-xs text-muted">退会・休会・復会申請</div>
                    <div className="text-sm font-semibold">
                      {r.memberName}（{r.group}）
                    </div>
                    <div className="text-xs text-muted">
                      {r.type}申請 ・ {r.reason || "理由の記載なし"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Link
            href="/mypage"
            className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
          >
            マイページ
          </Link>
          <Link
            href="/staff"
            className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
          >
            スタッフ
          </Link>
        </div>
      </div>

      {/* エリアタブ */}
      <div className="flex gap-2 mb-4">
        {AREA_LIST.map((a) => (
          <button
            key={a}
            className={`text-sm rounded-md px-4 py-2 border ${
              area === a
                ? "bg-matcha-deep text-white border-matcha-deep"
                : "bg-paper text-ink border-line"
            }`}
            onClick={() => switchArea(a)}
          >
            {a}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted mb-6">{AREA_DESCRIPTION[area]}</p>

      {area !== "スタッフ管理" && AREA_GROUPS[area] && (
        <div className="flex items-center gap-3 mb-6">
          <select
            className="border border-line rounded px-3 py-2 text-sm"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            {AREA_GROUPS[area].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          {nextLesson && (
            <span className="text-sm text-matcha-deep">
              次回のお稽古：{formatLessonDate(nextLesson.date)}
            </span>
          )}
        </div>
      )}

      {area !== "スタッフ管理" && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto">
          <h2 className="font-bold mb-1">会員名簿</h2>
          <p className="text-xs text-muted mb-3">氏名をクリックすると詳細の閲覧・編集ができます</p>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">会員番号</th>
                {showAffiliation && <th className="pr-3">所属</th>}
                <th className="pr-3">氏名</th>
                <th className="pr-3">保護者名</th>
                <th className="pr-3">許状段階</th>
                <th className="pr-3">入会日</th>
                {showBilling && (
                  <>
                    <th className="pr-3">入金状況</th>
                    <th className="pr-3">次回請求日</th>
                    <th className="pr-3">支払い方法</th>
                    <th className="pr-3">次回出欠</th>
                  </>
                )}
                <th>ステータス</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-line">
                  <td className="py-2 pr-3 text-muted">{m.id}</td>
                  {showAffiliation && <td className="pr-3">{m.group}</td>}
                  <td className="pr-3">
                    <button
                      className="font-semibold text-matcha-deep underline decoration-dotted underline-offset-2"
                      onClick={() => openMemberDetail(m)}
                    >
                      {m.name}
                    </button>
                  </td>
                  <td className="pr-3">{m.guardian ?? "—"}</td>
                  <td className="pr-3">{m.license ?? "—"}</td>
                  <td className="pr-3">{m.joinDate}</td>
                  {showBilling && (
                    <>
                      <td className="pr-3">{m.paymentStatus ?? "—"}</td>
                      <td className="pr-3">{m.nextBillingDate ?? "—"}</td>
                      <td className="pr-3">
                        <select
                          className="border border-line rounded px-2 py-1 text-xs"
                          value={m.paymentMethod ?? "月謝"}
                          onChange={(e) =>
                            updateMemberField(m.id, "paymentMethod", e.target.value as PaymentMethod)
                          }
                        >
                          <option>月謝</option>
                          <option>都度払い</option>
                        </select>
                      </td>
                      <td className="pr-3">{m.rsvp ?? "未回答"}</td>
                    </>
                  )}
                  <td>
                    <select
                      className="border border-line rounded px-2 py-1 text-xs"
                      value={m.status}
                      onChange={(e) =>
                        updateMemberField(m.id, "status", e.target.value as Member["status"])
                      }
                    >
                      <option>在籍</option>
                      <option>休会</option>
                      <option>退会</option>
                    </select>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="py-4 text-center text-muted">
                    この{showAffiliation ? "エリア" : "会"}の会員はまだ登録されていません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {(area === "宗徧流稽古" || area === "本部稽古") && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6">
          <h2 className="font-bold mb-2">出席簿</h2>
          <AttendanceGrid
            members={members}
            editable
            onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
          />
        </section>
      )}

      {area === "本部稽古" && (
        <>
          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <h2 className="font-bold mb-1">
              許状申請（
              {requests.filter((r) => r.status !== "完了" && r.status !== "取消").length}件 対応中）
            </h2>
            <p className="text-xs text-muted mb-3">
              受付 → 請求書発行済 → 発行手続き中 → 発行済 → お渡し済 → 完了 の順に進みます
            </p>
            <div className="space-y-3">
              {requests
                .filter((r) => r.status !== "完了" && r.status !== "取消")
                .map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between border-b border-line pb-3"
                  >
                    <div>
                      <div className="font-semibold text-sm">{r.memberName}</div>
                      <div className="text-xs text-muted">
                        {r.licenseName}　合計：¥{r.fee.toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                        {r.status}
                      </span>
                      {LICENSE_STAGES.indexOf(r.status) > 0 && (
                        <button
                          className="text-xs bg-paper border border-line text-ink rounded px-3 py-1.5"
                          onClick={() => revertLicense(r)}
                        >
                          一つ戻す
                        </button>
                      )}
                      <button
                        className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                        onClick={() => advanceLicense(r)}
                      >
                        次に進める
                      </button>
                      <button
                        className="text-xs bg-paper border border-line text-red-700 rounded px-3 py-1.5"
                        onClick={() => cancelLicenseRequest(r)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ))}
              {requests.filter((r) => r.status !== "完了" && r.status !== "取消").length === 0 && (
                <p className="text-sm text-muted text-center py-4">対応中の申請はありません</p>
              )}
            </div>
          </section>

          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <h2 className="font-bold mb-1">
              退会・休会・復会申請（
              {leaveRequests.filter((r) => r.status === "pending").length}件 対応中）
            </h2>
            <div className="space-y-3">
              {leaveRequests
                .filter((r) => r.status === "pending")
                .map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between border-b border-line pb-3"
                  >
                    <div>
                      <div className="font-semibold text-sm">
                        {r.memberName}
                        <span className="text-xs font-normal text-muted">{r.type}申請</span>
                      </div>
                      <div className="text-xs text-muted">{r.reason || "理由の記載なし"}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                        {LEAVE_STATUS_LABEL[r.status]}
                      </span>
                      <button
                        className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                        onClick={() => decideLeave(r, "approved")}
                      >
                        承認
                      </button>
                      <button
                        className="text-xs border border-line text-muted rounded px-3 py-1.5"
                        onClick={() => decideLeave(r, "rejected")}
                      >
                        却下
                      </button>
                    </div>
                  </div>
                ))}
              {leaveRequests.filter((r) => r.status === "pending").length === 0 && (
                <p className="text-sm text-muted text-center py-4">対応中の申請はありません</p>
              )}
            </div>
          </section>
        </>
      )}

      {area === "スタッフ管理" && (
        <section className="bg-paper border border-line rounded-md p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">スタッフ一覧（{staffList.length}名）</h2>
            <button
              className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
              onClick={openNewStaff}
            >
              ＋ 新規スタッフを追加
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">会員番号</th>
                <th className="pr-3">氏名</th>
                <th className="pr-3">役割</th>
                <th className="pr-3">担当グループ</th>
                <th className="pr-3">メールアドレス</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {staffList.map((s) => (
                <tr key={s.id} className="border-b border-line">
                  <td className="py-2 pr-3 text-muted">{s.id}</td>
                  <td className="pr-3 font-semibold">{s.name}</td>
                  <td className="pr-3">{STAFF_ROLE_LABEL[s.role]}</td>
                  <td className="pr-3">{s.groups.join("、") || "—"}</td>
                  <td className="pr-3">{s.email}</td>
                  <td className="flex items-center gap-2 py-2">
                    <button
                      className="text-xs border border-line text-matcha-deep rounded px-2 py-1"
                      onClick={() => openEditStaff(s)}
                    >
                      編集
                    </button>
                    <button
                      className="text-xs border border-line text-hanko rounded px-2 py-1"
                      onClick={() => removeStaff(s)}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
              {staffList.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted">
                    スタッフはまだ登録されていません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {/* 会員詳細・編集モーダル */}
      {selectedMember && draft && (
        <div
          className="fixed inset-0 bg-ink/40 flex items-center justify-center z-30 p-4"
          onClick={closeMemberDetail}
        >
          <div
            className="bg-paper rounded-md max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-matcha-deep">{selectedMember.name}</h3>
                <p className="text-xs text-muted">
                  会員番号：{selectedMember.id}　所属：{selectedMember.group}
                </p>
              </div>
              <button className="text-muted text-sm" onClick={closeMemberDetail}>
                閉じる ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="氏名">
                <input
                  className="input"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="氏名（フリガナ）">
                <input
                  className="input"
                  value={draft.nameKana ?? ""}
                  onChange={(e) => setDraft({ ...draft, nameKana: e.target.value })}
                />
              </Field>
              <Field label="宗名">
                <input
                  className="input"
                  value={draft.sotomei ?? ""}
                  onChange={(e) => setDraft({ ...draft, sotomei: e.target.value })}
                />
              </Field>
              <Field label="生年月日">
                <input
                  type="date"
                  className="input"
                  value={draft.birthDate ?? ""}
                  onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
                />
              </Field>
              <Field label="保護者名">
                <input
                  className="input"
                  value={draft.guardian ?? ""}
                  onChange={(e) => setDraft({ ...draft, guardian: e.target.value })}
                />
              </Field>
              <Field label="学年">
                <input
                  className="input"
                  value={draft.grade ?? ""}
                  onChange={(e) => setDraft({ ...draft, grade: e.target.value })}
                />
              </Field>
              <Field label="許状段階">
                <input
                  className="input"
                  value={draft.license ?? ""}
                  onChange={(e) => setDraft({ ...draft, license: e.target.value })}
                />
              </Field>
              <Field label="入会日">
                <input
                  type="date"
                  className="input"
                  value={draft.joinDate}
                  onChange={(e) => setDraft({ ...draft, joinDate: e.target.value })}
                />
              </Field>
              <Field label="ステータス">
                <select
                  className="input"
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as Member["status"] })
                  }
                >
                  <option>在籍</option>
                  <option>休会</option>
                  <option>退会</option>
                </select>
              </Field>
              {selectedMember.groupCategory === "本部稽古" && (
                <>
                  <Field label="支払い方法">
                    <select
                      className="input"
                      value={draft.paymentMethod ?? "月謝"}
                      onChange={(e) =>
                        setDraft({ ...draft, paymentMethod: e.target.value as PaymentMethod })
                      }
                    >
                      <option>月謝</option>
                      <option>都度払い</option>
                    </select>
                  </Field>
                  <Field label="入金状況">
                    <select
                      className="input"
                      value={draft.paymentStatus ?? "未納"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          paymentStatus: e.target.value as "済" | "未納",
                        })
                      }
                    >
                      <option>済</option>
                      <option>未納</option>
                    </select>
                  </Field>
                  <Field label="次回請求日">
                    <input
                      type="date"
                      className="input"
                      value={draft.nextBillingDate ?? ""}
                      onChange={(e) => setDraft({ ...draft, nextBillingDate: e.target.value })}
                    />
                  </Field>
                  <Field label="次回出欠">
                    <select
                      className="input"
                      value={draft.rsvp ?? "未回答"}
                      onChange={(e) => setDraft({ ...draft, rsvp: e.target.value as Rsvp })}
                    >
                      <option>出席</option>
                      <option>欠席</option>
                      <option>未回答</option>
                    </select>
                  </Field>
                </>
              )}
              <Field label="メールアドレス">
                <input
                  className="input"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                />
              </Field>
              <Field label="電話番号">
                <input
                  className="input"
                  value={draft.phone ?? ""}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
              </Field>
              <Field label="ご住所" full>
                <input
                  className="input"
                  value={draft.address ?? ""}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
              </Field>
              <Field label="ご職業">
                <input
                  className="input"
                  value={draft.occupation ?? ""}
                  onChange={(e) => setDraft({ ...draft, occupation: e.target.value })}
                />
              </Field>
              <Field label="他のお稽古事">
                <input
                  className="input"
                  value={draft.otherLessons ?? ""}
                  onChange={(e) => setDraft({ ...draft, otherLessons: e.target.value })}
                />
              </Field>
              <Field label="緊急連絡先">
                <input
                  className="input"
                  value={draft.emergencyContact ?? ""}
                  onChange={(e) => setDraft({ ...draft, emergencyContact: e.target.value })}
                />
              </Field>
              <Field label="アレルギー等健康上の留意点" full>
                <input
                  className="input"
                  value={draft.healthNotes ?? ""}
                  onChange={(e) => setDraft({ ...draft, healthNotes: e.target.value })}
                />
              </Field>
              <Field label="お稽古に期待すること" full>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.expectations ?? ""}
                  onChange={(e) => setDraft({ ...draft, expectations: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                className="text-sm border border-line text-muted rounded px-4 py-2"
                onClick={closeMemberDetail}
              >
                キャンセル
              </button>
              <button
                className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
                onClick={saveMemberDetail}
                disabled={savingDetail}
              >
                {savingDetail ? "保存中…" : "この内容で保存する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* スタッフ編集モーダル */}
      {staffDraft && (
        <div
          className="fixed inset-0 bg-ink/40 flex items-center justify-center z-30 p-4"
          onClick={closeStaffModal}
        >
          <div
            className="bg-paper rounded-md max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-lg font-bold text-matcha-deep">
                {staffDraft.mode === "new" ? "新規スタッフを追加" : "スタッフ情報を編集"}
              </h3>
              <button className="text-muted text-sm" onClick={closeStaffModal}>
                閉じる ✕
              </button>
            </div>

            <div className="space-y-3 text-sm">
              <Field label="会員番号（ID）">
                <input
                  className="input"
                  value={staffDraft.id}
                  disabled={staffDraft.mode === "edit"}
                  onChange={(e) => setStaffDraft({ ...staffDraft, id: e.target.value })}
                />
              </Field>
              <Field label="氏名">
                <input
                  className="input"
                  value={staffDraft.name}
                  onChange={(e) => setStaffDraft({ ...staffDraft, name: e.target.value })}
                />
              </Field>
              <Field label="役割">
                <select
                  className="input"
                  value={staffDraft.role}
                  onChange={(e) =>
                    setStaffDraft({ ...staffDraft, role: e.target.value as StaffRole })
                  }
                >
                  <option value="sewanin">世話人</option>
                  <option value="teacher">講師</option>
                </select>
              </Field>
              <Field label="担当グループ（複数の場合は「、」区切り）">
                <input
                  className="input"
                  value={staffDraft.groupsText}
                  onChange={(e) => setStaffDraft({ ...staffDraft, groupsText: e.target.value })}
                  placeholder="例：雪月花、一喝会"
                />
              </Field>
              <Field label="メールアドレス">
                <input
                  className="input"
                  value={staffDraft.email}
                  onChange={(e) => setStaffDraft({ ...staffDraft, email: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                className="text-sm border border-line text-muted rounded px-4 py-2"
                onClick={closeStaffModal}
              >
                キャンセル
              </button>
              <button
                className="text-sm bg-matcha-deep text-white rounded px-4 py-2 disabled:opacity-50"
                onClick={saveStaff}
                disabled={savingStaff}
              >
                {savingStaff ? "保存中…" : "この内容で保存する"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .input {
          width: 100%;
          border: 1px solid #e3decc;
          border-radius: 4px;
          padding: 6px 10px;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${full ? "col-span-2" : ""}`}>
      <span className="block text-xs text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
