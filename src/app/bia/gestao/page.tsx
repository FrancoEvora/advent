import type { Metadata } from 'next';
import BiaInbox from '@/components/bia/BiaInbox';
export const metadata: Metadata = { title: 'Bia — Vendas e atendimento | Évora', robots: { index: false, follow: false } };
export default function BiaManagementPage() { return <BiaInbox />; }
