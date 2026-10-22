// ClipSense 클립 카메라 펌웨어 — 컴파일 시 고정되는 설정.
//
// 여기에는 비밀정보를 두지 않는다. Wi-Fi 자격정보와 기기 토큰은 secrets.h에
// 두고 커밋하지 않는다(secrets.example.h만 저장소에 포함).
//
// 근거 문서: ClipSense 하드웨어 최종설계·제작 보고서 v0.2 §9~§10.
#pragma once

// ── 펌웨어 식별 ────────────────────────────────────────────────────────────
#define CLIP_FIRMWARE_VERSION "0.3.4"
#define CLIP_API_SCHEMA_VERSION "clipsense-camera-api-v1"

// 기기 식별자. 여러 대를 같은 망에 둘 때 기기마다 다르게 준다.
#define CLIP_DEVICE_ID "clipsense-cam-01"

// ── 카메라 프로필 (보고서 §9.2) ────────────────────────────────────────────
// 부팅 출력은 실제 수신에 성공한 QVGA/quality 12를 기본으로 한다.
// 0.3.4의 요청별 stable/balanced/detail 값은 camera_profiles.h에서 정의한다.
// PSRAM이 있으면 VGA용 버퍼를 확보하되 센서 출력은 안정 화질로 시작한다.
// docs/esp32-camera-quality.md의 절차로 각 프로필의 실제 전송을 비교한다.
#define CLIP_FRAME_SIZE FRAMESIZE_QVGA
#define CLIP_JPEG_QUALITY 12  // 낮을수록 고화질·큰 용량 (0~63)
#define CLIP_FB_COUNT 2

// ── 네트워크 (보고서 §9.4) ─────────────────────────────────────────────────
// STA 연결 제한시간. 초과하면 복구용 SoftAP로 전환한다(자동 안전 failover가
// 아니라, 사용자가 직접 접속해 상태를 확인하기 위한 복구 경로다).
#define CLIP_STA_CONNECT_TIMEOUT_MS 30000UL

// STA_ACTIVE 중 연결이 끊기면 이 간격으로 재접속을 시도한다(비동기).
#define CLIP_STA_RETRY_INTERVAL_MS 5000UL

// 재접속을 이 횟수만큼 연속 실패하면 SoftAP 복구 모드로 내린다.
#define CLIP_STA_RETRY_LIMIT 6

// SoftAP 채널. 2.4GHz만 사용한다(ESP32-S3는 5GHz 미지원).
#define CLIP_AP_CHANNEL 6

// ── HTTP 서버 (보고서 §10.1) ───────────────────────────────────────────────
#define CLIP_HTTP_PORT 80

// CORS 허용 origin. 와일드카드(*)를 쓰지 않는다(§10.1).
// 여러 개가 필요하면 CLIP_CORS_ORIGIN_ALT에 두 번째를 넣는다.
#define CLIP_CORS_ORIGIN "http://localhost:5173"
#define CLIP_CORS_ORIGIN_ALT "http://localhost:4173"

// 기기 토큰을 실을 요청 헤더 이름(§10.1).
#define CLIP_TOKEN_HEADER "X-Clip-Device-Token"

// ── 노트북 촬영 중계 (2026-10-15) ─────────────────────────────────────────
// 클립 카메라를 쓸 수 없을 때(확장 보드 불량 등) 노트북 카메라가 찍은 JPEG을
// POST /frame 으로 보드에 올리고, 앱·웹은 평소처럼 보드의 /capture 에서 받는다.
// 이 프레임은 클립 촬영이 아니므로 응답마다 X-Frame-Source: laptop-upload,
// X-Camera-Sensor: LAPTOP 을 붙여 구별한다. 카메라가 정상이면 항상 카메라가 우선이다.
#define CLIP_ENABLE_LAPTOP_RELAY 1
// 받아 둘 JPEG 최대 크기(PSRAM). QVGA JPEG은 보통 10~30KB.
#define CLIP_RELAY_MAX_BYTES (256 * 1024)
// 이보다 오래된 업로드 프레임은 /capture 로 내주지 않는다(정지 화면을 새 것처럼
// 보내지 않기 위해 — 오래되면 503 no_recent_frame).
#define CLIP_RELAY_MAX_AGE_MS 5000UL

// 조준·초점 점검용 단독 화면(`/`). 물리적으로 통제된 상태에서만 켠다(§10.1).
// 기본은 꺼 둔다 — 무인증 공개 카메라를 만들지 않기 위해서다.
#define CLIP_ENABLE_INSPECT_PAGE 0

// ── 표시 LED (보고서 §10.1 마지막 항목) ────────────────────────────────────
// 촬영 중임을 물리적으로 알리는 LED. XIAO ESP32S3의 사용자 LED는 LOW에서 켜진다.
#define CLIP_STATUS_LED_PIN LED_BUILTIN
#define CLIP_STATUS_LED_ACTIVE_LOW 1

// 촬영 표시를 유지할 최소 시간(ms). 스냅샷이 짧아 눈에 안 띄는 것을 막는다.
#define CLIP_CAPTURE_LED_HOLD_MS 120UL

// ── 직렬 로그 ──────────────────────────────────────────────────────────────
#define CLIP_SERIAL_BAUD 115200

// ── XIAO ESP32S3 Sense 카메라 핀맵 ────────────────────────────────────────
// Seeed Studio XIAO ESP32S3 Sense 확장보드(OV2640/OV3660) 기준.
#define CLIP_PIN_PWDN -1
#define CLIP_PIN_RESET -1
#define CLIP_PIN_XCLK 10
#define CLIP_PIN_SIOD 40
#define CLIP_PIN_SIOC 39
#define CLIP_PIN_Y9 48
#define CLIP_PIN_Y8 11
#define CLIP_PIN_Y7 12
#define CLIP_PIN_Y6 14
#define CLIP_PIN_Y5 16
#define CLIP_PIN_Y4 18
#define CLIP_PIN_Y3 17
#define CLIP_PIN_Y2 15
#define CLIP_PIN_VSYNC 38
#define CLIP_PIN_HREF 47
#define CLIP_PIN_PCLK 13
#define CLIP_XCLK_FREQ_HZ 20000000
