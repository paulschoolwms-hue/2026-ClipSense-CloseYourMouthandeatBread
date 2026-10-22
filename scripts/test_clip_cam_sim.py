"""클립 카메라 시뮬레이터·계약 검사기 단위 테스트. 실행: python scripts/test_clip_cam_sim.py

시뮬레이터를 포트 0 으로 같은 프로세스 안에 띄우고 검사기 함수를 돌린 뒤, 장애 모드마다 관측 가능한
동작을 확인한다. uptime·재부팅은 가짜 시계로, stall 만 실시계로(하한만 검사).

여기서 PASS 는 "시뮬레이터가 펌웨어 소스와 같은 계약을 낸다"까지다. 보드 동작은 증명하지 않는다.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import check_clip_cam_contract as checker  # noqa: E402
import clip_cam_sim as sim  # noqa: E402

HTTP_API = ROOT / "firmware" / "clipsense_cam" / "http_api.cpp"
TOKEN = "sim-test-token"
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


class FakeClock:
    """단조 ns 시계 흉내. 호출 가능 객체로 CameraSim 에 주입해 uptime 을 결정적으로 만든다."""

    def __init__(self, start_ns: int = 5_000_000_000) -> None:
        self.ns = start_ns

    def __call__(self) -> int:
        return self.ns

    def advance_ms(self, ms: int) -> None:
        self.ns += ms * 1_000_000


def default_camera(**kw) -> sim.CameraSim:
    return sim.CameraSim(sim.FrameSource(sim.load_jpeg_frames(sim.DEFAULT_FRAMES)), **kw)


def start_sim(camera: sim.CameraSim | None = None, token: str = TOKEN, **kw):
    """포트 0 으로 띄우고 (서버, base_url) 을 돌려준다. 호출자가 finally 로 stop() 한다."""
    if camera is None:
        camera = default_camera()
    server = sim.ClipCamSim(camera, token, quiet=kw.pop("quiet", True), **kw)
    server.start()
    return server, server.base_url


def get(base: str, path: str, token: str | None = TOKEN, extra: dict | None = None,
        timeout_s: float = 3.0) -> checker.HttpReply:
    headers = dict(extra or {})
    if token is not None:
        headers[sim.TOKEN_HEADER] = token
    return checker.fetch(base, "GET", path, headers=headers, timeout_s=timeout_s)


def capture(base: str, token: str = TOKEN, path: str = "/capture"):
    reply = get(base, path, token)
    return reply, checker.parse_capture_headers(reply.headers)


def set_fault(base: str, mode: str, hold_ms: int | None = None) -> checker.HttpReply:
    body: dict = {"mode": mode}
    if hold_ms is not None:
        body["hold_ms"] = hold_ms
    return checker.fetch(base, "POST", "/__sim/fault", body=json.dumps(body).encode())


def health(base: str, token: str = TOKEN) -> dict:
    reply = get(base, "/health", token)
    assert reply.status == 200, reply.status
    return json.loads(reply.body)


def state(base: str) -> dict:
    return json.loads(checker.fetch(base, "GET", "/__sim/state").body)


def wait_until(cond, timeout_s: float = 3.0) -> bool:
    """고정 sleep 대신 조건이 참이 될 때까지 짧게 폴링한다(전체 스위트 부하에서의 flake 방지)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.005)
    return cond()


# ── 계약 검사기 ────────────────────────────────────────────────────────────


def test_contract_all_pass() -> None:
    server, base = start_sim()
    try:
        results = checker.run_checks(base, TOKEN)
        failed = [r.name + (f" ({r.detail})" if r.detail else "") for r in results if not r.ok]
        check("계약 검사 전부 PASS(시뮬레이터, 실시계)", not failed, "; ".join(failed))
        check("계약 검사 항목 수 24", len(results) == 24, str(len(results)))
        check("검사기 대상 감지 == SIM", checker.detect_target(base) == "SIM")
    finally:
        server.stop()
    # 정당한 펌웨어 키 rssiDbm 이 'ssid' 부분 문자열에 걸리면 보드에서도 오탐한다.
    check(
        "비밀 키 판별: rssiDbm 은 통과, wifiSsid·apPassword·ssid 는 잡힌다",
        not checker._looks_like_secret_key("rssiDbm")
        and all(checker._looks_like_secret_key(k) for k in ("wifiSsid", "apPassword", "ssid", "wifi_password")),
    )


