"""브라우저 통합 검사. 실행 전 web 빌드를 HTTP loopback으로 서빙한다.

python scripts/check_web_evidence.py http://127.0.0.1:4182
선택 의존성: Playwright + Chromium. 카메라 응답과 음성 엔진은 합성/모의이며
실제 ESP32 촬영, Wi-Fi, 스피커 소리의 완료 증거로 쓰지 않는다.
"""
import base64
import json
import os
import shutil
import sys
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright, expect

base_url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4182'
with sync_playwright() as p:
    executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
    browser = p.chromium.launch(**({'executable_path': executable} if executable else {}))
    page = browser.new_page()
    page.add_init_script('''
      // 구형 Safari의 API 가용성을 재현한다.
      AbortSignal.any = undefined; AbortSignal.timeout = undefined;
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(window, 'speechSynthesis', { configurable:true, value: {
        cancel() {}, speak(u) { setTimeout(() => u.onstart?.(), 0); setTimeout(() => u.onend?.(), 20); }
      }});
    ''')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url)
    frames = {}
    for color, css in [('red', '#ff1428'), ('green', '#00e678'), ('unknown', '#808080')]:
        data = page.evaluate('''color => {
          const c=document.createElement('canvas'); c.width=640; c.height=480;
          const x=c.getContext('2d'); x.fillStyle='#808080'; x.fillRect(0,0,640,480);
          x.fillStyle=color; x.beginPath(); x.arc(320,380,48,0,Math.PI*2); x.fill();
          return c.toDataURL('image/jpeg').split(',')[1];
        }''', css)
        frames[color] = base64.b64decode(data)
    state = {'seq': 0, 'color': 'red', 'fail': False, 'sensor': 'OV3660', 'mock_requests': 0, 'quality_fail': 0, 'profiles': []}
    def device(route):
        assert route.request.headers.get('x-clip-device-token') == 'browser-test-only-token'
        target = parse_qs(urlsplit(route.request.url).query)['url'][0]
        profile = parse_qs(urlsplit(target).query).get('profile', ['stable'])[0]
        state['profiles'].append(profile)
        quality_failure = state['quality_fail'] > 0 and profile != 'stable'
        if quality_failure:
            state['quality_fail'] -= 1
        if state['fail'] or quality_failure:
            route.fulfill(status=502, content_type='application/json', body=json.dumps({'message': 'TEST 연결 장애'}))
            return
        state['seq'] += 1
        route.fulfill(status=200, headers={'Content-Type':'image/jpeg', 'X-Frame-Seq':str(state['seq']),
            'X-Boot-Id':'1234abcd', 'X-Capture-Uptime-Us':str(state['seq']*1000000),
            'X-Response-Uptime-Us':str(state['seq']*1000000+1000), 'X-Camera-Sensor':state['sensor'],
            'X-Firmware-Version':'BROWSER-TEST', 'X-Frame-Source':'camera',
            'X-Camera-Profile':profile, 'X-Jpeg-Quality':'18' if profile == 'balanced' else '12', 'X-Wifi-Rssi':'-83'}, body=frames[state['color']])
    def mock_cits(route):
        state['mock_requests'] += 1
        route.abort()
    page.route('**/esp32-proxy?*', device)
    page.route('**/cits-mock', mock_cits)
    page.get_by_role('button', name='ESP32 카메라로 신호등 인식 시작').click()
    page.get_by_role('textbox', name='ESP32 주소').fill('http://192.168.4.1')
    page.get_by_label('ESP32 기기 토큰').fill('browser-test-only-token')
    page.get_by_role('button', name='ESP32 연결', exact=True).click()
    expect(page.get_by_test_id('connection-state')).to_have_text('새 사진 수신 중')
    assert page.locator('.camera-view img').evaluate("el => getComputedStyle(el).transform") == 'matrix(-1, 0, 0, -1, 0, 0)'
    panel = page.locator('.evidence-panel')
    page.get_by_role('button', name='음성 시작 (현재 안내 읽기)').click()
    expect(page.get_by_test_id('speech-state')).to_contain_text('브라우저 발화 종료')
    for color, label in [('red', '빨간'), ('green', '초록'), ('unknown', '신호등을 확인할 수 없습니다')]:
        state['color'] = color
        expect(page.get_by_test_id('final-guidance')).to_contain_text(label)
        expect(page.get_by_test_id('final-guidance')).to_contain_text('대기')
        page.get_by_label('장면의 정답').select_option(color)
        page.get_by_role('button', name='현재 안내 다시 듣기').click()
        expect(page.get_by_test_id('speech-state')).to_contain_text('브라우저 발화 종료')
        page.get_by_role('button', name='현재 장면 기록', exact=True).click()
    expect(panel.locator('tbody tr')).to_have_count(3)
    # 실패 시 성공 횟수/마지막 수신 시각은 증가하지 않아야 한다.
    state['fail'] = True
    expect(page.get_by_test_id('connection-state')).to_have_text('연결 실패')
    count = page.get_by_test_id('success-count').inner_text()
    received = page.get_by_test_id('last-success').inner_text().split(' · ')[0]
    page.wait_for_timeout(1300)
    assert page.get_by_test_id('success-count').inner_text() == count
    assert page.get_by_test_id('last-success').inner_text().split(' · ')[0] == received
    page.get_by_role('button', name='현재 장면 기록', exact=True).click()
    expect(panel.locator('tbody tr')).to_have_count(3)
    page.get_by_role('button', name='연결 장애 장면 기록').click()
    with page.expect_download() as download:
        page.get_by_role('button', name='세션 JSON 다운로드').click()
    data = json.loads(open(download.value.path(), encoding='utf-8').read())
    assert 'browser-test-only-token' not in json.dumps(data)
    assert data['realSignalApiConnected'] is False
    assert len(data['rows']) == 3
    assert all(r['device']['rotationDeg'] == 180 for r in data['rows'])
    assert all(r['final']['decision'] == 'WAIT' and r['heard'] == '미확인' for r in data['rows'])
    assert [r['vision']['color'] for r in data['rows']] == ['red', 'green', 'unknown']
    assert any(e['type'] == 'manual_fault' for e in data['events'])
    with page.expect_download() as download:
        page.get_by_role('button', name='결과표 CSV 다운로드').click()
    assert 'WAIT' in open(download.value.path(), encoding='utf-8-sig').read()
    # 같은 주소에서도 연결 버튼으로 재연결하고 SIM 표시를 확인한다.
    state['fail'] = False; state['sensor'] = 'SIM'
    page.get_by_role('button', name='ESP32 연결', exact=True).click()
    expect(page.get_by_test_id('connection-state')).to_have_text('새 사진 수신 중')
    expect(panel).to_contain_text('SIM 시뮬레이터 (실촬영 아님)')
    try:
        with page.expect_download(timeout=5000) as download:
            page.get_by_role('button', name='현재 원본 JPEG 저장').click()
    except Exception:
        print('JPEG download diagnostics:',
            page.get_by_test_id('connection-state').inner_text(),
            page.get_by_test_id('last-success').inner_text(),
            page.get_by_test_id('success-count').inner_text(), 'requests=', state['seq'], 'errors=', errors)
        raise
    assert open(download.value.path(), 'rb').read()[:2] == b'\xff\xd8'
    assert state['mock_requests'] == 0
    assert not errors, errors
    page.set_viewport_size({'width':390, 'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    # 고화질 선택이 실제 요청에 반영되고 두 번 실패한 뒤 안정 화질로 복구된다.
    page.get_by_label('ESP32 화질').select_option('balanced')
    page.get_by_role('button', name='ESP32 연결', exact=True).click()
    expect(panel).to_contain_text('balanced / 18 / -83dBm')
    state['quality_fail'] = 2
    expect(panel).to_contain_text('고화질 수신이 두 번 실패하여 안정 화질로 전환했습니다.', timeout=10000)
    assert state['profiles'][-1] == 'stable'
    expect(page.get_by_test_id('connection-state')).to_have_text('새 사진 수신 중')
    # 재실행 시 이전 장면/음성 활성화를 자동 복원하지 않고 새로 확인한다.
    page.reload()
    page.get_by_role('button', name='ESP32 카메라로 신호등 인식 시작').click()
    expect(panel.locator('tbody tr')).to_have_count(0)
    expect(page.get_by_test_id('speech-state')).to_contain_text('미시작')
    page.get_by_role('textbox', name='ESP32 주소').fill('http://192.168.4.1')
    page.get_by_label('ESP32 기기 토큰').fill('browser-test-only-token')
    page.get_by_role('button', name='ESP32 연결', exact=True).click()
    expect(page.get_by_test_id('connection-state')).to_have_text('새 사진 수신 중')
    page.get_by_role('button', name='음성 시작 (현재 안내 읽기)').click()
    expect(page.get_by_test_id('speech-state')).to_contain_text('브라우저 발화 종료')
    browser.close()
    print('PASS: 합성 빨강/초록/불명→WAIT, 모의 신호 미요청, 음성 이벤트, 장면 기록, JSON/CSV/JPEG, 장애/재연결/SIM 구분, 모바일 폭')
    print('실제 ESP32/Wi-Fi/스피커 소리 검증은 별도 필요')
