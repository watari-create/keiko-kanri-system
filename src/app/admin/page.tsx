"use client";

export const dynamic = "force-dynamic";

// 本部用の管理画面（骨組み）。
// モックアップの「管理画面」にあった全機能のうち、まずは
// ①名簿の閲覧・ステータス変更 ②許状申請の一覧・ステータス進行 の2つをFirestore連携で実装している。
// 出席簿・入金確認・スタッフ管理などは、同じパターン（Firestoreのコレクションを読み書きするだけ）で追加できる。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import type { Member, LicenseRequest, LicenseStatus } from "@/types";

const GROUPS = ["名月会", "茶道教室", "Gマダムの茶の湯講座"];
const LICENSE_STAGES: LicenseStatus[] = [
  "受付",
  "請求書発行済",
  "発行手続き中",
  "発行済",
  "お渡し済",
  "完了",
];

export default function AdminPage() {
  const { role, loading } = useAuth();
  const router = useRouter();
  const [group, setGroup] = useState(GROUPS[0]);
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<LicenseRequest[]>([]);

  // 権限チェック：本部以外はログインページへ
  useEffect(() => {
    if (!loading && role !== "honbu") router.replace("/login");
  }, [loading, role, router]);

  // 会員一覧をリアルタイム購読
  useEffect(() => {
    const q = query(collection(db, "members"), where("group", "==", group));
    return onSnapshot(q, (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Member)));
    });
  }, [group]);

  // 許状申請をリアルタイム購読（完了以外）
  useEffect(() => {
    const q = query(
      collection(db, "licenseRequests"),
      where("group", "==", group)
    );
    return onSnapshot(q, (snap) => {
      setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LicenseRequest)));
    });
  }, [group]);

  async function updateMemberStatus(memberId: string, status: Member["status"]) {
    await updateDoc(doc(db, "members", memberId), { status });
  }

  async function advanceLicense(req: LicenseRequest) {
    const idx = LICENSE_STAGES.indexOf(req.status);
    if (idx >= LICENSE_STAGES.length - 1) return;
    const nextStatus = LICENSE_STAGES[idx + 1];
    await updateDoc(doc(db, "licenseRequests", req.id), {
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });
    // 許状段階の反映・通知はCloud Functions（onLicenseIssued）が自動で行う
  }

  if (loading || role !== "honbu") return <div className="p-8 text-muted">確認中…</div>;

  const activeRequests = requests.filter((r) => r.status !== "完了");

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xl font-bold text-matcha-deep mb-4">管理画面</h1>

      <select
        className="border border-line rounded px-3 py-2 mb-6 text-sm"
        value={group}
        onChange={(e) => setGroup(e.target.value)}
      >
        {GROUPS.map((g) => (
          <option key={g}>{g}</option>
        ))}
      </select>

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
                <td>
                  <select
                    className="border border-line rounded px-2 py-1 text-xs"
                    value={m.status}
                    onChange={(e) =>
                      updateMemberStatus(m.id, e.target.value as Member["status"])
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
                <td colSpan={3} className="py-4 text-center text-muted">
                  この会の会員はまだ登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="bg-paper border border-line rounded-md p-5">
        <h2 className="font-bold mb-1">許状申請（{activeRequests.length}件 対応中）</h2>
        <p className="text-xs text-muted mb-3">
          受付 → 請求書発行済 → 発行手続き中 → 発行済 → お渡し済 → 完了 の順に進みます
        </p>
        <div className="space-y-3">
          {activeRequests.map((r) => (
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
                <button
                  className="text-xs bg-matcha-deep text-white rounded px-3 py-1.5"
                  onClick={() => advanceLicense(r)}
                >
                  次に進める
                </button>
              </div>
            </div>
          ))}
          {activeRequests.length === 0 && (
            <p className="text-sm text-muted text-center py-4">対応中の申請はありません</p>
          )}
        </div>
      </section>
    </div>
  );
}
