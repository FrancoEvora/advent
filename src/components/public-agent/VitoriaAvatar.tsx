"use client";

import type { CSSProperties } from "react";

export type VitoriaAvatarState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  state: VitoriaAvatarState;
  heroImageUrl?: string | null;
  agentName?: string;
};

export function VitoriaAvatar({ state, heroImageUrl, agentName = "Vitória" }: Props) {
  const isVideo = Boolean(heroImageUrl && /\.(mp4|webm|mov)(\?|$)/i.test(heroImageUrl));
  const style = { "--vitoria-energy": state === "listening" ? 1 : state === "speaking" ? .82 : state === "thinking" ? .58 : .32 } as CSSProperties;

  return (
    <div className={`vitoria-avatar-stage is-${state}`} style={style} aria-label={`${agentName}, assistente virtual da Évora Urbanismo`}>
      <div className="vitoria-avatar-aura" aria-hidden="true" />
      <div className="vitoria-avatar-grid" aria-hidden="true" />
      {heroImageUrl ? (
        <div className="vitoria-avatar-media">
          {isVideo ? (
            <video src={heroImageUrl} autoPlay muted loop playsInline preload="metadata" />
          ) : (
            <img src={heroImageUrl} alt={`Representação visual de ${agentName}`} />
          )}
        </div>
      ) : (
        <svg className="vitoria-avatar-svg" viewBox="0 0 760 980" role="img" aria-labelledby="vitoria-avatar-title vitoria-avatar-desc">
          <title id="vitoria-avatar-title">Vitória, agente digital da Évora Urbanismo</title>
          <desc id="vitoria-avatar-desc">Retrato vetorial animado de uma jovem profissional elegante usando blazer escuro.</desc>
          <defs>
            <linearGradient id="avatar-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#0f1818" />
              <stop offset=".52" stopColor="#162221" />
              <stop offset="1" stopColor="#07100f" />
            </linearGradient>
            <radialGradient id="avatar-light" cx="52%" cy="28%" r="54%">
              <stop offset="0" stopColor="#f7d9be" stopOpacity=".36" />
              <stop offset=".44" stopColor="#4fd5c5" stopOpacity=".1" />
              <stop offset="1" stopColor="#07100f" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="skin" x1=".2" y1=".1" x2=".84" y2=".9">
              <stop offset="0" stopColor="#f2c5a7" />
              <stop offset=".52" stopColor="#e8b394" />
              <stop offset="1" stopColor="#bd7f66" />
            </linearGradient>
            <linearGradient id="skin-shadow" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d99a7c" />
              <stop offset="1" stopColor="#a76455" />
            </linearGradient>
            <linearGradient id="hair" x1=".15" y1=".05" x2=".82" y2=".9">
              <stop offset="0" stopColor="#2b201e" />
              <stop offset=".28" stopColor="#4a3029" />
              <stop offset=".7" stopColor="#281b1a" />
              <stop offset="1" stopColor="#120e0f" />
            </linearGradient>
            <linearGradient id="hair-light" x1=".1" y1="0" x2=".8" y2="1">
              <stop offset="0" stopColor="#b87857" stopOpacity=".8" />
              <stop offset=".7" stopColor="#6b4134" stopOpacity=".2" />
              <stop offset="1" stopColor="#1d1414" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="blazer" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#18394c" />
              <stop offset=".55" stopColor="#0d2636" />
              <stop offset="1" stopColor="#06121b" />
            </linearGradient>
            <linearGradient id="shirt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fffdf8" />
              <stop offset="1" stopColor="#dedbd4" />
            </linearGradient>
            <filter id="avatar-shadow" x="-30%" y="-30%" width="160%" height="180%">
              <feDropShadow dx="0" dy="28" stdDeviation="30" floodColor="#000" floodOpacity=".52" />
            </filter>
            <filter id="soft-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <rect width="760" height="980" rx="48" fill="url(#avatar-bg)" />
          <rect width="760" height="980" rx="48" fill="url(#avatar-light)" />
          <g className="vitoria-avatar-particles" fill="#6ff3d4">
            <circle cx="90" cy="170" r="3" opacity=".45" />
            <circle cx="665" cy="245" r="2.5" opacity=".52" />
            <circle cx="618" cy="116" r="1.8" opacity=".35" />
            <circle cx="122" cy="360" r="2" opacity=".3" />
          </g>

          <g className="vitoria-avatar-person" filter="url(#avatar-shadow)">
            <path d="M118 980c24-178 78-286 181-334l83-35 88 35c111 48 161 155 185 334H118Z" fill="url(#blazer)" />
            <path d="M294 649 382 820l91-171-54-33h-74l-51 33Z" fill="url(#shirt)" />
            <path d="m287 657 92 166-107-82-14 239H121c21-160 77-272 166-323Z" fill="#102f43" opacity=".95" />
            <path d="m477 657-95 166 112-82 18 239h143c-23-164-82-274-178-323Z" fill="#0b2536" opacity=".95" />
            <path d="M330 550h105v108c-15 34-35 51-53 51-22 0-40-18-52-51V550Z" fill="url(#skin-shadow)" />

            <path d="M219 267c13-139 91-204 176-204 100 0 175 71 174 220 50 80 47 227-21 333-30 47-74 75-121 93l-55-89-54 87c-43-18-84-48-111-91-65-103-55-258 12-349Z" fill="url(#hair)" />
            <path d="M272 210c19-89 81-123 130-123 76 0 131 60 132 160l-19 196c-9 98-58 166-133 166-76 0-125-71-134-169l-16-180c0-16 12-35 40-50Z" fill="url(#skin)" />
            <path d="M259 226c15-95 79-150 152-145 68 5 123 52 132 135-44-11-82-38-105-78-37 53-94 91-179 88Z" fill="url(#hair)" />
            <path d="M235 309c-32 26-36 77-10 121 13 21 28 30 43 26l-9-147c-8-7-16-7-24 0Z" fill="url(#skin-shadow)" />
            <path d="M531 309c31 25 36 77 9 121-12 21-27 30-42 26l8-147c8-7 17-7 25 0Z" fill="url(#skin-shadow)" />

            <path d="M302 315c25-18 59-19 84-3" fill="none" stroke="#4a302b" strokeWidth="10" strokeLinecap="round" />
            <path d="M421 312c26-17 59-15 82 5" fill="none" stroke="#4a302b" strokeWidth="10" strokeLinecap="round" />
            <g className="vitoria-eye vitoria-eye-left">
              <path d="M304 354c22-24 59-24 82 0-23 22-59 23-82 0Z" fill="#fff7ef" />
              <ellipse cx="346" cy="354" rx="13" ry="15" fill="#5d7667" />
              <circle cx="346" cy="354" r="7" fill="#18231e" /><circle cx="350" cy="348" r="3" fill="#fff" />
              <path className="vitoria-eyelid" d="M300 349c26-24 63-22 88 3-26-5-59-5-88-3Z" fill="url(#skin)" />
            </g>
            <g className="vitoria-eye vitoria-eye-right">
              <path d="M419 354c23-23 60-22 83 2-24 21-60 21-83-2Z" fill="#fff7ef" />
              <ellipse cx="460" cy="355" rx="13" ry="15" fill="#5d7667" />
              <circle cx="460" cy="355" r="7" fill="#18231e" /><circle cx="464" cy="349" r="3" fill="#fff" />
              <path className="vitoria-eyelid" d="M416 349c28-23 64-20 89 5-27-6-60-7-89-5Z" fill="url(#skin)" />
            </g>
            <path d="M397 365c-2 36 4 63 16 80-12 7-28 7-40 0" fill="none" stroke="#b97966" strokeWidth="6" strokeLinecap="round" />
            <path d="M341 481c30 25 73 26 105 0-14 42-88 46-105 0Z" fill="#a84e58" />
            <path d="M350 485c25 12 61 12 87-1" fill="none" stroke="#f5bbb5" strokeWidth="5" strokeLinecap="round" opacity=".8" />
            <path d="M319 272c25-52 87-72 136-49-56-1-96 22-136 49Z" fill="url(#hair-light)" opacity=".75" />
            <path d="M255 230c-30 146-12 289 58 394-80-45-119-135-110-265 5-66 21-109 52-129Z" fill="url(#hair)" />
            <path d="M520 229c37 146 17 295-60 399 88-46 126-145 112-278-6-58-24-101-52-121Z" fill="url(#hair)" />
          </g>

          <g className="vitoria-avatar-hud" opacity=".76">
            <path d="M70 760h90" stroke="#5ff0d1" strokeWidth="2" strokeDasharray="5 8" />
            <path d="M600 196h92" stroke="#d6b678" strokeWidth="2" strokeDasharray="5 8" />
            <circle cx="72" cy="760" r="6" fill="#5ff0d1" filter="url(#soft-glow)" />
            <circle cx="692" cy="196" r="5" fill="#d6b678" filter="url(#soft-glow)" />
          </g>
        </svg>
      )}
      <div className="vitoria-avatar-state" aria-live="polite">
        <span className="vitoria-avatar-status-dot" />
        {state === "listening" ? "Ouvindo" : state === "thinking" ? "Consultando o Enterprise" : state === "speaking" ? "Respondendo" : "Online"}
      </div>
      <div className="vitoria-avatar-wave" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}
      </div>
    </div>
  );
}
