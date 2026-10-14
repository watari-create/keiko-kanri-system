// 指定したメールアドレスのアカウントを「本部（管理者）」にして、強力なパスワードに変更するスクリプト。
// 2026-10-07 作成（yuu.watari@sohenryu.com を本部にするため）。
//
// 使い方（必ず ~/Desktop/keiko-app で実行）：
//   node scripts/setHonbuAdmin.js <メールアドレス>          … 今の状態の確認のみ（何も変更しない）
//   node scripts/setHonbuAdmin.js <メールアドレス> --apply  … 本部権限を付け、パスワードを新しく発行する
//   node scripts/setHonbuAdmin.js <メールアドレス> --apply --level=viewer … 権限レベルを指定（admin／editor／viewer、省略時は admin）
//
// 2026-10-14〜 本部の権限は「アドミン／編集できる／閲覧のみ」の3段階（honbuLevel）。ふだんの追加・変更は
// 管理画面「システム管理 → 権限管理」から行う。このスクリプトはアドミンが誰もログインできなくなったときの非常用。
//
// --apply の内容：
//   1. アカウントがなければ作成する
//   2. role: 'honbu' を付与する（他のクレームはそのまま残す）
//   3. 24文字のランダムなパスワードをこのパソコン上で生成して設定し、画面に一度だけ表示する
//   4. ほかの端末でのログインをすべて無効にする（古いパスワードで入っていた端末を締め出す）
// パスワードはどこにも保存しない。表示されたらすぐパスワード管理アプリ等に控えること。

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");
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

// 紛らわしい文字（0/O, 1/l/I など）を除いた文字から、偏りなく24文字を選ぶ
function generatePassword(length = 24) {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = lower + upper + digits + symbols;
  const pick = (set) => set[crypto.randomInt(set.length)];
  while (true) {
    let pw = "";
    for (let i = 0; i < length; i++) pw += pick(all);
    // 4種類すべてを必ず含める
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) return pw;
  }
}

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  const levelArg = (process.argv.find((a) => a.startsWith("--level=")) || "--level=admin").slice("--level=".length);
  if (!["admin", "editor", "viewer"].includes(levelArg)) {
    console.error("--level は admin／editor／viewer のいずれかを指定してください");
    process.exit(1);
  }
  if (!email || !email.includes("@")) {
    console.error("使い方: node scripts/setHonbuAdmin.js <メールアドレス> [--apply]");
    process.exit(1);
  }
  const auth = getAuth();

  let user = null;
  try {
    user = await auth.getUserByEmail(email);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
  }

  if (user) {
    console.log(`アカウントあり：${user.email}（UID ${user.uid}）`);
    console.log(`  現在の権限：${JSON.stringify(user.customClaims || {})}`);
    console.log(`  ログイン方法：${user.providerData.map((p) => p.providerId).join(", ") || "なし"}`);
    console.log(`  最終ログイン：${user.metadata.lastSignInTime || "-"}`);
  } else {
    console.log(`アカウントなし：${email}（--apply で新しく作成します）`);
  }

  if (!apply) {
    console.log("\n確認のみ（変更していません）。実行するには末尾に --apply を付けてください。");
    return;
  }

  const password = generatePassword();
  if (!user) {
    user = await auth.createUser({ email, password, emailVerified: false });
    console.log(`\nアカウントを作成しました（UID ${user.uid}）`);
  } else {
    await auth.updateUser(user.uid, { password });
    console.log("\nパスワードを変更しました");
  }
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), role: "honbu", honbuLevel: levelArg });
  const levelLabel = { admin: "アドミン", editor: "編集できる", viewer: "閲覧のみ" }[levelArg];
  console.log(`本部権限（${levelLabel}）を付けました`);
  await auth.revokeRefreshTokens(user.uid);
  console.log("ほかの端末でのログインをすべて無効にしました（新しいパスワードで入り直してください）");

  console.log("\n================ 新しいパスワード（この画面にだけ表示） ================");
  console.log(password);
  console.log("========================================================================");
  console.log("※ すぐにパスワード管理アプリ等に控えてから、ターミナルの画面を閉じてください（⌘K で消去できます）。");
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
