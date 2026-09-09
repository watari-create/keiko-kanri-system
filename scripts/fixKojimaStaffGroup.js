// 診断スクリプト（scripts/diagnoseStaffGroups.js）で見つかった、
// staff/850275（小嶋宗裕先生）の groups の誤字を修正する一度きりのスクリプト。
// 誤: "G1マダムの茶の湯講座" → 正: "Gマダムの茶の湯講座"（members側の実際の値と一致させる）
//
// 使い方： node scripts/fixKojimaStaffGroup.js

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

async function run() {
  const ref = db.collection("staff").doc("850275");
  const snap = await ref.get();
  if (!snap.exists) {
    console.log("staff/850275 が見つかりません。処理を中止します。");
    process.exit(1);
  }
  const data = snap.data();
  console.log("変更前 groups:", data.groups);

  const fixed = (data.groups || []).map((g) =>
    g === "G1マダムの茶の湯講座" ? "Gマダムの茶の湯講座" : g
  );

  if (JSON.stringify(fixed) === JSON.stringify(data.groups)) {
    console.log("該当する誤字が見つからなかったため、変更していません。");
    process.exit(0);
  }

  await ref.update({ groups: fixed });
  console.log("変更後 groups:", fixed);
  console.log("staff/850275 の groups を修正しました。");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
