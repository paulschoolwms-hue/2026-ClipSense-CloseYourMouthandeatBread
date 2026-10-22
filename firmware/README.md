# ClipSense 클립 카메라 펌웨어

옷깃에 다는 클립형 카메라(XIAO ESP32S3 Sense)가 보행 신호등을 촬영해 HTTP
스냅샷으로 넘긴다. **판정은 하지 않는다** — 신호 색·잔여시간 판단과 이중 검증은
폰/브라우저 쪽 판정 엔진이 맡고, 이 펌웨어는 "정직한 프레임"을 공급하는 역할만
한다.

> **상태:** 사양 확정·구현 완료·컴파일 검증 완료. **실기기 미검증** — 보드가
> 확보되기 전이라 업로드·촬영·발열·연속 동작은 측정하지 않았다. 아래 "실기기
> 검증 전 주장하지 않는 것"을 참고할 것.
>
> 폰 쪽 Snapshot Adapter는 `app/lib/clip/`에 구현됐다(헤더 파서·신선도/정지/재부팅
> 추적·스냅샷 클라이언트·JPEG 디코드·`ClipVisionSource`). MockClient·루프백
> HttpServer·cv2 인코딩 QVGA fixture로 검증했고 실기기 왕복은 미검증이다. 판정 쪽은
> QVGA 전체가 아니라 **중앙 25%**만 본다(전체 프레임에서는 램프가 면적 임계를 넘지
> 못함) — `config.h`의 "320px 전체" 전제와 다르며, VGA+50% 프로필은 보드 확보 후
> 측정할 항목이다([app/README.md](../app/README.md)).

설계 근거: `ClipSense 하드웨어 최종설계·제작 보고서 v0.2` §9~§10.

## 이 펌웨어가 지키는 원칙

판정 계층과 같은 원칙을 하드웨어 쪽에서도 지킨다.

| 원칙 | 구현 |
|---|---|
| 오래된 프레임을 새 것처럼 보내지 않음 | 획득 실패 시 캐시된 JPEG을 재전송하지 않고 **503** 반환 |
| 프레임과 메타데이터를 함께 묶음 | JPEG·`captureUptimeUs`·`frameSeq`를 카메라 mutex 안에서 원자적으로 결합 |
| 진행 여부를 판정 쪽이 확인 가능 | `frameSeq`는 **새 JPEG 획득 성공 시에만** 증가 → 정지(freeze) 감지 가능 |
| 재부팅을 숨기지 않음 | `bootId`가 부팅마다 바뀜 → 판정 쪽이 uptime 비교 이력을 폐기 |
| 무인증 공개 카메라를 만들지 않음 | 모든 데이터 엔드포인트에 기기 토큰 요구, CORS 와일드카드 금지 |
| 촬영 중임을 숨기지 않음 | 촬영 시 LED 점등 |

## 하드웨어

- **보드**: Seeed Studio XIAO ESP32S3 Sense (8MB OPI PSRAM)
- **카메라**: 확장보드 기본 OV2640 또는 OV3660 (DVP)
- **전원**: USB 5V (예선 구성 `BENCH_E2E`)
- **부품 목록**: `ClipSense_BOM_v0.2.csv` 참고

배선은 XIAO ESP32S3 Sense 확장보드에 카메라 FPC를 꽂는 것이 전부다. 핀맵은
`config.h`의 `CLIP_PIN_*`에 있으며 확장보드 표준 배치를 따른다.

## 빌드

### 준비

```bash
cd firmware/clipsense_cam
cp secrets.example.h secrets.h
# secrets.h 를 열어 Wi-Fi SSID/비밀번호, 기기 토큰, 복구 AP 비밀번호를 채운다
```

`secrets.h`는 `.gitignore`에 있다. **커밋하지 않는다.**

기기 토큰 생성 예:

```bash
openssl rand -hex 16
```

### arduino-cli

```bash
arduino-cli core install esp32:esp32 \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json

arduino-cli compile \
  -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi \
  firmware/clipsense_cam
```

업로드(보드를 USB로 연결한 뒤):

```bash
arduino-cli upload -p /dev/cu.usbmodem* \
  -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi \
  firmware/clipsense_cam

arduino-cli monitor -p /dev/cu.usbmodem* -c baudrate=115200
```

