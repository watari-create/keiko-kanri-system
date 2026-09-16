"use client";

export const dynamic = "force-dynamic";

// 本部用の管理画面。
// 上部タブで「宗徧流稽古／本部稽古／経理／スタッフ管理」の4エリアを切り替える。
// ①名簿の閲覧・編集 ②許状申請の進行 ③退会・休会・復会申請の承認 ④新着通知（申請中の案件一覧）
// ⑤スタッフ（世話人・講師）アカウントの管理 をFirestore連携で実装している。
// 出席簿・入金確認などは、同じパターン（Firestoreのコレクションを読み書きするだけ）で追加できる。

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  setDoc,
  deleteDoc,
  deleteField,
  runTransaction,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import AttendanceGrid from "@/components/AttendanceGrid";
import { formatLessonDate, type NextLessonInfo } from "@/lib/nextLesson";
import { fiscalYearMonths, monthLabel } from "@/lib/fiscalMonths";
import { LICENSE_STATUS_EMOJI } from "@/types";
import { LICENSE_FEES, formatYearMonth } from "@/lib/licenseFees";
import { groupDisplayName, groupHasGuardianField } from "@/lib/areas";
import CsvImportModal from "@/components/CsvImportModal";
import { CHADO_CLASSES, CHADO_SATURDAY_DEFAULT_CAPACITY } from "@/lib/chadoClasses";
import type {
  Member,
  LicenseRequest,
  LicenseStatus,
  LeaveRequest,
  PaymentMethod,
  StaffAccount,
  StaffRole,
  NyumonSetInventory,
  ChadoSaturdaySession,
  ChadoStudentNote,
} from "@/types";

type Area = "宗徧流稽古" | "本部稽古" | "経理" | "スタッフ管理";
const AREA_LIST: Area[] = ["宗徧流稽古", "本部稽古", "経理", "スタッフ管理"];

// 経理タブの対象グループ（名月会・Gマダムの茶の湯講座のみ）
const KEIRI_GROUPS = ["名月会", "Gマダムの茶の湯講座"];

// エリアごとの対象グループ。経理・スタッフ管理はグループ選択なし（下のコードで分岐）。
const AREA_GROUPS: Record<string, string[]> = {
  "宗徧流稽古": ["雪月花", "一喝会", "星組", "不識会", "萌芽会", "紅月会"],
  "本部稽古": ["名月会", "茶道教室", "Gマダムの茶の湯講座"],
};

// 雪月花は雪組・月組・花組の3つの実際のグループを束ねたもの。名簿はこの3区分で表示する。
const SOHEN_SUBGROUPS = ["雪組", "月組", "花組"];

const AREA_DESCRIPTION: Record<Area, string> = {
  "宗徧流稽古":
    "直門（雪月花・一喝会・星組・不識会）・萌芽会・紅月会が対象。世話人が名簿と出席を管理します。",
  "本部稽古":
    "名月会・茶道教室・G1マダムの茶の湯講座が対象。管理画面（本部・世話人向け）とお客様ページ（生徒向け）の2面構成です。",
  "経理": "名月会・G1マダムの茶の湯講座が対象。出席ごとの月謝・許状代金・入会金の入金状況を確認できます。",
  "スタッフ管理": "世話人・講師のアカウントを登録・編集します。",
};

const LICENSE_STAGES: LicenseStatus[] = [
  "受付",
  "請求書発行依頼",
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
  // UCIタブ廃止（経理タブに置き換え）に伴い、どちらにも属さない会は本部稽古にフォールバックする
  return "本部稽古";
}

