#include "camera_service.h"

#include <Arduino.h>

namespace {

// 센서 PID → 사람이 읽는 이름. /health 의 cameraSensorPid 로 나간다.
const char* sensorNameFromPid(uint16_t pid) {
  switch (pid) {
    case OV2640_PID:
      return "OV2640";
    case OV3660_PID:
      return "OV3660";
    case OV5640_PID:
      return "OV5640";
    case OV7725_PID:
      return "OV7725";
    default:
      return "unknown";
  }
}

}  // namespace

bool CameraService::begin() {
  _mutex = xSemaphoreCreateMutex();
  if (_mutex == nullptr) {
    _lastError = "mutex_alloc_failed";
    return false;
  }

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = CLIP_PIN_Y2;
  cfg.pin_d1 = CLIP_PIN_Y3;
  cfg.pin_d2 = CLIP_PIN_Y4;
  cfg.pin_d3 = CLIP_PIN_Y5;
  cfg.pin_d4 = CLIP_PIN_Y6;
  cfg.pin_d5 = CLIP_PIN_Y7;
  cfg.pin_d6 = CLIP_PIN_Y8;
  cfg.pin_d7 = CLIP_PIN_Y9;
  cfg.pin_xclk = CLIP_PIN_XCLK;
  cfg.pin_pclk = CLIP_PIN_PCLK;
  cfg.pin_vsync = CLIP_PIN_VSYNC;
  cfg.pin_href = CLIP_PIN_HREF;
  cfg.pin_sccb_sda = CLIP_PIN_SIOD;
  cfg.pin_sccb_scl = CLIP_PIN_SIOC;
  cfg.pin_pwdn = CLIP_PIN_PWDN;
  cfg.pin_reset = CLIP_PIN_RESET;
  cfg.xclk_freq_hz = CLIP_XCLK_FREQ_HZ;

  // config.h의 촬영 프로필. 원본 화질과 웹 분석 해상도는 독립적이다.
  cfg.pixel_format = PIXFORMAT_JPEG;
  _supportsVga = psramFound();
  // VGA까지 안전하게 전환할 수 있도록 PSRAM 프레임버퍼를 VGA 크기로 확보한다.
  // 센서의 실제 부팅 출력은 초기화 직후 안정(QVGA)으로 낮춘다.
  cfg.frame_size = _supportsVga ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
  cfg.jpeg_quality = CLIP_JPEG_QUALITY;
  cfg.fb_count = CLIP_FB_COUNT;
  cfg.grab_mode = CAMERA_GRAB_LATEST;  // 오래된 프레임을 쌓아두지 않는다
  cfg.fb_location = CAMERA_FB_IN_PSRAM;

  // PSRAM이 없으면 프레임버퍼를 여러 개 둘 수 없다. 판정용으로는 그래도
  // 동작해야 하므로 안전한 값으로 낮춘다(부팅 로그에 남는다).
  if (!psramFound()) {
    cfg.fb_location = CAMERA_FB_IN_DRAM;
    cfg.fb_count = 1;
    cfg.frame_size = FRAMESIZE_QVGA;
  }

  const esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    _cameraOk = false;
    _lastError = "esp_camera_init_failed";
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    _sensorName = sensorNameFromPid(sensor->id.PID);
    // OV3660은 기본값에서 상이 뒤집혀 나온다(벤더 권장 보정).
    if (sensor->id.PID == OV3660_PID) {
      sensor->set_vflip(sensor, 1);
      // 색 판별용 입력이므로 노출 밝기 증가와 탈채도 보정을 하지 않는다.
      sensor->set_brightness(sensor, 0);
      sensor->set_saturation(sensor, 0);
    }
  }

  if (sensor == nullptr || sensor->set_framesize(sensor, FRAMESIZE_QVGA) != 0 ||
      sensor->set_quality(sensor, CLIP_JPEG_QUALITY) != 0) {
    _lastError = "stable_profile_init_failed";
    return false;
  }
  // 초기 버퍼에 남아 있는 VGA 프레임을 버린 뒤 실제 QVGA 출력을 검증한다.
  for (int i = 0; i < CLIP_FB_COUNT; ++i) {
    camera_fb_t* warm = esp_camera_fb_get();
    if (warm == nullptr) { _lastError = "profile_warmup_failed"; return false; }
    esp_camera_fb_return(warm);
  }

  // 실제로 적용된 해상도를 한 프레임 받아 확인한다. 여기서 실패하면 배선이나
  // 센서 문제이므로 부팅 단계에서 드러내는 편이 낫다.
  camera_fb_t* probe = esp_camera_fb_get();
  if (probe == nullptr) {
    _cameraOk = false;
    _lastError = "first_frame_failed";
    return false;
  }
  if (probe->width != 320 || probe->height != 240) {
    esp_camera_fb_return(probe);
    _lastError = "stable_profile_size_mismatch";
    return false;
  }
  _frameWidth = probe->width;
  _frameHeight = probe->height;
  esp_camera_fb_return(probe);

  _cameraOk = true;
  _lastError = "";
  return true;
}

