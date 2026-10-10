#!/bin/zsh
# 2026-10-10 16:16 に #本部稽古-bo へ送られた中村 玲子様のカード自動払いお申込み通知を、
# 「請求書-経理」チャンネルに送り直してから、bo のメッセージを削除する。
# 使い方：zsh scripts/moveNakamuraSlackToKeiri.sh
BO=C0C0NNW743E
KEIRI=C02HCJREWH2
TS=1791616570.249539
TOKEN="$(npx -y firebase-tools@latest functions:secrets:access SLACK_BOT_TOKEN --project sohenryu-okeiko-management 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -z "$TOKEN" ] && { echo "Slackのトークンを取得できませんでした"; exit 1; }
TEXT=$(cat <<'MSG'
:credit_card: カード自動払いのお申込みがありました
中村 玲子様（30000056・茶道教室）
月額¥28,000　参加開始：2026年11月
次回：2026-10-25（2026年11月分）
（10/10 16:16 に本部稽古boへ送られた通知を移しました）
MSG
)
BODY=$(python3 -c 'import json,sys; print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))' "$KEIRI" "$TEXT")
r=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json; charset=utf-8" -d "$BODY" https://slack.com/api/chat.postMessage)
if ! echo "$r" | grep -q '"ok":true'; then echo "❌ 請求書-経理への送信に失敗しました：$r"; exit 1; fi
echo "✔ 請求書-経理に送りました"
r=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json; charset=utf-8" -d "{\"channel\":\"$BO\",\"ts\":\"$TS\"}" https://slack.com/api/chat.delete)
if echo "$r" | grep -q '"ok":true'; then echo "✔ 本部稽古boのメッセージを削除しました"; else echo "❌ 削除に失敗しました：$r"; fi
