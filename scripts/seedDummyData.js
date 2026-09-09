// 開発・テスト用のダミーデータをFirestoreに投入するscript
// 実在する会員の個人情報は絶対に使わないこと（技術仕様書 6章）。
//
// 使い方： node scripts/seedDummyData.js
// （setAdminClaim.js と同じ serviceAccountKey.json が必要）

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
if (fs.existsSync(keyPath)) {
  // サービスアカウントキーがある場合はそれを使う
  admin.initializeApp({
    credential: admin.cert(require(keyPath)),
  });
} else {
  // 組織ポリシーでサービスアカウントキーの発行が禁止されている場合は、
  // `gcloud auth application-default login --project sohenryu-okeiko-management`
  // を先に実行しておくと、ここで自動的にその認証情報が使われる。
  admin.initializeApp({
    credential: admin.applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}
const db = admin.firestore();

async function seed() {
  const members = [
    {
      id: "30000001",
      name: "サンプル 花子",
      group: "名月会",
      groupCategory: "本部稽古",
      license: "真台子",
      joinDate: "2022-01-22",
      status: "在籍",
      paymentMethod: "月謝",
      paymentStatus: "済",
      nextBillingDate: "2026-10-10",
      rsvp: "未回答",
      email: "sample.hanako@example.com",
      phone: "090-0000-0001",
      address: "東京都渋谷区サンプル1-1-1",
    },
    {
      id: "30000067",
      name: "サンプル 太郎",
      group: "Gマダムの茶の湯講座",
      groupCategory: "本部稽古",
      license: "入門",
      joinDate: "2025-06-24",
      status: "在籍",
      paymentMethod: "月謝",
      paymentStatus: "済",
      nextBillingDate: "2026-10-25",
      rsvp: "未回答",
      email: "sample.taro@example.com",
      phone: "090-0000-0002",
      address: "東京都渋谷区サンプル2-2-2",
    },
  ];

  const staff = [
    {
      id: "90000010",
      name: "サンプル 講師",
      role: "teacher",
      groups: ["名月会", "Gマダムの茶の湯講座"],
      email: "sample.teacher@example.com",
    },
    {
      id: "90000001",
      name: "サンプル 世話人",
      role: "sewanin",
      groups: ["雪月花"],
      email: "sample.sewanin@example.com",
    },
  ];

  for (const m of members) {
    await db.collection("members").doc(m.id).set(m);
  }
  for (const s of staff) {
    await db.collection("staff").doc(s.id).set(s);
  }

  console.log(`会員 ${members.length}件・スタッフ ${staff.length}件を投入しました。`);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
