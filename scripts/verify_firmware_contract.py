"""펌웨어 소스가 하드웨어 설계 보고서 §9~§10의 계약을 지키는지 검사한다.

실기기가 없어도 확인할 수 있는 것을 자동으로 잡는다: 응답 헤더 이름, 상태 코드,
보안 규칙(와일드카드 CORS 금지·토큰 필수), 안전 규칙(획득 실패 시 캐시 재전송
금지), 비밀정보 커밋 금지.

컴파일 통과는 "문법이 맞다"만 말하고, 이 검사는 "약속한 계약을 지킨다"를 말한다.
둘 다 실기기 동작을 증명하지는 않는다.

실행: python scripts/verify_firmware_contract.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FW = ROOT / "firmware" / "clipsense_cam"
sys.path.insert(0, str(ROOT))

# 헤더·경로 문자열은 앱 계약의 Python 미러(clip_snapshot.py)에서 가져온다 — 골든
# app/test/fixtures/clip_freshness_cases.json 이 그 상수를 clip_contract.dart 와 묶으므로
# 펌웨어 ↔ Python ↔ 골든 ↔ Dart 사슬이 닫힌다. 여기 복사본을 두면 세 벌이 되어 한쪽만
# 바뀌어도 검사가 통과한다.
from clip_snapshot import (  # noqa: E402
    CLIP_TOKEN_HEADER, CLIP_FRAME_SEQ_HEADER, CLIP_CAPTURE_UPTIME_HEADER,
    CLIP_RESPONSE_UPTIME_HEADER, CLIP_BOOT_ID_HEADER, CLIP_FIRMWARE_VERSION_HEADER,
    CLIP_CAMERA_SENSOR_HEADER, CLIP_CAPTURE_PATH, CLIP_HEALTH_PATH,
)

FRAME_HEADERS = [
    CLIP_FRAME_SEQ_HEADER,
    CLIP_CAPTURE_UPTIME_HEADER,
    CLIP_RESPONSE_UPTIME_HEADER,
    CLIP_BOOT_ID_HEADER,
    CLIP_FIRMWARE_VERSION_HEADER,
    CLIP_CAMERA_SENSOR_HEADER,
]

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def read(name: str) -> str:
    path = FW / name
    if not path.exists():
        FAILURES.append(f"파일 없음: {name}")
        return ""
    return path.read_text(encoding="utf-8")


def main() -> None:
    ino = read("clipsense_cam.ino")
    config = read("config.h")
    camera = read("camera_service.cpp")
    http = read("http_api.cpp")
    net = read("clip_network.cpp")
    secrets_example = read("secrets.example.h")

    print("=== 파일 구성 ===")
    for name in [
        "clipsense_cam.ino",
        "config.h",
        "secrets.example.h",
        "camera_service.h",
        "camera_service.cpp",
        "clip_network.h",
        "clip_network.cpp",
        "http_api.h",
        "http_api.cpp",
    ]:
        check(f"{name} 존재", (FW / name).exists())

    print("\n=== §10.1 엔드포인트 ===")
    for path in [CLIP_HEALTH_PATH, CLIP_CAPTURE_PATH, "/jpg"]:
        check(f"{path} 등록", f'"{path}"' in http)
    check(
        "/capture와 /jpg가 같은 핸들러",
        http.count("handleCapture(); });") >= 2,
        "별칭이 서로 다른 구현을 쓰면 계약이 갈린다",
    )
    check(
        "MJPEG /stream 미제공(프레임버퍼 경쟁 방지)",
        "/stream" not in http,
    )

    print("\n=== §10.1 보안 ===")
    check(f"토큰 헤더 이름이 {CLIP_TOKEN_HEADER}", f'CLIP_TOKEN_HEADER "{CLIP_TOKEN_HEADER}"' in config)
    check("모든 데이터 엔드포인트가 authorize() 통과", http.count("if (!authorize()) return;") >= 2)
    check(
        "CORS 와일드카드 미사용",
        '"Access-Control-Allow-Origin", "*"' not in http and "'*'" not in http,
    )
    check("허용 origin이 상수로 고정", "CLIP_CORS_ORIGIN" in config and "localhost:5173" in config)
    check("토큰 비교가 상수 시간", "constantTimeEquals" in http)
    check("조준 페이지 기본 비활성", "CLIP_ENABLE_INSPECT_PAGE 0" in config)
    check("/health가 SSID·비밀번호를 반환하지 않음",
          "CLIP_WIFI_SSID" not in http and "CLIP_WIFI_PASSWORD" not in http and
          "CLIP_AP_PASSWORD" not in http)

    print("\n=== §10.3 프레임 계약 ===")
    for header in FRAME_HEADERS:
        check(f"{header} 응답 헤더", f'"{header}"' in http)
    check(
        "Expose-Headers에 6개 모두 노출",
        all(h in http.split("Access-Control-Expose-Headers")[1][:400]
            for h in FRAME_HEADERS)
        if "Access-Control-Expose-Headers" in http else False,
    )
    check("획득 실패 → 503", '503, "application/json"' in http)
    check("점유 중 → 409", '409, "application/json"' in http)
    check(
        "실패 시 캐시된 JPEG 재전송 없음",
        "lastFrame" not in http and "cachedFrame" not in camera,
    )
    check("Cache-Control no-store", "no-store" in http)

    print("\n=== §10.3 원자성 ===")
    check("카메라 mutex 사용", "xSemaphoreCreateMutex" in camera and "xSemaphoreTake" in camera)
    # _frameSeq++ 는 mutex 획득 뒤에 있어야 하고, 그 사이에 mutex를 놓아서는 안 된다.
    # (조기 반환 경로가 여럿이라 단순한 첫 번째 return 위치로 비교하면 오판한다.)
    take_at = camera.index("xSemaphoreTake")
    seq_at = camera.index("_frameSeq++")
    between = camera[take_at:seq_at]
    check(
        "frameSeq 증가가 mutex 획득 뒤",
        take_at < seq_at,
    )
    check(
        "frameSeq 증가 전에 mutex를 놓지 않음",
        "xSemaphoreGive" not in between.split("if (fb == nullptr)")[0],
        "획득 실패 경로 외에서 mutex를 놓으면 원자성이 깨진다",
    )
    check(
        "capture 성공에만 frameSeq 증가",
        camera.count("_frameSeq++") == 1
        and "_frameSeq++" in camera.split("if (fb == nullptr)")[1],
    )
    check("framebuffer 반환 후 포인터 무효화", "result.fb = nullptr;" in camera)

    print("\n=== §9.2 카메라 프로필 ===")
    check("PIXFORMAT_JPEG", "PIXFORMAT_JPEG" in camera)
    check("FRAMESIZE_QVGA 기본", "CLIP_FRAME_SIZE FRAMESIZE_QVGA" in config)
    check("jpeg_quality 12", "CLIP_JPEG_QUALITY 12" in config)
    check("PSRAM 없음: QVGA 폴백", "cfg.frame_size = FRAMESIZE_QVGA" in camera)
    check("fb_count 2", "CLIP_FB_COUNT 2" in config)
    check("CAMERA_GRAB_LATEST", "CAMERA_GRAB_LATEST" in camera)
    check("fb_location PSRAM", "CAMERA_FB_IN_PSRAM" in camera)
    check("WiFi.setSleep(false)", "setSleep(false)" in net)

    print("\n=== §9.3 부팅 로그 ===")
    for field in [
        "firmwareVersion",
        "buildTimestamp",
        "deviceId",
        "bootId",
        "resetReason",
        "cameraSensorPid",
        "psramBytes",
        "heapBytes",
        "networkMode",
        "resolution",
        "jpegQuality",
    ]:
        check(f"부팅 로그에 {field}", field in ino)
    check("bootId가 재부팅마다 바뀜(esp_random)", "esp_random()" in ino)
    # RF 초기화 전 esp_random()은 엔트로피가 약할 수 있어 재부팅 감지가 깨진다.
    # MAC·RTC 부팅 카운터를 함께 섞는지 본다(2026-09-07).
    check("bootId에 eFuse MAC을 섞음", "esp_efuse_mac_get_default(" in ino)
    check("bootId에 RTC 부팅 카운터를 섞음", "RTC_NOINIT_ATTR" in ino and "rtcBootCounter" in ino)
    check("부팅 로그에 bootCounter", "bootCounter" in ino)

    print("\n=== §9.4 네트워크 상태기계 ===")
    for state in ["StaConnecting", "StaActive", "StaReconnecting", "ApRecovery"]:
        check(f"{state} 상태 존재", state in net)
    check("STA 연결 제한시간 후 AP 복구", "CLIP_STA_CONNECT_TIMEOUT_MS" in net)
    check("재시도 한도 후 AP 복구", "CLIP_STA_RETRY_LIMIT" in net)
    check("AP SSID가 ClipSense-<MAC뒤4자리>", 'ClipSense-" + suffix' in net)
    check("AP에서 STA 자동 재시도 안 함(조용한 모드 전환 방지)",
          "case NetState::ApRecovery:" in net and
          "enterStaConnecting();" not in net.split("case NetState::ApRecovery:")[1][:300])
    check("mDNS 시도", "MDNS.begin" in net)

    print("\n=== 비밀정보 ===")
    check("secrets.example.h만 있고 실제 값 없음",
          "your-2g4-ssid" in secrets_example and "replace-with" in secrets_example)
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    check("secrets.h가 gitignore", "firmware/clipsense_cam/secrets.h" in gitignore)
    # 소스에 하드코딩된 자격정보가 없는지
    combined = ino + config + camera + http + net
    check(
        "소스에 하드코딩된 비밀정보 없음",
        not re.search(r'(password|token)\s*=\s*"[A-Za-z0-9]{8,}"', combined, re.I),
    )

    print("\n=== LED 표시 ===")
    check("촬영 시 LED 점등", "clipSignalCaptureLed" in http and "clipSignalCaptureLed" in ino)

    print("=" * 56)
    if FAILURES:
        print(f"FAIL {len(FAILURES)}건: {FAILURES}")
        sys.exit(1)
    print("펌웨어 계약 검사 전부 PASS")


if __name__ == "__main__":
    main()
