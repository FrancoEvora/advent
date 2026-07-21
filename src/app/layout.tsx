import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./styles/v5-4-layout.css";
import "./styles/v5-4-admin.css";
import "./styles/v5-5-governance.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Évora Gestão — Versão 5.5 Enterprise",
  description: "Plataforma integrada da Évora Urbanismo com CRM, pós-venda, backup verificável, governança de acessos e portal do cliente.",
  manifest: "/manifest.webmanifest",
  applicationName: "Évora Gestão",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Évora Gestão" },
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
