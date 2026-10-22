import { afterEach, expect, it, vi } from 'vitest'
import { requestDeadline } from '../../src/sources/requestDeadline.js'
afterEach(() => vi.useRealTimers())
it('AbortSignal.any/timeout 없이 기한에 따라 중단한다', () => {
  vi.useFakeTimers()
  const d = requestDeadline(null, 100)
  expect(d.signal.aborted).toBe(false)
  vi.advanceTimersByTime(100)
  expect(d.signal.aborted).toBe(true); expect(d.timedOut).toBe(true)
  d.dispose()
})
it('상위 취소를 전달하고 정리 후에는 타이머가 동작하지 않는다', () => {
  vi.useFakeTimers()
  const parent = new AbortController(), d = requestDeadline(parent.signal, 100)
  parent.abort(); expect(d.signal.aborted).toBe(true); expect(d.timedOut).toBe(false)
  d.dispose(); vi.advanceTimersByTime(100); expect(d.timedOut).toBe(false)
})
it('이미 취소된 부모와 응답 완료 후 정리를 지원한다', () => {
  vi.useFakeTimers()
  const parent = new AbortController(); parent.abort()
  const cancelled = requestDeadline(parent.signal, 100)
  expect(cancelled.signal.aborted).toBe(true); cancelled.dispose()
  const completed = requestDeadline(null, 100)
  completed.dispose(); vi.advanceTimersByTime(100); expect(completed.signal.aborted).toBe(false)
})
