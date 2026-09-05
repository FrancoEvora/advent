import type { Metadata } from "next";
import ArisaChat from "@/components/arisa/ArisaChat";

export const metadata: Metadata = { title: "Arisa — Administradora da plataforma Évora", robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams: Promise<{ conversa?: string }> }) {
  const params = await searchParams;
  return <ArisaChat initialThreadId={typeof params.conversa === "string" ? params.conversa : null} />;
}
