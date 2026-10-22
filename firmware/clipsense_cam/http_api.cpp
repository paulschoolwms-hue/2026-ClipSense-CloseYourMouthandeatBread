#include "http_api.h"

#include <esp_system.h>

#include "config.h"
#include "jpeg_transfer.h"

extern void clipSignalCaptureLed();  // main .ino — 촬영 표시 LED

namespace {

// 문자열 비교 시간을 입력에 따라 달라지지 않게 한다(토큰 추측을 어렵게).
bool constantTimeEquals(const String& a, const char* b) {
  const size_t bLen = strlen(b);
  if (a.length() != bLen) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < bLen; i++) {
    diff |= static_cast<uint8_t>(a[i]) ^ static_cast<uint8_t>(b[i]);
  }
  return diff == 0;
}

const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
      return "POWERON_RESET";
    case ESP_RST_EXT:
      return "EXT_RESET";
    case ESP_RST_SW:
      return "SW_RESET";
    case ESP_RST_PANIC:
      return "PANIC_RESET";
    case ESP_RST_INT_WDT:
      return "INT_WDT_RESET";
    case ESP_RST_TASK_WDT:
      return "TASK_WDT_RESET";
    case ESP_RST_WDT:
      return "WDT_RESET";
    case ESP_RST_BROWNOUT:
      return "BROWNOUT_RESET";
    case ESP_RST_DEEPSLEEP:
      return "DEEPSLEEP_RESET";
    case ESP_RST_SDIO:
      return "SDIO_RESET";
    default:
      return "UNKNOWN_RESET";
  }
}

}  // namespace

HttpApi::HttpApi(CameraService& camera, ClipNetwork& net,
                 const char* deviceToken, const char* bootId)
    : _server(CLIP_HTTP_PORT),
      _camera(camera),
      _net(net),
      _deviceToken(deviceToken),
      _bootId(bootId) {}

void HttpApi::begin() {
  _server.on("/health", HTTP_GET, [this]() { handleHealth(); });
  _server.on("/health", HTTP_OPTIONS, [this]() { handleOptions(); });
  _server.on("/capture", HTTP_GET, [this]() { handleCapture(); });
  _server.on("/capture", HTTP_OPTIONS, [this]() { handleOptions(); });
  _server.on("/jpg", HTTP_GET, [this]() { handleCapture(); });  // 호환 별칭
  _server.on("/jpg", HTTP_OPTIONS, [this]() { handleOptions(); });
#if CLIP_ENABLE_LAPTOP_RELAY
  _relayBuf = static_cast<uint8_t*>(ps_malloc(CLIP_RELAY_MAX_BYTES));
  _relayRecvBuf = static_cast<uint8_t*>(ps_malloc(CLIP_RELAY_MAX_BYTES));
  _server.on(
      "/frame", HTTP_POST, [this]() { handleFrameUploadDone(); },
      [this]() { handleFrameUpload(); });
  _server.on("/relay", HTTP_GET, [this]() { handleRelayStatus(); });
#endif
  _server.on("/", HTTP_GET, [this]() { handleRoot(); });
  _server.onNotFound([this]() { handleNotFound(); });

  // 토큰과 Origin 헤더는 기본 수집 목록에 없으므로 명시해야 읽을 수 있다.
  const char* headerKeys[] = {CLIP_TOKEN_HEADER, "Origin"};
  _server.collectHeaders(headerKeys, 2);

  _server.begin();
}

void HttpApi::loop() { _server.handleClient(); }

const char* HttpApi::allowedOrigin() const {
  if (!_server.hasHeader("Origin")) return nullptr;
  const String origin = _server.header("Origin");
  if (origin == CLIP_CORS_ORIGIN) return CLIP_CORS_ORIGIN;
  if (origin == CLIP_CORS_ORIGIN_ALT) return CLIP_CORS_ORIGIN_ALT;
  return nullptr;
}

void HttpApi::applyCommonHeaders(bool exposeCaptureHeaders) {
  // 판정에 쓰는 응답은 절대 캐시되면 안 된다(오래된 프레임이 새 것처럼 보인다).
  _server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  _server.sendHeader("Pragma", "no-cache");

  const char* origin = allowedOrigin();
  if (origin != nullptr) {
    // 와일드카드를 쓰지 않는다(§10.1).
    _server.sendHeader("Access-Control-Allow-Origin", origin);
    _server.sendHeader("Vary", "Origin");
    if (exposeCaptureHeaders) {
      _server.sendHeader(
          "Access-Control-Expose-Headers",
          "X-Frame-Seq, X-Capture-Uptime-Us, X-Response-Uptime-Us, X-Boot-Id, "
          "X-Firmware-Version, X-Camera-Sensor, X-Frame-Source");
    }
  }
}

