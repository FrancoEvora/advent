import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

type Obj = Record<string, unknown>;
const root = new URL("../", import.meta.url), org = "11111111-1111-4111-8111-111111111111", user = "22222222-2222-4222-8222-222222222222", messageId = "33333333-3333-4333-8333-333333333333", threadId = "44444444-4444-4444-8444-444444444444", lease = "55555555-5555-4555-8555-555555555555";
let auth = true, adminAccess = true, visible = true, terminal = false, mutation = false, round = 0;
let calls: { key: string; name: string; args: Obj }[] = [];
let bia = false, biaContent = 'Final 1159', historyRows: Obj[] = [], queryFilters: {table:string;column:string;value:unknown}[] = [];
const defaultCrmRows = [{id:'jaq1',person_name:'Jaqueline',phone:'34999991159'},{id:'jaq2',person_name:'Jaqueline Hillebrand',phone:'34999990685'}];
let crmRows=defaultCrmRows;
const reset = () => { auth = true; adminAccess = true; visible = true; terminal = false; mutation = false; round = 0; calls = []; bia = false; historyRows = []; queryFilters = []; crmRows=defaultCrmRows; };
function createClient(_url: string, key: string) {
  return {
    auth: { getUser: async () => ({ error: auth ? null : {}, data: { user: auth ? { id: user } : null } }) },
    rpc: async (name: string, args: Obj) => {
      calls.push({ key, name, args });
      if (name === "arisa_admin_catalog") return { error: adminAccess ? null : { code: "42501", message: "ADMIN_REQUIRED" }, data: { entities: [] } };
      if (name === "get_crm_ai_runtime_credentials") return { error: null, data: { enabled: true, api_key: "private-test-key-".repeat(4), agent_model: "test-model" } };
      if (name === "arisa_chat_claim") return { error: null, data: { lease: terminal ? null : lease, message: { id: messageId, content: bia ? biaContent : "Cadastre o fornecedor Teste", created_at: "2026-09-05T12:00:00Z", file_ids: [] } } };
      if (name === 'arisa_admin_query') return {error:null,data: {total:2,rows:crmRows}};
      if (name === 'bia_whatsapp_credentials') return {error:null,data:{enabled:true,waba_id:'123',phone_number_id:'456',graph_api_version:'v23.0',access_token:'mock-only'}};
      if (name === 'bia_whatsapp_outbound_admin') {
        const data = args.p_args as Obj;
        return {error:null,data:args.p_action === 'access' ? {enabled:true} : args.p_action === 'recipient' ? {name:'Jaqueline'} : args.p_action === 'start' ? {proceed:true} : {status:data.status,provider_message_id:data.providerMessageId}};
      }
      if (name === "arisa_admin_execute") return { error: null, data: { ok: true, record_id: "created" } };
      if (name === "arisa_recall") return { error: null, data: [] };
      if (name === "arisa_trace") return { error: null, data: "archived-trace" };
      if (name === "arisa_chat_finish") return { error: null, data: { id: "reply", content: args.p_content, status: "completed" } };
      throw new Error("Unexpected RPC " + name);
    },
    from: (name: string) => {
      assert.equal(key, "public-test");
      const query = { select: () => query, eq: (column:string,value:unknown) => {queryFilters.push({table:name,column,value});return query;}, lte: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ error: null, data: visible ? { assistant: bia ? 'bia' : "arisa", id: messageId, thread_id: threadId, content: "Resposta anterior" } : null }),
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null, data: name === "arisa_chat_actions" ? [] : bia ? [...historyRows] : [{ id: messageId, role: "user", content: "Teste", file_ids: [], created_at: "2026-09-05T12:00:00Z" }] }).then(resolve),
      }; return query;
    },
  };
}
const target = globalThis as unknown as { __arisaManagerClient: typeof createClient; Deno: { env: { get: (name: string) => string | undefined } } };
target.__arisaManagerClient = createClient;
target.Deno = { env: { get: name => ({ SUPABASE_URL: "https://test.invalid", SUPABASE_ANON_KEY: "public-test", SUPABASE_SERVICE_ROLE_KEY: "service-test" } as Record<string, string>)[name] } };
const source = readFileSync(new URL("supabase/functions/arisa-manager/index.ts", root), "utf8")
  .replace(/import \{ createClient, type SupabaseClient \} from [^;]+;/, "const createClient = globalThis.__arisaManagerClient; type SupabaseClient = any;")
  .replaceAll('"../_shared/arisa-document.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-document.ts", root).href))
  .replaceAll('"../_shared/arisa-manager.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-manager.ts", root).href))
  .replaceAll('"../_shared/arisa-mail-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-mail-runtime.ts", root).href))
  .replaceAll('"../_shared/arisa-calendar.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-calendar.ts", root).href))
  .replaceAll('"../_shared/arisa-calendar-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-calendar-runtime.ts", root).href))
  .replaceAll('"../_shared/arisa-whatsapp.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-whatsapp.ts", root).href))
  .replaceAll('"../_shared/arisa-whatsapp-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-whatsapp-runtime.ts", root).href))
  .replaceAll("\"../_shared/bia-manager-whatsapp.ts\"", JSON.stringify(new URL("supabase/functions/_shared/bia-manager-whatsapp.ts", root).href))
  .replace("Deno.serve(handleRequest);", "");
const { handleRequest } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "strip" })).toString("base64")}`);
const originalFetch = globalThis.fetch;
const request = (token = "Bearer test-token") => new Request("https://test.invalid/arisa-manager", { method: "POST", headers: { authorization: token }, body: JSON.stringify({ action: "chat", organizationId: org, messageId }) });
test.beforeEach(() => {
  reset(); globalThis.fetch = async () => {
    const output = mutation && !round++ ? [{ type: "function_call", call_id: "call_1", name: "execute", arguments: JSON.stringify({ action: "create", entity: "contacts", values: { name: "Teste" }, summary: "Fornecedor cadastrado" }) }] : [{ type: "message", content: [{ type: "output_text", text: "Resposta concluída." }] }];
    return new Response(JSON.stringify({ status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } }));
  };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test("anonymous and expired sessions cannot read credentials or claim work", async () => {
  assert.equal((await handleRequest(request(""))).status, 401); assert.equal(calls.length, 0);
  auth = false; assert.equal((await handleRequest(request())).status, 401); assert.equal(calls.length, 0);
});
test("admin authorization is enforced before service-role credentials are read", async () => {
  adminAccess = false; assert.equal((await handleRequest(request())).status, 403);
  assert.deepEqual(calls.map(call => call.name), ["arisa_admin_catalog"]); assert.equal(calls[0].key, "public-test");
});
test("RLS visibility is required before a service-role claim", async () => {
  visible = false; assert.equal((await handleRequest(request())).status, 404); assert.equal(calls.some(call => call.name === "arisa_chat_claim"), false);
});
test("an already completed message is returned without new generation or mutation", async () => {
  terminal = true; const response = await handleRequest(request()); assert.equal(response.status, 200); assert.equal((await response.json()).replayed, true); assert.equal(calls.some(call => call.name === "arisa_chat_finish"), false);
});
test("administrative mutation uses the CALLER token, actual message lease, and server-enforced organization", async () => {
  mutation = true; const response = await handleRequest(request()); assert.equal(response.status, 200);
  const executed = calls.find(call => call.name === "arisa_admin_execute")!;
  assert.equal(executed.key, "public-test"); assert.equal(executed.args.p_organization_id, org); assert.equal(executed.args.p_message_id, messageId); assert.equal(executed.args.p_lease, lease); assert.match(String(executed.args.p_operation_key), /^[a-f0-9]{64}$/);
  const finish = calls.find(call => call.name === "arisa_chat_finish")!; assert.equal(finish.key, "service-test"); assert.equal(finish.args.p_lease, lease); assert.equal((finish.args.p_metadata as Obj).model, "test-model");
  assert.equal(JSON.stringify(await response.json()).includes("private-test-key"), false);
});

async function verifyBiaDispatch(message:string,skipModelQuery=false,direct=false,phoneCorrection=false,duplicatePhone=false) {
  reset();biaContent = message;
  if(duplicatePhone)crmRows=defaultCrmRows.map(row=>({...row,phone:defaultCrmRows[0].phone}));
  bia = true;let graphPosts = 0;
  const orderId = '88888888-8888-4888-8888-888888888888';
  historyRows = [
    {id:messageId,role:'user',content:message},
    {id:'reply',role:'assistant',status:'completed',content:'Encontrei duas Jaquelines, final 1159 e final 0685. Qual delas?'},
    {id:orderId,role:'user',content:'Bia, inicie contato com a Jaqueline cadastrada em nosso sistema. Via WhatsApp.'},
  ];
  if(direct)historyRows = historyRows.slice(0,1);
  else if(skipModelQuery)historyRows.splice(1,0,...['Tente novamente','+55 34 99999-1159 Tente este número','Tente novamente','Você tem a autorização','Final 1159'].map((content,index)=>({id:'prior-'+index,role:'user',content})));
  if(phoneCorrection)historyRows=[{id:messageId,role:'user',content:message},
    {id:'typo2',role:'user',content:'349999991159'},
    {id:'typo1',role:'user',content:'349999991159'},
    {id:orderId,role:'user',content:'Bia. Apresente o Solaris para 34999991159 Jaqueline.'}];
  globalThis.fetch = async (url,init) => {
    if(String(url).includes('graph.facebook.com')) {
      if(init?.method === 'POST') {
        graphPosts++;const body = JSON.parse(String(init.body));assert.equal(body.to,'5534999991159');assert.equal(body.template.name,'bia_indicacao_investimento');
        return Response.json({messages:[{id:'mock-message'}]});
      }
      return Response.json({data:[{name:'bia_indicacao_investimento',language:'pt_BR',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá, {{1}}! Sou a Bia.'}]}]});
    }
    const body = JSON.parse(String(init?.body));assert.match(body.instructions,/RETOMADA DO WHATSAPP/);
    const step = round++ + (skipModelQuery ? 1 : 0);
    const output = step === 0 ? [{type:'function_call',call_id:'crm',name:'query',arguments:JSON.stringify({entity:'crm_records',search:'Jaqueline'})}] :
      step === 1 ? [{type:'function_call',call_id:'wa',name:'whatsapp',arguments:JSON.stringify({action:'send',...(duplicatePhone ? {contact_id:'nonexistent-model-id'} : skipModelQuery ? {} : {contact_id:'jaq1'}),phone:'34999991159',template_name:'bia_indicacao_investimento'})}] :
      [{type:'message',content:[{type:'output_text',text:'Mensagem enviada.'}]}];
    return Response.json({status:'completed',output,usage:{input_tokens:1,output_tokens:1}});
  };
  const response = await handleRequest(request());const body = await response.json();assert.equal(response.status,200);assert.equal(body.ok,true);assert.equal(graphPosts,1);
  const lookup = calls.filter(call=>call.name === 'arisa_admin_query');assert.equal(lookup.length,duplicatePhone ? 1 : 2);assert.ok(lookup.every(call=>call.key === 'public-test' && call.args.p_organization_id === org));
  const start = calls.find(call=>call.name === 'bia_whatsapp_outbound_admin' && call.args.p_action === 'start')!;
  const {biaChatOperationId} = await import('../supabase/functions/enterprise-bia-agent-gateway/whatsapp-operator.ts');
  assert.equal((start.args.p_args as Obj).id,await biaChatOperationId(threadId,direct ? messageId : orderId));assert.equal(start.args.p_actor,user);
  if(skipModelQuery)assert.deepEqual(lookup[0].args.p_filters,duplicatePhone ? [{column:'id',operator:'eq',value:'nonexistent-model-id'}] : [{column:'phone',operator:'contains',value:'1159'}]);
  const historyAt = queryFilters.findIndex(filter=>filter.table === 'arisa_chat_messages' && filter.column === 'thread_id');
  assert.deepEqual(queryFilters.slice(historyAt,historyAt+3),[
    {table:'arisa_chat_messages',column:'thread_id',value:threadId},
    {table:'arisa_chat_messages',column:'organization_id',value:org},
    {table:'arisa_chat_messages',column:'owner_user_id',value:user},
  ]);
}

test('Bia handler carries only stored caller history through CRM lookup and clarified WhatsApp dispatch',async()=>{
  await verifyBiaDispatch('Final 1159');
});
test('Bia handler accepts the reported sales order and full phone-ending phrase',async()=>{
  await verifyBiaDispatch('Venda um lote para a Jaqueline. Via WhatsApp. O final do telefone é o 1159.',false,true);
});
test('Bia handler recovers CRM candidates when a retry skips the model query',async()=>{
  await verifyBiaDispatch('Tente agora',true);
  await verifyBiaDispatch('Tente novamente',true);
  await verifyBiaDispatch('+55 34 99999-1159 Tente este número',true);
});

test('Bia handler accepts an addressed presentation and preserves it across invalid phone corrections',async()=>{
  await verifyBiaDispatch('Bia. Apresente o Solaris para 34999991159 Jaqueline.',false,true);
  await verifyBiaDispatch('34999991159',true,false,true);
  await verifyBiaDispatch('34999991159',false,false,true,true);
});
