"use client";

// 入会のお申し込み（未ログインの方向け・公開ページ）
// /login からも「はじめての方はこちら」で来られるが、SNSやチラシのQRコードから
// このURLに直接誘導できるよう、/enroll として独立させている。
//
// 会員番号は送信と同時にその場で発行する（本部の事前承認は挟まない）。
// 発行ロジック・料金・入力項目は src/lib/enrollGroups.ts を参照。

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "@/lib/firebase";
import { ENROLL_GROUPS, MEMBER_COUNTER_START } from "@/lib/enrollGroups";
import type { ChadoClassLedgerEntry, ChadoRecruitClass, PaymentMethod } from "@/types";
import { formatYenNum, recruitTimeLabel } from "@/lib/chadoRecruit";
import { entryFeeFor } from "@/lib/memberFees";
import { chadoEnrollOptionLabel, mergeChadoLedger } from "@/lib/chadoClassLedger";

type Step = "form" | "confirm";

export default function EnrollPage() {
  const [groupKey, setGroupKey] = useState<string>("meigetsu");
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("form");
  const [issuedNo, setIssuedNo] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ label: string; amount: string; link: string; cardBilling?: boolean } | null>(null);
  // 入会金を最初のお支払い（カード登録・都度払いの支払いページ）に含めたか。含めない場合は後日Squareの請求書
  const [entryFeeWithFirstPayment, setEntryFeeWithFirstPayment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ご家族との連携（任意）：すでに登録済みのご家族の会員番号・登録メールアドレスが
  // 一致すれば、新規会員と相互に連携する（マイページで家族を切り替えられるようになる）。
  const [showFamilyLink, setShowFamilyLink] = useState(false);
  const [familyMemberNo, setFamilyMemberNo] = useState("");
  const [familyEmail, setFamilyEmail] = useState("");
  const [familyLinkStatus, setFamilyLinkStatus] = useState<"idle" | "success" | "error">("idle");

  // 茶道教室：クラス台帳（chadoClassLedger）で「入会受付」がオンのクラスだけを選択肢にする。
  // null = 読み込み中。台帳に定員が設定されていても在籍数は公開ページから読めないため、満席判定は管理画面側で受付をオフにして行う。
  const [chadoOpenClasses, setChadoOpenClasses] = useState<ChadoClassLedgerEntry[] | null>(null);
  useEffect(() => {
    getDocs(collection(db, "chadoClassLedger"))
      .then((snap) => {
        const docs: Record<string, Partial<ChadoClassLedgerEntry>> = {};
        snap.docs.forEach((d) => (docs[d.id] = d.data() as Partial<ChadoClassLedgerEntry>));
        setChadoOpenClasses(mergeChadoLedger(docs).filter((e) => e.accepting));
      })
      .catch(() => setChadoOpenClasses([]));
    // 新規募集クラス（管理画面の「＋ 新規クラスを作成して募集」で作成、受付中のもの）
    getDocs(query(collection(db, "chadoRecruitClasses"), where("accepting", "==", true)))
      .then((snap) =>
        setRecruitClasses(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as ChadoRecruitClass))
            .sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""))
        )
      )
      .catch(() => setRecruitClasses([]));
  }, []);
  const [recruitClasses, setRecruitClasses] = useState<ChadoRecruitClass[] | null>(null);

  const baseGroup = ENROLL_GROUPS[groupKey];
  const group =
    baseGroup.title === "茶道教室"
      ? {
          ...baseGroup,
          fields: baseGroup.fields.map((f) =>
            f.id === "chadoClass"
              ? {
                  ...f,
                  options: [
                    ...(recruitClasses ?? []).map((c) => `cohort:${c.id}`),
                    ...(chadoOpenClasses ?? []).map((e) => e.id),
                  ],
                  optionLabels: Object.fromEntries([
                    ...(recruitClasses ?? []).map((c) => [`cohort:${c.id}`, `${c.name}（${recruitTimeLabel(c)}）`]),
                    ...(chadoOpenClasses ?? []).map((e) => [e.id, chadoEnrollOptionLabel(e.id)]),
                  ]),
                }
              : f
          ),
        }
      : baseGroup;
  // 茶道教室で受付中のクラスが1つも無いときは、フォームの代わりに案内を表示する
  const chadoClosed =
    baseGroup.title === "茶道教室" &&
    chadoOpenClasses !== null &&
    recruitClasses !== null &&
    chadoOpenClasses.length === 0 &&
    recruitClasses.length === 0;
  const chadoLoading = baseGroup.title === "茶道教室" && (chadoOpenClasses === null || recruitClasses === null);
  // 選択中の新規募集クラス
  const selectedRecruit =
    baseGroup.title === "茶道教室" && values.chadoClass?.startsWith("cohort:")
      ? (recruitClasses ?? []).find((c) => `cohort:${c.id}` === values.chadoClass) ?? null
      : null;

  // showIf の条件を満たす項目だけを表示・必須チェックする（例：茶道教室のプランは土曜日クラスのみ）
  const visibleFields = group.fields.filter(
    (f) => !f.showIf || values[f.showIf.field] === f.showIf.equals
  );

  // プラン制の会（茶道教室）で、現在選ばれているプラン
  const selectedPlan = group.plans
    ? group.plans.options[
        visibleFields.some((f) => f.id === group.plans!.fieldId) && values[group.plans.fieldId]
          ? values[group.plans.fieldId]
          : group.plans.defaultKey
      ] ?? group.plans.options[group.plans.defaultKey]
    : null;

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
    if (chadoClosed || chadoLoading) return;

    for (const f of visibleFields) {
      if (f.required && !values[f.id]?.trim()) {
        setError(`「${f.label}」を入力してください。`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const isOneTime = !group.plans && values.paymentMethod === "都度払い";
      // 茶道教室のみ：曜日クラスと月の予約可能回数（土曜日クラスのみ）を保存する
      const chadoFields: Record<string, unknown> = {};
      if (group.title === "茶道教室" && selectedRecruit) {
        chadoFields.chadoCohortId = selectedRecruit.id;
      } else if (group.title === "茶道教室" && values.chadoClass) {
        chadoFields.chadoClass = values.chadoClass;
        if (values.chadoClass === "土曜日" && selectedPlan?.monthlyQuota) {
          chadoFields.chadoMonthlyQuota = selectedPlan.monthlyQuota;
        }
      }
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
          gender: values.gender === "男性" || values.gender === "女性" ? values.gender : "",
          guardian: values.guardian ?? "",
          guardianKana: values.guardianKana ?? "",
          grade: values.grade ?? "",
          affiliation: values.affiliation ?? "",
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
          ...chadoFields,
          createdAt: serverTimestamp(),
        });
        return memberId;
      });

      setIssuedNo(issued);

      if (showFamilyLink && familyMemberNo.trim()) {
        try {
          const functions = getFunctions();
          const linkFamily = httpsCallable<
            { newMemberId: string; existingMemberNo: string; existingEmail: string },
            { linked: boolean; existingMemberName: string }
          >(functions, "linkFamilyOnEnroll");
          await linkFamily({
            newMemberId: issued,
            existingMemberNo: familyMemberNo.trim(),
            existingEmail: (familyEmail || values.email || "").trim(),
          });
          setFamilyLinkStatus("success");
        } catch (err) {
          console.error(err);
          setFamilyLinkStatus("error");
        }
      }

      // 都度払い：この会員専用のSquareの支払いページ（今回分）を作る。入金は経理タブに自動で反映される。
      // 作れなかったときは決済リンクは出さず「本部より別途ご案内」と表示する
      // 入会金のある会は、入会金の明細も同じ支払いページに入る（functions/src/entryFee.ts）
      let onetimeUrl = "";
      let onetimeEntryFee = 0;
      if (isOneTime) {
        try {
          const fn = httpsCallable<
            { memberId: string; returnUrl: string },
            { paid: boolean; url?: string; entryFee?: number }
          >(getFunctions(), "createEnrollSessionCheckout");
          const res = await fn({ memberId: issued, returnUrl: `${window.location.origin}/mypage/login` });
          onetimeUrl = res.data.url ?? "";
          onetimeEntryFee = onetimeUrl ? res.data.entryFee ?? 0 : 0;
        } catch (err) {
          console.error("都度払いの支払いページの作成に失敗しました", err);
        }
      }

      // カード自動払い（マイページから申込み）を使う場合は、Squareの決済リンクの代わりにマイページへ案内する。
      // Vercelの環境変数 NEXT_PUBLIC_SQUARE_BILLING_ENABLED=1 で有効になる（本番のSquare設定が済んでから）。
      const cardBilling =
        process.env.NEXT_PUBLIC_SQUARE_BILLING_ENABLED === "1" &&
        !isOneTime &&
        ["茶道教室", "名月会", "Gマダムの茶の湯講座"].includes(group.title);
      const withCard = <T extends object>(info: T) => ({ ...info, cardBilling });
      setEntryFeeWithFirstPayment(cardBilling || onetimeEntryFee > 0);
      setPayInfo(withCard(
        selectedRecruit
          ? {
              label: `お支払い（月謝・自動払い）　${selectedRecruit.name}`,
              amount: formatYenNum(selectedRecruit.monthlyFee),
              link: selectedRecruit.paymentLink ?? "",
            }
          : selectedPlan
          ? {
              label: `お支払い（月謝・自動払い）　${selectedPlan.label}`,
              amount: selectedPlan.amount,
              link: selectedPlan.link,
            }
          : {
              label: isOneTime ? "お支払い（都度払い・今回分）" : "お支払い（月謝・自動払い）",
              amount: isOneTime
                ? onetimeEntryFee > 0
                  ? `${group.amounts.onetime}＋入会金 ${formatYenNum(onetimeEntryFee)}`
                  : group.amounts.onetime
                : group.amounts.subscription,
              link: isOneTime ? onetimeUrl : group.links.subscription,
            }
      ));
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

            {chadoClosed && (
              <div className="bg-matcha-pale border border-line rounded p-4 text-sm leading-relaxed">
                現在、茶道教室は新規のご入会を受け付けておりません。
                <br />
                次回の募集は公式LINE・ホームページでご案内いたします。
              </div>
            )}
            {chadoLoading && <p className="text-xs text-muted">受付中のクラスを確認しています…</p>}

            {!chadoClosed && !chadoLoading && visibleFields.map((f) => (
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
                        {f.optionLabels?.[o] ?? o}
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
                {f.id === "chadoClass" && selectedRecruit && (
                  <div className="mt-2 bg-matcha-pale border border-line rounded p-3 text-xs leading-relaxed">
                    <div className="font-bold text-sm mb-1">{selectedRecruit.name}</div>
                    <div>{recruitTimeLabel(selectedRecruit)}　講師：{selectedRecruit.teacher}</div>
                    <div>開始日：{selectedRecruit.startDate}</div>
                    {selectedRecruit.schedule && <div>日程：{selectedRecruit.schedule}</div>}
                    <div>月謝：{formatYenNum(selectedRecruit.monthlyFee)}</div>
                    {selectedRecruit.note && <p className="whitespace-pre-line mt-1">{selectedRecruit.note}</p>}
                  </div>
                )}
              </div>
            ))}

            <div className="border-t border-line pt-4">
              <label className="flex items-start gap-2 text-xs text-muted mb-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={showFamilyLink}
                  onChange={(e) => setShowFamilyLink(e.target.checked)}
                />
                <span>
                  ご家族がすでに会員登録済みです（連携すると、マイページでご家族の情報を切り替えて確認できるようになります）
                </span>
              </label>
              {showFamilyLink && (
                <div className="space-y-3 mt-2">
                  <div>
                    <label className="block text-xs text-muted mb-1">ご家族の会員番号</label>
                    <input
                      className="w-full border border-line rounded px-3 py-2 text-sm"
                      value={familyMemberNo}
                      onChange={(e) => setFamilyMemberNo(e.target.value)}
                      placeholder="例：30000001"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">
                      そのご家族のご登録メールアドレス（上の「メールアドレス」と同じ場合は未入力でかまいません）
                    </label>
                    <input
                      type="email"
                      className="w-full border border-line rounded px-3 py-2 text-sm"
                      value={familyEmail}
                      onChange={(e) => setFamilyEmail(e.target.value)}
                      placeholder={values.email || "example@example.com"}
                    />
                  </div>
                </div>
              )}
            </div>

            {error && <p className="text-hanko text-xs">{error}</p>}

            <button
              disabled={submitting || chadoClosed || chadoLoading}
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
                {payInfo.cardBilling ? (
                  <>
                    <p className="text-xs text-muted leading-relaxed mb-3">
                      お月謝は前払いのクレジットカード自動払いです（参加開始月の分はカード登録時、以降は毎月25日に翌月分）。
                      {entryFeeFor(group.title) !== null && "入会金もカード登録時に同じカードでお支払いいただきます。"}
                      上の会員番号とご登録のメールアドレスでマイページにログインし、カード情報をご登録ください。
                    </p>
                    <a
                      href="/mypage/login?next=/mypage/payment"
                      className="block text-center bg-matcha-deep text-white rounded py-3 text-sm font-semibold"
                    >
                      ログインしてカードを登録する
                    </a>
                  </>
                ) : payInfo.link ? (
                  <a
                    href={payInfo.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-center bg-white border border-hanko text-hanko rounded py-3 text-sm font-semibold"
                  >
                    Squareでお支払いへ進む
                  </a>
                ) : (
                  <p className="text-xs text-muted leading-relaxed">
                    お支払い方法は、本部より別途ご案内いたします。
                  </p>
                )}
              </div>
            )}

            {entryFeeFor(group.title) !== null && (
              <div className="border border-line rounded p-4 mt-3 bg-[#FCFBF8]">
                <div className="text-xs text-muted mb-1">{group.extraFeeNote?.label ?? "入会金（初回のみ）"}</div>
                <div className="text-lg font-bold mb-2">{formatYenNum(entryFeeFor(group.title) ?? 0)}</div>
                <p className="text-xs text-muted leading-relaxed">
                  {group.extraFeeNote?.body}
                  {entryFeeWithFirstPayment
                    ? payInfo?.cardBilling
                      ? "マイページでカードをご登録いただく際に、お月謝と一緒にお支払いいただきます（別途のお手続きは不要です）。"
                      : "上の支払いページで、今回分と一緒にお支払いいただけます。"
                    : "後日、Squareの請求書をメールでお送りいたしますので、そちらからお支払いください。"}
                </p>
              </div>
            )}

            {showFamilyLink && familyMemberNo.trim() && (
              <p className="text-xs text-center mt-4">
                {familyLinkStatus === "success" && "ご家族との連携が完了しました。"}
                {familyLinkStatus === "error" &&
                  "ご家族との連携が確認できませんでした。会員番号・メールアドレスをご確認のうえ、本部までお問い合わせください。"}
              </p>
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
