// 카메라 획득을 한 곳으로 모으고, JPEG과 메타데이터를 원자적으로 묶는다.
//
// 보고서 §10.3의 요구사항이 여기 있다:
//   "JPEG와 메타데이터의 결합은 카메라 mutex 안에서 원자적으로 수행한다.
//    esp_camera_fb_get()이 반환한 framebuffer, 그 순간의 captureUptimeUs,
//    증가시킨 frameSeq를 하나의 응답 객체에 묶고, 다른 요청이 그 사이 값을
//    바꾸지 못하게 한다."
//
// 동시 capture는 하나만 허용한다. 획득에 실패하면 마지막 JPEG을 재전송하지
// 않는다 — 오래된 프레임을 새 프레임처럼 보내면 판정이 정지(freeze)를
// 알아채지 못하기 때문이다.
#pragma once

#include <esp_camera.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "config.h"
#include "camera_profiles.h"

// 한 번의 획득 결과. fb가 non-null이면 반드시 release()로 반환해야 한다.
struct CaptureResult {
  camera_fb_t* fb = nullptr;
  uint64_t captureUptimeUs = 0;  // 획득 직후의 esp_timer_get_time()
  uint32_t frameSeq = 0;         // 획득 성공 시에만 증가한 값
  bool ok = false;
};

class CameraService {
 public:
  // 카메라를 초기화한다. 실패하면 false를 돌려주고 _lastError에 이유를 남긴다.
  bool begin();

  // 한 프레임을 획득한다. 다른 요청이 이미 카메라를 쓰고 있으면 busy로 실패.
  // timeoutMs 동안 mutex를 기다린다.
  CaptureResult capture(uint32_t timeoutMs = 1500, CameraProfile desired = CameraProfile::Current);

  // capture()가 돌려준 framebuffer를 반환한다. 반환 뒤 포인터를 재사용하지 않는다.
  void release(CaptureResult& result);

  // ── 진단(/health) ──
  const char* profileName() const { return cameraProfileSpec(_profile).name; }
  int jpegQuality() const { return cameraProfileSpec(_profile).jpegQuality; }
  bool supportsVga() const { return _supportsVga; }
  bool cameraOk() const { return _cameraOk; }
  const char* sensorName() const { return _sensorName; }
  uint32_t frameSeq() const { return _frameSeq; }
  uint32_t captureOkCount() const { return _captureOkCount; }
  uint32_t captureErrorCount() const { return _captureErrorCount; }
  uint32_t captureBusyCount() const { return _captureBusyCount; }
  uint64_t lastCaptureUptimeUs() const { return _lastCaptureUptimeUs; }
  const char* lastError() const { return _lastError; }
  int frameWidth() const { return _frameWidth; }
  int frameHeight() const { return _frameHeight; }

  // 마지막 획득이 busy로 거절됐는지 — HTTP 계층이 503과 409를 구분하는 데 쓴다.
  bool lastAttemptWasBusy() const { return _lastAttemptWasBusy; }

 private:
  bool setProfileLocked(CameraProfile desired);
  CameraProfile _profile = CameraProfile::Stable;
  bool _supportsVga = false;
  unsigned _discardFrames = 0;
  SemaphoreHandle_t _mutex = nullptr;
  bool _cameraOk = false;
  const char* _sensorName = "unknown";
  const char* _lastError = "";
  uint32_t _frameSeq = 0;
  uint32_t _captureOkCount = 0;
  uint32_t _captureErrorCount = 0;
  uint32_t _captureBusyCount = 0;
  uint64_t _lastCaptureUptimeUs = 0;
  int _frameWidth = 0;
  int _frameHeight = 0;
  bool _lastAttemptWasBusy = false;
};
