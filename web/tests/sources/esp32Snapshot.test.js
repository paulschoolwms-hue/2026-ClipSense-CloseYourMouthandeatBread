import { afterEach, expect, it, vi } from 'vitest'
import { captureUrl, fetchSnapshot } from '../../src/sources/esp32Snapshot.js'
afterEach(() => vi.unstubAllGlobals())
function response(status = 200, headers = {}) {
  return new Response(new Blob(['jpeg']), { status, headers: {
    'Content-Type': 'image/jpeg', 'X-Frame-Seq': '2', 'X-Boot-Id': 'boot1',
    'X-Capture-Uptime-Us': '1000', 'X-Response-Uptime-Us': '2000', ...headers,
  } })
}
it('uses the firmware capture endpoint', () => {
  expect(captureUrl('http://192.168.0.50/stream?old=1')).toBe('http://192.168.0.50/capture')
  expect(() => captureUrl('file:///tmp/x')).toThrow()
})
it('sends device token only in a header and preserves device metadata', async () => {
  const mock = vi.fn().mockResolvedValue(response())
  vi.stubGlobal('fetch', mock)
  const shot = await fetchSnapshot('http://192.168.0.50', 'test-token')
  expect(shot.seq).toBe(2)
  expect(mock.mock.calls[0][0]).not.toContain('test-token')
  expect(mock.mock.calls[0][1].headers['X-Clip-Device-Token']).toBe('test-token')
})
it('rejects replayed frames but accepts a new boot', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()))
  await expect(fetchSnapshot('http://device', '', { boot: 'boot1', seq: 2 })).rejects.toThrow('정지')
  expect((await fetchSnapshot('http://device', '', { boot: 'old', seq: 50 })).seq).toBe(2)
})
it('rejects auth failures, stale captures and missing proxy', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)))
  await expect(fetchSnapshot('http://device', '')).rejects.toThrow('토큰')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { 'X-Response-Uptime-Us': '3000000' })))
  await expect(fetchSnapshot('http://device', '')).rejects.toThrow('오래')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { 'Content-Type': 'text/html' })))
  await expect(fetchSnapshot('http://device', '')).rejects.toThrow('중계 서버')
})
