import { useEffect, useRef, useState } from 'react'
import { analyzeFrame, REGION_RATIO } from '../vision/signalDetector.js'
import { startCamera, stopStream, grabFrame, cameraErrorMessage } from '../sources/videoSource.js'

import { fetchSnapshot } from '../sources/esp32Snapshot.js'

const ANALYZE_MS = 300
const STEP = 4 // 다운샘플 간격(px) — quality 산식은 analyzeFrame과 별개로 독립 계산

/**
 * ROI(REGION_RATIO 상단) 프레임 품질 산식 (스펙 §2.10 "구현 파일에 산식 주석 문서화"):
 *
 *   quality = validPixelRatio × normalizedAvgBrightness
 *
 * - validPixelRatio: ROI 내 샘플링된 픽셀 중 "유효"(완전한 검정이 아닌, 즉
 *   alpha>0이고 r|g|b 중 하나라도 0을 넘는) 픽셀의 비율. 카메라 미기동·크롭
 *   실패 등으로 프레임이 비어있으면 0에 수렴한다.
 * - normalizedAvgBrightness: ROI 내 유효 픽셀의 HSV V(명도, 0~1)를 평균한
 *   값. 너무 어둡거나(저조도) 완전 포화(과다노출)여도 신호색 판별
 *   신뢰도가 낮아지므로, 평균 명도가 0.5(중간 밝기)에 가까울수록 1에
 *   가깝고 양 극단(0 또는 1)에 가까울수록 0에 가까워지도록
 *   `1 - |v - 0.5| / 0.5` 로 정규화한다.
 *
 * 두 항의 곱은 [0,1] 범위이며, "픽셀이 충분히 채워져 있고 동시에 밝기가
 * 신호색 판별에 적합한 중간 대역인가"를 함께 반영한다. contracts.js의
 * `validateVisionObservation`이 요구하는 quality ∈ [0,1] 계약을 만족한다.
 */
function computeQuality(frame) {
  if (!frame || !frame.data || !frame.width || !frame.height) return 0
  const { data, width, height } = frame
  const regionH = Math.floor(height * REGION_RATIO)
  if (regionH <= 0 || width <= 0) return 0

  let sampled = 0
  let valid = 0
  let brightnessSum = 0

  for (let y = 0; y < regionH; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      sampled++
      if (a > 0 && (r > 0 || g > 0 || b > 0)) {
        valid++
        const v = Math.max(r, g, b) / 255
        brightnessSum += v
      }
    }
  }

  if (sampled === 0) return 0
  const validPixelRatio = valid / sampled
  if (valid === 0) return 0
  const avgV = brightnessSum / valid
  const normalizedAvgBrightness = Math.max(0, 1 - Math.abs(avgV - 0.5) / 0.5)
  return Math.min(1, Math.max(0, validPixelRatio * normalizedAvgBrightness))
}

/**
 * 내장 카메라(또는 ESP32 스트림) 프레임을 주기적으로 캡처해 onVision으로
 * 전달한다. 기존 v1 계약(`{ color, confidence }`)은 그대로 유지하고,
 * 스펙 §2.10에 따라 SafeGraph-RTA vision observation 매핑에 필요한
 * `frameSeq`(단조 증가 카운터) · `capturedAtMonoMs`(performance.now(),
 * UI 계층이므로 허용 — 안전 코어에는 clock 인자로 전달됨) · `quality`를
 * 추가한다.
 */
