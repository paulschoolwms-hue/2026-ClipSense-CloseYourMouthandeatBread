/** AbortSignal.any/timeout가 없는 Safari에서도 취소/시간 제한을 보존한다. */
export function requestDeadline(parent, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  if (parent?.aborted) cancel()
  else parent?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  return { signal: controller.signal, get timedOut() { return timedOut },
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', cancel) } }
}
