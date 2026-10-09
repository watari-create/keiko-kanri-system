#!/bin/zsh
# Square の Access token を Firebase に登録する（チャットやコマンドに直接書かないため）。
# 使い方：zsh scripts/setSquareAccessToken.sh を実行 → 「貼り付けてください」と出たら、
#         Squareの Credentials 画面の Access token をコピーして貼り付けて Enter。
cd "$(dirname "$0")/.."
echo ""
echo "👉 Squareの Credentials 画面（Production）の Access token をコピーして、ここに貼り付けて Enter を押してください。"
read "RAW?Access token: "
TOKEN="$(printf '%s' "$RAW" | tr -d '[:space:]')"
LEN=${#TOKEN}
if [[ "$TOKEN" != EAAA* ]] || [ "$LEN" -lt 40 ]; then
  echo "❌ Access token ではないようです（EAAA で始まる長い文字列です）。もう一度やり直してください。"
  exit 1
fi
echo "受け取ったトークン：${TOKEN[1,6]}……${TOKEN[-4,-1]}（${LEN}文字）→ 登録します"
printf '%s' "$TOKEN" | npx -y firebase-tools@latest functions:secrets:set SQUARE_ACCESS_TOKEN --data-file=- --project sohenryu-okeiko-management