export default function CameraView({ mode, espUrl, espToken, onVision }) {
  const videoRef = useRef(null)
  const imgRef = useRef(null)
  const canvasRef = useRef(document.createElement('canvas'))
  const onVisionRef = useRef(onVision)
  onVisionRef.current = onVision
  const frameSeqRef = useRef(0)
  const [error, setError] = useState(null)
  const [facing, setFacing] = useState('environment')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const [ready, setReady] = useState(false)
  const lastFrameAtRef = useRef(0)
  const lastVideoTimeRef = useRef(-1)

  useEffect(() => {
    let stream = null
    let cancelled = false
    setError(null)
    setReady(false)
    setResult(null)
    lastVideoTimeRef.current = -1
    lastFrameAtRef.current = 0
    onVisionRef.current({ color: 'unknown', confidence: 0, quality: 0,
      frameSeq: ++frameSeqRef.current, capturedAtMonoMs: performance.now() })
    if (mode === 'camera') {
      startCamera(videoRef.current, facing, () => cancelled)
        .then((s) => { if (cancelled) stopStream(s); else { stream = s; setReady(Boolean(s)) } })
        .catch((e) => { if (!cancelled) setError(cameraErrorMessage(e)) })
    }
    return () => { cancelled = true; stopStream(stream) }
  }, [mode, facing, attempt])

  useEffect(() => {
    if (mode !== 'esp32') return undefined
    let cancelled = false
    let timer
    let previous = null
    let objectUrl = null
    const controller = new AbortController()
    setResult(null)
    setError(null)
    if (!espUrl) return undefined
    const poll = async () => {
      try {
        const shot = await fetchSnapshot(espUrl, espToken, previous,
          AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
        if (cancelled) return
        const nextUrl = URL.createObjectURL(shot.blob)
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        objectUrl = nextUrl
        const image = imgRef.current
        image.src = objectUrl
        await image.decode()
        if (cancelled) return
        const frame = grabFrame(image, canvasRef.current)
        if (!frame) throw new Error('ESP32 JPEG 영상을 읽을 수 없습니다.')
        previous = shot
        const base = analyzeFrame(frame)
        setResult(base)
        setError(null)
        onVisionRef.current({ ...base, frameSeq: ++frameSeqRef.current,
          capturedAtMonoMs: shot.capturedAtMonoMs, quality: computeQuality(frame) })
      } catch (e) {
        if (cancelled) return
        setResult(null)
        setError(e.name === 'TimeoutError' ? 'ESP32 응답 시간 초과. 같은 Wi-Fi와 기기 전원을 확인해 주세요.' : e.message)
        onVisionRef.current({ color: 'unknown', confidence: 0, quality: 0,
          frameSeq: ++frameSeqRef.current, capturedAtMonoMs: performance.now() })
      } finally {
        if (!cancelled) timer = setTimeout(poll, ANALYZE_MS)
      }
    }
    poll()
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [mode, espUrl, espToken])

  useEffect(() => {
    if (mode !== 'camera') return undefined
    const id = setInterval(() => {
      const el = mode === 'camera' ? videoRef.current : imgRef.current
      if (!el) return
      // A paused video must age out instead of acquiring a fresh timestamp.
      if (mode === 'camera' && (!ready || el.readyState < 2 ||
          el.currentTime === lastVideoTimeRef.current)) {
        if (performance.now() - lastFrameAtRef.current > 1500) setResult(null)
        return
      }
      const frame = grabFrame(el, canvasRef.current)
      if (mode === 'camera') lastVideoTimeRef.current = el.currentTime
      if (frame) lastFrameAtRef.current = performance.now()
      frameSeqRef.current += 1
      const base = frame ? analyzeFrame(frame) : { color: 'unknown', confidence: 0 }
      setResult(frame ? base : null)
      onVisionRef.current({
        ...base,
        frameSeq: frameSeqRef.current,
        capturedAtMonoMs: performance.now(),
        quality: computeQuality(frame),
      })
    }, ANALYZE_MS)
    return () => clearInterval(id)
  }, [mode, ready, facing, attempt])

  return (
    <div className="camera-view">
      {mode === 'camera' ? (
        <video ref={videoRef} muted playsInline autoPlay aria-label="신호등 인식 카메라" />
      ) : (
        <img ref={imgRef} alt="ESP32 카메라 영상" />
      )}
      <div className="region-line" style={{ top: `${REGION_RATIO * 100}%` }} />
      <span className="region-label">↑ 신호등 분석 영역</span>
      <div className={`camera-result camera-result-${result?.color ?? 'unknown'}`} role="status" aria-live="polite">
        {result?.color === 'red' ? '🔴 빨간 신호 감지' : result?.color === 'green' ? '🟢 초록 신호 감지' : '신호등을 분석 영역에 맞춰 주세요'}
        {result?.color !== 'unknown' && result && <small>색상 점수 {Math.round(result.confidence * 100)}%</small>}
      </div>
      {mode === 'camera' && <div className="camera-controls">
        <button onClick={() => setFacing((v) => v === 'environment' ? 'user' : 'environment')}>카메라 전환</button>
        <button onClick={() => setAttempt((v) => v + 1)}>다시 연결</button>
      </div>}
      {mode === 'esp32' && !espUrl && <div className="camera-loading">아래에서 ESP32 주소와 기기 토큰을 입력하고 ESP32 연결을 눌러 주세요.</div>}
      {mode === 'camera' && !ready && !error && <div className="camera-loading" role="status">카메라 연결 중 · 접근 권한을 허용해 주세요</div>}
      {error && <div className="camera-error" role="alert"><span>{error}</span>
        {mode === 'camera' && <button onClick={() => setAttempt((v) => v + 1)}>다시 시도</button>}
      </div>}
    </div>
  )
}
