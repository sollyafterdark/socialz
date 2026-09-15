'use client';

export const Logo = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="60"
      height="60"
      viewBox="40 40 432 432"
      role="img"
      aria-label="Socialz"
      className="mt-[8px] min-w-[60px] min-h-[60px]"
    >
      <defs>
        <linearGradient
          id="socialz-logo-a"
          x1="392"
          y1="110"
          x2="110"
          y2="250"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#67E8F9" />
          <stop offset="1" stopColor="#0F766E" />
        </linearGradient>
        <linearGradient
          id="socialz-logo-b"
          x1="120"
          y1="400"
          x2="400"
          y2="262"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#FDE68A" />
          <stop offset="1" stopColor="#F97316" />
        </linearGradient>
      </defs>
      <path
        d="M392 146 C346 70 124 62 104 184 C92 262 178 288 276 262 C204 262 164 232 172 188 C184 124 314 112 392 146 Z"
        fill="url(#socialz-logo-b)"
        transform="rotate(180 256 256)"
      />
      <path
        d="M392 146 C346 70 124 62 104 184 C92 262 178 288 276 262 C204 262 164 232 172 188 C184 124 314 112 392 146 Z"
        fill="url(#socialz-logo-a)"
        opacity="0.94"
      />
    </svg>
  );
};
