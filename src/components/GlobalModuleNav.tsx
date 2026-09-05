"use client";
import Link from "next/link";
import {usePathname} from "next/navigation";

export function GlobalModuleNav(){
 const path=usePathname();
 if(path==="/arisa"||path.startsWith("/cliente/")||path.startsWith("/parceiro")||path.startsWith("/proposta/")||path.startsWith("/contrato/")||path.startsWith("/verificar/")||path.startsWith("/atendimento/"))return null;
 const erpActive=path==="/"||path.startsWith("/crm")||path.startsWith("/pos-venda");
 const marketingActive=path==="/marketing"||path.startsWith("/marketing/");
 const agendaActive=path.startsWith("/agenda");
 return <nav className="global-module-nav" aria-label="Módulos da plataforma"><Link className={erpActive?"active":""} aria-current={erpActive?"page":undefined} href="/">ERP</Link><Link className={marketingActive?"active":""} aria-current={marketingActive?"page":undefined} href="/marketing">Marketing</Link><Link className={agendaActive?"active":""} aria-current={agendaActive?"page":undefined} href="/agenda">Agenda</Link><Link href="/arisa">Arisa</Link></nav>;
}
