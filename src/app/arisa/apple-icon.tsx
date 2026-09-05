import { ImageResponse } from "next/og";
import EvoraAppIcon from "@/components/arisa/EvoraAppIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    EvoraAppIcon(),
    size,
  );
}
