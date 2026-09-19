import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolarisMagazine } from "@/components/forms/SolarisMagazine";

export const metadata: Metadata = {
  title: "Solaris | Uma vida mais simples, perto da natureza",
  description: "Seus próximos vizinhos: natureza, lazer e uma vida mais simples em Monte Carmelo. Conheça os lotes, os espaços de lazer e o Centro Hípico anexo ao Solaris.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Solaris | Seus próximos vizinhos",
    description: "Uma vida mais simples. Mais perto da natureza. Conheça o Solaris em Monte Carmelo, MG.",
    locale: "pt_BR", type: "website",
    images: [{ url: "https://enterprise.terraragroup.com.br/forms/solaris/editorial/paisagem-aerea.webp", width: 1672, height: 941, alt: "Paisagem, lagos e vegetação no acervo da campanha Seus próximos vizinhos, Solaris." }],
  },
  twitter: { card: "summary_large_image" },
};
export default async function SolarisRegistration({ params }: { params: Promise<{ slug: string }> }) {
  if ((await params).slug !== "solaris") notFound();
  return <SolarisMagazine />;
}
