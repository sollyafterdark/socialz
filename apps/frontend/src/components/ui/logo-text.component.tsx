import React from 'react';
import { BRAND_NAME } from '@gitroom/helpers/utils/branding';

export const LogoTextComponent = () => {
  return (
    <div className="flex items-center gap-[8px]">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="32"
        height="32"
        viewBox="40 40 432 432"
        role="img"
        aria-label={BRAND_NAME}
      >
        <defs>
          <linearGradient
            id="socialz-logotext-a"
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
            id="socialz-logotext-b"
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
          fill="url(#socialz-logotext-b)"
          transform="rotate(180 256 256)"
        />
        <path
          d="M392 146 C346 70 124 62 104 184 C92 262 178 288 276 262 C204 262 164 232 172 188 C184 124 314 112 392 146 Z"
          fill="url(#socialz-logotext-a)"
          opacity="0.94"
        />
      </svg>
      <span className="lowercase text-[26px] font-semibold tracking-tight leading-none">
        {BRAND_NAME}
      </span>
    </div>
  );
};
