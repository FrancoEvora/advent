import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolarisForm } from "@/components/forms/SolarisForm";
export const metadata: Metadata = {title:"Solaris | Cadastro Futura Casa",description:"Cadastre seu interesse no Solaris Residencial Resort, em Monte Carmelo (MG).",robots:{index:false,follow:false}};
export default async function SolarisRegistration({params}:{params:Promise<{slug:string}>}) {
  if ((await params).slug !== "solaris") notFound();
  return <SolarisForm/>;
}
