import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const COPY_HEADERS = ['content-type', 'X-Frame-Seq', 'X-Boot-Id', 'X-Capture-Uptime-Us',
  'X-Response-Uptime-Us', 'X-Camera-Sensor', 'X-Frame-Source', 'X-Firmware-Version']
export function proxyFailure(error) {
  const code = error?.cause?.code ?? error?.code
  if (error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { status: 504, code: 'DEVICE_TIMEOUT', message: 'ESP32 응답 시간 초과. 같은 Wi-Fi와 기기 IP를 확인하세요.' }
  }
  if (code === 'ECONNREFUSED') return { status: 502, code: 'DEVICE_REFUSED', message: 'ESP32 웹 서버가 연결을 거부했습니다. 전원과 펌웨어를 확인하세요.' }
  return { status: 502, code: 'DEVICE_UNREACHABLE', message: '맥에서 ESP32에 연결하지 못했습니다. 연결된 Wi-Fi와 IP를 확인하세요.' }
}

export function createEsp32Proxy(fetchImpl = fetch) {
  return async (req, res) => {
    let target
    try {
      target = new URL(new URL(req.url ?? '', 'http://local').searchParams.get('url'))
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error()
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ code: 'BAD_DEVICE_URL', message: 'ESP32 주소는 http://로 시작해야 합니다. 맥의 HTTPS 주소를 입력하지 마세요.' }))
      return
    }
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      const token = req.headers['x-clip-device-token']
      const upstream = await fetchImpl(target.href, { headers: token ? { 'X-Clip-Device-Token': token } : {},
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      res.statusCode = upstream.status
      res.setHeader('Cache-Control', 'no-store')
      for (const name of COPY_HEADERS) {
        const value = upstream.headers.get(name)
        if (value != null) res.setHeader(name, value)
      }
      if (!upstream.body) { res.end(); return }
      await pipeline(Readable.fromWeb(upstream.body), res)
    } catch (error) {
      if (res.destroyed) return
      if (res.headersSent) { res.destroy(); return }
      const failure = proxyFailure(error)
      res.writeHead(failure.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(failure)) // 토큰/요청 URL/네트워크 예외 원문을 남기지 않는다.
    }
  }
}
