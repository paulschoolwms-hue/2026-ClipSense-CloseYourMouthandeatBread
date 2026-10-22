// ClipSense 클립 카메라 펌웨어 — XIAO ESP32S3 Sense
//
// 옷깃에 다는 클립형 카메라가 보행 신호등을 촬영해 HTTP 스냅샷으로 넘기고,
// 판정(이중 검증)은 폰/브라우저 쪽에서 수행한다. 이 펌웨어는 "정직한 프레임"을
// 공급하는 역할만 맡는다 — 판정하지 않고, 오래된 프레임을 새 것처럼 보내지
// 않으며, 실패를 성공처럼 포장하지 않는다.
//
// 설계 근거: ClipSense 하드웨어 최종설계·제작 보고서 v0.2 §9~§10.
//
// 빌드:
//   arduino-cli compile -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi \
//       firmware/clipsense_cam
// 또는 PlatformIO: firmware/platformio.ini 참고.
//
// 준비: secrets.example.h 를 secrets.h 로 복사해 Wi-Fi·토큰을 채운다.

#include <Arduino.h>
#include <esp_mac.h>
#include <esp_system.h>
#include <esp_timer.h>

#include "camera_service.h"
#include "config.h"
#include "http_api.h"
#include "clip_network.h"
#include "secrets.h"

namespace {

CameraService camera;
ClipNetwork network;
char bootId[9] = "00000000";
HttpApi* api = nullptr;

uint32_t ledOffAtMs = 0;
bool ledOn = false;

void ledWrite(bool on) {
#if CLIP_STATUS_LED_ACTIVE_LOW
  digitalWrite(CLIP_STATUS_LED_PIN, on ? LOW : HIGH);
#else
  digitalWrite(CLIP_STATUS_LED_PIN, on ? HIGH : LOW);
#endif
  ledOn = on;
}

// 소프트 리셋(패닉·워치독·esp_restart) 사이에 살아남는 부팅 카운터. RTC 메모리는
// 전원이 끊기면 임의값이 되지만, 그때는 어차피 새 값이므로 상관없다.
RTC_NOINIT_ATTR uint32_t rtcBootCounter;

// 재부팅마다 달라지는 부팅 식별자(§9.3). 판정 쪽은 bootId가 바뀌면 프레임
// 진행·정지 비교 이력을 폐기해야 한다 — uptime이 0부터 다시 시작하기 때문이다.
//
// esp_random()만 쓰면 위험하다: RF(Wi-Fi)가 켜지기 전에는 하드웨어 RNG 엔트로피가
// 약해 재부팅마다 같은 값이 나올 수 있고, 그러면 판정 쪽이 재부팅을 못 알아채
// 0부터 다시 시작한 uptime을 "시간 역행"으로 보고 모든 프레임을 거부한다(안전하지만
// 사용자가 stop/start 할 때까지 카메라가 멈춘 것처럼 보인다). 그래서 기기 고유
// eFuse MAC, 부팅 카운터, 타이머, esp_random()을 FNV-1a로 섞는다 — 연속 재부팅에서
// 같은 값이 나오지 않게 하는 용도이지 암호학적 식별자가 아니다.
void makeBootId() {
  uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
  esp_efuse_mac_get_default(mac);
  rtcBootCounter++;

  uint32_t h = 2166136261u;  // FNV-1a 32-bit offset basis
  auto mixByte = [&h](uint8_t b) {
    h ^= b;
    h *= 16777619u;
  };
  auto mixWord = [&mixByte](uint32_t w) {
    for (int i = 0; i < 4; i++) mixByte(static_cast<uint8_t>(w >> (8 * i)));
  };
  for (int i = 0; i < 6; i++) mixByte(mac[i]);
  mixWord(rtcBootCounter);
  mixWord(esp_random());
  const uint64_t now = static_cast<uint64_t>(esp_timer_get_time());
  mixWord(static_cast<uint32_t>(now));
  mixWord(static_cast<uint32_t>(now >> 32));
  snprintf(bootId, sizeof(bootId), "%08x", h);
}

// 부팅 진단(§9.3). 실기기에서 문제가 생겼을 때 첫 화면이 되는 로그다.
void printBootLog() {
  Serial.println();
  Serial.println(F("=== ClipSense camera ==="));
  Serial.printf("firmwareVersion   %s\n", CLIP_FIRMWARE_VERSION);
  Serial.printf("networkMode       %s\n", network.modeName());
  Serial.printf("hostname          %s.local\n", network.hostname().c_str());
  Serial.printf("ip                %s\n", network.ip().toString().c_str());
  Serial.printf("buildTimestamp    %s %s\n", __DATE__, __TIME__);
  Serial.printf("deviceId          %s\n", CLIP_DEVICE_ID);
  Serial.printf("bootId            %s\n", bootId);
  Serial.printf("bootCounter       %lu\n", static_cast<unsigned long>(rtcBootCounter));
  Serial.printf("resetReason       %d\n", static_cast<int>(esp_reset_reason()));
  Serial.printf("cameraSensorPid   %s\n", camera.sensorName());
  Serial.printf("cameraOk          %s\n", camera.cameraOk() ? "true" : "false");
  if (!camera.cameraOk()) {
    Serial.printf("cameraError       %s\n", camera.lastError());
  }
  Serial.printf("resolution        %dx%d\n", camera.frameWidth(),
                camera.frameHeight());
  Serial.printf("jpegQuality       %d\n", camera.jpegQuality());
  Serial.printf("cameraProfile     %s\n", camera.profileName());
  Serial.printf("rssiDbm           %d\n", network.rssiDbm());
  Serial.printf("psramBytes        %u\n", ESP.getPsramSize());
  Serial.printf("freePsram         %u\n", ESP.getFreePsram());
  Serial.printf("heapBytes         %u\n", ESP.getHeapSize());
  Serial.printf("minFreeHeap       %u\n", ESP.getMinFreeHeap());
  if (network.state() == NetState::ApRecovery) {
    Serial.printf("apSsid            %s\n", network.apSsid().c_str());
    if (strlen(CLIP_AP_PASSWORD) < 8) {
      Serial.println(F("WARNING           AP password shorter than 8 chars — "
                       "WPA2 will not engage"));
    }
  }
  Serial.println(F("========================"));
}

}  // namespace

