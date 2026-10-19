# ClipSense 프로토타입

옷깃 클립 카메라 × 경찰청 C-ITS × 비전 AI 이중검증 — 시각장애인 횡단보도 보행 안전 보조 시스템의 기술 검증용 웹 프로토타입 (React + Vite + PWA).

> ⚠️ 본 프로토타입은 기술 검증용 시연이며 실제 보행 판단에 사용할 수 없습니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # core/vision/sources/feedback 단위 테스트
```

## ESP32 카메라 연결 (ClipSense 펌웨어)

ESP32와 같은 Wi-Fi에 연결한 PC에서 `cd web && npm ci && npm run dev`로 실행합니다.
화면에서 **ESP32 카메라로 신호등 인식 시작**을 누른 뒤 **ESP32 주소**, **기기 접속 토큰**을 입력하고 **ESP32 연결**을 누릅니다. 내장 카메라 선택도 별도로 가능합니다.

- 주소는 시리얼 모니터의 Wi-Fi 연결 로그 또는 공유기/핫스팟 연결 기기 목록에서 확인한 보드 IP입니다. 예시 `http://192.168.0.50`은 실제 기기 주소가 아닙니다.
- 이 펌웨어는 MJPEG `/stream` 대신 JPEG `/capture`를 제공합니다. 웹은 개발 서버에서 토큰 헤더를 전달해 스냅샷을 순차 수신하고 새 프레임의 색상을 분석합니다.
- 토큰은 입력 탭 메모리에만 보관하며 URL이나 로컬 저장소에 저장하지 않습니다.
- 프레임 번호 역행/반복, 시각 오류, 2초 넘게 오래된 프레임은 거부합니다. 연결 실패 시 인식 불가로 표시합니다.
- GitHub Pages는 이 로컬 중계 서버를 실행하지 못합니다. 공개 페이지의 ESP32 연결을 사용하려면 같은 네트워크에서 개발 서버를 실행해야 합니다.
- 인증된 시뮬레이터 JPEG 중계는 검증했지만 실제 ESP32 연결/촬영은 아직 검증하지 않았습니다.

## 카메라로 신호등 색상 인식

1. HTTPS로 웹 화면을 열고 **ESP32 카메라로 신호등 인식 시작**을 누른 뒤 영상 입력에서 **내장 카메라**를 선택합니다.
2. 브라우저의 카메라 접근을 허용합니다. 휴대폰에서는 후면 카메라를 우선 사용합니다.
3. 신호등을 영상 상단 60%의 분석 영역에 맞춥니다. 영상 위에 빨강·초록 감지 결과와 색상 점수가 표시됩니다.
4. **카메라 전환**으로 전면/후면을 전환하고, 권한이나 연결 문제가 생기면 **다시 시도** 또는 **다시 연결**을 누릅니다.

카메라 영상은 브라우저 안에서 분석하며 서버로 전송하지 않습니다. 현재 인식기는 HSV 색상 기반이므로 비슷한 색 물체를 신호로 오인할 수 있습니다. 색상 점수는 신호등일 확률이나 실측 정확도가 아닙니다. 카메라 색상 결과는 횡단 판정과 별도이며, 라이브 모드의 C-ITS는 모의 데이터입니다. 영상이 멈추면 기존 색상 표시를 지우고 관측 시각을 갱신하지 않습니다.

## C-ITS 실데이터 연동 (선택)

`.env.local.example`을 `.env.local`로 복사해 발급받은 serviceKey·경로·교차로 ID를 입력.
미설정 시에도 모의 시나리오로 전체 기능 시연 가능 (화면에 "모의 신호 주입 중" 표시).

## 구조

- `src/core/` — 판정 로직 (순수 함수, 기본값 WAIT Fail-Safe). Vitest 검증
- `src/sources/` — C-ITS 실호출/모의, 카메라/ESP32 영상 어댑터
- `src/vision/` — HSV 신호등 색 판별
- `src/feedback/` — TTS(ko-KR)·진동 패턴
- `src/ui/` — 검증 현황·판정·시나리오 화면

## SafeGraph-RTA (v2)