def test_checker_not_vacuous() -> None:
    server, base = start_sim()
    try:
        set_fault(base, "drop_headers")
        results = {r.name: r for r in checker.run_checks(base, TOKEN)}
        check(
            "검사기는 계약 위반을 잡는다(drop_headers)",
            not results["/capture 헤더 6개 존재"].ok and any(not r.ok for r in results.values()),
        )
        set_fault(base, "freeze")
        results = {r.name: r for r in checker.run_checks(base, TOKEN)}
        check(
            "검사기는 정지를 잡는다(freeze)",
            not results["연속 두 capture: frameSeq 엄격 증가"].ok
            and not results["연속 두 capture: captureUptime 엄격 증가"].ok,
        )
    finally:
        server.stop()


# ── 펌웨어 소스와의 일치 ───────────────────────────────────────────────────


def test_matches_firmware_source() -> None:
    text = HTTP_API.read_text(encoding="utf-8")
    # handleHealth 본문 안의 \"key\": 만 본다 — 오류 본문의 \"error\": 가 섞이지 않게.
    body = text.split("void HttpApi::handleHealth()")[1].split("void HttpApi::handleCapture()")[0]
    # lastTransfer는 중첩된 선택 진단이며 v1 필수 키에 포함하지 않는다.
    top_level = body.split('lastTransfer')[0]
    fw_keys = re.findall(r'\\"(\w+)\\":', top_level)
    fw_keys = [k for k in fw_keys if k not in ('cameraProfile', 'supportsVga')]
    camera = default_camera()
    sim_keys = list(camera.health().keys())
    check(
        "펌웨어 /health 키 집합과 동일(26개, 같은 순서)",
        fw_keys == sim_keys and len(fw_keys) == 26,
        f"fw={fw_keys} sim={sim_keys}",
    )
    check("검사기 HEALTH_FIELDS 도 같은 26개", list(checker.HEALTH_FIELDS) == fw_keys)

    for name, const in [
        ("missing_device_token", sim.BODY_MISSING_TOKEN),
        ("invalid_device_token", sim.BODY_INVALID_TOKEN),
        ("capture_busy", sim.BODY_BUSY),
        ("capture_failed", sim.BODY_FAILED),
        ("inspect_page_disabled", sim.BODY_INSPECT_DISABLED),
        ("not_found", sim.BODY_NOT_FOUND),
    ]:
        escaped = '\\"error\\":\\"' + name + '\\"'
        check(
            f"오류 본문 {name} 이 펌웨어 소스와 동일",
            escaped in text and const == ('{"error":"' + name + '"}').encode(),
        )

    expose_src = text.split("Access-Control-Expose-Headers")[1][:400]
    positions = [expose_src.find(h) for h in sim.EXPOSE_HEADERS]
    check(
        "Expose-Headers 가 펌웨어와 같은 6개·같은 순서(소스)",
        all(p >= 0 for p in positions) and positions == sorted(positions),
    )
    check("계약 경로에 /__sim 이 없다(펌웨어 소스)", "/__sim" not in text)

    server, base = start_sim()
    try:
        reply = get(base, "/capture", extra={"Origin": "http://localhost:5173"})
        got = reply.headers.get("access-control-expose-headers", "").split(", ")
        check("Expose-Headers 가 펌웨어와 같은 6개·같은 순서(응답)", got == list(sim.EXPOSE_HEADERS), str(got))
        check("허용 origin 에코", reply.headers.get("access-control-allow-origin") == "http://localhost:5173")
        check("Vary: Origin", reply.headers.get("vary") == "Origin")
    finally:
        server.stop()


# ── 인증 ───────────────────────────────────────────────────────────────────


def test_auth() -> None:
    server, base = start_sim()
    try:
        r = get(base, "/capture", token="")
        # ESP32 코어 3.3.1 WebServer::hasHeader 는 header(name).length() > 0 이라
        # 빈 값은 "없음"이다(라이브러리 소스 기준, 실기기 미검증).
        check("빈 토큰 헤더는 401 missing_device_token", r.status == 401 and r.body == sim.BODY_MISSING_TOKEN,
              f"{r.status} {r.body!r}")
        r = checker.fetch(base, "GET", "/capture", headers={"x-clip-device-token": TOKEN})
        check("토큰 헤더 이름 대소문자 무시", r.status == 200, str(r.status))
        r = get(base, "/health", token=None)
        check("/health 도 토큰 필수", r.status == 401 and r.body == sim.BODY_MISSING_TOKEN)
        r = get(base, "/health", token=TOKEN + "x")
        check("/health 토큰 불일치 403", r.status == 403 and r.body == sim.BODY_INVALID_TOKEN)
        check("401 응답에 X-Frame-Seq 없음", "x-frame-seq" not in get(base, "/capture", token=None).headers)
    finally:
        server.stop()


