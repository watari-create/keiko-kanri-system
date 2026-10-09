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

// 新月会の在籍会員全員に「カード自動払い（Square）の申込みボタン」をマイページに表示する（squareBillingAllowed = true）。
// 使い方：node scripts/enableSquareBillingShingetsu.js          … 対象の確認のみ
//         node scripts/enableSquareBillingShingetsu.js --apply  … 実際に設定
(async () => {
  const apply = process.argv.includes("--apply");
  const snap = await db.collection("members").where("group", "==", "新月会").get();
  let n = 0, skip = 0;
  for (const d of snap.docs) {
    const m = d.data();
    if (m.status !== "在籍" || m.isTestAccount) { skip++; continue; }
    if (m.squareBillingAllowed === true) { skip++; continue; }
    n++;
    console.log(`${apply ? "[設定]" : "[設定予定]"} ${d.id} ${m.name}`);
    if (apply) await d.ref.update({ squareBillingAllowed: true });
  }
  console.log(`${apply ? "設定" : "設定予定"}：${n}名／対象外・設定済み：${skip}名`);
})();
