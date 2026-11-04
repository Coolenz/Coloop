/** Schematic symbol; does not depict a specific board revision. */
export function HardwareArt() {
  return (
    <svg
      className="board-illustration"
      viewBox="0 0 240 160"
      fill="none"
      role="img"
      aria-label="RK3588 设备连接示意"
    >
      <rect x="26" y="18" width="188" height="124" rx="16" fill="#f2f2f2" stroke="#c8c8c8" />
      <g stroke="#b7b7b7" strokeWidth="2">
        <path d="M52 56h32m-32 24h32m-32 24h32m72-48h32m-32 24h32m-32 24h32M102 18v28m18-28v28m18-28v28m-36 68v28m18-28v28m18-28v28" />
      </g>
      <rect x="82" y="44" width="76" height="72" rx="10" fill="#575757" />
      <text
        x="120"
        y="77"
        textAnchor="middle"
        fill="white"
        fontFamily="Segoe UI, sans-serif"
        fontSize="15"
        fontWeight="600"
      >
        RK3588
      </text>
      <text
        x="120"
        y="96"
        textAnchor="middle"
        fill="#e6e6e6"
        fontFamily="Segoe UI, sans-serif"
        fontSize="10"
      >
        Rockchip
      </text>
      <g fill="#ffffff" stroke="#c8c8c8">
        <rect x="16" y="48" width="22" height="16" rx="4" />
        <rect x="16" y="72" width="22" height="16" rx="4" />
        <rect x="16" y="96" width="22" height="16" rx="4" />
        <rect x="202" y="62" width="24" height="36" rx="4" />
      </g>
      <g fill="#c8c8c8">
        <circle cx="42" cy="32" r="3" />
        <circle cx="198" cy="32" r="3" />
        <circle cx="42" cy="128" r="3" />
        <circle cx="198" cy="128" r="3" />
      </g>
    </svg>
  )
}
