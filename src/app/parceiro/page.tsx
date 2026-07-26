import type { Metadata } from "next";
import { PartnerPaymentPortal } from "@/components/erp/partners/partner-payment-portal";

export const metadata: Metadata = {
  title: "Portal de Parceiros e Pagamentos | Évora Urbanismo",
  description:
    "Consulta protegida de pagamentos publicados e canal de negociação.",
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true,
    noimageindex: true,
  },
};

export default function PartnerPaymentPage() {
  return <PartnerPaymentPortal />;
}
