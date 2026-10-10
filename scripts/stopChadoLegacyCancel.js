const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const os = require("os");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
// Firebase CLI（npx firebase-tools login）のログイン情報。組織ポリシーで秘密鍵を作れないため、これを使う。
const firebaseCliConfig = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else if (fs.existsSync(firebaseCliConfig) && require(firebaseCliConfig).tokens?.refresh_token) {
  // Firestoreは「アプリケーションのデフォルト認証情報（ADC）」形式しか受け付けないため、
  // Firebase CLIのログイン情報をADC形式の一時ファイルに書き出して使う。
  const adcPath = path.join(os.tmpdir(), "keiko-app-adc.json");
  fs.writeFileSync(
    adcPath,
    JSON.stringify({
      type: "authorized_user",
      // Firebase CLI の公開OAuthクライアント（firebase-tools に同梱の値）
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: require(firebaseCliConfig).tokens.refresh_token,
      quota_project_id: "sohenryu-okeiko-management",
    }),
    { mode: 0o600 }
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
} else {
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}
const db = getFirestore();

// 茶道教室はSquareではない別の仕組みでお月謝を払っていたため、
// カード自動払いへの切り替え時に「同じメールアドレスのSquareの契約」を旧契約として自動解約する予定になっていたものを止める。
// すでにSquareで解約予約された契約は、解約予約を取り消す。
// 使い方：node scripts/stopChadoLegacyCancel.js          … 確認のみ
//         node scripts/stopChadoLegacyCancel.js --apply  … 実行
const { execSync } = require("child_process");
(async () => {
  const apply = process.argv.includes("--apply");
  const token = execSync(
    "npx -y firebase-tools@latest functions:secrets:access SQUARE_ACCESS_TOKEN --project sohenryu-okeiko-management 2>/dev/null"
  ).toString().trim().split("\n").pop().trim();
  const sq = async (method, path, body) => {
    const r = await fetch(`https://connect.squareup.com${path}`, {
      method,
      headers: { "Square-Version": "2025-01-23", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors ?? j));
    return j;
  };
  const snap = await db.collection("memberSubscriptions").where("group", "==", "茶道教室").get();
  let n = 0;
  for (const d of snap.docs) {
    const s = d.data();
    const ids = s.legacySubscriptionIds ?? [];
    if (!ids.length && !s.migratedFromLink) continue;
    n++;
    console.log(`\n${d.id} ${s.memberName}：旧契約として登録されたSquareの契約 ${ids.length}件（状態：${s.legacyCancelStatus ?? "—"}）`);
    for (const id of ids) {
      try {
        const { subscription: x } = await sq("GET", `/v2/subscriptions/${id}?include=actions`);
        console.log(`  ${id}　状態 ${x.status}　解約予定日 ${x.canceled_date ?? "なし"}　${x.charged_through_date ?? ""}まで支払い済み`);
        if (apply && x.canceled_date && x.status === "ACTIVE") {
          // 解約予約の取り消し（canceled_date を消す）
          const acts = (x.actions ?? []).filter((a) => a.type === "CANCEL");
          for (const a of acts) await sq("DELETE", `/v2/subscriptions/${id}/actions/${a.id}`);
          console.log(`    → 解約予約を取り消しました`);
        }
      } catch (e) {
        console.log(`  ${id}　確認・取り消しに失敗：${e.message}`);
      }
    }
    if (apply) {
      await d.ref.update({
        migratedFromLink: false,
        legacySubscriptionIds: [],
        legacyCanceledIds: [],
        legacyCancelStatus: "done",
        legacyCancelNote: "茶道教室は決済リンク（Square）を使っていなかったため、旧契約の自動解約を止めました（2026-10-10）",
      });
      console.log("  → 自動解約の予定を止めました");
    }
  }
  console.log(n ? `\n${n}名${apply ? "を処理しました" : "（--apply を付けると実行します）"}` : "対象はありません");
})();
