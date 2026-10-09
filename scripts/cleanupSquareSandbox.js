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

// テスト環境（sandbox）で作ったカード自動払いの契約データを削除する（本番切り替え時に1回だけ実行）。
// 使い方：node scripts/cleanupSquareSandbox.js          … 対象の確認のみ
//         node scripts/cleanupSquareSandbox.js --apply  … 実際に削除
(async () => {
  const apply = process.argv.includes("--apply");
  const snap = await db.collection("memberSubscriptions").get();
  let n = 0;
  for (const d of snap.docs) {
    const s = d.data();
    if (s.environment === "production") continue;
    n++;
    console.log(`${apply ? "[削除]" : "[削除予定]"} ${d.id} ${s.memberName ?? ""}（${s.environment ?? "環境不明"}・${s.status ?? ""}）`);
    if (apply) {
      const pays = await d.ref.collection("payments").get();
      for (const p of pays.docs) await p.ref.delete();
      await d.ref.delete();
    }
  }
  console.log(n ? `${n}件${apply ? "削除しました" : "（--apply を付けると削除します）"}` : "テスト環境の契約データはありません");
})();
