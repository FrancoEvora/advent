/** Pure, dependency-free contracts shared by the Bia runtime and behavioral tests. */
export type Obj = Record<string, unknown>;
export const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
export const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const unitCode = (v: unknown) => {
  const s = text(v)?.toUpperCase();
  return s && /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/.test(s) ? s : null;
};
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObject(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
export function cleanReply(v: string): string {
  return v.normalize('NFC').replace(/\r\n?/g, '\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ').replace(/(?:filecite|cite)[^]*/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function replyText(payload: unknown): string | null {
  if (!isObject(payload) || !Array.isArray(payload.output)) return null;
  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (isObject(c) && c.type === 'output_text' && text(c.text)) parts.push(String(c.text));
  }
  return cleanReply(parts.join('\n\n')) || null;
}
/** store:false: replay complete tool calls and encrypted reasoning, not server-only file-search IDs. */
export function replayOutput(payload: unknown): Obj[] {
  if (!isObject(payload) || !Array.isArray(payload.output)) return [];
  return payload.output.filter(isObject).flatMap(item => {
    if (item.type === 'function_call') return [{type:'function_call',call_id:item.call_id,name:item.name,arguments:item.arguments}];
    if (item.type === 'reasoning' && text(item.encrypted_content)) return [{type:'reasoning',encrypted_content:item.encrypted_content,summary:Array.isArray(item.summary)?item.summary:[]}];
    if (item.type === 'message' && Array.isArray(item.content)) {
      const content = item.content.filter(isObject).filter(c => c.type==='output_text').map(c=>text(c.text)||'').join('\n');
      return content ? [{role:'assistant',content}] : [];
    }
    return [];
  });
}
export type ToolCall = {name:string;callId:string;arguments:Obj;signature:string;invalid:boolean};
export function toolCalls(payload: unknown): ToolCall[] {
  if (!isObject(payload) || !Array.isArray(payload.output)) return [];
  const seen = new Set<string>();
  return payload.output.filter(isObject).filter(i=>i.type==='function_call').flatMap(i=>{
    const callId = text(i.call_id), name = text(i.name);
    if (!callId || !name || seen.has(callId)) return [];
    seen.add(callId);
    let args: Obj = {}, invalid=false;
    try { const parsed=JSON.parse(typeof i.arguments==='string'?i.arguments:''); if (!isObject(parsed)) invalid=true; else args=parsed; } catch {invalid=true;}
    return [{name,callId,arguments:args,signature:name+':'+canonical(args),invalid}];
  });
}
export function phone(v: unknown): string | null {
  let digits=(text(v)||'').replace(/\D/g,'');
  if ((digits.length===12||digits.length===13)&&digits.startsWith('55')) digits=digits.slice(2);
  if (!/^[1-9][0-9](?:[2-5][0-9]{7}|9[0-9]{8})$/.test(digits)) return null;
  return '+55'+digits;
}
/** Never let a model invent a name/phone from context, tool results, or prompt injection. */
export function evidencedContact(args: Obj, userTexts: string[]): Obj {
  const haystack=normalize(userTexts.join('\n'));
  const patch: Obj={};
  for (const field of ['name','city','email']) {
    const value=text(args[field]);
    if (value && value.length<=180 && haystack.includes(normalize(value))) patch[field]=value;
  }
  const value=phone(args.phone);
  if (value && userTexts.some(s=>s.match(/\+?[\d(][\d\s().-]{7,}\d/g)?.some(p=>phone(p)===value))) patch.phone=value;
  return patch;
}
export function safeExternalUrl(v: unknown): string | null {
  try {const u=new URL(String(v)); if (u.protocol!=='https:'||u.username||u.password||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|0\.)/i.test(u.hostname)) return null; return u.href;} catch {return null;}
}
export function safeFilters(args: Obj): Obj {
  const positive=(v:unknown)=> {const n=finite(v);return n!==null&&n>=0?n:null;};
  const code=text(args.unit_code);
  if (code&&!unitCode(code)) throw new Error('PUBLIC_AGENT_UNIT_CODE_INVALID');
  const result={unitCode:unitCode(code),areaMin:positive(args.area_min),areaMax:positive(args.area_max),budgetMax:positive(args.budget_max),limit:6};
  if (result.areaMin!==null&&result.areaMax!==null&&result.areaMin>result.areaMax) throw new Error('PUBLIC_AGENT_COMMERCIAL_FILTER_INVALID');
  return result;
}
export function compactCommercial(raw: unknown): Obj | null {
  if (!isObject(raw)) return null;
  const policy=isObject(raw.policy)?raw.policy:null;
  const params=policy&&isObject(policy.parameters)?policy.parameters:{};
  const allowed=['plan_options','annual_indexation','down_payment_options','annual_balloon_optional','annual_balloon_max_count','disclaimer'];
  const publicParams=Object.fromEntries(allowed.filter(k=>k in params).map(k=>[k,params[k]]));
  return {...raw,policy:policy?{...policy,parameters:publicParams}:null,units:Array.isArray(raw.units)?raw.units.filter(isObject).slice(0,6).map(u=>({unitCode:unitCode(u.unitCode??u.unit_code),area:finite(u.area),listPrice:finite(u.listPrice??u.list_price),pricePerSqm:finite(u.pricePerSqm??u.price_per_sqm),corner:u.corner===true})):[]};
}
export function cheapestUnit(raw: unknown): string | null {
  if (!isObject(raw)||!Array.isArray(raw.units)) return null;
  const units=raw.units.filter(isObject).filter(u=>(finite(u.listPrice??u.list_price)||0)>0&&unitCode(u.unitCode??u.unit_code));
  units.sort((a,b)=>Number(a.listPrice??a.list_price)-Number(b.listPrice??b.list_price));
  return units.length?unitCode(units[0].unitCode??units[0].unit_code):null;
}
export function bestScenario(sim: unknown): Obj | null {
  if (!isObject(sim)||!Array.isArray(sim.scenarios)) return null;
  const scenarios=sim.scenarios.filter(isObject).filter(s=>(finite(s.monthlyPayment)||0)>0&&(finite(s.months)||0)>0);
  return [...scenarios].sort((a,b)=>Number(a.monthlyPayment)-Number(b.monthlyPayment))[0]||null;
}
const brl=(n:unknown)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n));
export function simulationSummary(sim: Obj): string | null {
  const s=bestScenario(sim); if(!s) return null;
  const entry=Number(sim.downPaymentInstallments)>1?`${sim.downPaymentInstallments}x de ${brl(sim.downPaymentInstallmentAmount)}`:`${brl(sim.downPayment)} à vista`;
  const rate=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:4}).format(Number(sim.monthlyInterestRate)*100);
  const balloon=Number(sim.balloonCount)>0?`${sim.balloonCount} de ${brl(sim.balloonAmount)}, a cada ${sim.balloonFrequencyMonths} meses`:'sem balões neste cenário';
  return `Neste cenário, a menor parcela entre os prazos calculados é ${brl(s.monthlyPayment)}.\n\n• Lote ${sim.unitCode}: ${sim.area} m², ${brl(sim.price)}.\n• Entrada: ${entry}.\n• Saldo: ${s.months} parcelas iniciais de ${brl(s.monthlyPayment)}.\n• Juros: ${rate}% ao mês; correção pelo ${sim.indexer}.\n• Balões: ${balloon}.\n\nSimulação indicativa, sem projetar o índice futuro e sujeita à validação comercial. O valor mensal pode mudar com outra entrada ou balões.`;
}
export function errorKind(status:number, code:unknown): {code:string;status:number} {
  const c=text(code)||'';
  if (status===429 && /quota|credit|billing|balance|spend/i.test(c)) return {code:'BIA_PROVIDER_QUOTA',status:503};
  if (status===429) return {code:'BIA_PROVIDER_BUSY',status:503};
  if (status===401||status===403||status===404) return {code:'BIA_PROVIDER_CONFIGURATION',status:503};
  return {code:status>=500?'BIA_PROVIDER_UNAVAILABLE':'BIA_PROVIDER_REQUEST_FAILED',status:503};
}
export function dateWithZone(v:unknown,now=Date.now()): string|null {
  const s=text(v); if(!s||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:-03:00|Z)$/.test(s))return null;
  const t=Date.parse(s);return Number.isFinite(t)&&t>now+15*60_000&&t<now+180*86_400_000?new Date(t).toISOString():null;
}
