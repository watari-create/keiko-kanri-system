"use client";

// 入会のお申し込み（未ログインの方向け・公開ページ）
// /login からも「はじめての方はこちら」で来られるが、SNSやチラシのQRコードから
// このURLに直接誘導できるよう、/enroll として独立させている。
//
// 会員番号は送信と同時にその場で発行する（本部の事前承認は挟まない）。
// 発行ロジック・料金・入力項目は src/lib/enrollGroups.ts を参照。

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { ENROLL_GROUPS, MEMBER_COUNTER_START } from "@/lib/enrollGroups";
import type { PaymentMethod } from "@/types";

type Step = "form" | "confirm";

export default function EnrollPage() {
  const [groupKey, setGroupKey] = useState<string>("meigetsu");
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("form");
  const [issuedNo, setIssuedNo] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ label: string; amount: string; link: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const group = ENROLL_GROUPS[groupKey];

  // URLに ?group=meigetsu のように付けてアクセスした場合、その会をあらかじめ選択しておく。
  // 会ごとの募集チラシ・SNS等から、案内文つきのページへ直接誘導するのに使う。
  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("group");
    if (g && ENROLL_GROUPS[g]) setGroupKey(g);
  }, []);

  function setField(id: string, v: string) {
    setValues((prev) => ({ ...prev, [id]: v }));
  }

  function handleGroupChange(key: string) {
    setGroupKey(key);
    setValues({});
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    for (const f of group.fields) {
      if (f.required && !values[f.id]?.trim()) {
        setError(`「${f.label}」を入力してください。`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const isOneTime = values.paymentMethod === "都度払い";
      const paymentMethod: PaymentMethod = isOneTime ? "都度払い" : "月謝";
      const counterRef = doc(db, "counters", "members");

      const issued = await runTransaction(db, async (tx) => {
        const counterSnap = await tx.get(counterRef);
        const next = counterSnap.exists()
          ? (counterSnap.data().next as number)
          : MEMBER_COUNTER_START;
        const memberId = String(next);
        const memberRef = doc(db, "members", memberId);

        tx.set(counterRef, { next: next + 1 }, { merge: true });
        tx.set(memberRef, {
          id: memberId,
          name: values.name ?? "",
          nameKana: values.nameKana ?? "",
          birthDate: values.birthDate ?? "",
          guardian: values.guardian ?? "",
          guardianKana: values.guardianKana ?? "",
          grade: values.grade ?? "",
          occupation: values.occupation ?? "",
          otherLessons: values.otherLessons ?? "",
          healthNotes: values.healthNotes ?? "",
          emergencyContact: values.emergencyContact ?? "",
          expectations: values.expectations ?? "",
          group: group.title,
          groupCategory: "本部稽古",
          license: "入門",
          joinDate: new Date().toISOString().slice(0, 10),
          status: "在籍",
          paymentMethod,
          paymentStatus: "未納",
          rsvp: "未回答",
          email: values.email ?? "",
          phone: values.phone ?? "",
          address: values.address ?? "",
          createdAt: serverTimestamp(),
        });
        return memberId;
      });

      setIssuedNo(issued);
      setPayInfo({
        label: isOneTime ? "お支払い（都度払い・今回分）" : "お支払い（月謝・自動払い）",
        amount: isOneTime ? group.amounts.onetime : group.amounts.subscription,
        link: isOneTime ? group.links.onetime : group.links.subscription,
      });
      setStep("confirm");
    } catch (err) {
      console.error(err);
      setError("送信に失敗しました。お手数ですが、時間をおいて再度お試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16 p-6">
      <div className="text-center mb-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/meigetsukai-crest.png"
          alt="家紋"
          className="w-20 h-20 mx-auto mb-3"
        />
        <div className="text-[11px] text-[#B8934A] tracking-widest mb-2">茶道宗徧流不審庵</div>
        <h1 className="text-xl font-bold text-matcha-deep">お稽古入会のお申し込み</h1>
      </div>

      {step === "form" && group.notice && (
        <div className="bg-matcha-pale border border-line rounded-md p-5 mb-6 text-sm leading-relaxed">
          <p className="whitespace-pre-line mb-4">{group.notice.body}</p>
          <a
            href={group.notice.guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center bg-white border border-matcha-deep text-matcha-deep rounded py-3 text-sm font-semibold"
          >
            {group.notice.guideLabel ?? "入会の手引きをダウンロード"}
          </a>
        </div>
      )}

      <div className="bg-paper border border-line rounded-md p-6">
        {step === "form" ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">お申し込み先の会</label>
              <select
                className="w-full border border-line rounded px-3 py-2 text-sm bg-[#FCFBF8]"
                value={groupKey}
                onChange={(e) => handleGroupChange(e.target.value)}
              >
                {Object.values(ENROLL_GROUPS).map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label ?? g.title}
                  </option>
                ))}
              </select>
            </div>

            {group.fields.map((f) => (
              <div key={f.id}>
                <label className="block text-xs text-muted mb-1">
                  {f.label}
                  {f.required && <span className="text-hanko"> *</span>}
                </label>
                {f.type === "select" ? (
                  <select
                    className="w-full border border-line rounded px-3 py-2 text-sm bg-[#FCFBF8]"
                    value={values[f.id] ?? ""}
                    onChange={(e) => setField(f.id, e.target.value)}
                  >
                    <option value="" disabled>
                      選択してください
                    </option>
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type}
                    className="w-full border border-line rounded px-3 py-2 text-sm bg-[#FCFBF8]"
                    placeholder={f.placeholder}
                    value={values[f.id] ?? ""}
                    onChange={(e) => setField(f.id, e.target.value)}
                  />
                )}
              </div>
            ))}

            {error && <p className="text-hanko text-xs">{error}</p>}

            <button
              disabled={submitting}
              className="w-full bg-matcha-deep text-white rounded py-3 text-sm disabled:opacity-50"
            >
              {submitting ? "送信中…" : "申し込む"}
            </button>
          </form>
        ) : (
          <div>
            <div className="text-center py-2">
              <div className="w-10 h-10 rounded-full bg-matcha-pale text-matcha-deep flex items-center justify-center mx-auto mb-3 text-lg">
                ✓
              </div>
              <div className="text-base font-bold text-matcha-deep mb-1">
                ご入会いただきありがとうございます
              </div>
              <div className="text-sm text-muted">お申し込みを受け付けました</div>
            </div>

            <div className="border border-line rounded p-4 mt-4 bg-matcha-pale">
              <div className="text-xs text-muted mb-1">発行された会員番号</div>
              <div className="text-lg font-bold text-matcha-deep">{issuedNo}</div>
            </div>

            {payInfo && (
              <div className="border border-line rounded p-4 mt-3 bg-[#FCFBF8]">
                <div className="text-xs text-muted mb-1">{payInfo.label}</div>
                <div className="text-lg font-bold mb-3">
                  {payInfo.amount}
                  {payInfo.label.includes("月謝") && (
                    <span className="text-[11px] text-muted font-normal"> / 月</span>
                  )}
                </div>
                <a
                  href={payInfo.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center bg-white border border-hanko text-hanko rounded py-3 text-sm font-semibold"
                >
                  Squareでお支払いへ進む
                </a>
              </div>
            )}

            <p className="text-[11px] text-muted text-center mt-4">
              会員番号は今後のログインに必要です。控えておいてください。
            </p>
          </div>
        )}
      </div>

      {step === "form" && (
        <p className="text-center text-xs text-muted mt-4">
          すでに会員番号をお持ちの方は{" "}
          <a href="/mypage/login" className="underline">
            こちらからログイン
          </a>
        </p>
      )}
    </div>
  );
}
