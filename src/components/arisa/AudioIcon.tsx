import type { CSSProperties } from "react";
export type AudioIconName = "mic" | "send" | "trash" | "pause" | "play" | "stop" | "lock" | "chevron";
export default function AudioIcon({ name, style }: { name: AudioIconName; style?: CSSProperties }) {
  const paths = {
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    send: <><path d="m3 3 19 9-19 9 4-9-4-9Z" /><path d="M7 12h15" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    pause: <><path d="M9 5v14M15 5v14" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" /></>,
    chevron: <path d="m14 6-6 6 6 6" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={style} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
