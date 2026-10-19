import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCamera, grabFrame, cameraErrorMessage } from '../../src/sources/videoSource.js'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] }
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { stop, stream, getUserMedia }
}

describe('camera lifecycle', () => {
  it('starts a rear-facing silent stream and plays it', async () => {
    const { stream, getUserMedia } = setup()
    const video = { play: vi.fn().mockResolvedValue() }
    expect(await startCamera(video)).toBe(stream)
    expect(video.srcObject).toBe(stream)
    expect(video.play).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } }, audio: false })
  })
  it('releases the device when playback fails', async () => {
    const { stop } = setup()
    await expect(startCamera({ play: vi.fn().mockRejectedValue(new Error('play failed')) })).rejects.toThrow('play failed')
    expect(stop).toHaveBeenCalledOnce()
  })
  it('does not attach a late permission response after cancellation', async () => {
    const { stop } = setup()
    const video = { play: vi.fn() }
    expect(await startCamera(video, 'user', () => true)).toBeNull()
    expect(stop).toHaveBeenCalledOnce()
    expect(video.play).not.toHaveBeenCalled()
    expect(video.srcObject).toBeUndefined()
  })
  it('explains insecure origins and unavailable devices', async () => {
    setup()
    vi.stubGlobal('isSecureContext', false)
    await expect(startCamera({})).rejects.toThrow('HTTPS')
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toContain('연결된 카메라')
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toContain('권한')
  })
  it('returns unknown input for a failed frame capture instead of throwing', () => {
    const canvas = { getContext: () => ({ drawImage() { throw new Error('unavailable') } }) }
    expect(grabFrame({ videoWidth: 640, videoHeight: 480 }, canvas)).toBeNull()
  })
})
