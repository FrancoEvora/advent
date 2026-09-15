import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolarisForm } from "@/components/forms/SolarisForm";

export const metadata: Metadata = {
  title: "Solaris Residencial Resort | Mais natureza. Mais lazer. Mais vida.",
  description: "Lotes a partir de 360 m² em Monte Carmelo, no Parque das Árvores. Conheça o projeto Solaris: lazer resort, natureza e bem-estar. Atendimento Futura Casa.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Solaris Residencial Resort | Mais natureza. Mais lazer. Mais vida.",
    description: "Um novo jeito de viver no coração do Parque das Árvores, em Monte Carmelo. Conheça o projeto e receba lotes e condições com a Futura Casa.",
    locale: "pt_BR", type: "website",
    images: [{ url: "https://advent-tau.vercel.app/forms/solaris/book/resort.avif", width: 1200, height: 837, alt: "Perspectiva ilustrativa do lazer resort do Solaris, extraída do book comercial." }],
  },
  twitter: { card: "summary_large_image" },
};
export default async function SolarisRegistration({ params }: { params: Promise<{ slug: string }> }) {
  if ((await params).slug !== "solaris") notFound();
  return <SolarisForm />;
}