# ── 장애 모드 ──────────────────────────────────────────────────────────────


def test_freeze() -> None:
    clock = FakeClock()
    server, base = start_sim(default_camera(mono_ns=clock))
    try:
        ra, a = capture(base)
        set_fault(base, "freeze")
        h1 = health(base)
        clock.advance_ms(100)
        rb, b = capture(base)
        clock.advance_ms(100)
        rc, c = capture(base)
        h2 = health(base)
        check(
            "freeze: frameSeq·captureUptime 그대로, responseUptime 은 증가",
            a and b and c
            and b["frame_seq"] == a["frame_seq"] == c["frame_seq"]
            and b["capture_uptime_us"] == a["capture_uptime_us"]
            and c["response_uptime_us"] > b["response_uptime_us"] > b["capture_uptime_us"]
            and rb.body == ra.body == rc.body,
            f"a={a} b={b} c={c}",
        )
        check(
            "freeze 중 /health frameSeq·captureOkCount 불변",
            h1["frameSeq"] == h2["frameSeq"] == a["frame_seq"] and h1["captureOkCount"] == h2["captureOkCount"],
        )
        set_fault(base, "none")
        clock.advance_ms(100)
        _, d = capture(base)
        check(
            "freeze 해제 후 첫 프레임은 새 frameSeq",
            d and d["frame_seq"] == a["frame_seq"] + 1 and d["capture_uptime_us"] > a["capture_uptime_us"],
        )
    finally:
        server.stop()

    camera = default_camera()
    camera.set_fault("freeze")
    first = camera.capture()
    second = camera.capture()
    check(
        "freeze 가 첫 획득 전에 켜져도 한 장은 준다",
        first.kind == "ok" and first.shot.frame_seq == 1 and second.kind == "ok" and second.shot is first.shot,
    )


def test_capture_failed_and_busy() -> None:
    server, base = start_sim()
    try:
        capture(base)
        before = health(base)
        set_fault(base, "capture_failed")
        r = get(base, "/capture")
        after = health(base)
        check(
            "capture_failed: 503 본문·frameSeq 불변·captureErrorCount 증가",
            r.status == 503
            and r.body == sim.BODY_FAILED
            and r.headers.get("content-type", "").startswith("application/json")
            and "no-store" in r.headers.get("cache-control", "")
            and "x-frame-seq" not in r.headers
            and after["frameSeq"] == before["frameSeq"]
            and after["captureErrorCount"] == before["captureErrorCount"] + 1,
            f"{r.status} {r.body!r} {after}",
        )
        set_fault(base, "busy")
        r = get(base, "/capture")
        after2 = health(base)
        check(
            "busy: 409 본문·frameSeq 불변·captureBusyCount 증가",
            r.status == 409
            and r.body == sim.BODY_BUSY
            and "x-frame-seq" not in r.headers
            and after2["frameSeq"] == before["frameSeq"]
            and after2["captureBusyCount"] == before["captureBusyCount"] + 1,
            f"{r.status} {r.body!r} {after2}",
        )
    finally:
        server.stop()


def test_reboot() -> None:
    clock = FakeClock()
    server, base = start_sim(default_camera(mono_ns=clock))
    try:
        clock.advance_ms(30_000)
        capture(base)
        _, p = capture(base)
        r = set_fault(base, "reboot")
        st = json.loads(r.body)
        _, q = capture(base)
        h = health(base)
        check(
            "reboot: bootId 바뀜·uptime 작아짐·frameSeq 1부터·1회성",
            r.status == 200
            and st["fault"]["mode"] == "none"
            and p and q
            and q["boot_id"] != p["boot_id"]
            and re.fullmatch(r"[0-9a-f]{8}", q["boot_id"]) is not None
            and q["capture_uptime_us"] < p["capture_uptime_us"]
            and q["frame_seq"] == 1
            and h["resetReason"] == "SW_RESET"
            and h["bootId"] == q["boot_id"]
            and h["captureOkCount"] == 1,
            f"p={p} q={q} state={st} health={h}",
        )
    finally:
        server.stop()


