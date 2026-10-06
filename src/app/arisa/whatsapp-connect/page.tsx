import type { Metadata } from "next";
import WhatsAppConnect from "@/components/arisa/WhatsAppConnect";

export const metadata: Metadata = {
  title: "Preparar WhatsApp com YCloud | Arisa · Évora",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export default function Page() { return <WhatsAppConnect />; }