### PlatformIO

```bash
cd firmware
pio run                       # 컴파일
pio run -t upload             # 업로드
pio device monitor -b 115200  # 직렬 로그
```

## HTTP API

모든 데이터 엔드포인트는 `X-Clip-Device-Token` 헤더를 요구한다.

| 경로 | 용도 |
|---|---|
| `GET /health` | 상태·버전·장애 통계 (JSON) |
| `GET /capture` | 판정용 단일 JPEG |
| `GET /jpg` | `/capture` 호환 별칭 |
| `GET /` | 조준 점검 화면 (기본 **비활성**, `CLIP_ENABLE_INSPECT_PAGE`) |

MJPEG `/stream`은 제공하지 않는다. 스트림과 스냅샷이 프레임버퍼를 경쟁하면
"보인 프레임 = 분석한 프레임"이 깨지기 때문이다(§10.1).

### 예시

```bash
TOKEN=$(cat ~/.clipsense/device_token)
HOST=clipsense-a1b2.local   # 또는 직렬 로그에 찍힌 IP

curl -H "X-Clip-Device-Token: $TOKEN" http://$HOST/health
curl -H "X-Clip-Device-Token: $TOKEN" -o frame.jpg -D - http://$HOST/capture
```

### `/capture` 응답 헤더

```
X-Frame-Seq: 1482            새 JPEG 획득 성공 시에만 증가
X-Capture-Uptime-Us: 372800221   획득 순간의 기기 uptime
X-Response-Uptime-Us: 372812505  응답 직전의 기기 uptime
X-Boot-Id: a83f219c          부팅마다 바뀜
X-Firmware-Version: 0.2.0
X-Camera-Sensor: OV3660
```

실패 시:

| 코드 | 뜻 |
|---|---|
| 401 / 403 | 토큰 없음 / 틀림 |
| 409 | 다른 요청이 카메라를 점유 중 |
| 503 | 획득 실패 (오래된 프레임을 대신 보내지 않는다) |

### 프레임 신선도 계산

기기 uptime과 브라우저 `performance.now()`는 서로 다른 clock domain이라 직접
뺄 수 없다(§10.4). 판정 쪽은 이렇게 보수적으로 추정한다.

```
serverFrameAgeMs = ceil((X-Response-Uptime-Us - X-Capture-Uptime-Us) / 1000)   # 앱은 올림(보수적)
conservativeAgeMs = max(requestRttMs, 0) + serverFrameAgeMs
capturedAtMonoMs = responseReceivedMonoMs - conservativeAgeMs
```

앱 구현(`app/lib/clip/clip_snapshot.dart`·`clip_freshness.dart`)은 서버 프레임 나이를
올림하고 음수 rtt를 0으로 본다 — 프레임을 더 젊게 보는 방향의 반올림은 쓰지 않는다.

헤더가 없거나 유한하지 않거나 `responseUptime < captureUptime`이면 **프레임을
무효로 처리한다.** `X-Capture-Uptime-Us`는 같은 `bootId` 안에서만 프레임
진행·정지 비교에 쓰고, `bootId`가 바뀌면 이력을 폐기한다.

## 네트워크 동작

```
BOOT
└─ STA_CONNECTING ── 성공 ──────────→ STA_ACTIVE
                  └─ 15초 초과 ─────→ AP_RECOVERY

STA_ACTIVE 중 두절 → STA_RECONNECTING (5초 간격, 6회)
                   └─ 계속 실패 ────→ AP_RECOVERY
```

- 연결이 끊기면 카메라 관측은 도달 불가가 되고, 판정 쪽은 **freshness 만료로
  스스로 대기**에 들어간다. 펌웨어가 대신 판단하지 않는다.
- SoftAP는 자동 안전 failover가 **아니다.** 사람이 직접 붙어 상태를 확인하는
  복구 경로이며, Wi-Fi 자격정보를 입력받는 provisioning은 이 범위에 없다.
- STA에서는 `clipsense-<MAC뒤4자리>.local` mDNS를 시도한다. 실패하면 직렬
  로그의 IP를 쓴다.

## 보안 범위

