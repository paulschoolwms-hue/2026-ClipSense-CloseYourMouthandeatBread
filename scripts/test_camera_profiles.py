"""실제 CameraService를 가짜 센서/뮤텍스와 호스트 컴파일. ESP32 실기기 검증은 별도."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
compiler = shutil.which('g++') or shutil.which('clang++')
if not compiler:
    raise SystemExit('C++ 컴파일러 필요')
with tempfile.TemporaryDirectory(prefix='clipsense-profiles-') as folder:
    p = Path(folder)
    (p / 'freertos').mkdir()
    (p / 'freertos/FreeRTOS.h').write_text('#pragma once\n#define pdTRUE 1\n#define pdMS_TO_TICKS(x) (x)\n')
    (p / 'freertos/semphr.h').write_text('''#pragma once
using SemaphoreHandle_t = void*;
extern bool locked;
inline void* xSemaphoreCreateMutex() { return (void*)1; }
inline int xSemaphoreTake(void*, unsigned) { if (locked) return 0; locked=true; return 1; }
inline void xSemaphoreGive(void*) { locked=false; }
''')
    (p / 'Arduino.h').write_text('#pragma once\nbool psramFound();\n')
    (p / 'esp_timer.h').write_text('#pragma once\n#include <stdint.h>\ninline int64_t esp_timer_get_time() { static int64_t t=0; return ++t; }\n')
    (p / 'esp_camera.h').write_text('''#pragma once
#include <stdint.h>
#include <stddef.h>
using esp_err_t=int;
constexpr int ESP_OK=0, OV2640_PID=1, OV3660_PID=2, OV5640_PID=3, OV7725_PID=4;
enum framesize_t { FRAMESIZE_QVGA, FRAMESIZE_VGA };
constexpr int LEDC_CHANNEL_0=0, LEDC_TIMER_0=0, PIXFORMAT_JPEG=0, CAMERA_GRAB_LATEST=0, CAMERA_FB_IN_PSRAM=0, CAMERA_FB_IN_DRAM=1;
struct camera_config_t {
int ledc_channel,ledc_timer,pin_d0,pin_d1,pin_d2,pin_d3,pin_d4,pin_d5,pin_d6,pin_d7;
int pin_xclk,pin_pclk,pin_vsync,pin_href,pin_sccb_sda,pin_sccb_scl,pin_pwdn,pin_reset,xclk_freq_hz;
int pixel_format,jpeg_quality,fb_count,grab_mode,fb_location;
framesize_t frame_size;
};
struct camera_fb_t { uint8_t* buf; size_t len; int width,height; };
struct sensor_t {
struct { uint16_t PID; } id;
int (*set_framesize)(sensor_t*,framesize_t);
int (*set_quality)(sensor_t*,int);
int (*set_vflip)(sensor_t*,int);
int (*set_brightness)(sensor_t*,int);
int (*set_saturation)(sensor_t*,int);
};
int esp_camera_init(camera_config_t*);
sensor_t* esp_camera_sensor_get();
camera_fb_t* esp_camera_fb_get();
void esp_camera_fb_return(camera_fb_t*);
''')
    (p / 'test.cpp').write_text('''#include <assert.h>
#include <string.h>
#include "camera_service.h"
bool locked=false, psram=true, failFrame=false, failQuality=false, wrongSize=false;
int width=320,height=240,quality=12,gets=0,returns=0;
bool psramFound() { return psram; }
int setSize(sensor_t*,framesize_t s) { width=s==FRAMESIZE_VGA?640:320; height=s==FRAMESIZE_VGA?480:240; return 0; }
int setQuality(sensor_t*,int q) { if(failQuality) { failQuality=false; return -1; } quality=q; return 0; }
int noop(sensor_t*,int) { return 0; }
sensor_t sensor={{OV3660_PID},setSize,setQuality,noop,noop,noop};
int esp_camera_init(camera_config_t* cfg) { assert(cfg->frame_size==(psram?FRAMESIZE_VGA:FRAMESIZE_QVGA)); return 0; }
sensor_t* esp_camera_sensor_get() { return &sensor; }
camera_fb_t* esp_camera_fb_get() { ++gets; if(failFrame) return nullptr; static camera_fb_t fb={}; fb.width=wrongSize?1:width; fb.height=height; return &fb; }
void esp_camera_fb_return(camera_fb_t*) { ++returns; }
int main() {
CameraProfile profile=CameraProfile::Stable;
assert(!parseCameraProfile("typo",profile)); assert(profile==CameraProfile::Stable);
assert(parseCameraProfile("detail",profile)); assert(cameraProfileSpec(profile).jpegQuality==12);
CameraService camera; assert(camera.begin()); assert(width==320 && !locked);
auto first=camera.capture(); assert(first.ok && locked && first.frameSeq==1);
auto busy=camera.capture(); assert(!busy.ok && camera.lastAttemptWasBusy());
camera.release(first); assert(!locked && first.fb==nullptr); camera.release(first);
int before=gets;
auto balanced=camera.capture(0,CameraProfile::Balanced);
assert(balanced.ok && balanced.fb->width==640 && quality==18 && gets-before==3 && locked);
camera.release(balanced);
failQuality=true;
auto failed=camera.capture(0,CameraProfile::Detail);
assert(!failed.ok && !locked && quality==18 && strcmp(camera.profileName(),"balanced")==0 && camera.frameSeq()==2);
auto restored=camera.capture(); assert(restored.ok && restored.frameSeq==3); camera.release(restored);
failFrame=true; auto noFrame=camera.capture(); assert(!noFrame.ok && !locked && camera.frameSeq()==3); failFrame=false;
wrongSize=true; auto wrong=camera.capture(); assert(!wrong.ok && !locked && camera.frameSeq()==3); wrongSize=false;
auto stable=camera.capture(0,CameraProfile::Stable); assert(stable.ok && stable.fb->width==320 && quality==12); camera.release(stable);
psram=false; CameraService small; assert(small.begin() && !small.supportsVga());
auto denied=small.capture(0,CameraProfile::Detail); assert(!denied.ok && !locked && small.frameSeq()==0);
auto good=small.capture(); assert(good.ok && locked); small.release(good);
assert(!locked && gets>returns); // failed gets do not return a framebuffer
}
''')
    exe = p / 'test'
    subprocess.run([compiler, '-std=c++11', '-Wall', '-Wextra', '-Werror', '-I'+str(p),
        '-I'+str(root/'firmware/clipsense_cam'), str(p/'test.cpp'),
        str(root/'firmware/clipsense_cam/camera_service.cpp'), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
print('PASS: 실제 camera_service.cpp의 화질 전환/예열, 실패 복구, PSRAM 제한, mutex/seq 보존 (가짜 센서)')
