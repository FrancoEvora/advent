import type { Metadata, Viewport } from "next";
import ArisaChat from "@/components/arisa/ArisaChat";
import { workspacePanel } from "@/components/arisa/workspace-navigation";
export const metadata: Metadata = {
  title: "Bia — Gestora comercial da Évora", applicationName: "Bia", manifest: "/bia/manifest.webmanifest",
  icons: { icon: {url:"/bia/icon-512-v1.png",sizes:"512x512",type:"image/png"}, apple: {url:"/bia/apple-touch-icon-v1.png",sizes:"180x180",type:"image/png"} },
  appleWebApp: {capable:true,title:"Bia",statusBarStyle:"black-translucent"}, robots:{index:false,follow:false}
};
export const viewport: Viewport = {width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#79B82B"};
export default async function Page({searchParams}:{searchParams:Promise<{conversa?:string;painel?:string}>}) {
  const params = await searchParams;
  return <ArisaChat assistant="bia" initialThreadId={typeof params.conversa === "string" ? params.conversa : null} initialPanel={workspacePanel(params.painel)} />;
}
