// 最初の本部アカウントに role:'honbu' のカスタムクレームを付与するための、一度だけ実行するスクリプト。
//
// 使い方：
//   1. Firebaseコンソール → プロジェクトの設定 → サービスアカウント → 「新しい秘密鍵の生成」で
//      JSONファイルをダウンロードし、このファイルと同じ階層に serviceAccountKey.json として保存する
//      （このファイルは絶対にGitにコミットしないこと。.gitignoreに追加済み）
//   2. Firebase Authenticationで、本部用のメールアドレス・パスワードのユーザーを先に作成しておく
//   3. node scripts/setAdminClaim.js <そのユーザーのUID>

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
if (fs.existsSync(keyPath)) {
  // サービスアカウントキーがある場合はそれを使う
  admin.initializeApp({
    credential: admin.credential.cert(require(keyPath)),
  });
} else {
  // 組織ポリシーでサービスアカウントキーの発行が禁止されている場合は、
  // `gcloud auth application-default login --project sohenryu-okeiko-management`
  // を先に実行しておくと、ここで自動的にその認証情報が使われる。
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}

const uid = process.argv[2];
if (!uid) {
  console.error("使い方: node scripts/setAdminClaim.js <UID>");
  process.exit(1);
}

admin
  .auth()
  .setCustomUserClaims(uid, { role: "honbu" })
  .then(() => {
    console.log(`UID ${uid} に role:'honbu' を設定しました。`);
    console.log("反映には、そのユーザーが一度ログアウト→再ログインする必要があります。");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
