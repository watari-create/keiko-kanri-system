// Googleカレンダー同期の動作確認用スクリプト。
// meta/nextLessonDates の内容を表示する。
//
// 使い方： node scripts/checkNextLessonDates.js

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else {
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}

const db = getFirestore();

async function main() {
  const snap = await db.doc("meta/nextLessonDates").get();
  if (!snap.exists) {
    console.log("meta/nextLessonDates はまだ存在しません。");
    return;
  }
  console.log(JSON.stringify(snap.data(), null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
