import { ImageResponse } from "next/og";
import EvoraAppIcon from "@/components/arisa/EvoraAppIcon";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    EvoraAppIcon(),
    size,
  );
}