기존 v1은 C-ITS와 카메라 비전이 "같은 색인지"만 Boolean AND로 확인했다. SafeGraph-RTA는 여기에 다섯 가지 런타임 검사를 추가한다: (1) 두 소스가 **같은 횡단보도·같은 방향(대상 일치)**을 가리키는지, (2) 각 관측치가 **아직 유효한 데이터(신선도)**인지, (3) 패킷·프레임이 **재전송·역행 없이 정상 순서로 갱신되고 정지(freeze)되지 않았는지(순서·정지)**, (4) 남은 시간이 **횡단에 필요한 시간 예산**을 충족하는지, (5) 진행 방향은 K프레임+hold로 천천히 승인하고 차단 방향(빨강/불일치/신선도 상실 등)은 **같은 판정 주기에서 즉시 반영하는 비대칭 확인**. 다섯 검사 중 하나라도 실패하면 WAIT로 수렴한다. baseline `decide()`는 비교용으로만 남아 있으며, TTS·햅틱은 proposed(SafeGraph-RTA) 결과에만 연결된다.

```bash
npm run experiment   # 11개 결함주입 시나리오 × 3엔진(Raw/Legacy/SafeGraph-RTA) 재생, artifacts/ 7종 생성
```

생성되는 산출물(`artifacts/`):

- `실험보고서_SafeGraph_RTA.md` — 연구보고서 (초록·정량 결과·trade-off·한계)
- `experiment_raw.jsonl` — 원본 tick 로그 (11 시나리오 × 100 tick)
- `experiment_summary.csv` / `scenario_results.csv` — 요약/시나리오별 표 (원본 로그에서 자동 생성)
- `experiment_config.json` / `run_manifest.json` — 임계값 config 및 git HEAD·Node 버전 등 재현 정보
- `metric_definitions.md` — UAER/CVER/DPR_tick/Safe Coverage/Confirmation Latency/Time-to-Inhibit 정의 전문

**실측 헤드라인** (통제된 결함주입, MOCK 데이터 기준): 계약위반 시나리오 4종(WRONG_TARGET/STALE/REORDER/FROZEN)에서 baseline(Legacy AND+Stabilizer)의 계약위반 진행률(CVER) **5/6 → SafeGraph-RTA 0/6**(단측 95% 상한 39.3%)로 갈렸다. 다만 물리적위험 진행률(UAER)은 **1/4로 두 엔진 모두 동일**하게 잔존한다 — 두 소스가 같은 target·정상 timestamp로 장시간 동일한 거짓 초록을 제공하는 공통원인 오류(PERSISTENT_COMMON_CAUSE)는 대상/신선도 계약 검사만으로는 구분할 수 없으며, 이는 숨기지 않고 명시하는 잔존 위험이다.

### 증거 등급

아래 순서는 주장의 신뢰도가 높은 순이며, 이 프로토타입의 현재 결과가 어느 등급인지 항상 함께 표기한다.

| 등급 (높음→낮음) | 의미 |
|---|---|
| 1. 실시간 실측 | 실제 도로·실제 C-ITS·실제 카메라로 실시간 운용하며 측정 |
| 2. 실응답 녹화재생 | 실제 C-ITS 응답을 녹화해 재생하며 측정 |
| 3. 실영상 측정 | 실제 촬영 영상으로 비전 판정을 측정 |
| 4. 통제된 결함주입 | 결정론적으로 정의한 결함 시나리오를 재생해 측정 |
| 5. MOCK·합성 | 모의 데이터·합성 신호로 로직만 검증 |
| 6. 계획 | 아직 실행하지 않은 로드맵 |

> **현재 `npm run experiment` 결과는 "4. 통제된 결함주입" + "5. MOCK·합성" 등급이다.** 실제 C-ITS·실영상은 사용하지 않았으며(`run_manifest.json`: sourceMode=MOCK 전부), 위 CVER/UAER 수치는 실제 도로 사고율이나 실도로 정확도가 아니다.

### Vite proxy/미들웨어는 모두 dev 전용

`vite.config.js`의 `server.proxy['/cits']`는 **`npm run dev`(Vite dev 서버)에서만 동작**한다. `npm run build`로 생성한 정적 산출물이나 `npm run preview`, 실제 배포 환경에는 이 프록시가 포함되지 않는다 — C-ITS `serviceKey`를 서버 측에 은닉하기 위한 로컬 개발 편의 기능일 뿐, 배포 환경의 보안 기능이 아니다.

같은 이유로 아래 두 dev 미들웨어도 `npm run dev`에서만 존재한다:

