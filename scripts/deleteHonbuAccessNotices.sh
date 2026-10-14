#!/bin/zsh
# 2026-10-14 に #山田家運営共有 に届いた「本部アカウントの権限変更」4件と、
# それに反応した「不正アクセスの疑い（本部権限のアカウントが追加されました：otani）」1件を削除する。
# 使い方：zsh scripts/deleteHonbuAccessNotices.sh
CH=C02GH8X0U3C
TOKEN="$(npx -y firebase-tools@latest functions:secrets:access SLACK_BOT_TOKEN --project sohenryu-okeiko-management 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -z "$TOKEN" ] && { echo "Slackのトークンを取得できませんでした（npx firebase-tools login --reauth を試してください）"; exit 1; }
ok=0; ng=0
for ts in 1791947659.289759 1791948086.694089 1791948521.669469 1791954752.122149 1791954913.629979; do
  r=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json; charset=utf-8" \
      -d "{\"channel\":\"$CH\",\"ts\":\"$ts\"}" https://slack.com/api/chat.delete)
  if echo "$r" | grep -q '"ok":true'; then ok=$((ok+1)); else ng=$((ng+1)); echo "失敗 $ts $r"; fi
  sleep 1.2
done
echo "削除完了：成功 $ok 件／失敗 $ng 件"
