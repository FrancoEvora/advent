import {NextRequest,NextResponse} from "next/server";
import {buildEvidence,errorMessage,serverSupabase} from "@/lib/e-sign-server";

export const runtime="nodejs";

export async function POST(req:NextRequest){
 try{
  const body=await req.json();
  const token=String(body.token||"");
  const signerName=String(body.signerName||"").trim();
  const documentLast4=String(body.documentLast4||"").replace(/\D/g,"").slice(-4);
  if(!token||!signerName)throw new Error("Dados do aceite incompletos.");
  const client=serverSupabase();
  const{data,error}=await client.rpc("crm_sign_public_contract",{
   p_token:token,
   p_signer_name:signerName,
   p_document_last4:documentLast4,
   p_evidence:buildEvidence(req,body),
  });
  if(error)throw error;
  return NextResponse.json(data);
 }catch(error){
  return NextResponse.json({error:errorMessage(error)},{status:400});
 }
}
