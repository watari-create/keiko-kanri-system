#!/bin/zsh
# Square Webhook の受け口が、登録済みの Signature key で正しく照合できるかを確認する。
# 使い方：zsh scripts/testSquareWebhook.sh
U=https://squarewebhook-azyyg5u2jq-uc.a.run.app
KEY="$(npx -y firebase-tools@latest functions:secrets:access SQUARE_WEBHOOK_SIGNATURE_KEY --project sohenryu-okeiko-management 2>/dev/null | tail -1 | tr -d '[:space:]')"
echo "登録済みの鍵：${KEY[1,4]}……${KEY[-4,-1]}（${#KEY}文字）"
B='{"event_id":"selftest-'$(date +%s)'","type":"selftest","data":{"object":{}}}'
S=$(printf '%s' "$U$B" | openssl dgst -sha256 -hmac "$KEY" -binary | base64)
RES=$(curl -s -w "\n%{http_code}" -X POST "$U" -H 'Content-Type: application/json' -H "x-square-hmacsha256-signature: $S" -d "$B")
CODE=$(printf '%s' "$RES" | tail -1)
echo "結果：HTTP $CODE"
echo "返ってきた内容：$(printf '%s' "$RES" | sed '$d' | tr '\n' ' ' | cut -c1-200)"
echo "（参考）署名なしで送った場合：$(curl -s -X POST "$U" -H 'Content-Type: application/json' -d '{}' | tr '\n' ' ' | cut -c1-120)"
if [ "$CODE" = "200" ]; then
  echo "→ 受け口は正しく動いています。Square側の Signature key が、登録した鍵（上の最初と最後の4文字）と同じか確認してください。"
elif printf '%s' "$RES" | grep -q "Error: Forbidden"; then
  echo "→ Googleのアクセス制限で、外からの通知が受け口に届いていません。この結果をClaudeに送ってください。"
else
  echo "→ 受け口側の照合に問題があります。この結果をClaudeに送ってください。"
fi
