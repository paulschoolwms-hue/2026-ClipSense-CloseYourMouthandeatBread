import { execFileSync } from 'node:child_process'
import { createEsp32Proxy } from './server/esp32Proxy.js'
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

/** 맥 로컬 개발 서버에서만 동작하는 인증 JPEG/상태 HTTP 중계. */
function esp32ProxyPlugin() {
  return { name: 'clipsense-esp32-proxy', apply: 'serve',
    configureServer(server) { server.middlewares.use('/esp32-proxy', createEsp32Proxy()) } }
}

let revision = 'unknown'
try { revision = execFileSync('git', ['describe', '--always', '--dirty'], { encoding: 'utf8' }).trim() } catch {}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    define: { __APP_REVISION__: JSON.stringify(revision) },
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
