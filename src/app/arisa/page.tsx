import type { Metadata, Viewport } from "next";
import ArisaChat from "@/components/arisa/ArisaChat";

// A separate manifest prevents an installed Arisa shortcut from launching the ERP root.
export const metadata: Metadata = {
  title: "Arisa — Administradora da plataforma Évora",
  applicationName: "Arisa",
  manifest: "/arisa/manifest.webmanifest",
  icons: {
    icon: { url: "/arisa/icon?v=evora-1", type: "image/png", sizes: "512x512" },
    apple: { url: "/arisa/apple-icon?v=evora-1", type: "image/png", sizes: "180x180" },
  },
  appleWebApp: { capable: true, title: "Arisa", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#79B82B",
};
export default async function Page({ searchParams }: { searchParams: Promise<{ conversa?: string }> }) {
  const params = await searchParams;
  return <ArisaChat initialThreadId={typeof params.conversa === "string" ? params.conversa : null} />;
}
