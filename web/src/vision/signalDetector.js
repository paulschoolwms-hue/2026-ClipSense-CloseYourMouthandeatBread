// 버전 고정 색상·연결 영역 규칙. 학습 모델이나 보행자 모양 분류기가 아니다.
export const DETECTOR_CONFIG = Object.freeze({ version: 'hsv-components-v3', regionRatio: 0.6,
  sampleStep: 2, minRatio: 0.0012, fullRatio: 0.025, minPixels: 4,
  maxRatio: 0.35, minAspect: 0.15, maxAspect: 2.5, minFill: 0.15,
  redHueMax: 28, redHueMin: 338, greenHueMin: 75, greenHueMax: 195,
  minSaturation: 0.3, minBrightness: 0.25 })
export const REGION_RATIO = DETECTOR_CONFIG.regionRatio

export function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** 색 마스크의 8방향 연결 영역에서 흩어진 잡음·큰 면·극단적으로 가는 영역을 제외한다. */
function largestCandidate(mask, width, height, color) {
  const cfg = DETECTOR_CONFIG
  let best = null
  const visited = new Uint8Array(mask.length)
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== color || visited[start]) continue
    const stack = [start]
    visited[start] = 1
    let count = 0, minX = width, minY = height, maxX = 0, maxY = 0
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = Math.floor(p / width)
      count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      const neighbors = []
      if (x > 0) neighbors.push(p - 1)
      if (x + 1 < width) neighbors.push(p + 1)
      if (y > 0) neighbors.push(p - width)
      if (y + 1 < height) neighbors.push(p + width)
      if (x > 0 && y > 0) neighbors.push(p - width - 1)
      if (x + 1 < width && y > 0) neighbors.push(p - width + 1)
      if (x > 0 && y + 1 < height) neighbors.push(p + width - 1)
      if (x + 1 < width && y + 1 < height) neighbors.push(p + width + 1)
      for (const n of neighbors) if (!visited[n] && mask[n] === color) { visited[n] = 1; stack.push(n) }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1
    const ratio = count / mask.length, aspect = w / h, fill = count / (w * h)
    if (count < cfg.minPixels || ratio < cfg.minRatio || ratio > cfg.maxRatio ||
        aspect < cfg.minAspect || aspect > cfg.maxAspect || fill < cfg.minFill) continue
    if (!best || count > best.count) best = { count, ratio, aspect, fill, x: minX * cfg.sampleStep,
      y: minY * cfg.sampleStep, width: w * cfg.sampleStep, height: h * cfg.sampleStep }
  }
  return best
}

export function analyzeFrame(frame) {
  const unknown = { color: 'unknown', confidence: 0, candidate: null }
  if (!frame?.data || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
      frame.width <= 0 || frame.height <= 0 || frame.data.length < frame.width * frame.height * 4) return unknown
  const cfg = DETECTOR_CONFIG, step = cfg.sampleStep
  const cols = Math.ceil(frame.width / step), rows = Math.ceil(Math.floor(frame.height * REGION_RATIO) / step)
  if (!rows) return unknown
  const mask = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = (y * step * frame.width + x * step) * 4
    if (frame.data[i + 3] === 0) continue
    const { h, s, v } = rgbToHsv(frame.data[i], frame.data[i + 1], frame.data[i + 2])
    if (s <= cfg.minSaturation || v <= cfg.minBrightness) continue
    if (h <= cfg.redHueMax || h >= cfg.redHueMin) mask[y * cols + x] = 1
    else if (h >= cfg.greenHueMin && h <= cfg.greenHueMax) mask[y * cols + x] = 2
  }
  const red = largestCandidate(mask, cols, rows, 1), green = largestCandidate(mask, cols, rows, 2)
  if ((!red && !green) || (red && green)) return unknown // 두 색이 함께 검출되면 추측하지 않는다.
  const candidate = red ?? green
  return { color: red ? 'red' : 'green', confidence: Math.min(1, candidate.ratio / cfg.fullRatio), candidate }
}
