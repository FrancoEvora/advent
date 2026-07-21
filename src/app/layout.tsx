import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./styles/v5-4-layout.css";
import "./styles/v5-4-admin.css";
import "./styles/v5-5-governance.css";
import "./styles/v5-6-signatures.css";
import "./styles/v5-7-backup.css";
import "./styles/v5-8-experience.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { GlobalModuleNav } from "@/components/GlobalModuleNav";
export const metadata: Metadata = {title:"Évora Gestão — Versão 5.9 Enterprise",description:"Plataforma integrada da Évora Urbanismo com CRM, aprovação eletrônica de propostas, contratos com OTP, agenda colaborativa, marketing, pós-venda, governança e recuperação.",manifest:"/manifest.webmanifest",applicationName:"Évora Gestão",icons:{icon:"/icon.svg",apple:"/icon.svg"},appleWebApp:{capable:true,statusBarStyle:"default",title:"Évora Gestão"}};
export const viewport: Viewport={width:"device-width",initialScale:1,maximumScale:1,viewportFit:"cover",themeColor:"#1D5271"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="pt-BR"><body><ServiceWorkerRegister/><GlobalModuleNav/>{children}</body></html>}