void HttpApi::handleOptions() {
  const char* origin = allowedOrigin();
  if (origin == nullptr) {
    // 허용하지 않은 origin의 preflight는 CORS 헤더 없이 거절한다.
    _server.send(403, "text/plain", "origin not allowed");
    return;
  }
  _server.sendHeader("Access-Control-Allow-Origin", origin);
  _server.sendHeader("Vary", "Origin");
  _server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  _server.sendHeader("Access-Control-Allow-Headers", CLIP_TOKEN_HEADER);
  _server.sendHeader("Access-Control-Max-Age", "600");
  _server.send(204);
}

bool HttpApi::authorize() {
  if (!_server.hasHeader(CLIP_TOKEN_HEADER)) {
    applyCommonHeaders(false);
    _server.send(401, "application/json",
                 "{\"error\":\"missing_device_token\"}");
    return false;
  }
  if (!constantTimeEquals(_server.header(CLIP_TOKEN_HEADER), _deviceToken)) {
    applyCommonHeaders(false);
    _server.send(403, "application/json",
                 "{\"error\":\"invalid_device_token\"}");
    return false;
  }
  return true;
}

void HttpApi::handleHealth() {
  if (!authorize()) return;

  // 실제 SSID와 비밀번호는 응답에 넣지 않는다(§9.4).
  String json;
  json.reserve(768);
  json += "{";
  json += "\"schemaVersion\":\"" CLIP_API_SCHEMA_VERSION "\",";
  json += "\"deviceId\":\"" CLIP_DEVICE_ID "\",";
  json += "\"bootId\":\"" + String(_bootId) + "\",";
  json += "\"firmwareVersion\":\"" CLIP_FIRMWARE_VERSION "\",";
  json += "\"buildTimestamp\":\"" __DATE__ " " __TIME__ "\",";
  json += "\"cameraSensorPid\":\"" + String(_camera.sensorName()) + "\",";
  json += "\"cameraOk\":" + String(_camera.cameraOk() ? "true" : "false") + ",";
  json += "\"networkMode\":\"" + String(_net.modeName()) + "\",";
  json += "\"hostname\":\"" + _net.hostname() + "\",";
  json += "\"uptimeMs\":" + String(millis()) + ",";
  json += "\"rssiDbm\":" + String(_net.rssiDbm()) + ",";
  json += "\"frameSeq\":" + String(_camera.frameSeq()) + ",";
  json += "\"lastCaptureUptimeUs\":" + String(_camera.lastCaptureUptimeUs()) + ",";
  json += "\"captureOkCount\":" + String(_camera.captureOkCount()) + ",";
  json += "\"captureErrorCount\":" + String(_camera.captureErrorCount()) + ",";
  json += "\"captureBusyCount\":" + String(_camera.captureBusyCount()) + ",";
  json += "\"wifiDisconnectCount\":" + String(_net.disconnectCount()) + ",";
  json += "\"resolution\":\"" + String(_camera.frameWidth()) + "x" +
          String(_camera.frameHeight()) + "\",";
  json += "\"jpegQuality\":" + String(CLIP_JPEG_QUALITY) + ",";
  json += "\"psramBytes\":" + String(ESP.getPsramSize()) + ",";
  json += "\"freePsramBytes\":" + String(ESP.getFreePsram()) + ",";
  json += "\"heapBytes\":" + String(ESP.getHeapSize()) + ",";
  json += "\"freeHeapBytes\":" + String(ESP.getFreeHeap()) + ",";
  json += "\"minFreeHeapBytes\":" + String(ESP.getMinFreeHeap()) + ",";
  json += "\"resetReason\":\"" + String(resetReasonName()) + "\",";
  json += "\"lastError\":\"" + String(_camera.lastError()) + "\"";
  json += ",\"lastTransfer\":{\"expectedBytes\":" + String(_lastTransferExpected);
  json += ",\"queuedBytes\":" + String(_lastTransferQueued);
  json += ",\"elapsedMs\":" + String(_lastTransferMs);
  json += ",\"completeQueue\":" + String(_lastTransferComplete ? "true" : "false");
  json += ",\"errorCount\":" + String(_transferErrorCount);
  json += ",\"rssiDbm\":" + String(_lastTransferRssi) + "}";
  json += "}";

  applyCommonHeaders(false);
  _server.send(200, "application/json", json);
}

