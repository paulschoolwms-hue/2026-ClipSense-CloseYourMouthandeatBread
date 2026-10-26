// 실제 클립 실험의 정책. 실시간 신호 API를 구현하기 전에는 색상과 무관하게 WAIT.
export const EVIDENCE_VERSION = 'clipsense-evidence-v1'
export const MAX_FRAME_AGE_MS = 2000

export function cameraWait(base, vision, nowMonoMs) {
  const age = nowMonoMs - (vision?.capturedAtMonoMs ?? -Infinity)
  const fresh = Number.isFinite(age) && age >= 0 && age <= MAX_FRAME_AGE_MS && vision?.frameAvailable !== false
  const color = fresh && vision?.quality > 0 ? vision.color : 'unknown'
  const message = !fresh
    ? '카메라 영상이 없거나 오래되었습니다. 대기하세요.'
    : color === 'red' ? '빨간 색상이 감지됐습니다. 대기하세요.'
      : color === 'green' ? '초록 색상이 감지됐지만 실제 남은 시간을 확인할 수 없습니다. 대기하세요.'
        : '신호등을 확인할 수 없습니다. 대기하세요.'
  return { ...base, decision: 'WAIT', reason: !fresh ? 'VISION_STALE' : 'CITS_MISSING',
    message, effectiveRemainingSec: 0, checks: { ...base?.checks, citsAvailable: false, timeSufficient: false }, failedChecks: [...new Set([...(base?.failedChecks ?? []), 'CITS_MISSING'])] }
}

export function freshConnection(status, nowEpochMs) {
  return status?.state === 'connected' && Number.isFinite(status.lastSuccessAt) &&
    nowEpochMs - status.lastSuccessAt >= 0 && nowEpochMs - status.lastSuccessAt <= MAX_FRAME_AGE_MS
}

export function evidenceRow({ status, vision, decision, expected, sceneKind, heard, speech, nowEpochMs, nowMonoMs }) {
  if (!freshConnection(status, nowEpochMs)) throw new Error('새 ESP32 사진을 받은 뒤 기록해 주세요. 연결 끊김은 별도 장애 장면으로 기록하세요.')
  if (status.inputKind !== 'ESP32') throw new Error('실제 클립 증거는 ESP32 입력에서 기록해 주세요.')
  if (vision?.deviceFrameSeq !== status.seq || vision?.deviceBootId !== status.boot ||
      nowMonoMs - vision.capturedAtMonoMs > MAX_FRAME_AGE_MS) throw new Error('판독과 사진의 프레임이 아직 일치하지 않습니다. 다음 사진 수신 후 다시 기록하세요.')
  return { recordedAt: new Date(nowEpochMs).toISOString(), expected, sceneKind,
    heard: heard ?? '미확인', source: status.sensor === 'SIM' ? 'SIMULATOR' : status.frameSource === 'laptop-upload' ? 'LAPTOP_RELAY' : ['OV2640', 'OV3660', 'OV5640'].includes(status.sensor) ? 'ESP32_CAMERA' : 'UNVERIFIED_SOURCE',
    device: { bootId: status.boot, frameSeq: status.seq, captureUptimeUs: status.captureUs,
      sensor: status.sensor, firmware: status.firmware, width: status.width, height: status.height, rotationDeg: status.rotationDeg ?? 0,
      profile: status.profile ?? null, jpegQuality: status.jpegQuality ?? null,
      rssiDbm: status.rssiDbm ?? null, requestMs: status.requestMs ?? null,
      frameAgeMs: status.frameAgeMs ?? null, fps: status.fps ?? null },
    receivedAt: new Date(status.lastSuccessAt).toISOString(),
    vision: { color: vision?.color ?? 'unknown', score: vision?.score ?? 0, quality: vision?.quality ?? 0,
      ageMs: nowMonoMs - (vision?.capturedAtMonoMs ?? nowMonoMs) },
    final: { decision: decision?.decision ?? 'WAIT', message: decision?.message ?? '', realRemainingSec: null },
    speech: speech ? { message: speech.message, state: speech.state, at: speech.at, error: speech.error ?? null } : null }
}

export function csvRows(rows) {
  const cell = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"'
  const data = [['기록 시각 UTC', '장면 종류', '정답', '입력 출처', 'bootId', 'frameSeq', '판독 색상', '점수', '최종 판정', '화면 안내', '음성 이벤트', '음성 문구', '실제 청취 확인']]
  for (const row of rows) data.push([row.recordedAt, row.sceneKind, row.expected, row.source, row.device.bootId, row.device.frameSeq,
    row.vision.color, row.vision.score, row.final.decision, row.final.message, row.speech?.state, row.speech?.message, row.heard])
  return '\uFEFF' + data.map((r) => r.map(cell).join(',')).join('\r\n')
}
