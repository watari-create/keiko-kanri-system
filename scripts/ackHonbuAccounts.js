// 毎時の監視〈watchPrivilegedAccounts〉に「今いる本部アカウントは承知済み」と記録するスクリプト。
// 2026-10-14 作成（管理画面から正規に追加した本部アカウントで「🚨 本部権限のアカウントが追加されました」
// のSlack通知が出ないようにするため）。
//
// 使い方（必ず ~/Desktop/keiko-app で実行）：
//   node scripts/ackHonbuAccounts.js          … 今の本部アカウントと、監視が覚えている一覧の差を表示（変更しない）
//   node scripts/ackHonbuAccounts.js --apply  … 監視が覚えている一覧を、今の本部アカウントに合わせる
//
// 監視がまだ一度も記録していない（securityState/accounts がない）場合は何もしない
// （その場合、監視の初回は通知せずに今の状態を記録するだけなので、そもそも通知は出ない）。

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const os = require("os");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
const firebaseCliConfig = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
const adcPath = path.join(os.tmpdir(), "keiko-app-adc.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else if (fs.existsSync(firebaseCliConfig) && require(firebaseCliConfig).tokens?.refresh_token) {
  fs.writeFileSync(
    adcPath,
    JSON.stringify({
      type: "authorized_user",
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: require(firebaseCliConfig).tokens.refresh_token,
      quota_project_id: "sohenryu-okeiko-management",
    }),
    { mode: 0o600 }
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  initializeApp({ credential: applicationDefault(), projectId: "sohenryu-okeiko-management" });
} else {
  initializeApp({ credential: applicationDefault(), projectId: "sohenryu-okeiko-management" });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getFirestore();
  const ref = db.collection("securityState").doc("accounts");
  const snap = await ref.get();
  if (!snap.exists) {
    console.log("監視はまだ一度も記録していません（securityState/accounts なし）。");
    console.log("次回の監視は通知せずに今の状態を記録するだけなので、何もしなくて大丈夫です。");
    return;
  }

  const honbu = {};
  let pageToken;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (u.customClaims?.role === "honbu") honbu[u.uid] = u.email || u.uid;
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const prev = snap.data().honbu || {};
  const added = Object.keys(honbu).filter((uid) => !prev[uid]);
  const removed = Object.keys(prev).filter((uid) => !honbu[uid]);
  console.log(`今の本部アカウント：${Object.keys(honbu).length}件`);
  added.forEach((uid) => console.log(`  監視が知らない（このままだと「追加」と通知される）：${honbu[uid]}`));
  removed.forEach((uid) => console.log(`  監視が覚えているが今はない（このままだと「解除」と通知される）：${prev[uid]}`));
  if (added.length === 0 && removed.length === 0) {
    console.log("差はありません。通知は出ません。");
    return;
  }
  if (!apply) {
    console.log("\n確認のみ（変更していません）。承知済みとして記録するには末尾に --apply を付けてください。");
    return;
  }
  await ref.update({ honbu, checkedAt: Timestamp.now() });
  console.log("\n承知済みとして記録しました。これらの通知は出ません。");
}

main()
  .catch((e) => {
    console.error("エラー：", e.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      if (fs.existsSync(adcPath)) fs.unlinkSync(adcPath);
    } catch {}
  });
