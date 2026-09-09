export type BiaTool = (operation: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;
const ERRORS: Record<string,string> = {
  PUBLIC_AGENT_FILE_INVALID: 'Não consegui validar este arquivo. Envie PDF, imagem, TXT, CSV, XML ou OFX, com até 8 MB.',
  PUBLIC_AGENT_FILE_LIMIT: 'O limite de anexos deste atendimento foi atingido. Tente novamente mais tarde.',
  PUBLIC_AGENT_FILE_UPLOAD_INCOMPLETE: 'O arquivo não terminou de carregar. Selecione-o novamente para tentar de novo.',
  PUBLIC_AGENT_FILE_NOT_FOUND: 'Este arquivo não está disponível nesta conversa.',
  PUBLIC_AGENT_CONVERSATION_CHANGED: 'A conversa mudou em outra aba. Atualize a página antes de continuar.',
  PUBLIC_AGENT_SESSION_INACTIVE: 'Atualize a página para retomar o atendimento.',
  SPEECH_LIMIT: 'O limite temporário de voz foi atingido. A resposta escrita continua disponível.',
};
export async function toolError(response: Response, fallback: string) {
  const body=await response.json().catch(()=>null);
  return new Error(ERRORS[String(body?.error)]||fallback);
}
export async function toolJson<T>(tool:BiaTool,operation:string,args:Record<string,unknown>={}) {
  const response=await tool(operation,args);
  if(!response.ok)throw await toolError(response,'Não foi possível concluir agora. Tente novamente.');
  const body=await response.json();
  if(body.ok!==true)throw new Error('Não foi possível concluir agora. Tente novamente.');
  return body.data as T;
}
