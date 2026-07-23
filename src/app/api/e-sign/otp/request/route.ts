import {NextResponse} from "next/server";

export async function POST(){
 return NextResponse.json(
  {error:"O código por WhatsApp foi desativado. Propostas são aceitas e contratos são assinados diretamente pela tela pública, com registro das evidências eletrônicas."},
  {status:410},
 );
}
