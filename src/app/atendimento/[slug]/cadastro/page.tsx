import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolarisForm } from "@/components/forms/SolarisForm";

export const metadata: Metadata = {
  title: "Solaris Residencial Resort | Lotes em Monte Carmelo | Futura Casa",
  description: "Conheça o Solaris Residencial Resort em Monte Carmelo (MG). Receba lotes disponíveis e condições comerciais pelo WhatsApp com atendimento Futura Casa.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Solaris Residencial Resort | Seu próximo capítulo começa com um lugar",
    description: "Lotes em Monte Carmelo (MG) para morar ou investir. Conheça as opções e condições comerciais com a Futura Casa.",
    locale: "pt_BR",
    type: "website",
  },
};

export default async function SolarisRegistration({ params }: { params: Promise<{ slug: string }> }) {
  if ((await params).slug !== "solaris") notFound();
  return <SolarisForm />;
}
