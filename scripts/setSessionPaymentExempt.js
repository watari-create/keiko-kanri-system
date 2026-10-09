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

// 都度払いの「支払い確認の対象外」（sessionPaymentExempt）を設定する。
// 対象外の会員には、未入金の通知・支払い後の欠席の通知・マイページの支払い案内を出さない。
// 使い方：node scripts/setSessionPaymentExempt.js           … 対象の確認だけ（書き込みなし）
//         node scripts/setSessionPaymentExempt.js --apply   … 書き込む
// 2026-10-09 ゆちゃ指示：名月会の楢原 万栗絵さん・小木曽 宗哲（哲哉）さんは対象外
const TARGETS = [
  { group: "名月会", names: ["楢原"] },
  { group: "名月会", names: ["小木曽"] },
];
const apply = process.argv.includes("--apply");
(async () => {
  const snap = await db.collection("members").where("group", "==", "名月会").get();
  for (const t of TARGETS) {
    const hits = snap.docs.filter((d) => {
      const m = d.data();
      const text = `${m.name ?? ""} ${m.nameKana ?? ""} ${m.soumei ?? ""}`;
      return t.names.some((n) => text.includes(n));
    });
    if (hits.length !== 1) {
      console.log(`⚠️ ${t.names.join("/")}：${hits.length}件見つかりました（1件でないため変更しません）`, hits.map((d) => `${d.id} ${d.data().name}`));
      continue;
    }
    const d = hits[0];
    const m = d.data();
    console.log(`${d.id} ${m.name}（${m.group}・${m.paymentMethod ?? "-"}・${m.status ?? "-"}）現在：${m.sessionPaymentExempt === true ? "対象外" : "対象"}`);
    if (apply) {
      await d.ref.update({ sessionPaymentExempt: true });
      console.log("  → 対象外にしました");
    }
  }
  if (!apply) console.log("\n確認だけです。書き込むには --apply を付けて実行してください。");
})();