이 구성은 **팀 전용 격리망 + 기기 토큰**을 전제한 예선용 완화책이다. TLS와
사용자 인증을 갖춘 생산 보안을 대신하지 않는다.

- 데이터 엔드포인트는 토큰 필수, CORS는 설정된 origin만(와일드카드 금지)
- 조준 화면과 MJPEG 스트림은 기본 비활성
- `/health`는 SSID·비밀번호를 반환하지 않는다
- 프레임을 기기·서버에 저장하지 않는다
- 촬영 중 LED 점등

## 시뮬레이터로 앱 끝단 돌리기

보드 없이 앱의 클립 경로(폴링·신선도·정지·재부팅·토큰 오류)를 끝까지 돌려 보는
표준 라이브러리 가짜 펌웨어다(`scripts/clip_cam_sim.py`). `http_api.cpp`와 같은
경로·상태코드·헤더·오류 본문을 내고, `frameSeq`는 획득 성공 시에만 올린다.
**실기기 검증을 대신하지 않는다** — `X-Camera-Sensor: SIM`, `deviceId`
`clipsense-cam-sim`으로 자신을 밝히며, 시뮬레이터로 찍은 시연 영상에는 반드시
`SIM` 표시를 넣는다.

```bash
export CLIP_DEVICE_TOKEN=$(openssl rand -hex 16)   # 출력·커밋하지 않는다
.venv/bin/python scripts/clip_cam_sim.py --port 8080
#   기본: fixture 두 장(점등 f20 / 소등 f34)을 2회씩 순환 ≈ 250ms 폴링에서 1Hz 점멸
.venv/bin/python scripts/check_clip_cam_contract.py http://127.0.0.1:8080
#   계약 검사 — 보드에도 그대로 쓴다(요약 줄에 대상이 SIM 인지 보드인지 찍힌다)

cd app && flutter run -d macos \
  --dart-define=TDATA_KEY='발급받은_API_키' \
  --dart-define=CLIP_CAM_HOST=127.0.0.1:8080 \
  --dart-define=CLIP_CAM_TOKEN="$CLIP_DEVICE_TOKEN"
```

- 초록 확정(walk 경로)을 보려면 점등 프레임만 준다: `--jpeg app/test/fixtures/clip_qvga_f20.jpg`.
- Android 에뮬레이터는 `CLIP_CAM_HOST=10.0.2.2:8080`, 실제 폰은 `--host 0.0.0.0`으로
  띄우고 PC의 LAN IP를 준다(폰 왕복은 미검증).
- `--video 경로.mp4`는 cv2가 있을 때만 쓴다(중앙 4:3 → 320x240, 실시간 반복 재생).
- 단위 테스트: `scripts/test_clip_cam_sim.py`(러너 `run_unit_tests.py`에 등록, CI python job).

실행 중 장애 주입 — 계약 밖 제어 엔드포인트 `/__sim/…`이며 보드에는 없다:

```bash
curl -X POST http://127.0.0.1:8080/__sim/fault -d '{"mode":"freeze"}'
curl -X POST http://127.0.0.1:8080/__sim/fault -d '{"mode":"stall","hold_ms":1500}'
curl http://127.0.0.1:8080/__sim/state
```

| mode | 시뮬레이터 동작 | 앱이 보여야 하는 동작 |
|---|---|---|
| `none` | 정상 | accepted 프레임 8장 뒤 판독 |
| `freeze` | 같은 프레임·같은 `X-Frame-Seq`·`X-Capture-Uptime-Us` 재전송 | `same_frame` → 2초 뒤 wait, 이력 리셋 |
| `capture_failed` | 503 `capture_failed` | 즉시 unknown, 이력 리셋 |
| `busy` | 409 `capture_busy` | 즉시 unknown, 이력 리셋 |
| `reboot` | 새 `bootId`, uptime·`frameSeq` 0부터(1회성, 곧 `none`) | 이력 폐기 후 새로 쌓음 |
| `stall` | 획득 뒤 `hold_ms`(기본 1500) 동안 응답 보류 | 800ms 타임아웃 → `unreachable`, "전원과 Wi-Fi 연결을 확인해 주세요" |
| `drop_headers` | `X-Frame-Seq` 누락 | `bad_headers` → unknown |
| `wrong_content_type` | 200 `text/html`(캡티브 포털 흉내) | `bad_content_type` → unknown |