void HttpApi::sendJpegBody(const uint8_t* data, size_t length) {
  auto client = _server.client();
  client.setNoDelay(true);
  client.setConnectionTimeout(500);
  _lastTransferExpected = length;
  _lastTransferRssi = _net.rssiDbm();
  const auto result = writeJpegBody(client, data, length,
                                   []() { return millis(); }, []() { delay(1); });
  _lastTransferQueued = result.queuedBytes;
  _lastTransferMs = result.elapsedMs;
  _lastTransferComplete = result.complete;
  if (!result.complete) {
    ++_transferErrorCount;
    // 헤더의 Content-Length와 다른 불완전한 응답을 열린 채 남기지 않는다.
    client.stop();
  }
}

void HttpApi::handleCapture() {
  if (!authorize()) return;

  // 카메라가 초기화되지 않았으면 노트북 업로드 프레임으로 대신한다(표시 헤더 포함).
  if (!_camera.cameraOk() && sendRelayFrame()) return;

  CaptureResult shot = _camera.capture();
  if (!shot.ok) {
    applyCommonHeaders(false);
    // 획득 실패 시 마지막 JPEG을 재전송하지 않는다(§10.3) — 오래된 프레임을
    // 새 것처럼 보내면 판정이 정지(freeze)를 알아채지 못한다.
    if (_camera.lastAttemptWasBusy()) {
      _server.send(409, "application/json",
                   "{\"error\":\"capture_busy\"}");
    } else {
      _server.send(503, "application/json",
                   "{\"error\":\"capture_failed\"}");
    }
    return;
  }

  clipSignalCaptureLed();  // 촬영 중임을 물리적으로 표시(§10.1)

  // 응답 시점을 획득 시점과 같은 clock domain(uptime)으로 남긴다. 브라우저는
  // (responseUptimeUs - captureUptimeUs)로 서버측 프레임 age를 계산한다(§10.4).
  const uint64_t responseUptimeUs = esp_timer_get_time();

  applyCommonHeaders(true);
  _server.sendHeader("X-Frame-Seq", String(shot.frameSeq));
  _server.sendHeader("X-Capture-Uptime-Us", String(shot.captureUptimeUs));
  _server.sendHeader("X-Response-Uptime-Us", String(responseUptimeUs));
  _server.sendHeader("X-Boot-Id", _bootId);
  _server.sendHeader("X-Firmware-Version", CLIP_FIRMWARE_VERSION);
  _server.sendHeader("X-Camera-Sensor", _camera.sensorName());

  _server.setContentLength(shot.fb->len);
  _server.send(200, "image/jpeg", "");
  sendJpegBody(shot.fb->buf, shot.fb->len);

  _camera.release(shot);
  _frameSourceName = "camera";
}

// ── 노트북 촬영 중계 ───────────────────────────────────────────────────────
// 본문은 multipart/form-data 의 파일 조각으로 받는다(WebServer 의 "plain" 인자는
// 문자열이라 JPEG 안의 0x00 에서 잘린다). 토큰은 완료 시점에 확인하고, 실패하면
// 받은 내용을 버린다 — 인증되지 않은 프레임은 /capture 로 나가지 않는다.
void HttpApi::handleFrameUpload() {
  HTTPUpload& up = _server.upload();
  if (_relayRecvBuf == nullptr) return;
  if (up.status == UPLOAD_FILE_START) {
    _relayRecvLen = 0;
    _relayRecvOverflow = false;
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (_relayRecvLen + up.currentSize > CLIP_RELAY_MAX_BYTES) {
      _relayRecvOverflow = true;
      return;
    }
    memcpy(_relayRecvBuf + _relayRecvLen, up.buf, up.currentSize);
    _relayRecvLen += up.currentSize;
  }
}

void HttpApi::handleFrameUploadDone() {
  if (!authorize()) {
    _relayRecvLen = 0;
    _relayRejectCount++;
    return;
  }
  applyCommonHeaders(false);
  if (_relayRecvBuf == nullptr || _relayBuf == nullptr) {
    _server.send(503, "application/json", "{\"error\":\"relay_unavailable\"}");
    return;
  }
  const bool looksJpeg = _relayRecvLen > 4 && _relayRecvBuf[0] == 0xFF &&
                         _relayRecvBuf[1] == 0xD8;
  if (_relayRecvOverflow || !looksJpeg) {
    _relayRejectCount++;
    _relayRecvLen = 0;
    _server.send(400, "application/json",
                 _relayRecvOverflow ? "{\"error\":\"frame_too_large\"}"
                                    : "{\"error\":\"not_jpeg\"}");
    return;
  }
  memcpy(_relayBuf, _relayRecvBuf, _relayRecvLen);
  _relayLen = _relayRecvLen;
  _relayRecvLen = 0;
  _relaySeq++;
  _relayUploadCount++;
  _relayUptimeUs = esp_timer_get_time();
  _server.send(200, "application/json",
               "{\"ok\":true,\"relaySeq\":" + String(_relaySeq) +
                   ",\"bytes\":" + String(_relayLen) + "}");
}

