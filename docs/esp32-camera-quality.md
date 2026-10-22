# ESP32 화질 선택과 전송 복구 (펌웨어 0.3.4)

0.3.3에서 사용자가 제공한 로그에는 320×240 JPEG 전체 수신 성공과 WMS 신호
-83dBm이 함께 기록돼 있다. 이 한 번의 성공은 VGA 연속 전송을 보장하지 않는다.
0.3.4는 안정 화질을 기본으로 두고 웹에서 화질을 바꾸는 기능을 추가한다.

| 웹 선택 | 원본 | JPEG quality | 용도 |
|---|---|---|---|
| 안정 | 320×240 | 12 | 약한 Wi-Fi, 전송 비교 기준, 기본값 |
| 균형 | 640×480 | 18 | 해상도를 높이되 압축으로 용량을 줄임 |
| 선명 | 640×480 | 12 | 작은 압축 손실, 더 큰 전송량 |

JPEG quality는 숫자가 작을수록 압축 손실이 적다. 센서 초점·렌즈 오염·손떨림·
조명으로 생기는 흐림은 해상도 설정만으로 해결되지 않는다. 웹 분석은 기존의
다운샘플·색상/연결 영역 규칙을 그대로 쓰며 고해상도 원본이 인식 정확도 향상을
보장하지 않는다. 영상/분석의 180도 회전도 유지한다.

## Mac에서 업데이트

시리얼 모니터가 켜져 있으면 먼저 해당 터미널에서 Control+C로 종료한다.
Wi-Fi·토큰이 들어 있는 기존 secrets.h는 그대로 사용한다.

```bash
cd ~/2026-ClipSense-CloseYourMouthandeatBread
git fetch https://github.com/paulschoolwms-hue/2026-ClipSense-CloseYourMouthandeatBread.git codex/esp32-camera-web
git merge --ff-only FETCH_HEAD
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi firmware/clipsense_cam
```

컴파일 성공 후:

```bash
arduino-cli upload -p /dev/cu.usbmodem1101 --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi firmware/clipsense_cam
```

포트 점유 오류는 `lsof /dev/cu.usbmodem1101`로 실제 점유 프로세스를 확인하고
그 모니터를 종료한다. USB 번호가 바뀌면 `arduino-cli board list`로 확인한다.

웹 서버 터미널에서 Control+C 후 다시 실행한다:

```bash
cd ~/2026-ClipSense-CloseYourMouthandeatBread/web
CLIPSENSE_HTTP_LOCAL=1 npm run dev -- --port 5174 --strictPort
```

같은 Mac 브라우저에서 http://127.0.0.1:5174/ 를 연다. ESP32의 현재 IP와
기존 토큰을 입력하고 먼저 **안정 → ESP32 연결**, 다음 **균형 → ESP32 연결**로
비교한다. 증거 패널의 원본 크기, 실제 화질, 압축 값, 요청 시간, 신호 세기를 확인한다.
원하는 화질 선택은 연결 버튼을 눌러 적용한다. 구형 펌웨어가 화질 요청을 무시하면
VGA가 적용됐다고 표시하지 않고 업데이트 안내를 보여준다.

## 연결과 오류 처리

- PSRAM이 있는 기기는 VGA 프레임버퍼를 먼저 확보하고 실제 출력은 QVGA로 시작한다.
  화질 전환과 캡처는 같은 mutex 안에서 수행하고 이전 버퍼를 버린 뒤 크기를 검사한다.
  센서 설정 실패 시 이전 설정으로 복구를 시도한다. PSRAM 없는 기기는 안정만 허용한다.
- 같은 Mac 중계 서버에서는 한 기기의 사진 요청을 하나씩 처리한다. 다른 탭/진단과
  겹치면 409로 안내한다. 실패·요청 취소 시에도 점유 상태를 해제한다.
- 고화질 요청이 두 번 연속 실패하면 다음 요청부터 안정으로 복구한다. 자동 상향은
  하지 않는다. 토큰/PSRAM/구형 펌웨어 오류는 자동 반복하지 않으며 설정 후 재연결한다.
- 브라우저는 JPEG 시작·끝 표식과 제공된 Content-Length를 검사한다. 잘린 사진은
  성공 횟수·수신 시각·판독을 갱신하지 않는다. 실제 JPEG 디코드와 2초 신선도 검사도 유지한다.
