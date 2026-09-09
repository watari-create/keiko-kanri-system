// licenseRequests コレクションの中身を確認する一度きりのスクリプト。
// 使い方： node scripts/checkLicenseRequests.js

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
  const snap = await db.collection("licenseRequests").get();
  if (snap.empty) {
    console.log("licenseRequests コレクションは空です。");
    return;
  }
  snap.forEach((doc) => {
    console.log(doc.id, JSON.stringify(doc.data(), null, 2));
  });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
