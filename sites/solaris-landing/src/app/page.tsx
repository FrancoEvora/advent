import type { Metadata } from "next";
import { SolarisAlphaLanding } from "@/components/forms/SolarisAlphaLanding";
export const metadata: Metadata = {
  title: "Solaris Residencial Resort | Viva abraçado pela Natureza",
  description: "Viva abraçado pela Natureza. Viva no Solaris. Conheça os lotes, a portaria e os espaços de lazer do Residencial Resort em Monte Carmelo, MG.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { title: "Solaris | Viva abraçado pela Natureza", description: "Viva no Solaris. Natureza, lazer e um novo jeito de morar em Monte Carmelo.", url: "https://solarisresidencial.com.br", locale: "pt_BR", type: "website", images: [{ url: "/forms/solaris/editorial/deck-represa-v7.webp", width: 1280, height: 960, alt: "Represa e deck no Solaris Residencial Resort" }] },
  twitter: { card: "summary_large_image" },
};
export default function Page() { return <SolarisAlphaLanding />; }
