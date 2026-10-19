const COLOR_DOT = { green: '🟢', red: '🔴', unknown: '⚪' }
const COLOR_LABEL = { green: '초록', red: '빨강', unknown: '불명' }

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  return `${Math.round(ms)}ms`
}

function fmtSec(sec) {
  if (!Number.isFinite(sec)) return '—'
  return `${sec.toFixed(1)}초`
}

/** 실제 카메라 모드의 API 미연결과 MOCK 시나리오 입력을 구분한다. */
export default function SourcePanel({ target, cits, vision, ages, citsNetworkState, videoSourceLabel }) {
  const visionSourceMode = vision?.sourceMode ?? 'MOCK'
  const citsSourceMode = cits?.sourceMode ?? 'MOCK'
  const citsBadgeLabel = citsNetworkState ? `C-ITS: ${citsNetworkState} · 실제 잔여시간 없음` : `C-ITS: ${citsSourceMode}`
  const visionBadgeLabel = videoSourceLabel ? `영상: ${visionSourceMode} (${videoSourceLabel})` : `영상: ${visionSourceMode}`

  return (
    <section className="source-panel" aria-label="입력 소스 현황">
      <h2>입력 소스</h2>

      <div className="source-badges">
        <span className={`badge badge-source badge-${visionSourceMode.toLowerCase()}`}>
          {visionBadgeLabel}
        </span>
        <span className={`badge badge-source badge-${citsSourceMode.toLowerCase()}`}>
          {citsBadgeLabel}
        </span>
      </div>

      <div className="source-block">
        <h3>Target (MANUAL BINDING)</h3>
        <div className="kv-grid">
          <span className="kv-key">교차로</span>
          <span className="kv-val">{target?.intersectionId ?? '—'}</span>
          <span className="kv-key">횡단보도</span>
          <span className="kv-val">{target?.crosswalkId ?? '—'}</span>
          <span className="kv-key">이동류</span>
          <span className="kv-val">{target?.movementId ?? '—'}</span>
          <span className="kv-key">방향</span>
          <span className="kv-val">{target?.direction ?? '—'}</span>
          <span className="kv-key">ROI 바인딩</span>
          <span className="kv-val">{target?.roiBindingId ?? '—'}</span>
        </div>
      </div>

      <div className="source-block">
        <h3>C-ITS</h3>
        <div className="kv-grid">
          <span className="kv-key">색상</span>
          <span className="kv-val">
            {COLOR_DOT[cits?.color ?? 'unknown']} {COLOR_LABEL[cits?.color ?? 'unknown']}
            {cits?.available === false && ' (수신 불가)'}
          </span>
          <span className="kv-key">잔여시간</span>
          <span className="kv-val">{citsNetworkState ? '확인 불가' : fmtSec(cits?.remainingSec)}</span>
          <span className="kv-key">source age</span>
          <span className="kv-val">{fmtMs(ages?.citsSourceAgeMs)}</span>
          <span className="kv-key">receive age</span>
          <span className="kv-val">{fmtMs(ages?.citsReceiveAgeMs)}</span>
          <span className="kv-key">seq</span>
          <span className="kv-val">{cits?.seq ?? '—'}</span>
        </div>
      </div>

      <div className="source-block">
        <h3>Vision</h3>
        <div className="kv-grid">
          <span className="kv-key">색상</span>
          <span className="kv-val">
            {COLOR_DOT[vision?.color ?? 'unknown']} {COLOR_LABEL[vision?.color ?? 'unknown']}
          </span>
          <span className="kv-key">score</span>
          <span className="kv-val">{Number.isFinite(vision?.score) ? vision.score.toFixed(2) : '—'}</span>
          <span className="kv-key">quality</span>
          <span className="kv-val">{Number.isFinite(vision?.quality) ? vision.quality.toFixed(2) : '—'}</span>
          <span className="kv-key">frame age</span>
          <span className="kv-val">{fmtMs(ages?.visionAgeMs)}</span>
          <span className="kv-key">frameSeq</span>
          <span className="kv-val">{vision?.frameSeq ?? '—'}</span>
        </div>
      </div>
    </section>
  )
}
