"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { doc, getDoc, onSnapshot, updateDoc, collection, addDoc } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { db, auth } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { currentMonthKey } from "@/lib/fiscalMonths";
import { getOnetimeLinkForGroup } from "@/lib/enrollGroups";
import { groupDisplayName } from "@/lib/areas";
import { formatLessonDate, type NextLessonInfo } from "@/lib/nextLesson";
import { CHADO_FIXED_TEACHERS, CHADO_CLASS_TIME } from "@/lib/chadoClasses";
import SaturdayReservation from "@/components/SaturdayReservation";
import type { Member, LeaveRequestType } from "@/types";

export default function MyPage() {
  const { role, memberId, loading } = useAuth();
  const router = useRouter();
  const [member, setMember] = useState<Member | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [leaveType, setLeaveType] = useState<LeaveRequestType>("休会");
  const [reason, setReason] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [nextLesson, setNextLesson] = useState<NextLessonInfo | null>(null);

  // ご家族の切り替え（linkedMemberIdsで連携済みの会員一覧・切り替え中の状態）
  const [familyMembers, setFamilyMembers] = useState<{ id: string; name: string; group: string }[]>([]);
  const [switchingFamily, setSwitchingFamily] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && role !== "member") router.replace("/mypage/login");
  }, [loading, role, router]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("lineLinked");
    if (linked === "success") {
      setSavedMsg("公式LINEとの連携が完了しました。");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (linked === "error") {
      setSavedMsg("LINE連携に失敗しました。お手数ですが、もう一度お試しください。");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!member?.group) return;
    return onSnapshot(doc(db, "meta", "nextLessonDates"), (snap) => {
      const dates = snap.data()?.dates as Record<string, NextLessonInfo> | undefined;
      setNextLesson(dates?.[member.group] ?? null);
    });
  }, [member?.group]);

  useEffect(() => {
    if (!memberId) return;
    getDoc(doc(db, "members", memberId)).then((snap) => {
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as Member;
        setMember(data);
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
        setAddress(data.address ?? "");
        setAffiliation(data.affiliation ?? "");
        setLeaveType(data.status === "休会" ? "復会" : "休会");
      }
    });
  }, [memberId]);

  // 連携済みのご家族（linkedMemberIds）の氏名・所属を取得する。
  // firestore.rulesのisLinkedTo()により、連携済みの相手の会員ドキュメントは読み取りだけ許可されている。
  useEffect(() => {
    const ids = member?.linkedMemberIds ?? [];
    if (ids.length === 0) {
      setFamilyMembers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          const snap = await getDoc(doc(db, "members", id));
          if (!snap.exists()) return null;
          const data = snap.data() as Member;
          return { id, name: data.name, group: data.group };
        })
      );
      if (!cancelled) {
        setFamilyMembers(results.filter((r): r is { id: string; name: string; group: string } => r !== null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [member?.linkedMemberIds]);

  // ご家族への切り替え：Cloud Functions（switchToLinkedMember）に切り替え先の会員番号を渡し、
  // 発行されたカスタムトークンでサインインし直す。ログアウト・再ログインは不要。
  // 連携関係の確認はCloud Functions側でログイン中の会員の実データを見て行うため、
  // ここでは切り替え先を指定するだけでよい。
  async function switchToFamilyMember(targetId: string) {
    setSwitchingFamily(true);
    setSwitchError(null);
    try {
      const functions = getFunctions();
      const switchFn = httpsCallable<{ targetMemberId: string }, { token: string }>(
        functions,
        "switchToLinkedMember"
      );
      const result = await switchFn({ targetMemberId: targetId });
      await signInWithCustomToken(auth, result.data.token);
      setSavedMsg(null);
    } catch (err) {
      console.error(err);
      setSwitchError("切り替えに失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSwitchingFamily(false);
    }
  }

  async function saveContact() {
    if (!memberId || !member) return;
    const updates: Record<string, string> = { email, phone, address };
    if (member.group === "名月会") {
      updates.affiliation = affiliation;
    }
    await updateDoc(doc(db, "members", memberId), updates);
    setSavedMsg("連絡先情報を更新しました。");
  }

  async function updateRsvp(value: "出席" | "欠席") {
    if (!memberId || !member) return;
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

    // 都度払いの会員が「出席する」を押したときは、その場でSquareの支払いページを開く
    if (value === "出席" && member.paymentMethod === "都度払い") {
      const link = getOnetimeLinkForGroup(member.group);
      if (link) {
        window.open(link, "_blank", "noopener,noreferrer");
        setSavedMsg("出席で登録しました。お支払いページを別タブで開きましたので、そちらからお手続きください。");
      } else {
        setSavedMsg("出席で登録しました。お支払いリンクが未設定のため、本部より別途ご連絡します。");
      }
      return;
    }

    setSavedMsg(`次回のお稽古を「${value}」で登録しました。`);
  }

  async function submitLeave() {
    if (!memberId || !member) return;
    if ((leaveType === "休会" || leaveType === "退会") && !reason.trim()) {
      setSavedMsg("休会・退会の理由をご入力ください。");
      return;
    }
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

      {familyMembers.length > 0 && (
        <div className="bg-paper border border-line rounded-md p-3 mb-4">
          <div className="text-xs text-muted mb-2">ご家族を切り替える</div>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs bg-matcha-deep text-white rounded-full px-3 py-1">
              {member.name}様（表示中）
            </span>
            {familyMembers.map((f) => (
              <button
                key={f.id}
                className="text-xs border border-line text-matcha-deep rounded-full px-3 py-1 disabled:opacity-50"
                onClick={() => switchToFamilyMember(f.id)}
                disabled={switchingFamily}
              >
                {f.name}様（{groupDisplayName(f.group)}）
              </button>
            ))}
          </div>
          {switchingFamily && <p className="text-xs text-muted mt-2">切り替え中…</p>}
          {switchError && <p className="text-hanko text-xs mt-2">{switchError}</p>}
        </div>
      )}

      {member.group === "茶道教室" && (
        <Link
          href="/keiko-note"
          className="block text-center text-sm bg-matcha-pale text-matcha-deep rounded-md py-2.5 mb-4"
        >
          お稽古ノートを見る
        </Link>
      )}

      <div className="bg-paper border border-line rounded-md p-6 mb-4 text-center">
        <div className="text-lg font-bold text-matcha-deep">{member.name} 様</div>
        <div className="text-xs text-muted mt-1">{groupDisplayName(member.group)}</div>
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

      {member.group === "茶道教室" && (
        <div className="bg-paper border border-line rounded-md p-6 mb-4">
          <h2 className="text-sm text-muted mb-3">公式LINEとの連携</h2>
          {member.lineUserId ? (
            <p className="text-sm text-matcha-deep">
              連携済みです。お稽古前日にリマインドが届きます。
            </p>
          ) : (
            <>
              <p className="text-xs text-muted mb-3">
                連携すると、お稽古前日の出欠・ご予約のリマインドが公式LINEに届くようになります。
              </p>
              <a
                href={`https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID}`}
                className="block text-center w-full bg-matcha-deep text-white rounded py-2 text-sm"
              >
                LINEでログインして連携する
              </a>
            </>
          )}
        </div>
      )}

      {member.groupCategory === "本部稽古" &&
        (member.group === "茶道教室" && member.chadoClass === "土曜日" ? (
          <SaturdayReservation
            memberId={member.id}
            quota={member.chadoMonthlyQuota ?? 1}
            tickets={member.chadoMakeupTickets ?? 0}
          />
        ) : (
          <div className="bg-paper border border-line rounded-md p-6 mb-4">
            <h2 className="text-sm text-muted mb-3">次回のお稽古 出欠登録</h2>
            {member.group === "茶道教室" && member.chadoClass && (
              <p className="text-xs text-matcha-deep mb-1">
                {member.chadoClass}クラス　{CHADO_CLASS_TIME[member.chadoClass]}
                {CHADO_FIXED_TEACHERS[member.chadoClass] &&
                  `　担当：${CHADO_FIXED_TEACHERS[member.chadoClass]}`}
              </p>
            )}
            {nextLesson && (
              <p className="text-xs text-matcha-deep mb-1">
                次回：{formatLessonDate(nextLesson.date)}
              </p>
            )}
            <div className="mb-3">
              {member.rsvp === "出席" ? (
                <span className="inline-block text-xs font-bold text-matcha-deep bg-matcha-pale rounded-full px-3 py-1">
                  ✓ 出席で回答済み
                </span>
              ) : member.rsvp === "欠席" ? (
                <span className="inline-block text-xs font-bold text-hanko bg-hanko-pale rounded-full px-3 py-1">
                  ✓ 欠席で回答済み
                </span>
              ) : (
                <span className="inline-block text-xs text-muted bg-bg border border-line rounded-full px-3 py-1">
                  未回答
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                className={`flex-1 rounded py-2 text-sm transition ${
                  member.rsvp === "出席"
                    ? "bg-matcha-deep text-white ring-2 ring-matcha-deep ring-offset-1"
                    : "border border-line text-muted"
                }`}
                onClick={() => updateRsvp("出席")}
              >
                {member.rsvp === "出席" ? "✓ 出席する" : "出席する"}
              </button>
              <button
                className={`flex-1 rounded py-2 text-sm transition ${
                  member.rsvp === "欠席"
                    ? "bg-hanko text-white ring-2 ring-hanko ring-offset-1"
                    : "border border-line text-muted"
                }`}
                onClick={() => updateRsvp("欠席")}
              >
                {member.rsvp === "欠席" ? "✓ 欠席する" : "欠席する"}
              </button>
            </div>
          </div>
        ))}

      <div className="bg-paper border border-line rounded-md p-6 mb-4">
        <h2 className="text-sm text-muted mb-3">家元動画へのアクセス</h2>
        <a
          href="https://one-stream.io/login/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3?redirectPath=%2Fuser%2FWAFrlVXGvJeKz3PaYEwjUe1JjZJ3&isInvoicePayment=false"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-sm bg-matcha-deep text-white rounded-md py-2.5 mb-3"
        >
          家元動画を見る
        </a>
        <div className="text-xs text-muted bg-matcha-pale rounded-md p-3 space-y-1">
          <p className="font-bold text-matcha-deep">初めてご登録の方へ</p>
          <p>動画の料金はお稽古代に含まれております。</p>
          <p>お支払い時に下記のクーポンコードを入力ください。</p>
          <p>「クーポンをお持ちの方」を開き、下記のクーポンコードをご入力ください。</p>
          <p className="text-center text-sm font-bold text-matcha-deep tracking-wide mt-2">
            4bJIdgZJ
          </p>
        </div>
      </div>

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
          className={`w-full border border-line rounded px-3 py-2 text-sm ${
            member.group === "名月会" ? "mb-2" : "mb-3"
          }`}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="ご住所"
        />
        {member.group === "名月会" && (
          <input
            className="w-full border border-line rounded px-3 py-2 text-sm mb-3"
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            placeholder="現在の所属（学校名・勤務先など）"
          />
        )}
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
          placeholder={leaveType === "復会" ? "理由（任意）" : "理由（必須）"}
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
