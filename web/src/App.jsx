import { useCallback, useEffect, useRef, useState } from 'react'
import { createRuntimeShield } from './safety/runtimeShield.js'
import { createBaselineEngines } from './safety/baselineAdapter.js'
import { buildTrace, SCENARIOS, SCENARIO_IDS, TICK_MS } from './experiments/faultScenarios.js'
import { MESSAGES } from './safety/reasonCodes.js'
import { createAnnouncer, speakMessage } from './feedback/tts.js'
import EvidencePanel from './ui/EvidencePanel.jsx'
import { cameraWait, freshConnection } from './demo/evidence.js'
import { vibrate } from './feedback/haptic.js'
import CameraView from './ui/CameraView.jsx'
import SourcePanel from './ui/SourcePanel.jsx'
import SafetyGatePanel from './ui/SafetyGatePanel.jsx'
import ComparisonPanel from './ui/ComparisonPanel.jsx'
import ScenarioBar from './ui/ScenarioBar.jsx'
import ProductView from './ui/ProductView.jsx'
import { computeReplayOffset, reanchorTick } from './ui/traceReplayClock.js'
import { createFlightRecorder } from './demo/flightRecorder.js'
import './App.css'

const DEFAULT_SCENARIO = SCENARIO_IDS[0] // NORMAL_GREEN

// 카메라 모드 target — 시나리오 트레이스와 동일한 데모 target(고정 5필드
// MANUAL_DEMO 바인딩)을 사용해 vision.roiBindingId 매핑이 항상 일치하도록
// 한다 (스펙 §2.10: "target의 것"을 roiBindingId로 매핑).
const CAMERA_TARGET = Object.freeze({
  intersectionId: 'demo-int-001',
  crosswalkId: 'demo-cw-north-01',
  movementId: 'demo-ped-move-01',
  direction: 'NORTHBOUND',
  roiBindingId: 'roi-ped-north-01',
  bindingMethod: 'MANUAL_DEMO',
})

const CAMERA_USER = { walkingSpeedMps: 0.6 }
const CAMERA_CROSSWALK = { lengthM: 10, marginSec: 2 }
const CITS_TICK_MS = 500 // C-ITS poll 루프는 safety tick과 독립 (스펙 §2.10 "루프 분리")

/** 실시간 API 미연결 관측. 실제 카메라 모드에서는 MOCK 신호를 사용하지 않는다. */
function makeUnavailableCits(seq, nowEpochMs, nowMonoMs) {
  return {
    available: false,
    color: 'unknown',
    remainingSec: 0,
    intersectionId: CAMERA_TARGET.intersectionId,
    crosswalkId: CAMERA_TARGET.crosswalkId,
    movementId: CAMERA_TARGET.movementId,
    direction: CAMERA_TARGET.direction,
    sourceEpochMs: nowEpochMs,
    receivedAtMonoMs: nowMonoMs,
    seq,
    sourceMode: 'LIVE',
  }
}

// decision → hapticPattern 매핑 근거 (스펙 §2.10 "신규 매핑... 주석으로 근거
// 명시"). 기존 src/feedback/haptic.js의 PATTERNS 키(cross/caution/warning/
// wait)는 v1 decide()의 verdict 어휘에서 온 것이라 SafeGraph-RTA의 decision
// enum(WAIT/VERIFYING/SIGNAL_CONFIRMED/INFORMATION_ONLY)과 이름이 1:1로
// 대응하지 않는다. 의미로 매핑한다:
//   WAIT              → 'wait'    (그대로 대기 — 이름 일치)
//   VERIFYING         → 'caution' (확인 중 = 아직 확정 아님, 경계 신호)
//   SIGNAL_CONFIRMED  → 'cross'   (횡단 가능 확정 — 유일한 proceed-like)
//   INFORMATION_ONLY  → 'warning' (신호 미확정, 판단 유보를 강하게 경고)
const DECISION_HAPTIC = {
  WAIT: 'wait',
  VERIFYING: 'caution',
  SIGNAL_CONFIRMED: 'cross',
  INFORMATION_ONLY: 'warning',
}

