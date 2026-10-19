import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { createEsp32Proxy, proxyFailure } from '../../server/esp32Proxy.js'

it('연결 거부/시간 초과를 구분한다', () => {
  expect(proxyFailure({ cause: { code: 'ECONNREFUSED' } }).code).toBe('DEVICE_REFUSED')
  expect(proxyFailure({ name: 'TimeoutError' }).status).toBe(504)
})
it('실제 HTTP 중계가 사진/프레임 메타데이터/토큰을 보존한다', async () => {
  const upstream = createServer((req, res) => {
    expect(req.headers['x-clip-device-token']).toBe('test-only')
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Frame-Seq': '8', 'X-Camera-Sensor': 'SIM',
      'X-Firmware-Version': 'test-version', 'X-Frame-Source': 'camera' })
    res.end(Buffer.from([255, 216, 255, 217]))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const proxy = createServer(createEsp32Proxy()).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const target = `http://127.0.0.1:${upstream.address().port}/capture`
    const url = `http://127.0.0.1:${proxy.address().port}/?url=${encodeURIComponent(target)}`
    const r = await fetch(url, { headers: { 'X-Clip-Device-Token': 'test-only' } })
    expect(r.status).toBe(200); expect(r.headers.get('X-Camera-Sensor')).toBe('SIM')
    expect(r.headers.get('X-Firmware-Version')).toBe('test-version')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]))
  } finally { await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]) }
})
