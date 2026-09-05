type ChatViewport = {
  layoutHeight: number;
  visualHeight: number;
  offsetTop: number;
  scale: number;
  editing: boolean;
};

// Let CSS own the full screen. Only a visible software keyboard should pin the
// chat to VisualViewport pixels; startup/Safari chrome and pinch zoom must not.
export function chatViewport({ layoutHeight, visualHeight, offsetTop, scale, editing }: ChatViewport) {
  const keyboard = editing && Math.abs(scale - 1) < 0.02 && visualHeight > 0
    && layoutHeight - visualHeight > Math.min(150, layoutHeight * 0.25);
  return {
    height: keyboard ? `${Math.round(visualHeight)}px` : "100dvh",
    top: keyboard ? `${Math.max(0, Math.round(offsetTop))}px` : "0px",
    keyboard,
  };
}
