import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Évora Gestão — Versão 5.3 Enterprise",
  description: "Plataforma integrada da Évora Urbanismo com CRM imobiliário, pós-venda, contratos, financeiro, obras, atendimento e portal do cliente.",
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