def test_capture_uptime_strictly_increases_with_stalled_clock() -> None:
    camera = default_camera(mono_ns=FakeClock())
    a = camera.capture().shot
    b = camera.capture().shot
    check(
        "captureUptime 은 시계가 멈춰도 엄격 증가",
        b.capture_uptime_us == a.capture_uptime_us + 1 and b.frame_seq == a.frame_seq + 1,
    )


def test_stall() -> None:
    server, base = start_sim()
    try:
        set_fault(base, "stall", hold_ms=300)
        t0 = time.monotonic()
        r, parsed = capture(base)
        elapsed = time.monotonic() - t0
        check(
            "stall: 응답이 hold_ms 이상 걸린다(서버 age 도 hold 를 반영)",
            r.status == 200 and parsed is not None and elapsed >= 0.3
            and parsed["response_uptime_us"] - parsed["capture_uptime_us"] >= 300_000,
            f"status={r.status} elapsed={elapsed:.3f} parsed={parsed}",
        )

        # 획득은 sleep 앞에서 일어나므로 captureOkCount 증가 = 핸들러가 stall 안에 있다는 뜻.
        set_fault(base, "stall", hold_ms=500)
        ok_before = state(base)["captureOkCount"]
        worker = threading.Thread(target=lambda: get(base, "/capture", timeout_s=3.0), daemon=True)
        worker.start()
        entered = wait_until(lambda: state(base)["captureOkCount"] == ok_before + 1)
        t0 = time.monotonic()
        h = get(base, "/health", timeout_s=1.0)
        elapsed = time.monotonic() - t0
        worker.join(3.0)
        check(
            "stall: 다른 연결(/health)은 막히지 않는다",
            entered and h.status == 200 and elapsed < 0.4,
            f"entered={entered} status={h.status} elapsed={elapsed:.3f}",
        )

        set_fault(base, "stall", hold_ms=400)
        raised = False
        try:
            get(base, "/capture", timeout_s=0.1)
        except OSError:
            raised = True
        set_fault(base, "none")
        h = get(base, "/health")
        c, parsed = capture(base)
        check(
            "stall: 클라이언트가 먼저 끊어도 서버는 살아 있다",
            raised and h.status == 200 and c.status == 200 and parsed is not None,
        )
    finally:
        server.stop()


def test_drop_headers_and_wrong_content_type() -> None:
    server, base = start_sim()
    try:
        set_fault(base, "drop_headers")
        r = get(base, "/capture")
        others = [h.lower() for h in sim.EXPOSE_HEADERS if h != "X-Frame-Seq"]
        check(
            "drop_headers: X-Frame-Seq 만 없고 나머지 5개는 있다",
            r.status == 200
            and r.headers.get("content-type") == "image/jpeg"
            and "x-frame-seq" not in r.headers
            and all(h in r.headers for h in others)
            and checker.parse_capture_headers(r.headers) is None,
            str(sorted(r.headers)),
        )
        before = health(base)
        set_fault(base, "wrong_content_type")
        r = get(base, "/capture")
        after = health(base)
        check(
            "wrong_content_type: 200 이지만 image/jpeg 가 아니고 frameSeq 는 증가하지 않는다",
            r.status == 200
            and r.headers.get("content-type", "").split(";")[0].strip() == "text/html"
            and after["frameSeq"] == before["frameSeq"],
            f"{r.status} {r.headers.get('content-type')} {before['frameSeq']}→{after['frameSeq']}",
        )
    finally:
        server.stop()


# ── 제어 엔드포인트 ────────────────────────────────────────────────────────


def test_control_endpoint() -> None:
    server, base = start_sim()
    try:
        r = set_fault(base, "explode")
        body = json.loads(r.body)
        r2 = checker.fetch(base, "POST", "/__sim/fault", body=b"{not json")
        check(
            "알 수 없는 fault → 400 unknown_fault_mode, 깨진 본문 → 400 bad_json, 모드 불변",
            r.status == 400
            and body["error"] == "unknown_fault_mode"
            and body["modes"] == list(sim.FAULT_MODES)
            and r2.status == 400
            and json.loads(r2.body)["error"] == "bad_json"
            and state(base)["fault"]["mode"] == "none",
            f"{r.status} {body} {r2.status} {r2.body!r}",
        )
        r = checker.fetch(base, "GET", "/__sim/state")
        st = json.loads(r.body)
        check(
            "GET /__sim/state 는 토큰 없이 200, 계약 경로가 아니다",
            r.status == 200 and st["simulator"] is True and sim.CONTROL_PREFIX.startswith("/__sim/"),
        )
        r = checker.fetch(base, "GET", "/__sim/nope")
        check("/__sim/ 미지 경로 → 404 not_found", r.status == 404 and r.body == sim.BODY_NOT_FOUND)
    finally:
        server.stop()


