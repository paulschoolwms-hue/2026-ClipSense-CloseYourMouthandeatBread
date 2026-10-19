#!/usr/bin/env bash
# macOS에서만 실행. 토큰/환경 변수/비밀번호는 읽거나 출력하지 않는다.
set -u
if [ "$(uname -s)" != Darwin ]; then
  echo '이 진단은 ESP32와 연결한 맥 터미널에서 실행하세요.'
  exit 1
fi
clip_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
clip_ca="$clip_repo_root/web/node_modules/.vite/basic-ssl/_cert.pem"
printf '=== 맥 로컬 개발 서버 ===\n'
if [ -f "$clip_ca" ]; then
  curl --silent --show-error --cacert "$clip_ca" --connect-timeout 2 --max-time 4 \
    --output /dev/null --write-out 'localhost HTTPS 응답: %{http_code}\n' https://localhost:5173/ || true
else
  echo '개발 인증서 없음: web/에서 npm run dev를 먼저 실행하세요.'
fi
printf '=== ESP32로 가는 네트워크 경로 ===\n'
for clip_host in 192.168.4.1 192.168.0.52; do
  printf '\n대상 %s\n' "$clip_host"
  route -n get "$clip_host" 2>/dev/null | awk '/gateway:|interface:/ {print}'
  printf 'HTTP 응답: '
  curl --silent --show-error --connect-timeout 2 --max-time 4 --output /dev/null \
    --write-out '%{http_code}\n' "http://$clip_host/health" || true
done
printf '\n401/403: 기기 HTTP 서버 연결 성공(토큰 미전송 검사).\n'
printf '000/시간 초과: 토큰 이전의 연결 문제. 연결된 Wi-Fi와 실제 기기 IP 확인.\n'
printf '복구 Wi-Fi ClipSense-*라면 보통 192.168.4.1, WMS에서는 부팅 로그 IP 사용.\n'
printf '이 검사는 사진 촬영이나 실제 웹 음성 성공을 증명하지 않습니다.\n'
