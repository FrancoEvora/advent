import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Évora Gestão ERP — Inteligência Financeira e Imobiliária",
  description: "ERP corporativo da Évora Urbanismo para gestão financeira, centros de custo, empreendimentos, aprovações e governança.",
  manifest: "/manifest.webmanifest",
  applicationName: "Évora Gestão ERP",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Évora Gestão ERP",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b3f31",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body><ServiceWorkerRegister />{children}</body>
    </html>
  );
}
