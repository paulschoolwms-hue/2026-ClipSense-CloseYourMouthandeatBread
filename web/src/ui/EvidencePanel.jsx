import { useEffect, useRef, useState } from 'react'
import { EVIDENCE_VERSION, csvRows, evidenceRow, freshConnection } from '../demo/evidence.js'
import { DETECTOR_CONFIG } from '../vision/signalDetector.js'

const COLORS = { red: '빨강', green: '초록', unknown: '신호 없음/불명' }
const SPEECH = { requested: '발화 요청', started: '브라우저 발화 시작', ended: '브라우저 발화 종료', error: '발화 오류', unsupported: '음성 미지원' }
const REVISION = typeof __APP_REVISION__ === 'string' ? __APP_REVISION__ : 'unknown'
function saveFile(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function EvidencePanel({ liveMode, status, vision, decision, speech, audioEnabled, onAudio, onReplay, onSaveImage }) {
  const [now, setNow] = useState(Date.now())
  const [expected, setExpected] = useState('red')
  const [sceneKind, setSceneKind] = useState('화면에 표시한 테스트 사진')
  const [heard, setHeard] = useState('미확인')
  const [operators, setOperators] = useState('')
  const [conditions, setConditions] = useState('')
  const [rows, setRows] = useState([])
  const [notice, setNotice] = useState('')
  const eventsRef = useRef([])
  const droppedRef = useRef(0)
  const startedAt = useRef(new Date().toISOString())
  const connected = liveMode && freshConnection(status, now)
  const addEvent = (entry) => {
    eventsRef.current.push(entry)
    if (eventsRef.current.length > 2000) { eventsRef.current.shift(); droppedRef.current++ }
  }
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id) }, [])
  useEffect(() => {
    if (!liveMode || !status) return
    addEvent({ type: 'connection', at: new Date().toISOString(), ...status })

  }, [liveMode, status])
  useEffect(() => { if (speech) addEvent({ type: 'speech', ...speech }) }, [speech])
  const record = () => {
    try {
      if (!liveMode) throw new Error('실제 카메라 모드에서 기록해 주세요.')
      const row = evidenceRow({ status, vision, decision, expected, sceneKind, heard, speech,
        nowEpochMs: Date.now(), nowMonoMs: performance.now() })
      setRows((old) => [...old, row].slice(-200))
      setHeard('미확인'); setNotice('장면을 기록했습니다. 청취 확인은 사용자가 선택한 값이며 영상 증거가 별도로 필요합니다.')
    } catch (e) { setNotice(e.message) }
  }
  const fault = () => {
    addEvent({ type: 'manual_fault', at: new Date().toISOString(), state: status?.state ?? 'idle',
      error: status?.error ?? null, lastSuccessAt: status?.lastSuccessAt ?? null, decision: decision?.decision ?? 'WAIT' })
    setNotice('장애 장면을 세션 JSON에 기록했습니다. 이것은 새 사진 수신 증거가 아닙니다.')
  }
  const exportSession = () => {
    const bundle = { evidenceVersion: EVIDENCE_VERSION, revision: REVISION, startedAt: startedAt.current,
      exportedAt: new Date().toISOString(), operators, conditions,
      browser: { userAgent: navigator.userAgent, origin: location.origin, secureContext: isSecureContext,
        speechSupported: typeof speechSynthesis !== 'undefined' },
      detector: DETECTOR_CONFIG, realSignalApiConnected: false, realRemainingSec: null,
      rows, events: eventsRef.current, droppedEvents: droppedRef.current,
      limits: '최근 장면 최대 200개, 최근 이벤트 최대 2000개. 브라우저 음성 이벤트는 실제 청취 증거가 아니다. SIM/LAPTOP은 실촬영 증거가 아니다.' }
    saveFile('clipsense-evidence-session.json', JSON.stringify(bundle, null, 2), 'application/json')
  }
  const lastAt = status?.lastSuccessAt
  const age = Number.isFinite(lastAt) ? Math.max(0, (now - lastAt) / 1000).toFixed(1) : null
  return <section className="evidence-panel" aria-label="제출 증거 수집">
    <h2>실제 클립 검증 · 증거 수집</h2>
    <p className="evidence-warning">실시간 신호 API 미연결 · 실제 잔여시간 없음 → 최종 안내는 항상 대기. 모의 시나리오는 별도입니다.</p>
    {!liveMode && <p>아래 기록 기능은 카메라 모드에서 사용하세요. 현재 화면은 MOCK 시나리오입니다.</p>}
    <dl className="evidence-status">
      <dt>클립 연결</dt><dd data-testid="connection-state">{!liveMode ? '시나리오 재생 중' : connected ? '새 사진 수신 중' : status?.state === 'error' ? '연결 실패' : status?.state === 'connecting' ? '연결 시도 중' : status?.state === 'connected' ? '새 사진 없음/오래됨' : '미연결'}</dd>
      <dt>마지막 성공 수신</dt><dd data-testid="last-success">{lastAt ? `${new Date(lastAt).toLocaleTimeString()} · ${age}초 전` : '없음'}</dd>
      <dt>성공 사진 수</dt><dd data-testid="success-count">{status?.successCount ?? 0}</dd>
      <dt>기기 프레임 / 부팅 ID</dt><dd>{status?.seq ?? '—'} / {status?.boot ?? '—'}</dd>
      <dt>실제 입력 출처</dt><dd>{status?.inputKind === 'BUILTIN' ? '맥/내장 카메라 (클립 증거 아님)' : status?.sensor === 'SIM' ? 'SIM 시뮬레이터 (실촬영 아님)' : status?.frameSource === 'laptop-upload' ? '노트북 중계 (클립 실촬영 아님)' : status?.lastSuccessAt ? `ESP32 · ${status.sensor}` : '아직 확인되지 않음'}</dd>
      <dt>원본 / 펌웨어 / 요청 시간</dt><dd>{status?.width ?? '—'}×{status?.height ?? '—'} / {status?.firmware ?? '—'} / {Number.isFinite(status?.requestMs) ? `${Math.round(status.requestMs)}ms` : '—'}</dd>
      <dt>판독 / 최종 안내</dt><dd data-testid="final-guidance">{liveMode ? `${COLORS[vision?.color ?? 'unknown']} / 대기 · ${decision?.message ?? '카메라 영상을 기다리고 있습니다. 대기하세요.'}` : '모의 시나리오 — 실제 클립 결과와 구분하세요.'}</dd>
    </dl>
    <p>규칙 {DETECTOR_CONFIG.version} · 코드 {REVISION} · HSV 색상 + 연결 영역의 크기/종횡비/채움 검사. 학습 AI·보행자 모양 분류가 아닙니다.</p>
    <div className="evidence-actions">
      <button onClick={onAudio}>{audioEnabled ? '음성 끄기' : '음성 시작 (현재 안내 읽기)'}</button>
      <button onClick={onReplay} disabled={!audioEnabled}>현재 안내 다시 듣기</button>
      <button onClick={onSaveImage} disabled={!connected || status?.inputKind !== 'ESP32'}>현재 원본 JPEG 저장</button>
    </div>
    <p role="status" data-testid="speech-state">음성: {SPEECH[speech?.state] ?? '미시작'}{speech?.error ? ` (${speech.error})` : ''} · {speech?.message ?? '시작 버튼을 눌러 주세요.'}</p>
    <p>브라우저 발화 이벤트는 실제 소리의 증거가 아닙니다. 직접 듣고 아래에서 선택하고, 소리 포함 영상을 따로 촬영하세요.</p>
    <div className="evidence-fields">
      <label>실험자 <input value={operators} onChange={(e) => setOperators(e.target.value)} placeholder="다림 / 폴" /></label>
      <label>접속·촬영 조건 <input value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="Mac 모델, 브라우저 버전, Wi-Fi 이름/모드, 조명·거리" /></label>
      <label>장면 종류 <select value={sceneKind} onChange={(e) => setSceneKind(e.target.value)}>{['화면에 표시한 테스트 사진', '인쇄된 테스트 사진', '실제 신호등', '기타 통제된 입력'].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>장면의 정답 <select value={expected} onChange={(e) => setExpected(e.target.value)}>{Object.entries(COLORS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>이번 안내 직접 청취 <select value={heard} onChange={(e) => setHeard(e.target.value)}>{['미확인', '들림', '안 들림'].map((x) => <option key={x}>{x}</option>)}</select></label>
    </div>
    <div className="evidence-actions">
      <button onClick={record}>현재 장면 기록</button><button onClick={fault}>연결 장애 장면 기록</button>
      <button onClick={exportSession}>세션 JSON 다운로드</button>
      <button disabled={!rows.length} onClick={() => saveFile('clipsense-scenes.csv', csvRows(rows), 'text/csv;charset=utf-8')}>결과표 CSV 다운로드</button>
    </div>
    <p role="status">{notice}</p>
    <p>장면 {rows.length}건 기록 · 빨강/초록/신호 없음, 연속 갱신 영상, 음성·재실행 영상을 직접 확인해야 제출 완료입니다. 성공 판정은 자동 생성하지 않습니다.</p>
    <div className="evidence-table"><table><thead><tr><th>정답</th><th>판독</th><th>최종</th><th>입력 출처</th><th>기기 프레임</th><th>직접 청취</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{COLORS[r.expected]}</td><td>{COLORS[r.vision.color]}</td><td>{r.final.decision}</td><td>{r.source}</td><td>{r.device.frameSeq}</td><td>{r.heard}</td></tr>)}</tbody></table></div>
  </section>
}
