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

// カード自動払い（Square）の申込みボタンが出ない原因を調べる。
// 使い方：node scripts/checkSquareBilling.js            … 「表示する」設定の会員を一覧
//         node scripts/checkSquareBilling.js 会員番号   … その会員の判定材料を表示
(async () => {
  const id = process.argv[2];
  const TARGET = ["茶道教室", "名月会", "Gマダムの茶の湯講座"];
  const show = (d) => {
    const m = d.data();
    const problems = [];
    if (!TARGET.includes(m.group)) problems.push(`対象外の会（${m.group}）`);
    if (m.status !== "在籍") problems.push(`在籍ではない（${m.status}）`);
    if (m.paymentMethod === "都度払い") problems.push("都度払い");
    if (m.squareBillingAllowed !== true) problems.push(`申込みボタンの設定が「表示する」になっていない（${m.squareBillingAllowed ?? "未設定"}）`);
    if (!m.email) problems.push("メールアドレス未登録");
    console.log(`${d.id} ${m.name}｜${m.group}｜${m.status}｜${m.paymentMethod ?? "-"}｜入会日 ${m.joinDate}｜squareBillingAllowed=${m.squareBillingAllowed}`);
    console.log(problems.length ? `  → 出ない理由：${problems.join("／")}` : "  → 条件はすべて満たしています（ボタンが出るはず）");
  };
  if (id) {
    const d = await db.doc(`members/${id}`).get();
    if (!d.exists) return console.log(`会員番号 ${id} が見つかりません`);
    show(d);
    const s = await db.doc(`memberSubscriptions/${id}`).get();
    console.log(s.exists ? `  契約データ：${JSON.stringify(s.data())}` : "  契約データ：なし");
  } else {
    const q = await db.collection("members").where("squareBillingAllowed", "==", true).get();
    if (q.empty) console.log("「マイページに表示する」に設定された会員はいません。管理画面の会員詳細で設定し、「保存」を押してください。");
    q.forEach(show);
  }
})();
