#!/bin/zsh
# Square Webhook の Signature key を登録して、squareWebhook を再デプロイする。
# 使い方：zsh scripts/setSquareWebhookKey.sh を実行 → 「貼り付けてください」と出たら、
#         Squareの画面で Signature key をコピーして、ターミナルに貼り付けて Enter。
cd "$(dirname "$0")/.."
echo ""
echo "👉 Squareの画面で Signature key をコピーして、ここに貼り付けて Enter を押してください。"
read -s "RAW?Signature key（貼り付けても画面には表示されません）: "
echo ""
KEY="$(printf '%s' "$RAW" | tr -d '[:space:]')"
LEN=${#KEY}
if [ "$LEN" -lt 10 ] || [ "$LEN" -gt 100 ] || [[ "$KEY" == *zsh* ]] || [[ "$KEY" == *firebase* ]] || [[ "$KEY" == *npx* ]] || [[ "$KEY" == *scripts* ]]; then
  echo "❌ Signature key ではないようです（${LEN}文字）。もう一度 zsh scripts/setSquareWebhookKey.sh からやり直してください。"
  exit 1
fi
echo "受け取った鍵：${KEY[1,4]}……${KEY[-4,-1]}（${LEN}文字）→ 登録してデプロイします"
printf '%s' "$KEY" | npx -y firebase-tools@latest functions:secrets:set SQUARE_WEBHOOK_SIGNATURE_KEY --data-file=- --project sohenryu-okeiko-management || exit 1
npx -y firebase-tools@latest deploy --only functions:squareWebhook --project sohenryu-okeiko-management