// 중계 상태는 /health 계약(26개 키)을 바꾸지 않도록 별도 경로로 낸다.
void HttpApi::handleRelayStatus() {
  if (!authorize()) return;
  String json = "{";
  json += "\"relaySeq\":" + String(_relaySeq) + ",";
  json += "\"relayUploadCount\":" + String(_relayUploadCount) + ",";
  json += "\"relayRejectCount\":" + String(_relayRejectCount) + ",";
  json += "\"relayUptimeUs\":" + String(_relayUptimeUs) + ",";
  json += "\"relayBytes\":" + String(_relayLen) + ",";
  json += "\"servedSource\":\"" + String(_frameSourceName) + "\",";
  json += "\"cameraOk\":" + String(_camera.cameraOk() ? "true" : "false");
  json += "}";
  applyCommonHeaders(false);
  _server.send(200, "application/json", json);
}

bool HttpApi::sendRelayFrame() {
#if CLIP_ENABLE_LAPTOP_RELAY
  if (_relayBuf == nullptr || _relayLen == 0) return false;
  const uint64_t nowUs = esp_timer_get_time();
  if (nowUs - _relayUptimeUs > CLIP_RELAY_MAX_AGE_MS * 1000ULL) {
    applyCommonHeaders(false);
    _server.send(503, "application/json", "{\"error\":\"no_recent_frame\"}");
    return true;
  }
  applyCommonHeaders(true);
  _server.sendHeader("X-Frame-Seq", String(_relaySeq));
  _server.sendHeader("X-Capture-Uptime-Us", String(_relayUptimeUs));
  _server.sendHeader("X-Response-Uptime-Us", String(nowUs));
  _server.sendHeader("X-Boot-Id", _bootId);
  _server.sendHeader("X-Firmware-Version", CLIP_FIRMWARE_VERSION);
  _server.sendHeader("X-Camera-Sensor", "LAPTOP");
  _server.sendHeader("X-Frame-Source", "laptop-upload");
  _server.setContentLength(_relayLen);
  _server.send(200, "image/jpeg", "");
  sendJpegBody(_relayBuf, _relayLen);
  _frameSourceName = "laptop-upload";
  return true;
#else
  return false;
#endif
}

void HttpApi::handleRoot() {
#if CLIP_ENABLE_INSPECT_PAGE
  // 조준·초점 점검용 최소 화면. 물리적으로 통제된 상태에서만 켠다(§10.1).
  // 토큰을 URL 쿼리로 받지 않는다 — 브라우저 기록·로그에 남기 때문이다.
  String html;
  html.reserve(1024);
  html += F(
      "<!doctype html><meta charset=utf-8>"
      "<meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>ClipSense 카메라 점검</title>"
      "<style>body{background:#0f1417;color:#e8eeea;font-family:system-ui;"
      "margin:0;padding:24px;font-size:18px}h1{font-size:22px;margin:0 0 16px}"
      "code{background:#1f282d;padding:2px 6px;border-radius:4px}"
      "p{max-width:34em;line-height:1.6}</style>"
      "<h1>ClipSense 카메라</h1>");
  html += "<p>기기 <code>" CLIP_DEVICE_ID "</code> · 펌웨어 <code>" CLIP_FIRMWARE_VERSION
          "</code></p>";
  html += "<p>상태와 프레임은 <code>" CLIP_TOKEN_HEADER
          "</code> 헤더를 붙여 <code>/health</code>, <code>/capture</code>로 "
          "요청한다. 이 화면은 조준 점검용이며 프레임을 보여주지 않는다.</p>";
  applyCommonHeaders(false);
  _server.send(200, "text/html; charset=utf-8", html);
#else
  applyCommonHeaders(false);
  _server.send(404, "application/json", "{\"error\":\"inspect_page_disabled\"}");
#endif
}

void HttpApi::handleNotFound() {
  applyCommonHeaders(false);
  _server.send(404, "application/json", "{\"error\":\"not_found\"}");
}