- **`GET /cits-mock`** — 네트워크로 서빙되는 모의 C-ITS 관측(카메라 라이브 모드가 500ms 간격으로 폴링). green 40초 → red 30초 반복, `seq` 요청마다 증가, `Cache-Control: no-store`.
- **`GET /esp32-proxy?url=<http://...>`** — ESP32 MJPEG 스트림을 그대로 파이프하며 `Access-Control-Allow-Origin: *`을 붙여 `<img crossOrigin>` 캡처 시 CORS taint를 dev 환경에서 회피한다. `url`이 `http://`로 시작하지 않으면 400으로 거부한다(임의 스킴 프록시 방지). HTTPS 배포 페이지에서 평문 `http://` ESP32 스트림에 이 프록시 없이 직접 접속하면 mixed-content로 차단될 수 있다는 점도 dev 전용인 이유 중 하나다.

`/esp32-proxy`는 기기 토큰을 URL이 아닌 헤더로 전달한다. 토큰은 저장하거나 로그로 남기지 않는다.
이 중계는 신뢰하는 로컬 PC에서만 사용하고 공개 서버로 노출하지 않는다.
실제 카메라 모드에서는 `/cits-mock`을 호출하지 않으며, 이 엔드포인트는 개발/테스트용으로만 남아 있다.

## 라이브 로그

카메라 라이브 모드(및 시나리오 재생 모드)에서는 100ms safety tick마다
`src/demo/flightRecorder.js`가 한 건씩 메모리에 기록한다(세션당 최대
30000건, 초과분은 오래된 것부터 폐기). 화면 하단 "로그 다운로드
(JSONL)" 버튼으로 `clipsense-live-log-<ISO시각>.jsonl`을 내려받을 수
있다 — 한 줄당 JSON 객체 하나.

기록 필드: 시각(epoch/mono), 모드/시나리오, vision 프레임 정보(색상/
score/quality/frameSeq/캡처시각), E2E latency(`e2eMs` = safety tick
시각 − 해당 tick에 쓰인 vision 프레임 캡처 시각, 프레임이 없으면
`null`), shield 연산 시간(`shieldMs`), C-ITS 관측(색상/잔여시간/seq/
가용여부)과 그 source age, baseline/SafeGraph-RTA 각각의 판정, 그리고
그 tick에 TTS가 실제로 발화한 메시지(없으면 `null`).

화면 상단 상태 바의 **E2E p95** 수치와 기록 건수는 이 로그에서
직접 계산한 값(nearest-rank p95, `experiments/metrics.js`와 동일
공식)이며 약 1초 간격으로 갱신된다. 시연/보고서에서 제시하는 E2E
latency 근거는 항상 이 다운로드 로그다 — 화면에 순간적으로 보이는
숫자가 아니라, 다운로드한 JSONL을 근거 자료로 사용한다.

## 안전 고지

> ⚠️ 본 프로토타입은 기술 검증용 시연이며 실제 보행 판단에 사용할 수 없습니다. SafeGraph-RTA는 정의된 소프트웨어 결함 시나리오에서 기존 방식과 비교한 결과이며, 실제 도로에서의 안전을 보장하거나 사고를 원천 차단한다고 주장하지 않습니다. 예선 버전의 횡단보도–영상 ROI 연결은 수동 바인딩(MANUAL TARGET BINDING)이며 자동 공간 인식이 아닙니다.

## 10/19 증거 수집 화면

실제 카메라 모드는 실시간 신호/남은 시간 미연결로 최종 WAIT를 유지한다.
MOCK 시나리오는 별도이며 실제 클립 결과와 섞어 제출하지 않는다.
연결 상태·마지막 성공 수신·센서/기기 프레임, 원본 JPEG 저장,
장면 정답/판독/최종 안내의 CSV·JSON 내보내기, 음성 시작/다시 듣기·이벤트·직접 청취 기록을 지원한다.
자세한 실행·촬영·재실행 절차와 제출 양식은
[증거 수집 안내](../docs/evidence/2026-10-19/README.md)를 따른다.
현재 웹 규칙은 `hsv-components-v2` (색상 + 단순 연결 영역 모양 검사)이며 학습 AI 모델이 아니다.
실제 클립의 네트워크·인식·스피커 소리는 사용 기기에서 별도로 검증한다.
