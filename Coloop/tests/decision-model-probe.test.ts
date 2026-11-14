import { expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { createDecisionProbeImage } from '../src/main/infrastructure/decision-model-probe'

it('encodes the probe answer only as synthetic raster pixels, not PNG metadata', () => {
  const first = createDecisionProbeImage(),
    second = createDecisionProbeImage()
  expect(first.code).toMatch(/^\d{8}$/)
  expect(first.dataUrl).not.toBe(second.dataUrl)
  const png = Buffer.from(first.dataUrl.split(',')[1], 'base64')
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20)
  const idatLength = png.readUInt32BE(33)
  expect(png.subarray(37, 41).toString()).toBe('IDAT')
  const pixels = inflateSync(png.subarray(41, 41 + idatLength))
  expect(pixels).toHaveLength((width + 1) * height)
  expect(pixels.filter((byte) => byte === 0).length).toBeGreaterThan(height)
  expect(png.includes(Buffer.from('tEXt'))).toBe(false)
})
