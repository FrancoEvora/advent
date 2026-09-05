import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#075e54" }}>
      <div style={{ width: 300, height: 300, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "#e4eee7", color: "#075e54", fontSize: 230, fontWeight: 700 }}>A</div>
    </div>,
    size,
  );
}