토큰을 틀리게 주면(`--dart-define=CLIP_CAM_TOKEN=wrong`) 403 → `token_rejected`,
"기기 토큰 설정을 확인해 주세요"가 나오고 폴링이 멈춘다. 빈 토큰 헤더는 401이다
(ESP32 코어 3.3.1 `WebServer::hasHeader`가 빈 값을 "없음"으로 보는 것을 따랐다 —
라이브러리 소스 기준, 실기기 미검증).

### Dart 어댑터 끝단 테스트(선택 실행)

시뮬레이터가 떠 있을 때만 `app/test/clip/clip_sim_e2e_test.dart` 가 실제 소켓으로
`ClipVisionSource` 를 붙여 freeze·reboot·503·stall 주입에 대한 반응(same_frame·새
bootId·capture_failed·timeout→unreachable·복귀)을 확인한다. 기본 `flutter test` 에서는
건너뛴다.

```bash
cd app
flutter test test/clip/clip_sim_e2e_test.dart \
  --dart-define=CLIP_SIM_URL=http://127.0.0.1:8765 \
  --dart-define=CLIP_SIM_TOKEN="$CLIP_DEVICE_TOKEN"
```

통과해도 "계약을 말하는 서버를 앱이 받아들인다"까지다 — 실기기 검증이 아니다.

## 실기기 검증 전 주장하지 않는 것

보드가 손에 들어오기 전까지 아래는 **측정되지 않았다.**

- 업로드 성공, 실제 촬영 프레임, 센서 PID
- 프레임 획득 지연과 실효 fps
- Wi-Fi 재접속 실제 소요 시간
- 연속 동작 시 발열과 스로틀링
- 케이스·클립 고정, 케이블 인장

컴파일이 통과한 것과 기기에서 도는 것은 다른 주장이다. 이 문서는 그 둘을
섞어 쓰지 않는다.

## 파일 구성

```
firmware/
├── platformio.ini            PlatformIO 빌드 설정
├── README.md                 이 문서
└── clipsense_cam/
    ├── clipsense_cam.ino     setup/loop, 부팅 로그, bootId, LED
    ├── config.h              고정 설정 (핀맵·프로필·CORS·타임아웃)
    ├── secrets.example.h     secrets.h 템플릿 (실제 값은 커밋 금지)
    ├── camera_service.h/.cpp 카메라 초기화, mutex, 원자적 프레임+메타데이터
    ├── clip_network.h/.cpp   Wi-Fi 상태기계, mDNS, 복구 AP (ESP32 코어의 NetworkManager 와 이름 충돌 회피)
    └── http_api.h/.cpp       /health · /capture · 토큰 인증 · CORS
```

## 노트북 촬영 중계 (0.3.0, 2026-10-15)

클립 카메라를 쓸 수 없을 때(확장 보드 불량 등) 노트북 카메라 사진을 보드로 보내 통신 경로를 검증한다.

- `POST /frame` (multipart JPEG, `X-Clip-Device-Token`) — 카메라가 초기화되지 않았을 때만 `/capture`로 나간다
- `/capture` 응답에 `X-Frame-Source: laptop-upload`, `X-Camera-Sensor: LAPTOP` 표시 — 클립 촬영과 구별
- 5초보다 오래된 업로드 프레임은 내주지 않음(`503 no_recent_frame`)
- `GET /relay` — 중계 통계 (`/health` 계약은 그대로)
- 노트북 쪽 도구: `scripts/laptop_frame_relay.py`
- 카메라 진단 스케치: `firmware/tools/camera_probe` (XCLK·SDA/SCL·I2C 주소 스캔)
- 끄려면 `config.h`의 `CLIP_ENABLE_LAPTOP_RELAY 0`

## 화질 프로필 (0.3.1)

PSRAM이 있는 보드는 기본 VGA(640×480), JPEG quality 10으로 촬영한다.
기존 QVGA(320×240), quality 12보다 원본 미리보기의 세부를 늘리고 압축을 줄인 설정이다.
웹 색상 분석은 계속 320px로 축소하므로 원본 해상도 증가가 인식 정확도 향상을 보장하지는 않는다.
OV3660의 수직 반전은 유지하고 밝기/채도를 중립값(0)으로 설정한다.
PSRAM이 없으면 기존 QVGA·버퍼 1개 폴백을 유지한다.

