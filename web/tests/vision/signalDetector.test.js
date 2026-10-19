import { describe, it, expect } from 'vitest'
import { analyzeFrame, rgbToHsv, REGION_RATIO } from '../../src/vision/signalDetector.js'

/** w×h 프레임을 base색으로 채우고, blocks[{x,y,w,h,rgb}]를 덧그린다 */
function makeFrame(width, height, baseRgb, blocks = []) {
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, baseRgb)
  for (const bl of blocks)
    for (let y = bl.y; y < bl.y + bl.h; y++)
      for (let x = bl.x; x < bl.x + bl.w; x++) put(x, y, bl.rgb)
  return { data, width, height }
}

const GRAY = [128, 128, 128]
const GREEN = [0, 230, 120]   // 보행 신호 초록 (h≈151)
const RED = [255, 20, 40]     // 신호 빨강 (h≈355)

describe('rgbToHsv', () => {
  it('순수 초록/빨강/무채색 변환', () => {
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 0)
    expect(rgbToHsv(255, 0, 0).h).toBeCloseTo(0, 0)
    const gray = rgbToHsv(128, 128, 128)
    expect(gray.s).toBeCloseTo(0, 2)
  })
})

describe('analyzeFrame', () => {
  it('상단에 충분한 초록 광원 → green, confidence 1', () => {
    const f = makeFrame(100, 100, GRAY, [{ x: 40, y: 10, w: 20, h: 20, rgb: GREEN }])
    const r = analyzeFrame(f)
    expect(r.color).toBe('green')
    expect(r.confidence).toBeCloseTo(1, 1)
  })
  it('상단에 빨강 광원 → red', () => {
    const f = makeFrame(100, 100, GRAY, [{ x: 40, y: 10, w: 20, h: 20, rgb: RED }])
    expect(analyzeFrame(f).color).toBe('red')
  })
  it('무채색 화면 → unknown, confidence 0', () => {
    const r = analyzeFrame(makeFrame(100, 100, GRAY))
    expect(r.color).toBe('unknown')
    expect(r.confidence).toBe(0)
  })
  it('하단(REGION_RATIO 밖) 초록은 무시된다 — 신호등은 위쪽에 있다', () => {
    const yBelow = Math.floor(100 * REGION_RATIO) + 5
    const f = makeFrame(100, 100, GRAY, [{ x: 40, y: yBelow, w: 20, h: 20, rgb: GREEN }])
    expect(analyzeFrame(f).color).toBe('unknown')
  })
  it('아주 작은 초록(노이즈 수준) → unknown', () => {
    const f = makeFrame(100, 100, GRAY, [{ x: 50, y: 10, w: 2, h: 2, rgb: GREEN }])
    expect(analyzeFrame(f).color).toBe('unknown')
  })
  it('무효 입력 → unknown (Fail-Safe)', () => {
    expect(analyzeFrame(null).color).toBe('unknown')
    expect(analyzeFrame({}).color).toBe('unknown')
  })
})

describe('연결 영역과 색상 모호성', () => {
  it('화면 전체 초록 벽을 신호로 인정하지 않는다', () => {
    expect(analyzeFrame(makeFrame(100, 100, GREEN)).color).toBe('unknown')
  })
  it('빨강과 초록 후보가 함께 있으면 추측하지 않는다', () => {
    const f = makeFrame(100, 100, GRAY, [{ x: 10, y: 10, w: 20, h: 20, rgb: RED }, { x: 60, y: 10, w: 20, h: 20, rgb: GREEN }])
    expect(analyzeFrame(f).color).toBe('unknown')
  })
  it('흩어진 단일 픽셀과 가늘고 긴 선을 제외한다', () => {
    const blocks = []
    for (let y = 0; y < 50; y += 8) for (let x = 0; x < 100; x += 8) blocks.push({ x, y, w: 2, h: 2, rgb: GREEN })
    expect(analyzeFrame(makeFrame(100, 100, GRAY, blocks)).color).toBe('unknown')
    expect(analyzeFrame(makeFrame(100, 100, GRAY, [{ x: 10, y: 10, w: 80, h: 2, rgb: GREEN }])).color).toBe('unknown')
  })
  it('투명 픽셀과 잘린 프레임을 신호로 인정하지 않는다', () => {
    const f = makeFrame(100, 100, GREEN); for (let i = 3; i < f.data.length; i += 4) f.data[i] = 0
    expect(analyzeFrame(f).color).toBe('unknown')
    expect(analyzeFrame({ width: 100, height: 100, data: new Uint8Array(5) }).color).toBe('unknown')
  })
})
