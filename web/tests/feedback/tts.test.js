import { describe, it, expect, vi } from 'vitest'
import { createAnnouncer } from '../../src/feedback/tts.js'

describe('announcer', () => {
  it('새 메시지는 발화, 같은 메시지는 쿨다운 내 침묵', () => {
    const speak = vi.fn()
    const a = createAnnouncer({ speak, cooldownMs: 4000 })
    expect(a.announce('지금 건너셔도 됩니다', 0)).toBe(true)
    expect(a.announce('지금 건너셔도 됩니다', 2000)).toBe(false)
    expect(speak).toHaveBeenCalledTimes(1)
  })
  it('쿨다운 경과 후 같은 메시지 재발화', () => {
    const speak = vi.fn()
    const a = createAnnouncer({ speak, cooldownMs: 4000 })
    a.announce('시간이 부족합니다', 0)
    expect(a.announce('시간이 부족합니다', 4100)).toBe(true)
    expect(speak).toHaveBeenCalledTimes(2)
  })
  it('다른 메시지는 쿨다운 무관 즉시 발화', () => {
    const speak = vi.fn()
    const a = createAnnouncer({ speak, cooldownMs: 4000 })
    a.announce('빨간불입니다. 대기하세요', 0)
    expect(a.announce('지금 건너셔도 됩니다', 500)).toBe(true)
  })
  it('빈 메시지는 발화하지 않음', () => {
    const speak = vi.fn()
    const a = createAnnouncer({ speak })
    expect(a.announce('', 0)).toBe(false)
    expect(a.announce(null, 0)).toBe(false)
    expect(speak).not.toHaveBeenCalled()
  })
})

describe('발화 요청과 청취를 혼동하지 않는다', () => {
  it('미지원/거부된 발화는 성공 요청으로 처리하지 않는다', () => {
    const a = createAnnouncer({ speak: () => false })
    expect(a.announce('대기하세요', 0)).toBe(false)
  })
  it('사용자 다시 듣기는 같은 메시지도 즉시 요청한다', () => {
    const speak = vi.fn()
    const a = createAnnouncer({ speak })
    a.announce('대기하세요', 0)
    expect(a.announce('대기하세요', 1, { force: true })).toBe(true)
    expect(speak).toHaveBeenCalledTimes(2)
  })
})
