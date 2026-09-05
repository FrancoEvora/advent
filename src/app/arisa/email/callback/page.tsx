import type { Metadata } from "next";
import ArisaGoogleCallback from "@/components/arisa/ArisaGoogleCallback";

export const metadata: Metadata = { title: "Conectar e-mail da Arisa", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function Page() { return <ArisaGoogleCallback />; }