- `X-Camera-Profile`, `X-Jpeg-Quality`, `X-Wifi-Rssi`를 중계·표시한다. 세션 JSON에는
  수신 이벤트와 장면별 화질/신호/지연을 기록한다. 토큰은 포함하지 않는다.
- WMS 연결 대기 시간을 15초에서 30초로 늘린다. MAC을 Wi-Fi 초기화 전에 읽어서
  `ClipSense-0000`으로 고정되던 이름을 고친다. 복구 AP와 hostname 끝 4자리는
  **실제 MAC 뒤 4자리로 바뀔 수 있다**. AP에서는 인터넷이 제공되지 않는다.
- 시리얼 모니터에서 `status`를 입력하고 Enter를 누르면 IP/모드/화질/신호를 다시
  출력한다. 재부팅 로그가 잘려도 이 명령으로 확인할 수 있다.

## 실제 기기에서 비교할 것

웹 카메라 탭을 닫고 프로젝트 루트의 새 터미널에서 다음을 실행한다.
토큰은 로컬 secrets.h에서 읽으며 화면에 출력하지 않는다. IP는 현재 부팅 로그에 맞춘다.

```bash
python3 scripts/probe_clip_snapshot.py http://192.168.0.54 --profile stable
python3 scripts/probe_clip_snapshot.py http://192.168.0.54 --profile balanced
python3 scripts/probe_clip_snapshot.py http://192.168.0.54 --profile detail
```

각 화질에서 웹 사진 수가 30초 이상 증가하는지, 물체 이동이 반영되는지, 전체 JPEG
수신/디코드가 되는지 직접 확인한다. 오류 횟수와 요청 시간을 비교해 안정적인 화질을
선택한다. -83dBm 같은 약한 신호면 공유기 가까이에서 다시 비교한다.
네트워크 격리나 무선 손실을 소프트웨어로 없앴다고 주장하지 않는다.

## 검증 범위와 되돌리기

호스트 C++ 테스트는 실제 camera_service.cpp를 가짜 센서와 컴파일해 프로필 전환,
예열, 설정 실패 복구, PSRAM 제한, mutex 해제와 프레임 번호를 검사한다.
웹 단위/HTTP 중계 테스트와 Playwright는 합성 JPEG·모의 센서를 사용한다.
**0.3.4의 ESP32 Arduino 컴파일·업로드·무선 연속 촬영은 사용자의 Mac/실기기에서
별도 확인해야 한다.** 자동 테스트 통과는 완료 증거를 대신하지 않는다.

문제 발생 시 웹에서 먼저 안정으로 다시 연결한다. 펌웨어 자체 부팅 문제가 생기면
기존 성공 버전 c5a72f3의 소스만 복원해 컴파일·업로드할 수 있다. 기존 비밀 파일은
복원 대상에 넣지 않는다:

```bash
git restore --source=c5a72f3 -- firmware/clipsense_cam/camera_service.cpp firmware/clipsense_cam/camera_service.h firmware/clipsense_cam/clip_network.cpp firmware/clipsense_cam/clipsense_cam.ino firmware/clipsense_cam/config.h firmware/clipsense_cam/http_api.cpp
```

복원 후 위 컴파일/업로드 명령을 실행한다. 이 명령은 열거한 소스의 로컬 편집을
덮어쓰므로 수정 중이라면 먼저 따로 보관한다.

### 클라우드 자동 검사 기록 (2026-10-22)

- `npm test --prefix web -- --reporter=dot`: 25개 파일, 414개 테스트 통과.
- `npm run build --prefix web`: 빌드 통과.
- `SDL_AUDIODRIVER=dummy .venv/bin/python scripts/run_unit_tests.py`: 16개 검사 스크립트 통과.
  음성 로직은 무음 장치로 검사했으며 실제 청취 증거가 아니다.
- `python scripts/check_web_evidence.py http://127.0.0.1:4182`: 합성 JPEG로 화질 선택,
  고화질 2회 실패 후 안정 복구, 사진 신선도, 장면/JSON/CSV/JPEG, 회전, 모바일 폭 검증 통과.
- 실제 ESP32용 Arduino 툴체인이 이 환경에 없어 0.3.4 스케치 빌드는 미실행.
