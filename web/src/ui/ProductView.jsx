import { REASONS } from '../safety/reasonCodes.js'
import { RTA_CONFIG_V1 } from '../safety/config.js'

// decision → tint/아이콘/타이틀 매핑. 순수 표시 매핑이며 판정 로직은 전혀
// 포함하지 않는다 — shieldOut.decision을 그대로 읽어 스타일 클래스만 고른다.
const DECISION_META = {
  WAIT: { tint: 'tint-wait', icon: '✋', title: '대기' },
  VERIFYING: { tint: 'tint-verify', icon: '◌', title: '신호 확인 중' },
  SIGNAL_CONFIRMED: { tint: 'tint-confirmed', icon: '✔', title: '보행신호 확인됨' },
  INFORMATION_ONLY: { tint: 'tint-info', icon: 'ℹ', title: '정보 제공만' },
}

const HAS_VIBRATE = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

/**
 * 제품 모드(product mode) 풀스크린 안내 화면 (스펙: 촬영용 프로토타입).
 *
 * 순수 프레젠테이션 컴포넌트 — 새로운 판정 로직이나 두 번째 tick 루프를
 * 만들지 않는다. App.jsx의 safety tick이 이미 계산한 shieldOut을 그대로
 * 읽어 화면에 옮길 뿐이다. CameraView는 이 컴포넌트 밖(App.jsx)에서 항상
 * 렌더링되며 이 컴포넌트는 그 위에 겹쳐지는 오버레이다.
 */
export default function ProductView({ shieldOut, citsConnected, audioOn, onExit, liveMode = false, cameraConnected = false }) {
  const decision = shieldOut?.decision ?? 'WAIT'
  const meta = DECISION_META[decision] ?? DECISION_META.WAIT
  const message = shieldOut?.message ?? ''
  const reason = shieldOut?.reason ?? null
  // shield는 hold 시간이 차는 동안에도 카운터를 계속 올리므로(확인 성공 후
  // 다음 사이클까지) 분자가 목표치를 넘어설 수 있다 — "6/5 프레임"처럼
  // 보이지 않도록 목표치로 클램프한다(리뷰 I-1).
  const distinctGreenFrames = Math.min(
    shieldOut?.confirmation?.distinctGreenFrames ?? 0,
    RTA_CONFIG_V1.minDistinctGreenFrames
  )
  const remainingSec =
    decision === 'SIGNAL_CONFIRMED'
      ? Math.max(0, Math.floor(shieldOut?.effectiveRemainingSec ?? 0))
      : null

  return (
    <div className={`product-view ${meta.tint}`} role="region" aria-label="제품 모드 안내 화면">
      {/* ---- 상단 바: 정직 배지는 항상 보인다 ---- */}
      <header className="pv-topbar">
        <span className="pv-wordmark">ClipSense</span>
        <div className="pv-status-cluster">
          <span className="pv-dot-group" title="C-ITS 연결 상태">
            <span className={`pv-dot ${citsConnected ? 'pv-dot-on' : 'pv-dot-off'}`} />
            C-ITS {citsConnected ? '연결' : '끊김'}
          </span>
          <span className="pv-dot-group" title="카메라 상태">
            <span className={`pv-dot ${cameraConnected ? 'pv-dot-on' : 'pv-dot-off'}`} />
            카메라
          </span>
          <span className="pv-badge-mock">{liveMode ? '실시간 API 없음 · 대기' : 'MOCK'}</span>
          <span className="pv-badge-verify">기술 검증용</span>
        </div>
      </header>

      {/* ---- 중앙 스테이지 ---- */}
      <main className="pv-stage">
        <div className={`pv-icon ${decision === 'VERIFYING' ? 'pv-icon-pulse' : ''}`} aria-hidden="true">
          {meta.icon}
        </div>
        <div className="pv-title">{meta.title}</div>

        {decision === 'VERIFYING' && (
          <div className="pv-verify-progress">
            {distinctGreenFrames}/{RTA_CONFIG_V1.minDistinctGreenFrames} 프레임
          </div>
        )}

        {decision === 'SIGNAL_CONFIRMED' && remainingSec !== null && (
          <div className="pv-countdown">
            <span className="pv-countdown-num">{remainingSec}</span>
            <span className="pv-countdown-unit">초</span>
          </div>
        )}

        {message && <div className="pv-message">{message}</div>}
      </main>

      {/* ---- 하단 스트립 ---- */}
      <footer className="pv-bottombar">
        <span className="pv-bottom-item">{audioOn ? '🔊 음성 안내 켜짐' : '🔇 음성 안내 꺼짐'}</span>
        <span className="pv-bottom-item">{HAS_VIBRATE ? '진동 지원됨' : '진동 미지원'}</span>
        {decision === 'WAIT' && reason && (
          <span className="pv-bottom-item pv-reason-code">
            {reason === REASONS.INVALID_INPUT ? 'INVALID_INPUT' : reason}
          </span>
        )}
        <button type="button" className="pv-exit-btn" onClick={onExit}>
          검증 화면
        </button>
      </footer>
    </div>
  )
}