def test_token_never_leaks() -> None:
    server, base = start_sim(quiet=False)
    try:
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            r = get(base, "/capture")
            get(base, "/capture", token="wrong")
            h = json.dumps(health(base))
            st = json.dumps(state(base))
        log = buf.getvalue()
        check(
            "요청 로그·/health·/__sim/state 에 토큰이 없다",
            r.status == 200
            and TOKEN not in log and "wrong" not in log
            and "GET /capture 200" in log and "GET /capture 403" in log
            and TOKEN not in h and TOKEN not in st,
            f"log={log!r}",
        )
    finally:
        server.stop()


# ── 라우팅(펌웨어 WebServer.onNotFound 와 동일) ───────────────────────────


def test_routing() -> None:
    server, base = start_sim()
    try:
        r = checker.fetch(base, "OPTIONS", "/capture", headers={"Origin": "http://evil.example"})
        check(
            "OPTIONS 비허용 origin → 403 CORS 헤더 없음",
            r.status == 403 and "access-control-allow-origin" not in r.headers and r.body == b"origin not allowed",
            f"{r.status} {r.body!r}",
        )
        r = checker.fetch(base, "OPTIONS", "/capture")
        check("OPTIONS origin 없음 → 403", r.status == 403 and "access-control-allow-origin" not in r.headers)
        r = checker.fetch(base, "OPTIONS", "/", headers={"Origin": "http://localhost:5173"})
        check("OPTIONS / → 404 not_found", r.status == 404 and r.body == sim.BODY_NOT_FOUND)
        r = checker.fetch(base, "POST", "/capture", headers={sim.TOKEN_HEADER: TOKEN})
        check("POST /capture 는 404 not_found(펌웨어는 GET 만 등록)", r.status == 404 and r.body == sim.BODY_NOT_FOUND)
        r = get(base, "/", token=None)
        check("GET / → 404 inspect_page_disabled(토큰 없이도)", r.status == 404 and r.body == sim.BODY_INSPECT_DISABLED)
        r = checker.fetch(base, "GET", "/capture?x=1", headers={sim.TOKEN_HEADER: TOKEN})
        check("쿼리 문자열은 무시(GET /capture?x=1 → 200)", r.status == 200)
    finally:
        server.stop()


# ── 프레임 소스·토큰 ───────────────────────────────────────────────────────


def test_frame_source() -> None:
    a, b = b"\xff\xd8A", b"\xff\xd8B"
    src = sim.FrameSource([a, b], hold_frames=2)
    check("hold_frames=2: 프레임 바이트가 두 번씩 순환한다", [src.next() for _ in range(5)] == [a, a, b, b, a])
    src = sim.FrameSource([a, b], hold_frames=1)
    check("hold_frames=1: 번갈아 낸다", [src.next() for _ in range(3)] == [a, b, a])
    empty_raises = False
    try:
        sim.FrameSource([])
    except ValueError:
        empty_raises = True
    check("FrameSource([]) 는 ValueError", empty_raises)

    clock = FakeClock()
    timed = sim.TimedFrameSource([a, b], fps=10.0, mono_ns=clock)
    seq = [timed.next()]
    clock.advance_ms(100)
    seq.append(timed.next())
    clock.advance_ms(100)
    seq.append(timed.next())
    check("TimedFrameSource: 경과 시간 × fps 로 고른다(반복)", seq == [a, b, a], str(seq))

    frames = sim.load_jpeg_frames(sim.DEFAULT_FRAMES)
    check(
        "기본 fixture 두 장이 로드되고 320x240 이다",
        len(frames) == 2
        and all(f[:2] == b"\xff\xd8" for f in frames)
        and all(sim.jpeg_dimensions(f) == (320, 240) for f in frames)
        and default_camera().health()["resolution"] == "320x240",
    )
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "not.jpg"
        bad.write_text("hello", encoding="utf-8")
        rejected = False
        try:
            sim.load_jpeg_frames([bad])
        except ValueError:
            rejected = True
        check("JPEG 이 아닌 파일은 거부", rejected)