export default function App() {
  const [mode, setMode] = useState('SCENARIO') // 'SCENARIO' | 'CAMERA'
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO)
  const [audioEnabled, setAudioEnabled] = useState(false)

  // ---- 제품 모드(product mode) — 순수 표시 전환. 새 tick 루프나 로직을
  // 만들지 않는다: 기존 safety tick이 계산한 display.shield를 그대로
  // ProductView에 넘겨 풀스크린으로 렌더링할 뿐이다 (스펙: 촬영용 UI).
  const [viewMode, setViewMode] = useState('console') // 'console' | 'product'

  // 제품 모드에서 배경 콘솔이 터치 드래그로 스크롤되지 않도록 body 스크롤을
  // 잠근다 — 화면 전환에 따른 부수효과일 뿐 판정 로직과 무관.
  useEffect(() => {
    if (viewMode !== 'product') return undefined
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [viewMode])

  // ---- 실제 영상 입력: 내장 카메라 | ESP32 인증 JPEG 스냅샷 ----
  const [videoSourceKind, setVideoSourceKind] = useState('ESP32') // 'BUILTIN' | 'ESP32'
  const [espUrl, setEspUrl] = useState('')
  const [espToken, setEspToken] = useState('')
  const [espConnection, setEspConnection] = useState(null)
  const [cameraStatus, setCameraStatus] = useState(null)
  const [cameraVision, setCameraVision] = useState(null)
  const [speech, setSpeech] = useState(null)
  const latestImageRef = useRef(null)
  const modeRef = useRef(mode)
  modeRef.current = mode


  // 화면에 그릴 최신 tick 스냅샷 (표시 전용 — 판정 로직은 ref 기반으로 독립 루프에서 돈다)
  const [display, setDisplay] = useState({
    target: null,
    cits: null,
    vision: null,
    shield: null,
    baselineRaw: null,
    baselineStabilized: null,
  })

  // ---- 최신 tickInput 구성요소를 보유하는 ref들 (safety tick이 매 100ms 읽는다) ----
  const targetRef = useRef(CAMERA_TARGET)
  const citsRef = useRef(null)
  const visionRef = useRef(null)
  const userRef = useRef(CAMERA_USER)
  const crosswalkRef = useRef(CAMERA_CROSSWALK)

  // ---- generation token: 시나리오/모드 전환 시 증가, 이전 재생/폴 타이머의 늦은 갱신을 폐기 ----
  const generationRef = useRef(0)

  // ---- 라이브 로그 (스펙 §W2): 모드/시나리오 전환에 영향받지 않고 세션
  // 전체 tick을 계속 누적한다 — 시연 중 WAIT 전환 순간을 놓치지 않도록
  // resetForModeChange에서 지우지 않는다.
  const flightRecorderRef = useRef(createFlightRecorder())
  const [logCount, setLogCount] = useState(0)
  const [e2eStats, setE2eStats] = useState({ n: 0, medianMs: null, p95Ms: null })

  // ---- 엔진 인스턴스 (mode/scenario 전환 시 fresh 재생성) ----
  const shieldRef = useRef(createRuntimeShield())
  const baselineRef = useRef(createBaselineEngines())

  const announcerRef = useRef(null)
  if (!announcerRef.current) announcerRef.current = createAnnouncer({ speak: (message) => speakMessage(message, setSpeech) })
  const audioEnabledRef = useRef(audioEnabled)
  audioEnabledRef.current = audioEnabled
  const lastProposedDecisionRef = useRef(null)
  const lastProposedMessageRef = useRef(null)

  // 실시간 API 미연결 관측의 순번
  const citsFallbackSeqRef = useRef(0)
  // SourcePanel에 표시하는 실시간 API 미연결 상태
  const [citsConn, setCitsConn] = useState('연결 중')

  /** 시나리오/카메라 전환 시 모든 축적 상태를 초기화한다. */
  const resetForModeChange = useCallback(() => {
    generationRef.current += 1
    shieldRef.current = createRuntimeShield()
    baselineRef.current = createBaselineEngines()
    lastProposedDecisionRef.current = null
    lastProposedMessageRef.current = null
    citsRef.current = null
    visionRef.current = null
    citsFallbackSeqRef.current = 0
    setCitsConn('실시간 API 미연결')
    latestImageRef.current = null
    setCameraStatus(null)
    setCameraVision(null)
    setSpeech(null)
    setAudioEnabled(false)
    audioEnabledRef.current = false
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  }, [])

  useEffect(() => {
    resetForModeChange()
  }, [mode, scenarioId, resetForModeChange])

  // ---- 시나리오 모드: buildTrace() 재생 (실시간, TICK_MS 간격) ----
  // 트레이스 timestamp는 BASE_EPOCH/BASE_MONO 고정 앵커라서 safety tick의
  // 실제 clock과 그대로 비교하면 age가 수백만 ms로 튀어 영구 WAIT에
  // 고정된다(리뷰 지적). computeReplayOffset/reanchorTick으로 재생 시작
  // 순간(및 루프 재시작 시점)마다 offset을 다시 잡아 cits/vision의
  // clock-비교 대상 timestamp만 실시간 좌표로 옮긴다.
  useEffect(() => {
    if (mode !== 'SCENARIO') return undefined
    const myGeneration = generationRef.current
    const trace = buildTrace(scenarioId)
    let tickIndex = 0
    let offset = computeReplayOffset(trace.ticks[0].clock)

    const applyTick = () => {
      if (generationRef.current !== myGeneration) return // 이전 재생의 늦은 갱신 폐기
      if (tickIndex >= trace.ticks.length) {
        tickIndex = 0
        // 루프 재생: tick 0으로 되돌아가는 순간 트레이스 시각도 과거로
        // 점프하므로, offset을 "지금"으로 다시 앵커링하지 않으면 다음
        // 바퀴부터는 미래 timestamp가 되어 futureClockToleranceMs를
        // 넘겨 다시 깨진다.
        offset = computeReplayOffset(trace.ticks[0].clock)
      }
      const tick = trace.ticks[tickIndex]
      const { cits, vision } = reanchorTick(tick, offset)
      targetRef.current = tick.target
      citsRef.current = cits
      visionRef.current = vision
      userRef.current = tick.user
      crosswalkRef.current = tick.crosswalk
      tickIndex += 1
    }

    applyTick() // 즉시 첫 tick 반영 — 버튼 클릭 직후 화면이 비어 보이지 않도록
    const id = setInterval(applyTick, TICK_MS)
    return () => clearInterval(id)
  }, [mode, scenarioId])

  // 실제 카메라 모드에는 실시간 API가 없다. 모의 신호/잔여시간을 주입하지 않는다.
  useEffect(() => {
    if (mode !== 'CAMERA') return undefined
    targetRef.current = CAMERA_TARGET
    userRef.current = CAMERA_USER
    crosswalkRef.current = CAMERA_CROSSWALK
    const unavailable = () => {
      citsRef.current = makeUnavailableCits(++citsFallbackSeqRef.current, Date.now(), performance.now())
      setCitsConn('실시간 API 미연결')
    }
    unavailable()
    const id = setInterval(unavailable, CITS_TICK_MS)
    return () => clearInterval(id)
  }, [mode])

  // ---- 라이브 로그 다운로드 (스펙 §W2.3): JSONL Blob 다운로드 ----
  const downloadLog = useCallback(() => {
    const jsonl = flightRecorderRef.current.toJsonl()
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clipsense-live-log-${new Date().toISOString()}.jsonl`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [])

  // ---- 카메라 모드: CameraView의 vision 콜백을 SafeGraph vision observation으로 매핑 ----
  const onCameraVision = useCallback((v) => {
    if (modeRef.current !== 'CAMERA') return
    latestImageRef.current = v.blob ?? null
    visionRef.current = {
      color: v.color,
      score: v.confidence,
      quality: v.quality,
      frameAvailable: v.frameAvailable,
      roiBindingId: targetRef.current?.roiBindingId ?? CAMERA_TARGET.roiBindingId,
      capturedAtMonoMs: v.capturedAtMonoMs,
      frameSeq: v.frameSeq,
      mediaTimeMs: v.capturedAtMonoMs,
      sourceMode: 'CAMERA',
      deviceFrameSeq: v.deviceFrameSeq, deviceBootId: v.deviceBootId,
    }
    setCameraVision(visionRef.current)
  }, [])

  // ---- safety tick: 100ms 고정, EVERY tick clock을 새로 만들고 두 엔진을 동시에 구동 ----
  useEffect(() => {
    let lastStatsFlushMonoMs = 0
    const id = setInterval(() => {
      const myGeneration = generationRef.current
      const clock = { nowEpochMs: Date.now(), nowMonoMs: performance.now() }
      const target = targetRef.current
      const cits = citsRef.current
      const vision = visionRef.current
      const user = userRef.current
      const crosswalk = crosswalkRef.current

      if (!target || !cits || !vision) return // 아직 첫 관측이 도착하지 않음

      const tickInput = { target, cits, vision, user, crosswalk, clock }

      const shieldStartMonoMs = performance.now()
      const checked = shieldRef.current.update(tickInput)
      const shieldOut = mode === 'CAMERA' ? cameraWait(checked, vision, clock.nowMonoMs) : checked
      const shieldMs = performance.now() - shieldStartMonoMs
      const rawOut = baselineRef.current.raw.update(tickInput, clock.nowMonoMs)
      const stabilizedOut = baselineRef.current.stabilized.update(tickInput, clock.nowMonoMs)

      if (generationRef.current !== myGeneration) return // 이 tick 사이 모드/시나리오가 바뀜 — 폐기

      setDisplay({
        target,
        cits,
        vision,
        ages: shieldOut.ages,
        shield: shieldOut,
        baselineRaw: rawOut,
        baselineStabilized: stabilizedOut,
      })

      // ---- TTS: 오디오 활성화 후에만, proposed decision/message 변화 시만 발화. baseline은 절대 발화하지 않는다. ----
      const decisionChanged = shieldOut.decision !== lastProposedDecisionRef.current
      const messageChanged = shieldOut.message !== lastProposedMessageRef.current
      let announcedMessage = null
      if (decisionChanged && shieldOut.decision === 'WAIT' && typeof speechSynthesis !== 'undefined') {
        speechSynthesis.cancel() // WAIT 전환 시 진행 가능 관련 발화를 즉시 취소
      }
      if (audioEnabledRef.current && (decisionChanged || messageChanged)) {
        if (announcerRef.current.announce(shieldOut.message, clock.nowMonoMs)) announcedMessage = shieldOut.message
        const pattern = DECISION_HAPTIC[shieldOut.decision]
        if (pattern) vibrate(pattern)
      }
      lastProposedDecisionRef.current = shieldOut.decision
      lastProposedMessageRef.current = shieldOut.message

      // ---- 라이브 로그 기록 (스펙 §W2.2): E2E latency = safety tick 시각 -
      // 이번 tick에 쓰인 vision 프레임의 캡처 시각. 프레임이 없으면(vision에
      // capturedAtMonoMs가 없는 시나리오 모드 등) null.
      const frameCapturedAtMonoMs = Number.isFinite(vision?.capturedAtMonoMs)
        ? vision.capturedAtMonoMs
        : null
      const e2eMs = frameCapturedAtMonoMs !== null ? clock.nowMonoMs - frameCapturedAtMonoMs : null

      flightRecorderRef.current.record({
        t: clock.nowEpochMs,
        tickMonoMs: clock.nowMonoMs,
        mode,
        scenarioId: mode === 'SCENARIO' ? scenarioId : null,
        frameSeq: vision?.frameSeq ?? null,
        frameCapturedAtMonoMs,
        e2eMs,
        shieldMs,
        vision: { color: vision?.color ?? null, score: vision?.score ?? null, quality: vision?.quality ?? null },
        cits: {
          color: cits?.color ?? null,
          remainingSec: cits?.remainingSec ?? null,
          seq: cits?.seq ?? null,
          available: cits?.available ?? null,
          sourceMode: cits?.sourceMode ?? null,
        },
        citsSourceAgeMs: Number.isFinite(shieldOut.ages?.citsSourceAgeMs) ? shieldOut.ages.citsSourceAgeMs : null,
        baseline: {
          verdict: stabilizedOut?.verdict ?? null,
          proceedLike: stabilizedOut?.verdict === 'CROSS',
        },
        proposed: { decision: shieldOut.decision, reason: shieldOut.reason },
        tts: announcedMessage,
        ttsMeaning: '발화 요청만 기록. 실제 청취는 별도 확인',
      })

      // 화면 카운터/p95는 매 100ms 재렌더하지 않도록 ~1초 간격으로만 갱신한다.
      if (clock.nowMonoMs - lastStatsFlushMonoMs >= 1000) {
        lastStatsFlushMonoMs = clock.nowMonoMs
        setLogCount(flightRecorderRef.current.count())
        setE2eStats(flightRecorderRef.current.latencyStats())
      }
    }, 100)
    return () => clearInterval(id)
  }, [mode, scenarioId])

  const currentMessage = () => mode === 'CAMERA'
    ? cameraWait(display.shield, visionRef.current, performance.now()).message
    : display.shield?.message ?? MESSAGES.WAIT
  const changeAudio = (enabled) => {
    setAudioEnabled(enabled)
    audioEnabledRef.current = enabled
    if (enabled) announcerRef.current.announce(currentMessage(), performance.now(), { force: true })
    else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  }
  const replay = () => announcerRef.current.announce(currentMessage(), performance.now(), { force: true })
  const saveImage = () => {
    if (mode !== 'CAMERA' || !freshConnection(cameraStatus, Date.now()) || !latestImageRef.current) return
    const url = URL.createObjectURL(latestImageRef.current)
    const a = document.createElement('a')
    a.href = url
    a.download = `clip-${cameraStatus.boot}-${cameraStatus.seq}.jpg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="app">
      <div className="safety-banner">
        <span>⚠️ 기술 검증용 시제품입니다. 실제 보행 판단이나 안전 보장에 사용할 수 없습니다.</span>
        <span className="badge badge-manual-target">MANUAL TARGET BINDING</span>
      </div>
      <header className="app-header">
        <h1>ClipSense — SafeGraph-RTA</h1>
        <p>Boolean-AND 기준선 vs SafeGraph-RTA 실시간 A/B 비교 · 결함주입 시연 프로토타입</p>
      </header>

      <main className="main-grid">
        {/* CameraView는 절대 조건부로 언마운트/이동시키지 않는다 — 트리 위치는
            고정하고 콘솔/제품 모드 전환은 이 래퍼의 className만 바꿔 CSS로만
            위치를 옮긴다(콘솔: 레이아웃 안 / 제품: 우하단 PiP). 카메라 비전이
            여기서 멈추면 촬영 중 shield가 WAIT으로 떨어진다. */}
        <div className={viewMode === 'product' ? 'cam-pip' : 'cam-console'}>
          {mode === 'CAMERA' ? (
            <CameraView
              mode={videoSourceKind === 'ESP32' ? 'esp32' : 'camera'}
              espUrl={espConnection?.url ?? ''}
              espToken={espConnection?.token ?? ''}
              connectionId={espConnection?.id}
              onStatus={setCameraStatus}
              onVision={onCameraVision}
            />
          ) : (
            <div className="camera-view scenario-placeholder">
              <div className="scenario-placeholder-body">
                <button className="camera-start" onClick={() => setMode('CAMERA')}>ESP32 카메라로 신호등 인식 시작</button>
                <p>ESP32와 같은 Wi-Fi에서 기기 주소와 접속 토큰을 입력해 주세요.</p>
                <div className="scenario-placeholder-title">시나리오 모드</div>
                <div className="scenario-placeholder-label">{SCENARIOS[scenarioId]?.label}</div>
                <div className="scenario-placeholder-desc">{SCENARIOS[scenarioId]?.description}</div>
                <span className="badge badge-mock">MOCK 재생 중 — TICK_MS={TICK_MS}</span>
              </div>
            </div>
          )}
        </div>
        <SourcePanel
          target={display.target}
          cits={display.cits}
          vision={display.vision}
          ages={display.ages}
          citsNetworkState={mode === 'CAMERA' ? citsConn : null}
          videoSourceLabel={mode === 'CAMERA' ? (videoSourceKind === 'ESP32' ? 'ESP32 스냅샷' : '내장 카메라') : null}
        />
      </main>

      {mode === 'CAMERA' && (
        <section className="video-source-bar" aria-label="영상 입력 소스">
          <span className="row-label">영상 입력</span>
          <button
            className={videoSourceKind === 'BUILTIN' ? 'on' : ''}
            onClick={() => setVideoSourceKind('BUILTIN')}
          >
            내장 카메라
          </button>
          <button
            className={videoSourceKind === 'ESP32' ? 'on' : ''}
            onClick={() => setVideoSourceKind('ESP32')}
          >
            ESP32
          </button>
          {videoSourceKind === 'ESP32' && (<>
            <input
              className="esp32-url-input"
              type="text"
              aria-label="ESP32 주소" placeholder="ESP32 주소 (예: http://192.168.0.50)"
              value={espUrl}
              onChange={(e) => setEspUrl(e.target.value)}
            />
            <input className="esp32-url-input" type="password" aria-label="ESP32 기기 토큰"
              placeholder="기기 접속 토큰" autoComplete="off" value={espToken}
              onChange={(e) => setEspToken(e.target.value)} />
            <button onClick={() => setEspConnection({ url: espUrl.trim(), token: espToken, id: Date.now() })}>ESP32 연결</button>
            <p>ESP32와 같은 Wi-Fi의 PC에서 개발 서버로 실행해 주세요. 기기 토큰은 이 탭의 메모리에만 보관됩니다.</p>
          </>)}
        </section>
      )}

      <EvidencePanel liveMode={mode === 'CAMERA'} status={cameraStatus} vision={cameraVision}
        decision={mode === 'CAMERA' ? cameraWait(display.shield, cameraVision, performance.now()) : display.shield} speech={speech} audioEnabled={audioEnabled}
        onAudio={() => changeAudio(!audioEnabled)} onReplay={replay} onSaveImage={saveImage} />

      <SafetyGatePanel checks={display.shield?.checks} failedChecks={display.shield?.failedChecks} />

      <ComparisonPanel
        baselineRaw={display.baselineRaw}
        baselineStabilized={display.baselineStabilized}
        shield={display.shield}
      />

      <ScenarioBar
        mode={mode}
        setMode={setMode}
        scenarioId={scenarioId}
        setScenarioId={setScenarioId}
        audioEnabled={audioEnabled}
        setAudioEnabled={changeAudio}
      />

      <section className="view-mode-bar" aria-label="화면 모드">
        <button className="view-mode-btn" onClick={() => setViewMode('product')}>
          📱 제품 화면
        </button>
      </section>

      <section className="log-strip" aria-label="라이브 로그">
        <button className="log-download-btn" onClick={downloadLog}>
          로그 다운로드 (JSONL)
        </button>
        <span className="log-count">기록 {logCount}건</span>
        <span className="log-e2e">
          E2E p95: {Number.isFinite(e2eStats.p95Ms) ? `${Math.round(e2eStats.p95Ms)}ms` : '—'}
        </span>
      </section>

      {!display.shield && (
        <p className="boot-hint">신호 대기 중… (표시된 판정은 {MESSAGES.WAIT})</p>
      )}

      {viewMode === 'product' && (
        <ProductView
          shieldOut={display.shield}
          citsConnected={mode === 'CAMERA' ? citsConn === '연결됨' : Boolean(display.cits?.available)}
          audioOn={audioEnabled}
          liveMode={mode === 'CAMERA'}
          cameraConnected={freshConnection(cameraStatus, Date.now())}
          onExit={() => setViewMode('console')}
        />
      )}
    </div>
  )
}
