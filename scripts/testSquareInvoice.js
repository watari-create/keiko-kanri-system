// Square請求書の自動送信（functions/src/squareInvoice.ts）を本番で1件だけ試すスクリプト。
// テスト会員宛に【テスト】の許状申請（¥100）を作って「請求書発行依頼」にし、請求書が届いたのを確かめたら
// 申請を「取消」にして、Square上の請求書も自動でキャンセルさせる。最後にテスト用の申請を削除する。
//
// 使い方： node scripts/testSquareInvoice.js            … テスト会員（isTestAccount）の一覧を表示
//         node scripts/testSquareInvoice.js <会員番号>  … その会員宛にテスト送信する

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
const readline = require("readline");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}
async function waitFor(ref, check, label, seconds = 90) {
  for (let i = 0; i < seconds / 3; i++) {
    const d = (await ref.get()).data() || {};
    if (check(d)) return d;
    process.stdout.write(".");
    await sleep(3000);
  }
  console.log(`\n${label}：${seconds}秒待っても結果が出ませんでした。Cloud Functionsのログを確認してください。`);
  return null;
}

async function run() {
  const memberId = process.argv[2];
  if (!memberId) {
    const snap = await db.collection("members").where("isTestAccount", "==", true).get();
    console.log("テスト会員の一覧（会員番号 を付けて実行してください）:");
    snap.docs.forEach((d) => console.log(`  ${d.id}  ${d.data().name}（${d.data().group}）  ${d.data().email || "メール未登録"}`));
    return;
  }
  const m = await db.doc(`members/${memberId}`).get();
  if (!m.exists) throw new Error(`会員 ${memberId} が見つかりません`);
  const md = m.data();
  console.log(`宛先：${md.name}（${md.group}）  ${md.email || "メール未登録"}${md.isTestAccount ? "" : "  ※テスト会員ではありません"}`);
  if ((await ask("この会員宛に【テスト】¥100の請求書を送ります。よろしいですか？ (y/N) ")).trim().toLowerCase() !== "y") return;

  const ref = db.collection("licenseRequests").doc();
  const now = new Date().toISOString();
  // 「受付」で作るとSlackの新規申請通知が出るため、別のステータスで作ってから「請求書発行依頼」にする
  await ref.set({
    memberId,
    memberName: md.name,
    group: md.group,
    licenseName: "【テスト】請求書の自動送信テスト",
    fee: 100,
    status: "テスト準備",
    appliedDate: now.slice(0, 10),
    isTest: true,
    updatedAt: now,
  });
  await ref.update({ status: "請求書発行依頼", updatedAt: new Date().toISOString() });
  process.stdout.write("請求書の送信を待っています");
  const d = await waitFor(ref, (x) => x.squareInvoice || x.squareInvoiceError, "送信");
  console.log("");
  if (!d) return;
  if (d.squareInvoiceError) {
    console.log(`送信できませんでした：${d.squareInvoiceError}`);
  } else {
    console.log(`送信しました：請求書番号 ${d.squareInvoice.number}  期日 ${d.squareInvoice.dueDate}  ステータス ${d.status}`);
    console.log(`請求書ページ：${d.squareInvoice.url}`);
    await ask("メールが届いたことを確認したら Enter を押してください（請求書をキャンセルします）");
    await ref.update({ status: "取消", updatedAt: new Date().toISOString() });
    process.stdout.write("キャンセルを待っています");
    const c = await waitFor(ref, (x) => x.squareInvoice && x.squareInvoice.status === "CANCELED", "キャンセル");
    console.log("");
    if (c) console.log("Square上の請求書をキャンセルしました。");
  }
  await ref.delete();
  console.log("テスト用の申請を削除しました。");
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