// 名月会の入門セット在庫。まだ何も登録されていない場合は、以下の5品目を0件で初期表示する
// （年齢・性別に応じて入会時に自動で減算される品目。functions/src/index.tsのdecrementNyumonSetInventoryと対にしてある）。
type InventoryDraftRow = { name: string; qty: string };
function inventoryToDraft(items: Record<string, number> | undefined): InventoryDraftRow[] {
  const entries = Object.entries(items ?? {});
  if (entries.length === 0) {
    return [
      { name: "子供用服紗（3歳から8歳まで）", qty: "0" },
      { name: "服紗（9歳以上）", qty: "0" },
      { name: "扇子　女性用", qty: "0" },
      { name: "扇子　男性用", qty: "0" },
      { name: "懐紙", qty: "0" },
    ];
  }
  return entries.map(([name, qty]) => ({ name, qty: String(qty) }));
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

  // CSV名簿インポート（宗徧流稽古のみ）
  const [showCsvImport, setShowCsvImport] = useState(false);

  // 次回のお稽古（Googleカレンダー同期）
  const [nextLesson, setNextLesson] = useState<NextLessonInfo | null>(null);

  // 名月会 入門セット在庫（本部稽古エリアのみ購読）
  const [inventory, setInventory] = useState<NyumonSetInventory | null>(null);
  const [inventoryDraft, setInventoryDraft] = useState<InventoryDraftRow[] | null>(null);
  const [savingInventory, setSavingInventory] = useState(false);

  // 茶道教室：土曜日クラスの開催日・予約状況（本部稽古エリア／茶道教室グループのみ購読）
  const [saturdaySessions, setSaturdaySessions] = useState<ChadoSaturdaySession[]>([]);
  const [newSessionDate, setNewSessionDate] = useState("");

  // 茶道教室：生徒ごとの進捗申し送り（会員詳細モーダルを開いている間のみ購読）
  const [studentNotes, setStudentNotes] = useState<ChadoStudentNote[]>([]);
  const [newNoteDate, setNewNoteDate] = useState("");
  const [newNoteBody, setNewNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // 権限チェック：本部以外はログインページへ
  useEffect(() => {
    if (!loading && role !== "honbu") router.replace("/login");
  }, [loading, role, router]);

  // Slack通知の「detail」ボタン（?licenseRequestId=...）から来た場合、
  // 許状申請セクションのその申請までスクロールして知らせる。
  const [highlightRequestId, setHighlightRequestId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("licenseRequestId");
    if (!id) return;
    setArea("本部稽古");
    setHighlightRequestId(id);
  }, []);
  useEffect(() => {
    if (!highlightRequestId) return;
    const el = document.getElementById(`license-request-${highlightRequestId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRequestId, requests]);

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

  // 名月会 入門セット在庫をリアルタイム購読（本部稽古エリアを開いている間のみ）
  useEffect(() => {
    if (area !== "本部稽古") {
      setInventory(null);
      return;
    }
    return onSnapshot(doc(db, "meta", "nyumonSetInventory"), (snap) => {
      setInventory(snap.exists() ? (snap.data() as NyumonSetInventory) : null);
    });
  }, [area]);

  // 茶道教室：土曜日クラスの開催日・予約状況をリアルタイム購読（本部稽古エリア／茶道教室グループを開いている間のみ）
  useEffect(() => {
    if (area !== "本部稽古" || group !== "茶道教室") {
      setSaturdaySessions([]);
      return;
    }
    const q = query(collection(db, "chadoSaturdaySessions"), orderBy("date"));
    return onSnapshot(q, (snap) => {
      setSaturdaySessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoSaturdaySession)));
    });
  }, [area, group]);

  // 茶道教室：会員詳細モーダルで選択中の生徒の申し送りをリアルタイム購読
  useEffect(() => {
    if (!selectedMember || selectedMember.group !== "茶道教室") {
      setStudentNotes([]);
      return;
    }
    const q = query(
      collection(db, "chadoStudentNotes"),
      where("memberId", "==", selectedMember.id),
      orderBy("date", "desc"),
      orderBy("createdAt", "desc")
    );
    return onSnapshot(q, (snap) => {
      setStudentNotes(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChadoStudentNote)));
    });
  }, [selectedMember]);

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
      area === "経理"
        ? query(collection(db, "members"), where("group", "in", KEIRI_GROUPS))
        : query(collection(db, "members"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Member)));
    });
  }, [area, group]);

  // 許状申請をリアルタイム購読（本部稽古・経理のみ。宗徧流稽古は許状申請の仕組みを使わない）
  useEffect(() => {
    if (area !== "本部稽古" && area !== "経理") {
      setRequests([]);
      return;
    }
    const q =
      area === "経理"
        ? query(collection(db, "licenseRequests"), where("group", "in", KEIRI_GROUPS))
        : query(collection(db, "licenseRequests"), where("group", "==", group));
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
  const showAffiliation = false; // UCIタブ廃止（経理タブに置き換え）により所属列は使用しない
  const showSohenDetails = area === "宗徧流稽古";
  const showGuardian = !showSohenDetails && groupHasGuardianField(group); // 宗徧流稽古・茶道教室・Gマダムの茶の湯講座は保護者欄を使わない
  const showChadoClass = area === "本部稽古" && group === "茶道教室"; // 茶道教室のみ、曜日クラス列を表示
  const colCount =
    5 +
    (showGuardian ? 1 : 0) +
    (showAffiliation ? 1 : 0) +
    (showBilling ? 2 : 0) +
    (showSohenDetails ? 3 : 0) +
    (showChadoClass ? 1 : 0);

  // 雪月花のみ、組（雪組・月組・花組）ごとに名簿を区切って表示する
  const memberSections = useMemo(() => {
    if (group !== "雪月花") return [{ label: null as string | null, members }];
    const bySub = new Map<string, Member[]>();
    SOHEN_SUBGROUPS.forEach((s) => bySub.set(s, []));
    const others: Member[] = [];
    members.forEach((m) => {
      const list = m.subGroup ? bySub.get(m.subGroup) : undefined;
      if (list) list.push(m);
      else others.push(m);
    });
    const sections = SOHEN_SUBGROUPS.map((s) => ({
      label: s as string | null,
      members: bySub.get(s)!,
    })).filter((sec) => sec.members.length > 0);
    if (others.length > 0) sections.push({ label: "組未設定", members: others });
    return sections;
  }, [group, members]);

  // 経理タブ：都度払い会員の月謝グリッド対象（休会・退会中は対象外。アンジェラさんのように休会中の会員は掲載しない）
  const sessionPaymentMembers = useMemo(
    () => members.filter((m) => m.paymentMethod === "都度払い" && m.status === "在籍"),
    [members]
  );

  // 経理タブ：入会金の対象会員（名月会のみ）。入会金の徴収は吉井さんの入会から始まったため、
  // 吉井さんより前に入会した会員は対象外。吉井さん以降に入会した会員（今後の新規入会者を含む）のみ表示する
  const entryFeeMembers = useMemo(() => {
    const meigetsukai = members.filter((m) => m.group === "名月会");
    const yoshii = meigetsukai.find((m) => m.name.includes("吉井"));
    return yoshii ? meigetsukai.filter((m) => m.joinDate >= yoshii.joinDate) : meigetsukai;
  }, [members]);

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

  // 経理タブ：入会金の入金状況（名月会のみ）
  async function setEntryFeeStatus(memberId: string, value: "済" | "未納") {
    await updateMemberField(memberId, "entryFeeStatus", value);
  }

  // 経理タブ：都度払い会員の、出席した月ごとの月謝入金状況
  async function setSessionPayment(
    memberId: string,
    monthKey: string,
    value: "済" | "未納" | undefined
  ) {
    await updateDoc(doc(db, "members", memberId), {
      [`sessionPayments.${monthKey}`]: value === undefined ? deleteField() : value,
    });
  }

  // 経理タブ：許状代金の入金確認（許状の進行ステータスとは独立して経理側で管理する）
  async function setLicenseAccountingStatus(requestId: string, value: "済" | "未納") {
    await updateDoc(doc(db, "licenseRequests", requestId), { accountingPaymentStatus: value });
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

  // 生年月日から満年齢を計算する（印刷時点の年齢を毎回計算するため、常に最新）。
  function calculateAge(birthDate?: string, at: Date = new Date()): number | null {
    if (!birthDate) return null;
    const bd = new Date(birthDate);
    if (Number.isNaN(bd.getTime())) return null;
    let age = at.getFullYear() - bd.getFullYear();
    const monthDiff = at.getMonth() - bd.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < bd.getDate())) {
      age--;
    }
    return age;
  }

  // 許状申請者一覧（現在表示中のグループの、対応中の申請）を印刷する。
  // 性別は会員ドキュメントの性別欄、年齢は生年月日から自動計算して取得する。
  async function printLicenseRequests() {
    const activeRequests = requests
      .filter((r) => r.status !== "完了" && r.status !== "取消")
      .slice()
      .sort((a, b) => a.memberName.localeCompare(b.memberName, "ja"));

    if (activeRequests.length === 0) {
      alert(`${groupDisplayName(group)}の対応中の許状申請はありません。`);
      return;
    }

    const uniqueMemberIds = Array.from(new Set(activeRequests.map((r) => r.memberId)));
    const memberSnaps = await Promise.all(
      uniqueMemberIds.map((id) => getDoc(doc(db, "members", id)))
    );
    const memberById = new Map(
      memberSnaps.map((snap) => [snap.id, snap.exists() ? (snap.data() as Member) : null])
    );

    const rowsHtml = activeRequests
      .map((r) => {
        const m = memberById.get(r.memberId);
        const age = m?.age != null ? m.age : calculateAge(m?.birthDate);
        return `<tr>
          <td>${r.memberName}</td>
          <td>${m?.gender ?? ""}</td>
          <td>${age ?? ""}</td>
          <td>${r.licenseName}</td>
          <td>${formatYearMonth(r.issueMonth)}</td>
        </tr>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>許状申請者一覧（${groupDisplayName(group)}）</title>
<style>
  body { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; padding: 24px; color: #1a1a1a; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.meta { font-size: 12px; color: #555; margin-top: 0; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  th { background: #f0f0f0; }
  @media print {
    body { padding: 0; }
  }
</style>
</head>
<body>
  <h1>許状申請者一覧（${groupDisplayName(group)}）</h1>
  <p class="meta">印刷日：${new Date().toLocaleDateString("ja-JP")}　対応中：${activeRequests.length}件</p>
  <table>
    <thead>
      <tr>
        <th>氏名</th>
        <th>性別</th>
        <th>年齢</th>
        <th>申請許状名</th>
        <th>申請月</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) {
      alert("ポップアップがブロックされました。ブラウザの設定を確認してください。");
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  }

  async function decideLeave(req: LeaveRequest, decision: "approved" | "rejected") {
    await updateDoc(doc(db, "leaveRequests", req.id), {
      status: decision,
      approvedAt: new Date().toISOString(),
    });
    // 承認時の会員ステータス反映はCloud Functions（onLeaveRequestApproved）が自動で行う
  }

  function startInventoryEdit() {
    setInventoryDraft(inventoryToDraft(inventory?.items));
  }

  function cancelInventoryEdit() {
    setInventoryDraft(null);
  }

  function updateInventoryRowName(idx: number, name: string) {
    setInventoryDraft((rows) => rows && rows.map((r, i) => (i === idx ? { ...r, name } : r)));
  }

  function updateInventoryRowQty(idx: number, qty: string) {
    setInventoryDraft((rows) => rows && rows.map((r, i) => (i === idx ? { ...r, qty } : r)));
  }

  function addInventoryRow() {
    setInventoryDraft((rows) => [...(rows ?? []), { name: "", qty: "0" }]);
  }

  function removeInventoryRow(idx: number) {
    setInventoryDraft((rows) => rows && rows.filter((_, i) => i !== idx));
  }

  async function saveInventory() {
    if (!inventoryDraft) return;
    setSavingInventory(true);
    try {
      const items: Record<string, number> = {};
      for (const row of inventoryDraft) {
        const name = row.name.trim();
        if (!name) continue;
        items[name] = Math.max(0, Number(row.qty) || 0);
      }
      await setDoc(doc(db, "meta", "nyumonSetInventory"), {
        items,
        updatedAt: new Date().toISOString(),
        updatedBy: role ?? "honbu",
      });
      setInventoryDraft(null);
    } finally {
      setSavingInventory(false);
    }
  }

  // 茶道教室：土曜日クラスの開催日を追加（定員はデフォルト3名、担当講師は空欄で作成し、あとで入力する）
  async function addSaturdaySession() {
    if (!newSessionDate) return;
    await setDoc(
      doc(db, "chadoSaturdaySessions", newSessionDate),
      {
        date: newSessionDate,
        amCapacity: CHADO_SATURDAY_DEFAULT_CAPACITY,
        pmCapacity: CHADO_SATURDAY_DEFAULT_CAPACITY,
        amTeacher: "",
        pmTeacher: "",
        amBookings: [],
        pmBookings: [],
      },
      { merge: true }
    );
    setNewSessionDate("");
  }

  async function updateSaturdaySessionField(
    sessionId: string,
    field: "amTeacher" | "pmTeacher" | "amCapacity" | "pmCapacity",
    value: string | number
  ) {
    await updateDoc(doc(db, "chadoSaturdaySessions", sessionId), { [field]: value });
  }

  // 本部・世話人による予約の手動取り消し（会員から連絡があった場合の代理操作など）
  async function removeSaturdayBooking(
    sessionId: string,
    slot: "am" | "pm",
    memberIdToRemove: string
  ) {
    const session = saturdaySessions.find((s) => s.id === sessionId);
    if (!session) return;
    const field = slot === "am" ? "amBookings" : "pmBookings";
    const current = (slot === "am" ? session.amBookings : session.pmBookings) ?? [];
    await updateDoc(doc(db, "chadoSaturdaySessions", sessionId), {
      [field]: current.filter((b) => b.memberId !== memberIdToRemove),
    });
  }

  async function deleteSaturdaySession(sessionId: string) {
    if (!confirm("この開催日を削除しますか？（予約状況もすべて削除されます）")) return;
    await deleteDoc(doc(db, "chadoSaturdaySessions", sessionId));
  }

  // 本部による事後の出欠記録。「欠席」にすると振替チケットを1枚付与し、
  // 取り消す／「出席」に変えると付与したチケットを1枚戻す（トランザクションで整合性を保つ）。
  async function setSaturdayBookingAttendance(
    sessionId: string,
    slot: "am" | "pm",
    memberId: string,
    value: "出席" | "欠席" | undefined
  ) {
    const sessionRef = doc(db, "chadoSaturdaySessions", sessionId);
    const memberRef = doc(db, "members", memberId);
    await runTransaction(db, async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      const memberSnap = await tx.get(memberRef);
      if (!sessionSnap.exists() || !memberSnap.exists()) return;
      const data = sessionSnap.data() as ChadoSaturdaySession;
      const field = slot === "am" ? "amBookings" : "pmBookings";
      const bookings = (slot === "am" ? data.amBookings : data.pmBookings) ?? [];
      const idx = bookings.findIndex((b) => b.memberId === memberId);
      if (idx === -1) return;
      const prev = bookings[idx].attended;
      const updated = bookings.slice();
      updated[idx] = { ...updated[idx], attended: value };

      let ticketDelta = 0;
      if (prev !== "欠席" && value === "欠席") ticketDelta = 1;
      if (prev === "欠席" && value !== "欠席") ticketDelta = -1;

      tx.update(sessionRef, { [field]: updated });
      if (ticketDelta !== 0) {
        const currentTickets = (memberSnap.data() as Member).chadoMakeupTickets ?? 0;
        tx.update(memberRef, {
          chadoMakeupTickets: Math.max(0, currentTickets + ticketDelta),
        });
      }
    });
  }

  function openMemberDetail(m: Member) {
    setSelectedMember(m);
    setDraft(toDraft(m));
    setNewNoteDate(new Date().toISOString().slice(0, 10));
    setNewNoteBody("");
  }

  function closeMemberDetail() {
    setSelectedMember(null);
    setDraft(null);
  }

  async function addStudentNote() {
    if (!selectedMember || !newNoteBody.trim() || !newNoteDate) return;
    setSavingNote(true);
    try {
      const ref = doc(collection(db, "chadoStudentNotes"));
      await setDoc(ref, {
        memberId: selectedMember.id,
        memberName: selectedMember.name,
        date: newNoteDate,
        body: newNoteBody.trim(),
        authorName: "本部",
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

  async function saveMemberDetail() {
    if (!selectedMember || !draft) return;
    setSavingDetail(true);
    try {
      await updateDoc(doc(db, "members", selectedMember.id), {
        ...draft,
        email: draft.email.trim(),
      });
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

  async function removeMember(m: Member) {
    if (
      !confirm(
        `${m.name}さん（会員番号${m.id}）を名簿から削除しますか？\nこの操作は取り消せません。`
      )
    )
      return;
    await deleteDoc(doc(db, "members", m.id));
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
                      {r.memberName}（{groupDisplayName(r.group)}）
                    </div>
                    <div className="text-xs text-muted">
                      {r.licenseName} 申請 ・ {LICENSE_STATUS_EMOJI[r.status]} {r.status}
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
                      {r.memberName}（{groupDisplayName(r.group)}）
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
          <Link
            href="/g1-shipping"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
          >
            G1発送物
          </Link>
          <Link
            href="/keiko-note"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs bg-paper border border-line rounded-full px-3 py-1.5 text-ink"
          >
            お稽古ノート
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
              <option key={g} value={g}>
                {groupDisplayName(g)}
              </option>
            ))}
          </select>
          {nextLesson && (
            <span className="text-sm text-matcha-deep">
              次回のお稽古：{formatLessonDate(nextLesson.date)}
            </span>
          )}
        </div>
      )}

      {area === "経理" && (
        <>
          {/* セクション1：都度払い会員の月謝（出席回ごと） */}
          <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto">
            <h2 className="font-bold mb-1">都度払い会員の月謝（出席回ごと）</h2>
            <p className="text-xs text-muted mb-3">
              出席簿と同じ形式です。セルをクリックして入金済/未納を切り替えます（出席していない月は「－」）
            </p>
            <table className="text-sm border-collapse">
              <thead>
                <tr className="text-left text-muted border-b border-line">
                  <th className="py-2 pr-2 sticky left-0 bg-paper w-24">氏名</th>
                  {fiscalYearMonths().map((mk) => (
                    <th key={mk} className="px-1 text-center font-medium">
                      {monthLabel(mk)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessionPaymentMembers.map((m) => (
                    <tr key={m.id} className="border-b border-line">
                      <td className="py-2 pr-2 sticky left-0 bg-paper w-24">
                        <span className="block truncate" title={`${m.name}（${groupDisplayName(m.group)}）`}>
                          {m.name}（{groupDisplayName(m.group)}）
                        </span>
                      </td>
                      {fiscalYearMonths().map((mk) => {
                        const attended = m.attendance?.[mk] === "出席";
                        const val = m.sessionPayments?.[mk];
                        if (!attended) {
                          return (
                            <td key={mk} className="w-9 h-9 text-center border border-line text-muted">
                              －
                            </td>
                          );
                        }
                        const colorClass =
                          val === "済"
                            ? "text-matcha-deep font-bold bg-matcha-pale"
                            : "text-hanko font-bold bg-hanko-pale";
                        return (
                          <td
                            key={mk}
                            className={`w-9 h-9 text-center border border-line cursor-pointer hover:bg-matcha-pale/40 ${colorClass}`}
                            onClick={() => setSessionPayment(m.id, mk, val === "済" ? "未納" : "済")}
                          >
                            {val === "済" ? "済" : "未"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                {sessionPaymentMembers.length === 0 && (
                  <tr>
                    <td colSpan={13} className="py-4 text-center text-muted">
                      都度払いの会員がいません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="flex gap-4 mt-2 text-xs text-muted">
              <span>済　入金あり</span>
              <span>未　出席したが未納</span>
              <span>－　未出席・対象外</span>
            </div>
          </section>

          {/* セクション2：許状代金の入金確認 */}
          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <h2 className="font-bold mb-1">許状代金の入金確認</h2>
            <p className="text-xs text-muted mb-3">
              請求書を発行し「発行手続き中」以降に進んだ申請が対象です（請求書発行依頼・お渡し済・完了・取消は含みません）。ここでの入金確認は許状の進行状況とは別に、経理側で個別に管理します。
            </p>
            <div className="space-y-3">
              {requests
                .filter((r) => {
                  const idx = LICENSE_STAGES.indexOf(r.status);
                  return (
                    idx >= LICENSE_STAGES.indexOf("発行手続き中") &&
                    idx <= LICENSE_STAGES.indexOf("発行済")
                  );
                })
                .map((r) => (
                  <div key={r.id} className="flex items-center justify-between border-b border-line pb-3">
                    <div>
                      <div className="font-semibold text-sm">
                        {r.memberName}（{groupDisplayName(r.group)}）
                      </div>
                      <div className="text-xs text-muted">
                        {r.licenseName}　合計：¥{r.fee.toLocaleString()}　申請月：{formatYearMonth(r.issueMonth)}
                      </div>
                    </div>
                    {r.accountingPaymentStatus === "済" ? (
                      <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                        済
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-hanko-pale text-hanko rounded-full px-3 py-1">
                          未納
                        </span>
                        <button
                          className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                          onClick={() => setLicenseAccountingStatus(r.id, "済")}
                        >
                          入金済にする
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              {requests.filter((r) => {
                const idx = LICENSE_STAGES.indexOf(r.status);
                return (
                  idx >= LICENSE_STAGES.indexOf("発行手続き中") && idx <= LICENSE_STAGES.indexOf("発行済")
                );
              }).length === 0 && (
                <p className="text-sm text-muted text-center py-4">対象の申請はありません</p>
              )}
            </div>
          </section>

          {/* セクション3：入会金の入金確認（名月会のみ） */}
          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <h2 className="font-bold mb-1">入会金の入金確認（名月会のみ）</h2>
            <p className="text-xs text-muted mb-3">入会金は一律 ¥33,000（G1マダムの茶の湯講座は対象外）</p>
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="text-left text-muted border-b border-line">
                  <th className="py-2 pr-3">会員名</th>
                  <th className="pr-3">入会日</th>
                  <th className="pr-3">入会金</th>
                  <th>入金状況</th>
                </tr>
              </thead>
              <tbody>
                {entryFeeMembers.map((m) => (
                    <tr key={m.id} className="border-b border-line">
                      <td className="py-2 pr-3 font-semibold">{m.name}</td>
                      <td className="pr-3">{m.joinDate}</td>
                      <td className="pr-3">¥33,000</td>
                      <td>
                        {m.entryFeeStatus === "済" ? (
                          <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                            済
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-xs bg-hanko-pale text-hanko rounded-full px-3 py-1">
                              未納
                            </span>
                            <button
                              className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                              onClick={() => setEntryFeeStatus(m.id, "済")}
                            >
                              入金済にする
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                {entryFeeMembers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-muted">
                      名月会の会員がいません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {area !== "スタッフ管理" && area !== "経理" && (
        <section className="bg-paper border border-line rounded-md p-5 mb-6 overflow-x-auto">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-bold">会員名簿</h2>
            {area === "宗徧流稽古" && (
              <button
                className="text-xs bg-paper border border-line text-matcha-deep rounded px-3 py-1.5"
                onClick={() => setShowCsvImport(true)}
              >
                CSVから名簿を更新
              </button>
            )}
          </div>
          <p className="text-xs text-muted mb-3">氏名をクリックすると詳細の閲覧・編集ができます</p>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-3">会員番号</th>
                {showAffiliation && <th className="pr-3">所属</th>}
                {showSohenDetails && <th className="pr-3">支部</th>}
                <th className="pr-3">氏名</th>
                {showGuardian && <th className="pr-3">保護者名</th>}
                {showSohenDetails && <th className="pr-3">年齢</th>}
                {showSohenDetails && <th className="pr-3">社中</th>}
                {showChadoClass && <th className="pr-3">曜日クラス</th>}
                <th className="pr-3">許状段階</th>
                <th className="pr-3">入会日</th>
                {showBilling && (
                  <>
                    <th className="pr-3">次回請求日</th>
                    <th className="pr-3">支払い方法</th>
                  </>
                )}
                <th>ステータス</th>
              </tr>
            </thead>
            <tbody>
              {memberSections.map((section) => (
                <Fragment key={section.label ?? "__all__"}>
                  {section.label && (
                    <tr>
                      <td colSpan={colCount} className="pt-4 pb-1 text-xs font-bold text-matcha-deep">
                        {section.label}（{section.members.length}名）
                      </td>
                    </tr>
                  )}
                  {section.members.map((m) => (
                <tr key={m.id} className="border-b border-line">
                  <td className="py-2 pr-3 text-muted">{m.id}</td>
                  {showAffiliation && <td className="pr-3">{groupDisplayName(m.group)}</td>}
                  {showSohenDetails && <td className="pr-3">{m.branch ?? "—"}</td>}
                  <td className="pr-3">
                    <button
                      className="font-semibold text-matcha-deep underline decoration-dotted underline-offset-2"
                      onClick={() => openMemberDetail(m)}
                    >
                      {m.name}
                    </button>
                  </td>
                  {showGuardian && <td className="pr-3">{m.guardian ?? "—"}</td>}
                  {showSohenDetails && <td className="pr-3">{m.age ?? "—"}</td>}
                  {showSohenDetails && <td className="pr-3">{m.shachu ?? "—"}</td>}
                  {showChadoClass && (
                    <td className="pr-3">
                      <select
                        className="border border-line rounded px-2 py-1 text-xs"
                        value={m.chadoClass ?? ""}
                        onChange={(e) =>
                          updateMemberField(
                            m.id,
                            "chadoClass",
                            (e.target.value || undefined) as Member["chadoClass"]
                          )
                        }
                      >
                        <option value="">（未設定）</option>
                        {CHADO_CLASSES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="pr-3">{m.license ?? "—"}</td>
                  <td className="pr-3">{m.joinDate}</td>
                  {showBilling && (
                    <>
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
                    {m.status === "退会" && (
                      <button
                        className="ml-2 text-xs text-hanko underline decoration-dotted underline-offset-2"
                        onClick={() => removeMember(m)}
                      >
                        削除
                      </button>
                    )}
                  </td>
                </tr>
                  ))}
                </Fragment>
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
            sections={memberSections}
            editable
            onCellChange={(memberId, monthKey, value) => setAttendance(memberId, monthKey, value)}
          />
        </section>
      )}

      {area === "本部稽古" && (
        <>
          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-bold">名月会 入門セット在庫</h2>
              {!inventoryDraft && (
                <button
                  className="text-xs bg-paper border border-line rounded px-3 py-1.5"
                  onClick={startInventoryEdit}
                >
                  編集する
                </button>
              )}
            </div>
            <p className="text-xs text-muted mb-3">
              名月会で新規入門があるたびに、下の品目がすべて自動的に1つ減ります（0未満にはなりません）。
              {inventory?.updatedAt &&
                `　最終更新：${new Date(inventory.updatedAt).toLocaleString("ja-JP")}`}
            </p>
            {inventoryDraft ? (
              <div className="space-y-2">
                {inventoryDraft.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="border border-line rounded px-2 py-1 text-sm flex-1"
                      placeholder="品名（例：扇子）"
                      value={row.name}
                      onChange={(e) => updateInventoryRowName(i, e.target.value)}
                    />
                    <input
                      className="border border-line rounded px-2 py-1 text-sm w-24"
                      type="number"
                      min={0}
                      value={row.qty}
                      onChange={(e) => updateInventoryRowQty(i, e.target.value)}
                    />
                    <button
                      className="text-xs text-hanko"
                      onClick={() => removeInventoryRow(i)}
                    >
                      削除
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-3 pt-2">
                  <button
                    className="text-xs bg-paper border border-line rounded px-3 py-1.5"
                    onClick={addInventoryRow}
                  >
                    ＋ 品目を追加
                  </button>
                  <div className="flex-1" />
                  <button
                    className="text-xs border border-line text-muted rounded px-3 py-1.5"
                    onClick={cancelInventoryEdit}
                  >
                    キャンセル
                  </button>
                  <button
                    className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 disabled:opacity-50"
                    disabled={savingInventory}
                    onClick={saveInventory}
                  >
                    {savingInventory ? "保存中…" : "保存する"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-6">
                {Object.entries(inventory?.items ?? {}).map(([name, qty]) => (
                  <div key={name} className="text-center">
                    <div className="text-2xl font-bold text-matcha-deep">{qty}</div>
                    <div className="text-xs text-muted">{name}</div>
                  </div>
                ))}
                {Object.keys(inventory?.items ?? {}).length === 0 && (
                  <p className="text-sm text-muted">まだ在庫が登録されていません（「編集する」から登録してください）</p>
                )}
              </div>
            )}
          </section>

          {group === "茶道教室" && (
            <section className="bg-paper border border-line rounded-md p-5 mb-6">
              <h2 className="font-bold mb-1">土曜日クラスの開催日・予約状況</h2>
              <p className="text-xs text-muted mb-3">
                開催日ごとに午前・午後の枠を管理します（各枠デフォルト定員3名）。担当講師は交代制のため、開催日ごとに入力してください。
                予約の受付・キャンセルは会員本人がマイページから行います（ここでは開催日の追加・担当講師や定員の設定・予約の手動修正ができます）。
                開催後、予約者の出欠を「出席／欠席」で記録してください。「欠席」にすると振替チケットが1枚自動的に付与され、翌月以降の追加予約に使えるようになります。
              </p>
              <div className="flex items-center gap-2 mb-4">
                <input
                  type="date"
                  className="input"
                  value={newSessionDate}
                  onChange={(e) => setNewSessionDate(e.target.value)}
                />
                <button
                  className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5 disabled:opacity-50"
                  disabled={!newSessionDate}
                  onClick={addSaturdaySession}
                >
                  ＋ 開催日を追加
                </button>
              </div>
              <div className="space-y-4">
                {saturdaySessions.map((s) => (
                  <div key={s.id} className="border border-line rounded-md p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold">{s.date}</span>
                      <button
                        className="text-xs text-hanko underline decoration-dotted underline-offset-2"
                        onClick={() => deleteSaturdaySession(s.id)}
                      >
                        この開催日を削除
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      {(["am", "pm"] as const).map((slot) => {
                        const isAm = slot === "am";
                        const bookings = (isAm ? s.amBookings : s.pmBookings) ?? [];
                        const capacity =
                          (isAm ? s.amCapacity : s.pmCapacity) ?? CHADO_SATURDAY_DEFAULT_CAPACITY;
                        const teacherField = isAm ? "amTeacher" : "pmTeacher";
                        const capacityField = isAm ? "amCapacity" : "pmCapacity";
                        return (
                          <div key={slot}>
                            <p className="text-xs font-bold text-matcha-deep mb-1">
                              {isAm ? "午前" : "午後"}
                            </p>
                            <div className="flex items-center gap-2 mb-1">
                              <input
                                className="border border-line rounded px-2 py-1 text-xs flex-1"
                                placeholder="担当講師名"
                                defaultValue={isAm ? s.amTeacher ?? "" : s.pmTeacher ?? ""}
                                onBlur={(e) =>
                                  updateSaturdaySessionField(s.id, teacherField, e.target.value)
                                }
                              />
                              <input
                                type="number"
                                min={1}
                                className="border border-line rounded px-2 py-1 text-xs w-16"
                                defaultValue={capacity}
                                onBlur={(e) =>
                                  updateSaturdaySessionField(
                                    s.id,
                                    capacityField,
                                    Number(e.target.value) || CHADO_SATURDAY_DEFAULT_CAPACITY
                                  )
                                }
                              />
                            </div>
                            <p className="text-xs text-muted mb-1">
                              予約：{bookings.length}/{capacity}名
                            </p>
                            <ul className="space-y-1">
                              {bookings.map((b) => (
                                <li key={b.memberId} className="flex items-center justify-between text-xs gap-2">
                                  <span>
                                    {b.memberName}
                                    {b.usedTicket && (
                                      <span className="text-muted">（チケット使用）</span>
                                    )}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <select
                                      className="border border-line rounded px-1 py-0.5 text-xs"
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
                                    <button
                                      className="text-hanko underline decoration-dotted underline-offset-2"
                                      onClick={() => removeSaturdayBooking(s.id, slot, b.memberId)}
                                    >
                                      削除
                                    </button>
                                  </div>
                                </li>
                              ))}
                              {bookings.length === 0 && (
                                <li className="text-xs text-muted">予約なし</li>
                              )}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {saturdaySessions.length === 0 && (
                  <p className="text-xs text-muted text-center py-4">開催日はまだ登録されていません</p>
                )}
              </div>
            </section>
          )}

          <section className="bg-paper border border-line rounded-md p-5 mb-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-bold">
                許状申請（
                {requests.filter((r) => r.status !== "完了" && r.status !== "取消").length}件 対応中）
              </h2>
              <button
                className="text-xs border border-line text-ink rounded px-3 py-1.5"
                onClick={printLicenseRequests}
              >
                申請者一覧を印刷
              </button>
            </div>
            <p className="text-xs text-muted mb-3">
              受付 → 請求書発行依頼 → 発行手続き中 → 発行済 → お渡し済 → 完了 の順に進みます
              （「申請者一覧を印刷」は、現在表示中の「{groupDisplayName(group)}」の対応中の申請を印刷します）
            </p>
            <div className="space-y-3">
              {requests
                .filter((r) => r.status !== "完了" && r.status !== "取消")
                .map((r) => (
                  <div
                    key={r.id}
                    id={`license-request-${r.id}`}
                    className={`flex items-center justify-between border-b border-line pb-3 ${
                      r.id === highlightRequestId ? "bg-matcha-pale -mx-2 px-2 rounded" : ""
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-sm">{r.memberName}</div>
                      <div className="text-xs text-muted">
                        {r.licenseName}　合計：¥{r.fee.toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs bg-matcha-pale text-matcha-deep rounded-full px-3 py-1">
                        {LICENSE_STATUS_EMOJI[r.status]} {r.status}
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
                  会員番号：{selectedMember.id}　所属：{groupDisplayName(selectedMember.group)}
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
              <Field label="支部">
                <input
                  className="input"
                  value={draft.branch ?? ""}
                  onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                />
              </Field>
              <Field label="社中（代表）">
                <input
                  className="input"
                  value={draft.shachu ?? ""}
                  onChange={(e) => setDraft({ ...draft, shachu: e.target.value })}
                />
              </Field>
              <Field label="年齢">
                <input
                  type="number"
                  className="input"
                  value={draft.age ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      age: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="組（雪月花のみ）">
                <select
                  className="input"
                  value={draft.subGroup ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, subGroup: e.target.value || undefined })
                  }
                >
                  <option value="">（未設定）</option>
                  <option>雪組</option>
                  <option>月組</option>
                  <option>花組</option>
                </select>
              </Field>
              <Field label="生年月日">
                <input
                  type="date"
                  className="input"
                  value={draft.birthDate ?? ""}
                  onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
                />
              </Field>
              <Field label="性別（名月会のみ）">
                <select
                  className="input"
                  value={draft.gender ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      gender: (e.target.value || undefined) as typeof draft.gender,
                    })
                  }
                >
                  <option value="">（未設定）</option>
                  <option>男性</option>
                  <option>女性</option>
                </select>
              </Field>
              {area !== "宗徧流稽古" && groupHasGuardianField(selectedMember.group) && (
                <Field label="保護者名">
                  <input
                    className="input"
                    value={draft.guardian ?? ""}
                    onChange={(e) => setDraft({ ...draft, guardian: e.target.value })}
                  />
                </Field>
              )}
              {selectedMember.group === "茶道教室" && (
                <Field label="曜日クラス">
                  <select
                    className="input"
                    value={draft.chadoClass ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        chadoClass: (e.target.value || undefined) as typeof draft.chadoClass,
                      })
                    }
                  >
                    <option value="">（未設定）</option>
                    {CHADO_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {selectedMember.group === "茶道教室" && draft.chadoClass === "土曜日" && (
                <>
                  <Field label="月の予約可能回数">
                    <select
                      className="input"
                      value={draft.chadoMonthlyQuota ?? 1}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chadoMonthlyQuota: Number(e.target.value) as 1 | 2,
                        })
                      }
                    >
                      <option value={1}>月1回</option>
                      <option value={2}>月2回</option>
                    </select>
                  </Field>
                  <Field label="振替チケット残数">
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={draft.chadoMakeupTickets ?? 0}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chadoMakeupTickets: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                  </Field>
                </>
              )}
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
                  <Field label="次回請求日">
                    <input
                      type="date"
                      className="input"
                      value={draft.nextBillingDate ?? ""}
                      onChange={(e) => setDraft({ ...draft, nextBillingDate: e.target.value })}
                    />
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

            {selectedMember.groupCategory === "本部稽古" && (
              <div className="mt-4 pt-4 border-t border-line">
                <h4 className="text-sm font-bold mb-1">茶歴</h4>
                <p className="text-xs text-muted mb-2">
                  各許状を取得した年月を記録します（未取得は空欄のまま）。許状申請が「完了」になると自動で記録されます。
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                  {LICENSE_FEES.map((l) => (
                    <div key={l.name} className="flex items-center gap-2">
                      <span className="text-xs w-24 shrink-0">{l.name}</span>
                      <input
                        type="month"
                        className="input text-xs"
                        value={draft.licenseHistory?.[l.name] ?? ""}
                        onChange={(e) => {
                          const next = { ...(draft.licenseHistory ?? {}) };
                          if (e.target.value) {
                            next[l.name] = e.target.value;
                          } else {
                            delete next[l.name];
                          }
                          setDraft({ ...draft, licenseHistory: next });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedMember.group === "茶道教室" && (
              <div className="mt-4 pt-4 border-t border-line">
                <h4 className="text-sm font-bold mb-1">生徒の申し送り</h4>
                <p className="text-xs text-muted mb-2">
                  講師間・本部の引き継ぎ用の内部メモです（生徒本人には表示されません）。お稽古のたびに記録してください。
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
                <div className="flex gap-2 items-start">
                  <input
                    type="date"
                    className="input w-36 shrink-0"
                    value={newNoteDate}
                    onChange={(e) => setNewNoteDate(e.target.value)}
                  />
                  <textarea
                    className="input flex-1"
                    rows={2}
                    placeholder="例：割稽古の柄杓の扱いを中心に。次回は総稽古から。"
                    value={newNoteBody}
                    onChange={(e) => setNewNoteBody(e.target.value)}
                  />
                  <button
                    className="text-sm bg-matcha-deep text-white rounded px-3 py-2 disabled:opacity-50 shrink-0"
                    onClick={addStudentNote}
                    disabled={savingNote || !newNoteBody.trim()}
                  >
                    記録する
                  </button>
                </div>
              </div>
            )}

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

      <CsvImportModal
        open={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        group={group}
        groupCategory="宗徧流稽古"
        existingMembers={members}
      />

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
