import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#075e54" }}>
      <div style={{ width: 106, height: 106, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "#e4eee7", color: "#075e54", fontSize: 81, fontWeight: 700 }}>A</div>
    </div>,
    size,
  );
}
