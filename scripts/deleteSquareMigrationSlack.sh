#!/bin/zsh
# 2026-10-09 19:26〜19:27 に #本部稽古-bo へ送られた「決済リンクからカード自動払いに切り替えました（本部操作）」11件を削除する
# 使い方：zsh scripts/deleteSquareMigrationSlack.sh
CH=C0C0NNW743E
TOKEN="$(npx -y firebase-tools@latest functions:secrets:access SLACK_BOT_TOKEN --project sohenryu-okeiko-management 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -z "$TOKEN" ] && { echo "Slackのトークンを取得できませんでした"; exit 1; }
ok=0; ng=0
for ts in 1791541623.375269 1791541620.141779 1791541616.615699 1791541613.136489 1791541609.592559 \
          1791541606.347309 1791541602.594679 1791541599.470699 1791541595.298019 1791541591.124379 1791541586.186679; do
  r=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json; charset=utf-8" \
      -d "{\"channel\":\"$CH\",\"ts\":\"$ts\"}" https://slack.com/api/chat.delete)
  if echo "$r" | grep -q '"ok":true'; then ok=$((ok+1)); else ng=$((ng+1)); echo "失敗 $ts $r"; fi
  sleep 1.2
done
echo "削除完了：成功 $ok 件／失敗 $ng 件"
