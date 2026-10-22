"""데이터 계층 단위 테스트를 한 번에 실행. 실행: python scripts/run_unit_tests.py

각 test_*.py는 실패 시 sys.exit(1)로 끝나는 독립 스크립트다. 여기서는
서브프로세스로 순차 실행하고, 하나라도 실패하면 전체를 1로 종료한다.
파이프라인 영상 검증(run_pipeline_test.py)과는 별개다.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = [
    "test_signals.py",
    "test_signal_api.py",
    "test_vision_adapter.py",
    "test_judge.py",
    "test_judge_golden.py",
    "test_clip_snapshot.py",
    "test_main_config.py",
    "test_detector.py",
    "test_state_machine.py",
    "test_digits.py",
    "test_digits_robust.py",
    "test_voice.py",
    "test_clip_cam_sim.py",
    "verify_firmware_contract.py",
    "test_jpeg_transfer.py",
]

failed = []
for name in TESTS:
    path = ROOT / "scripts" / name
    if not path.exists():
        print(f"[SKIP] {name} (없음)")
        continue
    print(f"--- {name} ---")
    proc = subprocess.run([sys.executable, str(path)], cwd=ROOT)
    if proc.returncode != 0:
        failed.append(name)

print("=" * 50)
if failed:
    print(f"FAIL: {failed}")
    sys.exit(1)
print("단위 테스트 러너 — 전부 PASS")
