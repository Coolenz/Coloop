import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: {},
  screen: {},
  nativeImage: {},
}))
import {
  WindowsObservationCapture,
  type ForegroundMetadata,
  type ForegroundObservation,
} from '../src/main/infrastructure/foreground-observation'
const meta: ForegroundMetadata = {
  window_id: '100',
  process_id: 200,
  window_rect: [0, 0, 800, 600],
  point_owner: '100',
  editable_focus: false,
  screen: { x: 0, y: 0, width: 1920, height: 1080 },
}
const view: ForegroundObservation = {
  ...meta,
  observation_id: 'before',
  content_hash: 'hash',
  captured_at: Date.now(),
  ocr_text: 'CLICK pending',
  ocr_items: [],
  targets: [],
}
describe('fresh visible result verification', () => {
  it('uses a new OCR capture even without editable focus', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    const fresh = vi
      .spyOn(capture, 'capture')
      .mockResolvedValue({ ...view, observation_id: 'after', ocr_text: 'CLICK VERIFIED' })
    expect(await capture.verifyVisibleText(view, 'CLICK VERIFIED')).toEqual({
      verified: true,
      source: 'ocr',
      observation_id: 'after',
    })
    expect(fresh).toHaveBeenCalledOnce()
    capture.dispose()
  })
  it('rejects cached-only evidence and changed windows', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const metadata = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    const fresh = vi
      .spyOn(capture, 'capture')
      .mockResolvedValue({ ...view, ocr_text: 'CLICK pending' })
    expect(
      (await capture.verifyVisibleText({ ...view, ocr_text: 'CLICK VERIFIED' }, 'CLICK VERIFIED'))
        .verified,
    ).toBe(false)
    metadata.mockResolvedValue({ ...meta, window_id: 'other' })
    fresh.mockClear()
    expect((await capture.verifyVisibleText(view, 'CLICK VERIFIED')).verified).toBe(false)
    expect(fresh).not.toHaveBeenCalled()
    capture.dispose()
  })
})