def test_video_frames_if_available() -> None:
    video = ROOT / "data" / "test_countdown.mp4"
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("[SKIP] --video: cv2 없음")
        return
    if not video.exists():
        print("[SKIP] --video: data/test_countdown.mp4 없음(scripts/make_test_video.py)")
        return
    frames, fps = sim.load_video_frames(video, max_frames=12)
    check(
        "--video: 프레임이 320x240 JPEG 으로 나온다(cv2 있을 때만)",
        len(frames) == 12 and fps > 0 and all(sim.jpeg_dimensions(f) == (320, 240) for f in frames),
        f"n={len(frames)} fps={fps}",
    )


def test_resolve_token() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "device_token"
        f.write_text("file-tok\n", encoding="utf-8")
        missing = Path(tmp) / "absent"
        env = {"CLIP_DEVICE_TOKEN": "env-tok"}
        raised = False
        try:
            sim.resolve_token(None, {}, missing)
        except ValueError:
            raised = True
        check(
            "resolve_token: --token > env > 파일, 없으면 ValueError",
            sim.resolve_token("cli-tok", env, f) == ("cli-tok", "cli")
            and sim.resolve_token(None, env, f) == ("env-tok", "env")
            and sim.resolve_token(None, {}, f) == ("file-tok", "file")
            and raised,
        )


# ── CLI 스모크(서브프로세스) ───────────────────────────────────────────────


def test_cli_smoke() -> None:
    env = {**os.environ, "CLIP_DEVICE_TOKEN": "cli-smoke-token"}
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / "clip_cam_sim.py"), "--port", "0", "--quiet"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        first = proc.stdout.readline().strip()
        m = re.match(r"^listening (http://\S+)", first)
        check("CLI 첫 줄 'listening http://…'", m is not None and "cli-smoke-token" not in first, first)
        if m is None:
            return
        run = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "check_clip_cam_contract.py"), m.group(1)],
            env=env, capture_output=True, text=True, timeout=60,
        )
        out = run.stdout + run.stderr
        check(
            "CLI 스모크: 서브프로세스 sim + check_clip_cam_contract.py 종료코드 0",
            run.returncode == 0 and "계약 검사 24/24 PASS" in run.stdout and "대상: SIM" in run.stdout
            and "cli-smoke-token" not in out,
            out[-600:],
        )
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        rest = proc.stdout.read() + proc.stderr.read()
        check("CLI 출력 어디에도 토큰이 없다", "cli-smoke-token" not in rest, rest[-300:])


def test_cli_without_token_exits_2() -> None:
    with tempfile.TemporaryDirectory() as home:
        env = {k: v for k, v in os.environ.items() if k != "CLIP_DEVICE_TOKEN"}
        env["HOME"] = home
        run = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "clip_cam_sim.py"), "--port", "0"],
            env=env, capture_output=True, text=True, timeout=30,
        )
        check("CLI: 토큰 없으면 종료코드 2", run.returncode == 2 and "기기 토큰이 없다" in run.stderr,
              f"rc={run.returncode} err={run.stderr[-200:]!r}")
        run = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "check_clip_cam_contract.py"), "http://127.0.0.1:9"],
            env=env, capture_output=True, text=True, timeout=30,
        )
        check("검사기 CLI: 토큰 없으면 종료코드 2", run.returncode == 2, f"rc={run.returncode}")


def main() -> None:
    tests = [
        test_contract_all_pass,
        test_checker_not_vacuous,
        test_matches_firmware_source,
        test_auth,
        test_freeze,
        test_capture_failed_and_busy,
        test_reboot,
        test_capture_uptime_strictly_increases_with_stalled_clock,
        test_stall,
        test_drop_headers_and_wrong_content_type,
        test_control_endpoint,
        test_token_never_leaks,
        test_routing,
        test_frame_source,
        test_video_frames_if_available,
        test_resolve_token,
        test_cli_smoke,
        test_cli_without_token_exits_2,
    ]
    for t in tests:
        print(f"\n=== {t.__name__} ===")
        try:
            t()
        except Exception as e:  # noqa: BLE001 — 한 테스트의 예외가 나머지를 가리지 않게
            check(f"{t.__name__} 예외 없음", False, repr(e))

    print("=" * 50)
    if FAILURES:
        print(f"FAIL {len(FAILURES)}건: {FAILURES}")
        sys.exit(1)
    print("클립 카메라 시뮬레이터 테스트 전부 PASS")


if __name__ == "__main__":
    main()
