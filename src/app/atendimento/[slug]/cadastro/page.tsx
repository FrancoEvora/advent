import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolarisNature } from "@/components/forms/SolarisNature";

export const metadata: Metadata = {
  title: "Solaris | Uma vida mais simples, perto da natureza",
  description: "Seus próximos vizinhos: natureza, lazer e uma vida mais simples em Monte Carmelo. Conheça os lotes a partir de 360 m². Atendimento Futura Casa.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Solaris | Seus próximos vizinhos",
    description: "Uma vida mais simples. Mais perto da natureza. Conheça o Solaris em Monte Carmelo, MG.",
    locale: "pt_BR", type: "website",
    images: [{ url: "https://enterprise.terraragroup.com.br/forms/solaris/nature/paisagem.webp", width: 1536, height: 1024, alt: "Vegetação e água ao entardecer, no acervo fotográfico da campanha Solaris." }],
  },
  twitter: { card: "summary_large_image" },
};
export default async function SolarisRegistration({ params }: { params: Promise<{ slug: string }> }) {
  if ((await params).slug !== "solaris") notFound();
  return <SolarisNature />;
}
