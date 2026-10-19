import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

// 카메라 모드 target — src/App.jsx의 CAMERA_TARGET과 동일한 5필드 고정 데모
// target(MANUAL_DEMO 바인딩)이다. 이 미들웨어는 App.jsx를 import할 수 없는
// vite.config.js(node 프로세스, 별도 모듈 그래프) 안에서 실행되므로 부득이
// 문자 그대로 중복 정의한다 — App.jsx의 CAMERA_TARGET을 바꾸면 이 객체도
// 함께 갱신해야 한다 (스펙 §W1.2: "duplication 주석 명시").
const CITS_MOCK_TARGET = Object.freeze({
  intersectionId: 'demo-int-001',
  crosswalkId: 'demo-cw-north-01',
  movementId: 'demo-ped-move-01',
  direction: 'NORTHBOUND',
})

const CITS_MOCK_CYCLE_MS = { green: 40_000, red: 30_000 }
const CITS_MOCK_CYCLE_TOTAL_MS = CITS_MOCK_CYCLE_MS.green + CITS_MOCK_CYCLE_MS.red

/** `/cits-mock` dev 미들웨어: green 40s → red 30s → 반복 카운트다운 상태를 서버 시작 시각 기준으로 계산한다. */
function citsMockState(nowMs, startMs, seq) {
  const elapsed = Math.max(0, nowMs - startMs)
  const phase = elapsed % CITS_MOCK_CYCLE_TOTAL_MS
  const inGreen = phase < CITS_MOCK_CYCLE_MS.green
  const color = inGreen ? 'green' : 'red'
  const remainingMs = inGreen ? CITS_MOCK_CYCLE_MS.green - phase : CITS_MOCK_CYCLE_TOTAL_MS - phase
  return {
    available: true,
    color,
    remainingSec: Math.max(0, Math.ceil(remainingMs / 1000)),
    intersectionId: CITS_MOCK_TARGET.intersectionId,
    crosswalkId: CITS_MOCK_TARGET.crosswalkId,
    movementId: CITS_MOCK_TARGET.movementId,
    direction: CITS_MOCK_TARGET.direction,
    sourceEpochMs: nowMs,
    seq,
    sourceMode: 'MOCK',
  }
}

/** dev-only: GET /cits-mock — 네트워크로 서빙되는 모의 C-ITS 관측 (스펙 §W1.2). */
function citsMockPlugin() {
  const startMs = Date.now()
  let seq = 0
  return {
    name: 'clipsense-cits-mock',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/cits-mock', (req, res) => {
        seq += 1
        const body = JSON.stringify(citsMockState(Date.now(), startMs, seq))
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },
  }
}

/**
 * dev-only: GET /esp32-proxy?url=http://... — ESP32 MJPEG 스트림을 그대로
 * 파이프하되 Access-Control-Allow-Origin: * 를 붙여 <img crossOrigin>의
 * CORS taint를 dev 환경에서 회피할 수 있게 한다 (스펙 §W3). url은
 * http://로 시작해야만 허용한다(그 외 스킴·상대경로는 400) — 임의
 * 내부망/파일 스킴으로의 SSRF성 프록시를 막기 위함이다.
 */
function esp32ProxyPlugin() {
  return {
    name: 'clipsense-esp32-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/esp32-proxy', async (req, res) => {
        const reqUrl = new URL(req.url ?? '', 'http://internal.local')
        const target = reqUrl.searchParams.get('url') ?? ''
        if (!target.startsWith('http://')) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'text/plain')
          res.end('esp32-proxy: url must start with http://')
          return
        }
        try {
          const token = req.headers['x-clip-device-token']
          const upstream = await fetch(target, {
            headers: token ? { 'X-Clip-Device-Token': token } : {},
            signal: AbortSignal.timeout(5000),
          })
          res.statusCode = upstream.status
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'no-store')
          for (const name of ['X-Frame-Seq', 'X-Boot-Id', 'X-Capture-Uptime-Us', 'X-Response-Uptime-Us']) {
            const value = upstream.headers.get(name)
            if (value != null) res.setHeader(name, value)
          }
          const contentType = upstream.headers.get('content-type')
          if (contentType) res.setHeader('Content-Type', contentType)
          if (!upstream.body) {
            res.end()
            return
          }
          const reader = upstream.body.getReader()
          req.on('close', () => reader.cancel().catch(() => {}))
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
          res.end()
        } catch {
          res.statusCode = 502
          res.setHeader('Content-Type', 'text/plain')
          res.end('esp32-proxy: upstream fetch failed')
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      basicSsl(), // dev HTTPS — 폰에서 getUserMedia는 secure context 필요 (스펙 §W1.1)
      citsMockPlugin(),
      esp32ProxyPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'ClipSense Prototype',
          short_name: 'ClipSense',
          description: '시각장애인 횡단보도 보행 안전 보조 — 기술 검증용 프로토타입',
          theme_color: '#101418',
          background_color: '#101418',
          icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
        },
      }),
    ],
    server: {
      host: true, // 핫스팟 상의 폰에서 접속 가능하도록 0.0.0.0 바인딩
      proxy: {
        // '/cits?...' → CITS_TARGET '?...&serviceKey=...' (키는 서버측 은닉)
        '/cits': {
          target: env.CITS_TARGET ?? 'http://localhost:9',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/cits/, env.CITS_PATH ?? '') + `&serviceKey=${env.CITS_KEY ?? ''}`,
        },
      },
    },
  }
})
