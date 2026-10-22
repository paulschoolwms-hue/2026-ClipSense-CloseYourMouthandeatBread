"""네트워크/Arduino 없는 호스트 검사. 실제 Wi-Fi 전송 완료를 증명하지 않는다."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
compiler = shutil.which('g++') or shutil.which('clang++')
if not compiler:
    raise SystemExit('C++ 컴파일러가 필요합니다. 호스트 전송 테스트를 실행하지 못했습니다.')
with tempfile.TemporaryDirectory(prefix='clipsense-transfer-') as folder:
    executable = Path(folder) / 'test-transfer'
    subprocess.run([compiler, '-std=c++11', '-Wall', '-Wextra', '-Werror',
                    str(root / 'scripts/test_jpeg_transfer.cpp'), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
print('PASS: 전체/단편 write의 바이트 보존, 512-byte 한도, 0-byte/끊김 중단, 시간 예산/시계 롤오버')
