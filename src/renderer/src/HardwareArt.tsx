export function HardwareArt() {
  return (
    <svg
      className="board-illustration"
      viewBox="0 0 320 210"
      fill="none"
      aria-label="RK 设备示意图"
    >
      <defs>
        <linearGradient id="pcb" x1="70" y1="50" x2="228" y2="157" gradientUnits="userSpaceOnUse">
          <stop stopColor="#516E74" />
          <stop offset="1" stopColor="#263D4A" />
        </linearGradient>
        <linearGradient id="chip" x1="131" y1="66" x2="190" y2="119" gradientUnits="userSpaceOnUse">
          <stop stopColor="#46516B" />
          <stop offset="1" stopColor="#202B45" />
        </linearGradient>
        <linearGradient id="port" x1="238" y1="72" x2="266" y2="116" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E4EAF3" />
          <stop offset="1" stopColor="#8D9EB4" />
        </linearGradient>
        <radialGradient id="halo">
          <stop stopColor="#97A9EE" stopOpacity=".2" />
          <stop offset="1" stopColor="#97A9EE" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="165" cy="120" rx="150" ry="84" fill="url(#halo)" />
      <ellipse cx="165" cy="174" rx="105" ry="13" fill="#212C48" opacity=".1" />
      <path d="m58 88 146-43 73 44-147 53Z" fill="url(#pcb)" stroke="#7A9298" strokeWidth="1.5" />
      <path d="m58 88 72 54v15l-72-52Z" fill="#344653" />
      <path d="m130 142 147-53v15l-147 53Z" fill="#223440" />
      <path d="m64 89 139-39 66 39-139 47Z" stroke="#A5B9B2" strokeOpacity=".35" />
      <g stroke="#9CBDB2" strokeOpacity=".6" strokeWidth="1.2">
        <path d="m79 82 35 24 17-5m-39-29 30 22 18-6m29-30 28 17 26-8m-47 54 32-10 20 13m-87 16 32-10m-15 18 32-10m-79-28 16-5" />
      </g>
      <path d="m126 83 43-14 40 25-45 16Z" fill="#B5B9C7" />
      <path d="m129 83 40-12 35 22-41 14Z" fill="url(#chip)" stroke="#79849B" />
      <path d="m129 83 34 24v9l-34-24Z" fill="#1E2B43" />
      <path d="m163 107 41-14v9l-41 14Z" fill="#17243B" />
      <text
        x="153"
        y="89"
        fontSize="10"
        fill="#E1E6F4"
        fontFamily="Segoe UI, sans-serif"
        transform="rotate(29 153 89)"
      >
        RK3588
      </text>
      <path d="m215 62 22-6 28 17-23 8Z" fill="#E4EAF1" />
      <path d="m242 81 23-8v24l-23 9Z" fill="url(#port)" />
      <path d="m215 62 27 19v25l-27-19Z" fill="#AEBCCB" />
      <path d="m247 84 13-4v11l-13 5Z" fill="#63748A" />
      <path d="m65 107 23 16v13l-23-17Z" fill="#C1CBD8" />
      <path d="m69 112 14 10v6l-14-10Z" fill="#536279" />
      <path d="m96 129 21 15v12l-21-15Z" fill="#C1CBD8" />
      <path d="m100 134 13 9v5l-13-9Z" fill="#536279" />
      <g fill="#B9C5CA">
        <path d="m89 77 13-4 8 5-13 4Z" />
        <path d="m109 70 13-4 8 5-13 4Z" />
        <path d="m195 111 16-5 9 5-16 6Z" />
        <path d="m215 103 16-5 9 5-16 6Z" />
      </g>
      <g fill="#1D2C39">
        <path d="m91 96 16-5 13 9-16 5Z" />
        <path d="m109 113 16-5 10 7-16 6Z" />
        <path d="m173 58 18-5 11 7-17 5Z" />
      </g>
      <g fill="#D4C28C">
        <circle cx="77" cy="89" r="3" />
        <circle cx="199" cy="55" r="3" />
        <circle cx="260" cy="91" r="3" />
        <circle cx="135" cy="134" r="3" />
      </g>
      <path d="m183 127 19-7" stroke="#A5BEE3" strokeWidth="3" />
      <circle cx="214" cy="116" r="3" fill="#F5B17B" />
      <path
        d="M75 123c-44 0-52 24-24 42 14 9 38 11 62 11"
        stroke="#62718C"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M75 122c-44 0-52 24-24 42 14 9 38 11 62 11"
        stroke="#A6B1C8"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="109" y="169" width="27" height="14" rx="4" fill="#B3BFD2" />
      <rect x="132" y="172" width="10" height="8" rx="2" fill="#7D8AA3" />
    </svg>
  )
}
