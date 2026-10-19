let speechGeneration = 0

export function speakMessage(message, onEvent = () => {}) {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    onEvent({ state: 'unsupported', message, at: new Date().toISOString() })
    return false
  }
  const generation = ++speechGeneration
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(message)
  u.lang = 'ko-KR'
  u.rate = 1.05
  const emit = (state, error) => { if (generation === speechGeneration) onEvent({ state, message, at: new Date().toISOString(), ...(error ? { error } : {}) }) }
  u.onstart = () => emit('started')
  u.onend = () => emit('ended')
  u.onerror = (e) => emit('error', e.error)
  emit('requested')
  speechSynthesis.speak(u)
  return true // 요청 성공일 뿐 실제 소리를 증명하지 않는다.
}

export function createAnnouncer({ speak = speakMessage, cooldownMs = 4000 } = {}) {
  let lastMessage = null
  let lastAt = -Infinity
  return {
    announce(message, nowMs, { force = false } = {}) {
      if (!message || (!force && message === lastMessage && nowMs - lastAt < cooldownMs)) return false
      if (speak(message) === false) return false
      lastMessage = message
      lastAt = nowMs
      return true
    },
  }
}
