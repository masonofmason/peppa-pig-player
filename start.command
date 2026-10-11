#!/bin/sh
# macOS/Linux 실행 파일. Finder에서 더블클릭하거나 터미널에서 `sh start.command` 로 실행한다.
cd "$(dirname "$0")" || exit 1

if command -v node >/dev/null 2>&1; then
  exec node server.js --open
elif command -v python3 >/dev/null 2>&1; then
  URL="http://localhost:5173"
  echo "Peppa Pig Player: $URL  (이 창을 닫으면 앱이 종료됩니다)"
  ( sleep 1; if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi ) &
  exec python3 -m http.server 5173 --bind 127.0.0.1 --directory public
else
  echo "Node.js(https://nodejs.org) 또는 Python 3를 설치한 뒤 다시 실행해 주세요."
  exit 1
fi
