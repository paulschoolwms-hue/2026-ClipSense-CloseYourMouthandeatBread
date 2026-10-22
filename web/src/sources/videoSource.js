/** 모바일 후면 카메라를 우선 사용하고, 시작 실패 시 장치를 반환한다. */
export async function startCamera(videoEl, facingMode = 'environment', isCancelled = () => false) {
  if (!globalThis.isSecureContext) {
    throw new Error('카메라는 HTTPS 또는 localhost에서 사용할 수 있습니다.')
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('이 브라우저는 카메라를 지원하지 않습니다. Chrome 또는 Safari에서 열어 주세요.')
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 640 } },
      audio: false,
    })
    if (isCancelled()) { stopStream(stream); return null }
    videoEl.srcObject = stream
    await videoEl.play()
    if (isCancelled()) { stopStream(stream); return null }
    return stream
  } catch (error) {
    stopStream(stream)
    throw error
  }
}

export function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError': return '카메라 권한을 허용한 뒤 다시 시도해 주세요.'
    case 'NotFoundError': return '연결된 카메라가 없습니다. 카메라 연결을 확인해 주세요.'
    case 'NotReadableError': return '다른 앱이 카메라를 사용 중입니다. 해당 앱을 닫고 다시 시도해 주세요.'
    default: return error?.message || '카메라를 시작하지 못했습니다. 다시 시도해 주세요.'
  }
}

export function stopStream(stream) {
  stream?.getTracks?.().forEach((t) => t.stop())
}

const TARGET_W = 320 // 분석용 다운스케일 폭 — 320이면 HSV 스캔이 60fps에도 여유

/** video/img 요소의 현재 프레임을 축소해 ImageData로 반환. 준비 안 됐으면 null. */
export function grabFrame(el, canvas, rotationDeg = 0) {
  const srcW = el.videoWidth ?? el.naturalWidth ?? 0
  const srcH = el.videoHeight ?? el.naturalHeight ?? 0
  if (!srcW || !srcH) return null
  const w = TARGET_W
  const h = Math.round((srcH / srcW) * TARGET_W)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    // CSS 미리보기와 동일하게 회전한 픽셀을 분석한다. 분석 영역은 회전 후 상단이다.
    if (rotationDeg === 180) {
      ctx.translate(w, h)
      ctx.rotate(Math.PI)
    }
    ctx.drawImage(el, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  } catch {
    return null // ESP32 CORS 미허용 등 — 불확실하면 null → 비전 unknown → WAIT
  }
}
