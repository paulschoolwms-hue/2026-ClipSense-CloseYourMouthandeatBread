/** ClipSense 펌웨어의 인증된 JPEG 스냅샷. 토큰은 URL에 넣지 않는다. */
export function captureUrl(address) {
  const url = new URL(address)
  if (url.protocol !== 'http:' || url.username || url.password) {
    throw new Error('ESP32의 http:// 주소를 입력해 주세요. 브라우저의 HTTPS 주소와 다릅니다.')
  }
  url.pathname = '/capture'
  url.search = ''
  url.hash = ''
  return url.href
}

export async function fetchSnapshot(address, token, previous, signal) {
  const start = performance.now()
  const response = await fetch(`/esp32-proxy?url=${encodeURIComponent(captureUrl(address))}`, {
    headers: { 'X-Clip-Device-Token': token }, cache: 'no-store', signal,
  })
  if ([401, 403].includes(response.status)) throw new Error('ESP32 기기 토큰을 확인해 주세요.')
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
  const blob = await response.blob()
  const ageMs = performance.now() - start + (sent - captured) / 1000
  if (ageMs > 2000) throw new Error('ESP32 영상이 오래되었습니다.')
  const bytes = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('ESP32 응답이 JPEG 사진이 아닙니다.')
  return { blob, seq, boot, captureUs: captured, requestMs: performance.now() - start,
    receivedAt: Date.now(), sensor: response.headers.get('X-Camera-Sensor') ?? 'unknown',
    frameSource: response.headers.get('X-Frame-Source') ?? 'camera',
    firmware: response.headers.get('X-Firmware-Version') ?? 'unknown',
    capturedAtMonoMs: performance.now() - ageMs }

}
