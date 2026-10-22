"""맥에서 실제 ESP32 JPEG의 수신 완료 여부 측정. 토큰을 출력하지 않는다."""
import argparse
import http.client
import json
from pathlib import Path
import re
import socket
import sys
import time
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('address', help='예: http://192.168.0.54')
    parser.add_argument('--secrets-file', type=Path, default=Path(__file__).resolve().parent.parent / 'firmware/clipsense_cam/secrets.h')
    args = parser.parse_args()
    target = urlsplit(args.address)
    if target.scheme != 'http' or not target.hostname or target.username or target.password:
        parser.error('비밀번호 없는 http://기기IP 주소를 사용하세요.')
    try:
        text = args.secrets_file.read_text(encoding='utf-8')
    except OSError:
        print('로컬 secrets.h를 열 수 없습니다. 파일 경로를 확인하세요. 내용은 채팅에 보내지 마세요.')
        return 1
    match = re.search(r'^\s*#define\s+CLIP_DEVICE_TOKEN\s+"([^"\r\n]*)"', text, re.MULTILINE)
    if not match or not match.group(1):
        print('secrets.h의 CLIP_DEVICE_TOKEN 따옴표 값을 확인하세요. 값은 출력하지 않습니다.')
        return 1
    def report_device_status():
        health = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=3)
        try:
            health.request('GET', '/health', headers={'X-Clip-Device-Token': match.group(1)})
            result = health.getresponse()
            if result.status != 200:
                print('상태 진단 HTTP:', result.status)
                return
            info = json.loads(result.read(8192))
            print('기기 상태:', json.dumps({key: info.get(key) for key in
                ('firmwareVersion', 'networkMode', 'rssiDbm', 'resolution', 'lastTransfer')}, ensure_ascii=False))
        except (OSError, http.client.HTTPException, ValueError):
            print('추가 기기 상태 응답 없음')
        finally:
            health.close()

    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=3)
    started = time.monotonic()
    data = bytearray()
    response = None
    problem = None
    try:
        connection.request('GET', '/capture', headers={'X-Clip-Device-Token': match.group(1)})
        response = connection.getresponse()
        print('HTTP:', response.status)
        print('Content-Length:', response.getheader('Content-Length', '없음'))
        if response.status != 200:
            print('401/403이면 기기 토큰, 503이면 촬영 상태를 확인하세요.')
            return 1
        while time.monotonic() - started < 15:
            chunk = response.read1(16384)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 4 * 1024 * 1024:
                problem = '허용한 진단 크기(4MiB) 초과'
                break
        else:
            problem = '전체 진단 시간 15초 초과'
    except (socket.timeout, TimeoutError):
        problem = '응답/본문 수신 시간 초과'
    except (OSError, http.client.HTTPException):
        problem = '기기 연결 또는 본문 수신 중단'
    finally:
        connection.close()
        print(f'경과 시간: {time.monotonic() - started:.3f}초 / 실제 수신: {len(data)}바이트')
        report_device_status()
    if response is None:
        print(problem or 'HTTP 응답 없음')
        return 1
    expected = response.getheader('Content-Length')
    size_ok = expected is not None and expected.isdecimal() and int(expected) == len(data)
    markers_ok = data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9')
    print('길이 일치:', size_ok, '/ JPEG 시작·끝 표식:', markers_ok)
    if problem or not size_ok or not markers_ok:
        print('수신 미완료:', problem or '길이 또는 JPEG 표식 불일치')
        return 1
    output = Path('/tmp/clipsense-probe.jpg')
    output.write_bytes(data)
    print('전체 바이트와 JPEG 표식 확인. 디코드/웹 연속 갱신 검증은 별도 필요.')
    print('파일:', output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
