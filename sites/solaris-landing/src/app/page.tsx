import type { Metadata } from "next";
import { SolarisMagazine } from "@/components/forms/SolarisMagazine";
export const metadata: Metadata = {
  title: "Solaris Residencial Resort | Seus próximos vizinhos",
  description: "Uma vida mais simples, perto da natureza. Conheça o Solaris Residencial Resort em Monte Carmelo, MG.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { title: "Solaris | Seus próximos vizinhos", description: "Natureza, lazer e um novo jeito de morar em Monte Carmelo.", url: "https://solarisresidencial.com.br", locale: "pt_BR", type: "website", images: [{ url: "/forms/solaris/editorial/paisagem-aerea.webp", width: 1672, height: 941, alt: "Solaris Residencial Resort em Monte Carmelo" }] },
  twitter: { card: "summary_large_image" },
};
export default function Page() { return <SolarisMagazine />; }
