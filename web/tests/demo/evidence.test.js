import { describe, expect, it } from 'vitest'
import { cameraWait, evidenceRow, freshConnection, csvRows } from '../../src/demo/evidence.js'
const status = { inputKind: 'ESP32', state: 'connected', lastSuccessAt: 10000, sensor: 'OV3660', boot: 'abcd1234', seq: 7,
  captureUs: 100, width: 640, height: 480, firmware: '0.3.1' }
const vision = { color: 'green', confidence: 1, score: 1, quality: 0.9, capturedAtMonoMs: 9900, deviceFrameSeq: 7, deviceBootId: 'abcd1234' }
function row(extra = {}) { return evidenceRow({ status, vision, decision: cameraWait({}, vision, 10000), expected: 'green',
  sceneKind: '화면에 표시한 테스트 사진', nowEpochMs: 10000, nowMonoMs: 10000, ...extra }) }
describe('실제 입력의 대기 원칙', () => {
  it.each(['red', 'green', 'unknown'])('색상 %s도 실시간 잔여정보 없으면 WAIT', (color) => {
    const out = cameraWait({ decision: 'SIGNAL_CONFIRMED', effectiveRemainingSec: 30, checks: { citsAvailable: true } }, { ...vision, color }, 10000)
    expect(out.decision).toBe('WAIT'); expect(out.effectiveRemainingSec).toBe(0)
    expect(out.checks.citsAvailable).toBe(false); expect(out.message).toContain('대기')
  })
  it('오래된/미래/품질0 관측은 초록을 안내하지 않는다', () => {
    for (const v of [{ ...vision, capturedAtMonoMs: 1 }, { ...vision, capturedAtMonoMs: 10001 }, { ...vision, quality: 0 }]) {
      expect(cameraWait({}, v, 10000).message).not.toContain('초록')
    }
  })
})
describe('증거의 출처와 신선도', () => {
  it('오류/오래된/미래 수신을 성공으로 취급하지 않는다', () => {
    expect(freshConnection(status, 10000)).toBe(true)
    for (const s of [{ ...status, state: 'error' }, { ...status, lastSuccessAt: 1 }, { ...status, lastSuccessAt: 11000 }]) {
      expect(() => row({ status: s })).toThrow()
    }
  })
  it('SIM과 노트북 중계, 출처 미확인을 실제 클립과 구분한다', () => {
    expect(row().source).toBe('ESP32_CAMERA')
    expect(row({ status: { ...status, sensor: 'SIM' } }).source).toBe('SIMULATOR')
    expect(row({ status: { ...status, frameSource: 'laptop-upload' } }).source).toBe('LAPTOP_RELAY')
    expect(row({ status: { ...status, sensor: 'unknown' } }).source).toBe('UNVERIFIED_SOURCE')
  })
  it('내장 카메라와 불일치 프레임의 실촬영 기록을 거부한다', () => {
    expect(() => row({ status: { ...status, inputKind: 'BUILTIN' } })).toThrow()
    expect(() => row({ vision: { ...vision, deviceFrameSeq: 6 } })).toThrow('일치')
  })
  it('기기/판독/안내를 분리하고 실제 청취를 자동 성공시키지 않는다', () => {
    const r = row(); expect(r.vision.color).toBe('green'); expect(r.final.decision).toBe('WAIT')
    expect(r.heard).toBe('미확인'); expect(r.final.realRemainingSec).toBeNull()
    const csv = csvRows([r]); expect(csv).toContain('ESP32_CAMERA'); expect(csv).toContain('WAIT')
  })
})
