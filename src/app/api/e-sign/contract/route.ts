import {NextRequest,NextResponse} from "next/server";
import {buildEvidence,errorMessage,serverSupabase} from "@/lib/e-sign-server";

export const runtime="nodejs";

export async function POST(req:NextRequest){
 try{
  const body=await req.json();
  const token=String(body.token||"");
  const signerName=String(body.signerName||"").trim();
  const documentLast4=String(body.documentLast4||"").replace(/\D/g,"").slice(-4);
  const challengeId=String(body.otpChallengeId||"");
  const otpCode=String(body.otpCode||"").replace(/\D/g,"").slice(0,6);
  if(!token||!signerName||!challengeId||otpCode.length!==6)throw new Error("Dados da assinatura ou código de confirmação incompletos.");

  const client=serverSupabase();
  const evidence=buildEvidence(req,body);
  const{data,error}=await client.rpc("crm_sign_public_contract_with_otp",{
   p_token:token,
   p_signer_name:signerName,
   p_document_last4:documentLast4,
   p_challenge_id:challengeId,
   p_code:otpCode,
   p_evidence:evidence,
  });
  if(error)throw error;
  return NextResponse.json(data);
 }catch(error){
  return NextResponse.json({error:errorMessage(error)},{status:400});
 }
}
