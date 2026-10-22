/** ClipSense 펌웨어의 인증된 JPEG 스냅샷. 토큰은 URL에 넣지 않는다. */
export function captureUrl(address, profile) {
  let url
  try { url = new URL(address) } catch {
    const error = new Error('ESP32 주소를 http://기기IP 형식으로 입력해 주세요.')
    error.permanent = true
    throw error
  }
  if (url.protocol !== 'http:' || url.username || url.password) {
    const error = new Error('ESP32의 http:// 주소를 입력해 주세요. 브라우저의 HTTPS 주소와 다릅니다.')
    error.permanent = true
    throw error
  }
  url.pathname = '/capture'
  url.search = ''
  url.hash = ''
  if (profile != null) {
    if (!['stable', 'balanced', 'detail'].includes(profile)) throw new Error('지원하지 않는 화질입니다.')
    url.searchParams.set('profile', profile)
  }
  return url.href
}

export async function fetchSnapshot(address, token, previous, signal, profile) {
  const start = performance.now()
  const target = captureUrl(address, profile)
  let response
  try {
    response = await fetch(`/esp32-proxy?url=${encodeURIComponent(target)}`, {
      headers: { 'X-Clip-Device-Token': token }, cache: 'no-store', signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (!(error instanceof TypeError)) throw error
    throw new Error('브라우저에서 맥 중계 요청에 실패했습니다. 같은 맥 브라우저에서 로컬 HTTP 주소를 확인하세요. 이 메시지만으로 서버 종료를 뜻하지는 않습니다.')
  }
  if ([401, 403, 422].includes(response.status)) {
    const error = new Error(response.status === 422 ? '이 기기는 고화질용 PSRAM을 지원하지 않습니다. 안정 화질로 연결하세요.' : 'ESP32 기기 토큰을 확인해 주세요.')
    error.permanent = true
    throw error
  }
  if (response.status === 503) throw new Error('ESP32 카메라 촬영 실패 또는 새 프레임 없음')
  if (!response.ok) {
    let detail
    try { detail = await response.json() } catch {}
    throw new Error(detail?.message || `ESP32 연결 실패 (${response.status}). 같은 Wi-Fi와 기기 IP를 확인해 주세요.`)
  }
  if (!response.headers.get('content-type')?.startsWith('image/jpeg')) {
    throw new Error('ESP32 중계 서버가 없습니다. 같은 Wi-Fi의 PC에서 npm run dev로 실행해 주세요.')
  }
  const uint = (name) => {
    const value = response.headers.get(name)
    if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('ESP32 프레임 헤더 오류')
    return Number(value)
  }
  const seq = uint('X-Frame-Seq')
  const captured = uint('X-Capture-Uptime-Us')
  const sent = uint('X-Response-Uptime-Us')
  const boot = response.headers.get('X-Boot-Id')
  if (!boot || sent < captured) throw new Error('ESP32 프레임 시각 오류')
  if (previous?.boot === boot && (seq <= previous.seq || captured <= previous.captureUs)) throw new Error('ESP32 영상이 정지했거나 이전 프레임입니다.')
  let blob
  try { blob = await response.blob() } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('ESP32 사진 본문을 받는 중 연결이 끊겼습니다. 토큰 오류나 웹 서버 종료로 단정할 수 없습니다.')
  }
  const ageMs = performance.now() - start + (sent - captured) / 1000
  if (ageMs > 2000) throw new Error('ESP32 영상이 오래되었습니다.')
  const expected = response.headers.get('content-length')
  if (blob.size > 4 * 1024 * 1024 || (expected != null && (!/^\d+$/.test(expected) || Number(expected) !== blob.size))) {
    throw new Error('ESP32 사진 길이가 맞지 않습니다. 사진 전송이 완료되지 않았습니다.')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error('ESP32 JPEG 사진이 잘렸거나 표식이 올바르지 않습니다.')
  }
  const actualProfile = response.headers.get('X-Camera-Profile')
  if (profile && profile !== 'stable' && actualProfile !== profile) {
    const error = new Error('화질 변경은 펌웨어 0.3.4 이상이 필요합니다. 안정 화질로 다시 연결하세요.')
    error.permanent = true
    throw error
  }
  return { blob, seq, boot, captureUs: captured, requestMs: performance.now() - start,
    profile: actualProfile ?? 'unknown',
    jpegQuality: response.headers.get('X-Jpeg-Quality'),
    rssiDbm: /^-?\d+$/.test(response.headers.get('X-Wifi-Rssi') ?? '') ? Number(response.headers.get('X-Wifi-Rssi')) : null,
    receivedAt: Date.now(), sensor: response.headers.get('X-Camera-Sensor') ?? 'unknown',
    frameSource: response.headers.get('X-Frame-Source') ?? 'camera',
    firmware: response.headers.get('X-Firmware-Version') ?? 'unknown',
    capturedAtMonoMs: performance.now() - ageMs }

}