원본 픽셀 수는 4배가 되어 전송량/지연이 늘 수 있다. 실기기에서 `/health`의
`resolution`이 `640x480`인지, `/capture`의 사진과 응답 지연을 확인해야 한다.
느린 무선망에서는 `config.h`의 `CLIP_FRAME_SIZE`를 `FRAMESIZE_QVGA`,
`CLIP_JPEG_QUALITY`를 `12`로 되돌리고 컴파일·업로드한다.
렌즈 보호필름, 오염, 흔들림이나 광학 초점 문제는 해상도 변경으로 해결되지 않는다.

## 전송 안정성 비교 프로필 (0.3.2, 2026-10-22)

VGA/quality 10 사용 중 HTTP 200 이후 15초 제한까지 JPEG 2872바이트만 수신되고,
저장 파일 끝에 JPEG EOI(FF D9)가 없는 결과가 사용자 맥에서 관찰됐다.
인증은 통과했으나 전체 JPEG 수신 완료를 증명하지 못한 상태다.
이를 해상도 원인으로 단정하지 않고, 우선 실제 단일 JPEG 수신에 성공했던
QVGA(320×240)/quality 12를 기본값으로 복귀해 전송량을 줄여 비교한다.
중립 밝기·채도 보정과 프레임 신선도/인증 계약은 유지한다.
실제 보드에서 컴파일·업로드·재측정이 필요하며, 정적 검사만으로 전송 문제가 해결됐다고 하지 않는다.

측정 도구는 저장소 루트의 `python3 scripts/probe_clip_snapshot.py http://<현재 기기 IP>`이다.
로컬 `secrets.h`에서 토큰을 메모리로 읽어 헤더로 전달하므로 토큰을 터미널에 입력하거나
채팅에 복사하지 않는다. HTTP 상태, Content-Length와 실제 바이트 수, 경과 시간,
JPEG 시작/끝 여부를 확인한다. 전체 수신과 JPEG 표식이 맞을 때만 완료로 보고한다.
이것은 JPEG 디코더 검증이나 웹 연속 갱신/소리 증거를 대신하지 않는다.

## 소량 전송·진단 보완 (0.3.3)

같은 맥/WMS 측정에서 JPEG의 선언 길이는 바뀌어도 2872바이트에서 반복 중단되는 현상이 관찰됐다.
원인이 펌웨어/네트워크/드라이버 중 무엇인지는 아직 확정되지 않았다.
0.3.3은 한 번의 큰 `sendContent` 호출 대신 내부 RAM의 512바이트 블록으로 원본 JPEG을 복사해
소켓에 쓰고, 부분 write를 이어서 처리하며 각 블록 사이에 스케줄러에 양보한다.
프레임버퍼는 전체 쓰기 시도가 끝날 때까지 유지하며, 실패한 응답 연결은 닫는다.
인증·프레임 번호·보수적 신선도·JPEG 원본은 유지한다.

인증된 `/health`에 선택적인 `lastTransfer` 진단을 추가한다:
`expectedBytes`, `queuedBytes`, `elapsedMs`, `completeQueue`, `errorCount`, `rssiDbm`.
queuedBytes/completeQueue는 **소켓이 받아들인 양**일 뿐 맥의 최종 수신/ACK를 증명하지 않는다.
`probe_clip_snapshot.py`는 측정 후 이 상태도 출력한다. 토큰은 출력하지 않는다.
시리얼을 반복 출력하지 않아 USB 로그를 읽지 않을 때의 부가적인 블로킹을 피한다.

`python3 scripts/test_jpeg_transfer.py`로 호스트에서 부분 write/바이트 보존/중단을 검사한다.
ESP32 라이브러리 3.3.12의 공식 NetworkClient API를 사용하지만, 이 클라우드의 호스트 테스트는
실제 ESP32 스케치 컴파일·업로드·Wi-Fi 검증을 대신하지 않는다. 보드에서 재측정이 필요하다.
2초 예산은 소켓 write 사이에서 검사하며 write 내부를 강제 종료하는 hard timeout은 아니다.
