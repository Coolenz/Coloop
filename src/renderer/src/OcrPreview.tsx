import { useState } from 'react'
import { Copy, ScanLine, SquareDashedMousePointer } from 'lucide-react'
import type { Capture, OcrResult } from '../../shared/contracts'
import { api, unwrap } from './api'

export function OcrPreview({ capture, result }: { capture: Capture; result?: OcrResult }) {
  const [showBoxes, setShowBoxes] = useState(true)
  return (
    <div className="ocr-preview-wrap">
      <div className="image-canvas">
        <img src={capture.dataUrl} alt="待识别图像" />
        {showBoxes && !!result?.items.length && (
          <svg
            className="ocr-overlay"
            viewBox={`0 0 ${capture.width} ${capture.height}`}
            aria-label="识别文字区域"
          >
            {result.items.map((item, index) => (
              <g key={index}>
                <rect
                  x={item.rect[0]}
                  y={item.rect[1]}
                  width={item.rect[2] - item.rect[0]}
                  height={item.rect[3] - item.rect[1]}
                  fill="#4169e110"
                  stroke="#4169e1"
                  strokeWidth={Math.max(1, capture.width / 600)}
                />
                <circle
                  cx={item.center[0]}
                  cy={item.center[1]}
                  r={Math.max(2, capture.width / 400)}
                  fill="#4169e1"
                />
                <title>{`${index + 1}. ${item.text}`}</title>
              </g>
            ))}
          </svg>
        )}
      </div>
      {!!result?.items.length && (
        <button
          className="boxes-toggle"
          aria-pressed={showBoxes}
          onClick={() => setShowBoxes(!showBoxes)}
        >
          <SquareDashedMousePointer size={13} />
          {showBoxes ? '隐藏文字框' : '显示文字框'}
          <span>{result.items.length}</span>
        </button>
      )}
    </div>
  )
}
export function OcrCoordinates({
  result,
  notify,
}: {
  result?: OcrResult
  notify: (message: string, error?: boolean) => void
}) {
  if (!result?.items.length) return null
  return (
    <details className="ocr-coordinates">
      <summary>
        <ScanLine size={13} />
        原始识别坐标<span>{result.items.length} 个文字区域</span>
      </summary>
      <div className="coordinates-header">
        <span>图像像素坐标 · 文字区域不等于按钮边界</span>
        <button
          className="text-button"
          onClick={() =>
            void unwrap(
              api.copyText(
                JSON.stringify(
                  { coordinateSpace: result.coordinateSpace, items: result.items },
                  null,
                  2,
                ),
              ),
            )
              .then(() => notify('文字与坐标 JSON 已复制'))
              .catch((e) => notify(e.message, true))
          }
        >
          <Copy size={12} />
          复制 JSON
        </button>
      </div>
      <div className="coordinates-list">
        {result.items.map((item, index) => (
          <div key={index}>
            <strong>{item.text}</strong>
            <span>中心 ({item.center.map((n) => Math.round(n)).join(', ')})</span>
            <small>{(item.confidence * 100).toFixed(0)}%</small>
          </div>
        ))}
      </div>
    </details>
  )
}