bool CameraService::setProfileLocked(CameraProfile desired) {
  if (desired == CameraProfile::Current || desired == _profile) return true;
  if (!_supportsVga && desired != CameraProfile::Stable) { _lastError = "profile_requires_psram"; return false; }
  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor == nullptr) { _lastError = "sensor_unavailable"; return false; }
  const auto next = cameraProfileSpec(desired);
  const auto old = cameraProfileSpec(_profile);
  const auto size = desired == CameraProfile::Stable ? FRAMESIZE_QVGA : FRAMESIZE_VGA;
  if (sensor->set_framesize(sensor, size) != 0 || sensor->set_quality(sensor, next.jpegQuality) != 0) {
    const auto oldSize = _profile == CameraProfile::Stable ? FRAMESIZE_QVGA : FRAMESIZE_VGA;
    const bool restoredSize = sensor->set_framesize(sensor, oldSize) == 0;
    const bool restoredQuality = sensor->set_quality(sensor, old.jpegQuality) == 0;
    _cameraOk = restoredSize && restoredQuality;
    _discardFrames = CLIP_FB_COUNT;
    _lastError = "profile_apply_failed";
    return false;
  }
  _profile = desired;
  _discardFrames = CLIP_FB_COUNT;
  return true;
}

CaptureResult CameraService::capture(uint32_t timeoutMs, CameraProfile desired) {
  CaptureResult result;
  _lastAttemptWasBusy = false;

  if (!_cameraOk || _mutex == nullptr) {
    _captureErrorCount++;
    return result;
  }

  // 동시 capture는 하나만 허용한다(§10.3). 기다리다 실패하면 busy로 구분해
  // HTTP 계층이 409를 돌려줄 수 있게 한다.
  if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) {
    _captureBusyCount++;
    _lastAttemptWasBusy = true;
    return result;
  }

  if (!setProfileLocked(desired)) {
    ++_captureErrorCount;
    xSemaphoreGive(_mutex);
    return result;
  }
  while (_discardFrames > 0) {
    camera_fb_t* warm = esp_camera_fb_get();
    if (warm == nullptr) {
      _lastError = "profile_warmup_failed"; ++_captureErrorCount;
      xSemaphoreGive(_mutex); return result;
    }
    esp_camera_fb_return(warm);
    --_discardFrames;
  }
  camera_fb_t* fb = esp_camera_fb_get();
  if (fb == nullptr) {
    _captureErrorCount++;
    xSemaphoreGive(_mutex);
    return result;
  }

  const auto spec = cameraProfileSpec(_profile);
  if (fb->width != spec.width || fb->height != spec.height) {
    esp_camera_fb_return(fb);
    _lastError = "profile_size_mismatch"; ++_captureErrorCount;
    xSemaphoreGive(_mutex); return result;
  }
  _frameWidth = fb->width; _frameHeight = fb->height;
  _lastError = "";

  // framebuffer·획득시각·frameSeq를 같은 임계구역에서 하나로 묶는다.
  // frameSeq는 새 JPEG 획득에 성공했을 때만 증가한다(§9.3).
  const uint64_t captureUptimeUs = esp_timer_get_time();
  _frameSeq++;
  _captureOkCount++;
  _lastCaptureUptimeUs = captureUptimeUs;

  result.fb = fb;
  result.captureUptimeUs = captureUptimeUs;
  result.frameSeq = _frameSeq;
  result.ok = true;

  // mutex는 release()까지 잡고 있는다 — framebuffer를 반환하기 전에 다른
  // 요청이 esp_camera_fb_get()을 호출하면 같은 버퍼를 경쟁하게 된다.
  return result;
}

void CameraService::release(CaptureResult& result) {
  if (result.fb != nullptr) {
    esp_camera_fb_return(result.fb);
    result.fb = nullptr;
  }
  if (result.ok && _mutex != nullptr) {
    xSemaphoreGive(_mutex);
    result.ok = false;
  }
}
