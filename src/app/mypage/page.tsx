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
import SessionPaymentBox from "@/components/SessionPaymentBox";
import { groupDisplayName, isHonbuKeikoGroup } from "@/lib/areas";
import { useGroupSettings } from "@/lib/groupSettings";
import { formatLessonDate, nextLessonKey, type NextLessonInfo } from "@/lib/nextLesson";
import { CHADO_FIXED_TEACHERS, CHADO_CLASS_TIME, CHADO_CLASS_LABEL } from "@/lib/chadoClasses";
import SaturdayReservation from "@/components/SaturdayReservation";
import ShingetsuAttendanceCard from "@/components/ShingetsuAttendanceCard";
import { SHINGETSU_GROUP } from "@/lib/shingetsu";
import MyPagePaymentCard from "@/components/MyPagePaymentCard";
import type { Member, LeaveRequestType } from "@/types";

export default function MyPage() {
  useGroupSettings(); // 会の設定（表示名・エリア）の読み込み後に再描画する
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
  // 都度払い：作成したSquareの支払いページ（タブが開けなかったときのボタン用）と処理中フラグ
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  // 画面のタブ：お稽古（出欠・ノート・動画）／各種お手続き（連絡先・お月謝・休会退会）。URLの ?tab=procedures で直接開ける
  const [tab, setTab] = useState<"keiko" | "procedures">("keiko");

  useEffect(() => {
    if (!loading && role !== "member") router.replace("/mypage/login");
  }, [loading, role, router]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "procedures") setTab("procedures");
    const sessionPaid = params.get("sessionPaid");
    if (sessionPaid) {
      setSavedMsg("お支払いありがとうございました。反映まで少し時間がかかる場合があります。");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
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
      setNextLesson(dates?.[nextLessonKey(member.group, member.chadoClass)] ?? null);
    });
  }, [member?.group, member?.chadoClass]);

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

  // 都度払い：Squareの支払いページを開く。ポップアップがブロックされないよう、先に空のタブを開いてから移動する
  async function openSessionCheckout(monthKey: string, prefix = "") {
    setCheckoutBusy(true);
    setCheckoutUrl(null);
    const win = window.open("", "_blank");
    try {
      const fn = httpsCallable<
        { monthKey: string; returnUrl: string },
        { paid: boolean; url?: string; amount?: number }
      >(getFunctions(), "createSessionCheckout");
      const res = await fn({ monthKey, returnUrl: `${window.location.origin}/mypage?sessionPaid=${monthKey}` });
      if (res.data.paid || !res.data.url) {
        win?.close();
        setSavedMsg(`${prefix}${monthKey.slice(5).replace(/^0/, "")}月分はお支払い済みです。`);
        return;
      }
      setCheckoutUrl(res.data.url);
      if (win) {
        win.location.href = res.data.url;
        setSavedMsg(`${prefix}お支払いページを別タブで開きました。そちらからお手続きください。`);
      } else {
        setSavedMsg(`${prefix}下の「お支払いページを開く」からお手続きください。`);
      }
    } catch (err) {
      win?.close();
      console.error(err);
      const msg = (err as { message?: string })?.message;
      setSavedMsg(`${prefix}${msg || "お支払いページを用意できませんでした。本部より別途ご連絡します。"}`);
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function updateRsvp(value: "出席" | "欠席") {
    if (!memberId || !member) return;
    const monthKey = currentMonthKey();
    // お稽古日ごとの回答も残す（管理画面の開催日・予約状況で、日付ごとの出席者／欠席者を表示するため）
    const lessonDate = nextLesson?.date?.slice(0, 10);
    await updateDoc(doc(db, "members", memberId), {
      rsvp: value,
      [`attendance.${monthKey}`]: value,
      ...(lessonDate ? { [`rsvpByDate.${lessonDate}`]: value } : {}),
    });
    setMember((prev) =>
      prev
        ? { ...prev, rsvp: value, attendance: { ...prev.attendance, [monthKey]: value } }
        : prev
    );

    // 都度払いの会員が「出席する」を押したときは、その場でSquareの支払いページ（この会員・この月専用）を開く
    if (member.paymentMethod === "都度払い" && !member.sessionPaymentExempt) {
      const paid = member.sessionPayments?.[monthKey] === "済";
      if (value === "出席") {
        if (paid) {
          setSavedMsg("出席で登録しました。今月分はお支払い済みです。");
        } else {
          await openSessionCheckout(monthKey, "出席で登録しました。");
        }
        return;
      }
      if (paid) {
        setSavedMsg("欠席で登録しました。お支払い済みの今月分の扱いは、本部よりご連絡いたします。");
        return;
      }
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

  function changeTab(next: "keiko" | "procedures") {
    setTab(next);
    const url = next === "procedures" ? `${window.location.pathname}?tab=procedures` : window.location.pathname;
    window.history.replaceState({}, "", url);
    window.scrollTo({ top: 0 });
  }

  async function logout() {
    await auth.signOut();
    router.push("/mypage/login");
  }

  if (loading || !member) return <div className="p-8 text-muted">確認中…</div>;

  const showLineCard = member.group === "茶道教室" && !member.lineUserId;
  const isError = !!savedMsg && /失敗|できません|ご入力ください/.test(savedMsg);

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-md mx-auto px-4 py-6 pb-28">
        {/* ① お名前・会員情報 */}
        <div className="bg-paper border border-line rounded-lg p-5 mb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-muted">{groupDisplayName(member.group)}</div>
              <div className="text-xl font-bold text-matcha-deep mt-0.5">{member.name} 様</div>
            </div>
            <button
              className="shrink-0 text-xs text-muted border border-line rounded-full px-3 py-1"
              onClick={logout}
            >
              ログアウト
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-2 mt-4">
            <div className="bg-bg rounded-md px-3 py-2">
              <dt className="text-xs text-muted">会員番号</dt>
              <dd className="text-sm font-bold text-ink mt-0.5">{member.id}</dd>
            </div>
            <div className="bg-bg rounded-md px-3 py-2">
              <dt className="text-xs text-muted">許状段階</dt>
              <dd className="text-sm font-bold text-ink mt-0.5">{member.license ?? "—"}</dd>
            </div>
          </dl>
          {member.group === "茶道教室" && member.lineUserId && (
            <p className="text-xs text-matcha-deep mt-3">✓ 公式LINE連携済み（お稽古前日にリマインドが届きます）</p>
          )}

          {familyMembers.length > 0 && (
            <div className="border-t border-line mt-4 pt-3">
              <div className="text-xs text-muted mb-2">ご家族を切り替える</div>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs bg-btn text-btn-ink rounded-full px-3 py-1.5">
                  {member.name}様（表示中）
                </span>
                {familyMembers.map((f) => (
                  <button
                    key={f.id}
                    className="text-xs border border-matcha text-matcha-deep rounded-full px-3 py-1.5 disabled:opacity-50"
                    onClick={() => switchToFamilyMember(f.id)}
                    disabled={switchingFamily}
                  >
                    {f.name}様（{groupDisplayName(f.group)}）に切り替え
                  </button>
                ))}
              </div>
              {switchingFamily && <p className="text-xs text-muted mt-2">切り替え中…</p>}
              {switchError && <p className="text-hanko text-xs mt-2">{switchError}</p>}
            </div>
          )}
        </div>

        {/* タブ切り替え */}
        <div role="tablist" className="grid grid-cols-2 gap-1 bg-paper border border-line rounded-lg p-1 mb-4">
          {(
            [
              ["keiko", "お稽古"],
              ["procedures", "各種お手続き"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`rounded-md py-2.5 text-sm font-bold transition ${
                tab === key ? "bg-btn text-btn-ink" : "text-muted"
              }`}
              onClick={() => changeTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "keiko" && (
          <>
        {/* ② 次回のお稽古（いちばん大事な欄なので上に） */}
        {member.groupCategory === "本部稽古" &&
          (member.group === SHINGETSU_GROUP ? (
            // 新月会：月2回の開催日から1日を選ぶ方式（管理画面の出席簿と連動）
            <ShingetsuAttendanceCard memberId={member.id} />
          ) : member.group === "茶道教室" && member.chadoClass === "土曜日" ? (
            <SaturdayReservation
              memberId={member.id}
              quota={member.chadoMonthlyQuota ?? 1}
              tickets={member.chadoMakeupTickets ?? 0}
            />
          ) : (
            <div className="bg-paper border border-line rounded-lg p-5 mb-4">
              <h2 className={H2}>次回のお稽古 出欠登録</h2>
              {(nextLesson || (member.group === "茶道教室" && member.chadoClass)) && (
                <div className="bg-matcha-pale rounded-md px-4 py-3 mb-3">
                  {nextLesson && (
                    <div className="text-base font-bold text-matcha-deep">
                      {formatLessonDate(nextLesson.date)}
                    </div>
                  )}
                  {nextLesson?.place && (
                    <div className="text-sm text-ink mt-1">場所：{nextLesson.place}</div>
                  )}
                  {member.group === "茶道教室" && member.chadoClass && (
                    <div className="text-xs text-matcha-deep mt-1">
                      {CHADO_CLASS_LABEL[member.chadoClass]}クラス　{CHADO_CLASS_TIME[member.chadoClass]}
                      {CHADO_FIXED_TEACHERS[member.chadoClass] &&
                        `　担当：${CHADO_FIXED_TEACHERS[member.chadoClass]}`}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-muted">現在のご回答：</span>
                {member.rsvp === "出席" ? (
                  <span className="text-sm font-bold text-matcha-deep bg-matcha-pale rounded-full px-3 py-1">
                    ✓ 出席
                  </span>
                ) : member.rsvp === "欠席" ? (
                  <span className="text-sm font-bold text-hanko bg-hanko-pale rounded-full px-3 py-1">
                    ✓ 欠席
                  </span>
                ) : (
                  <span className="text-sm text-hanko font-bold">まだ回答していません</span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  className={`flex-1 rounded-md py-3 text-base font-bold transition ${
                    member.rsvp === "出席"
                      ? "bg-btn text-btn-ink ring-1 ring-matcha"
                      : "border border-matcha text-matcha-deep bg-paper"
                  }`}
                  onClick={() => updateRsvp("出席")}
                >
                  {member.rsvp === "出席" ? "✓ 出席する" : "出席する"}
                </button>
                <button
                  className={`flex-1 rounded-md py-3 text-base font-bold transition ${
                    member.rsvp === "欠席"
                      ? "bg-hanko text-white"
                      : "border border-hanko/40 text-hanko bg-paper"
                  }`}
                  onClick={() => updateRsvp("欠席")}
                >
                  {member.rsvp === "欠席" ? "✓ 欠席する" : "欠席する"}
                </button>
              </div>
              {member.paymentMethod === "都度払い" && !member.sessionPaymentExempt && (
                <SessionPaymentBox
                  member={member}
                  busy={checkoutBusy}
                  checkoutUrl={checkoutUrl}
                  onPay={(mk) => openSessionCheckout(mk)}
                />
              )}
            </div>
          ))}

        {/* ③ 公式LINE（未連携のときだけ大きく案内） */}
        {showLineCard && (
          <div className="bg-paper border border-line rounded-lg p-5 mb-4">
            <h2 className={H2}>公式LINEとの連携</h2>
            <p className="text-sm text-ink mb-3">
              連携すると、お稽古前日の出欠・ご予約のリマインドが公式LINEに届くようになります。
            </p>
            <a
              href={`https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID}`}
              className="block text-center w-full bg-btn text-btn-ink rounded-md py-3 text-base font-bold"
            >
              LINEでログインして連携する
            </a>
          </div>
        )}

        {/* ④ お稽古ノート・家元動画 */}
        <div className="bg-paper border border-line rounded-lg p-5 mb-4">
          <h2 className={H2}>お稽古の予習・復習</h2>
          <div className={`grid gap-2 ${member.group === "茶道教室" ? "grid-cols-2" : "grid-cols-1"}`}>
            {member.group === "茶道教室" && (
              <Link
                href="/keiko-note"
                className="block text-center text-sm font-bold bg-matcha-pale text-matcha-deep rounded-md py-3"
              >
                お稽古ノート
              </Link>
            )}
            <a
              href="https://one-stream.io/login/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3?redirectPath=%2Fuser%2FWAFrlVXGvJeKz3PaYEwjUe1JjZJ3&isInvoicePayment=false"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-sm font-bold bg-btn text-btn-ink rounded-md py-3"
            >
              家元動画を見る
            </a>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-matcha-deep">家元動画に初めてご登録の方へ</summary>
            <div className="text-ink bg-matcha-pale rounded-md p-3 mt-2 space-y-1">
              <p>動画の料金はお稽古代に含まれております。</p>
              <p>お支払い画面で「クーポンをお持ちの方」を開き、下記のクーポンコードをご入力ください。</p>
              <p className="text-center text-lg font-bold text-matcha-deep tracking-widest mt-2 select-all">
                4bJIdgZJ
              </p>
            </div>
          </details>
        </div>

          </>
        )}

        {tab === "procedures" && (
          <>
        {/* ⑤ お支払い */}
        {isHonbuKeikoGroup(member.group) && <MyPagePaymentCard />}

        {/* ⑥ 連絡先 */}
        <div className="bg-paper border border-line rounded-lg p-5 mb-4">
          <h2 className={H2}>連絡先情報の変更</h2>
          <div className="space-y-3 mb-4">
            <label className="block">
              <span className="text-xs text-muted">メールアドレス</span>
              <input
                type="email"
                className={INPUT}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">電話番号</span>
              <input
                type="tel"
                className={INPUT}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">ご住所</span>
              <input className={INPUT} value={address} onChange={(e) => setAddress(e.target.value)} />
            </label>
            {member.group === "名月会" && (
              <label className="block">
                <span className="text-xs text-muted">現在の所属（学校名・勤務先など）</span>
                <input
                  className={INPUT}
                  value={affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                />
              </label>
            )}
          </div>
          <button
            className="w-full border-2 border-matcha-deep text-matcha-deep font-bold rounded-md py-3 text-sm"
            onClick={saveContact}
          >
            この内容で保存する
          </button>
        </div>

        {/* ⑦ 休会・退会 */}
        <div className="bg-paper border border-line rounded-lg p-5">
          <h2 className={H2}>
            {member.status === "休会" ? "復会・退会のお申請" : "休会・退会のお申請"}
          </h2>
          <div>
            <select
              className={`${INPUT} mb-2`}
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
              className={`${INPUT} mb-3`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={leaveType === "復会" ? "理由（任意）" : "理由（必須）"}
            />
            <button
              className="w-full border border-matcha-deep text-matcha-deep rounded-md py-2.5 text-sm"
              onClick={submitLeave}
            >
              申請する
            </button>
          </div>
        </div>
          </>
        )}
      </div>

      {/* 完了・エラーのお知らせ：どこまでスクロールしていても見えるよう画面下に固定 */}
      {savedMsg && (
        <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4">
          <div
            role="status"
            className={`max-w-md mx-auto flex items-start gap-3 rounded-lg shadow-lg px-4 py-3 text-sm text-white ${
              isError ? "bg-hanko" : "bg-matcha-deep"
            }`}
          >
            <p className="flex-1">{savedMsg}</p>
            <button className="shrink-0 text-white/80 text-lg leading-none" onClick={() => setSavedMsg(null)} aria-label="閉じる">
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const H2 = "text-base font-bold text-ink mb-3 pl-2 border-l-4 border-matcha";
const INPUT = "mt-1 w-full border border-line rounded-md px-3 py-2.5 text-base bg-paper focus:outline-none focus:border-matcha";
