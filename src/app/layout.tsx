import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Évora Gestão CRM — Versão 5.0 Enterprise",
  description: "CRM e plataforma de gestão integrada da Évora Urbanismo.",
  manifest: "/manifest.webmanifest",
  applicationName: "Évora Gestão CRM",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Évora Gestão CRM" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#1D5271",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body><ServiceWorkerRegister />{children}</body></html>;
}