// http_api.cpp에서 촬영 시점에 부른다. 촬영 중임을 물리적으로 알린다(§10.1).
void clipSignalCaptureLed() {
  ledWrite(true);
  ledOffAtMs = millis() + CLIP_CAPTURE_LED_HOLD_MS;
}

void setup() {
  Serial.begin(CLIP_SERIAL_BAUD);
  // 직렬 포트가 열릴 때까지 잠깐 기다린다(USB CDC는 준비에 시간이 걸린다).
  const uint32_t serialWaitUntil = millis() + 1500;
  while (!Serial && millis() < serialWaitUntil) {
    delay(10);
  }

  pinMode(CLIP_STATUS_LED_PIN, OUTPUT);
  ledWrite(false);

  makeBootId();

  // 카메라를 먼저 올린다. 실패해도 계속 진행해 /health로 원인을 볼 수 있게 한다
  // — 조용히 죽는 것보다 "cameraOk:false"를 말하는 편이 진단에 낫다.
  const bool cameraReady = camera.begin();

  network.begin(CLIP_WIFI_SSID, CLIP_WIFI_PASSWORD, CLIP_AP_PASSWORD);
  // 첫 연결 판정까지만 짧게 돌려 부팅 로그에 실제 상태가 찍히게 한다.
  const uint32_t netWaitUntil = millis() + CLIP_STA_CONNECT_TIMEOUT_MS + 500;
  while (network.state() == NetState::StaConnecting && millis() < netWaitUntil) {
    network.loop();
    delay(50);
  }

  static HttpApi httpApi(camera, network, CLIP_DEVICE_TOKEN, bootId);
  api = &httpApi;
  api->begin();

  printBootLog();

  if (!cameraReady) {
    // 카메라 없이도 /health는 응답한다. LED를 길게 켜 눈으로도 알 수 있게 한다.
    ledWrite(true);
    ledOffAtMs = millis() + 2000;
  }
}

void loop() {
  static char command[16];
  static size_t commandLen = 0;
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      command[commandLen] = '\0';
      if (strcmp(command, "status") == 0) {
        Serial.printf("firmwareVersion %s\nnetworkMode %s\nip %s\ncameraOk %s\ncameraProfile %s\nrssiDbm %d\n",
          CLIP_FIRMWARE_VERSION, network.modeName(), network.ip().toString().c_str(),
          camera.cameraOk() ? "true" : "false", camera.profileName(), network.rssiDbm());
      }
      commandLen = 0;
    } else if (commandLen + 1 < sizeof(command)) command[commandLen++] = ch;
  }
  network.loop();
  if (api != nullptr) api->loop();

  if (ledOn && millis() >= ledOffAtMs) {
    ledWrite(false);
  }
}
