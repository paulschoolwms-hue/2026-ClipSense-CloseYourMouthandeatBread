#include "clip_network.h"

#include <ESPmDNS.h>
#include <esp_mac.h>

namespace {

// MAC 뒤 4자리(16진). 기기 구분용 접미사로 쓴다(§9.4).
String macSuffix() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);  // Wi-Fi 초기화 전에도 실제 MAC을 읽는다.
  char buf[5];
  snprintf(buf, sizeof(buf), "%02x%02x", mac[4], mac[5]);
  return String(buf);
}

}  // namespace

void ClipNetwork::begin(const char* ssid, const char* password,
                           const char* apPassword) {
  _ssid = ssid;
  _password = password;
  _apPassword = apPassword;

  const String suffix = macSuffix();
  _hostname = "clipsense-" + suffix;
  _apSsid = "ClipSense-" + suffix;

  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);  // 재접속은 이 상태기계가 직접 관리한다
  WiFi.setSleep(false);          // 지연을 줄인다(§9.2)

  enterStaConnecting();
}

void ClipNetwork::enterStaConnecting() {
  _state = NetState::StaConnecting;
  _connectStartedMs = millis();
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(_hostname.c_str());
  WiFi.begin(_ssid, _password);
}

void ClipNetwork::enterStaActive() {
  _state = NetState::StaActive;
  _retryCount = 0;
  startMdns();
}

void ClipNetwork::enterApRecovery() {
  _state = NetState::ApRecovery;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  // 비밀번호가 8자 미만이면 WPA2가 걸리지 않는다. 열린 AP를 만들지 않기 위해
  // 그런 경우에도 시작은 하되, 부팅 로그가 비밀번호 길이를 경고한다.
  WiFi.softAP(_apSsid.c_str(), _apPassword, CLIP_AP_CHANNEL);
}

void ClipNetwork::startMdns() {
  if (_mdnsStarted) {
    MDNS.end();
    _mdnsStarted = false;
  }
  // 실패해도 치명적이지 않다 — 직렬 로그의 IP로 접속하면 된다(§9.4).
  if (MDNS.begin(_hostname.c_str())) {
    MDNS.addService("http", "tcp", CLIP_HTTP_PORT);
    _mdnsStarted = true;
  }
}

void ClipNetwork::loop() {
  const uint32_t now = millis();

  switch (_state) {
    case NetState::Boot:
      break;

    case NetState::StaConnecting:
      if (WiFi.status() == WL_CONNECTED) {
        enterStaActive();
      } else if (now - _connectStartedMs >= CLIP_STA_CONNECT_TIMEOUT_MS) {
        enterApRecovery();
      }
      break;

    case NetState::StaActive:
      if (WiFi.status() != WL_CONNECTED) {
        // 연결이 끊겼다. 카메라 관측은 이 순간부터 도달 불가가 되고, 앱은
        // freshness 만료로 스스로 WAIT에 들어간다. 여기서는 재접속만 한다.
        _disconnectCount++;
        _state = NetState::StaReconnecting;
        _lastRetryMs = now;
        _retryCount = 0;
        WiFi.disconnect();
        WiFi.begin(_ssid, _password);
      }
      break;

    case NetState::StaReconnecting:
      if (WiFi.status() == WL_CONNECTED) {
        enterStaActive();
      } else if (now - _lastRetryMs >= CLIP_STA_RETRY_INTERVAL_MS) {
        _lastRetryMs = now;
        _retryCount++;
        if (_retryCount >= CLIP_STA_RETRY_LIMIT) {
          enterApRecovery();
        } else {
          WiFi.disconnect();
          WiFi.begin(_ssid, _password);
        }
      }
      break;

    case NetState::ApRecovery:
      // 복구 AP는 사람이 붙어 상태를 확인하는 경로다. 자동으로 STA를 다시
      // 시도하지 않는다 — 조용히 모드가 바뀌면 어디에 붙어 있는지 알 수 없다.
      break;
  }
}

const char* ClipNetwork::modeName() const {
  switch (_state) {
    case NetState::StaActive:
      return "STA";
    case NetState::StaConnecting:
      return "STA_CONNECTING";
    case NetState::StaReconnecting:
      return "STA_RECONNECTING";
    case NetState::ApRecovery:
      return "AP";
    case NetState::Boot:
    default:
      return "BOOT";
  }
}

IPAddress ClipNetwork::ip() const {
  if (_state == NetState::ApRecovery) return WiFi.softAPIP();
  return WiFi.localIP();
}

int ClipNetwork::rssiDbm() const {
  if (_state == NetState::StaActive) return WiFi.RSSI();
  return 0;
}
