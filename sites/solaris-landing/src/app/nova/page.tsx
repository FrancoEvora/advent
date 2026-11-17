import type { Metadata } from "next";
import { SolarisAlphaLanding } from "@/components/forms/SolarisAlphaLanding";

export const metadata: Metadata = {
  title: "Solaris Residencial Resort | Viva abraçado pela natureza",
  description:
    "Descubra o Solaris Residencial Resort, em Monte Carmelo, MG. Lazer, natureza, lotes e uma nova experiência de viver no bairro Parque das Árvores.",
  alternates: { canonical: "/nova" },
  robots: { index: false, follow: true },
  openGraph: {
    title: "Solaris Residencial Resort — Viva abraçado pela natureza",
    description: "Uma nova perspectiva para viver bem, em Monte Carmelo.",
    images: ["/forms/solaris/editorial/deck-represa-v7.webp"],
  },
};

export default function SolarisNewLandingPage() {
  return <SolarisAlphaLanding />;
}
