type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
type Runtime = { rpc: Rpc; authenticate: (token: string) => Promise<string | null>; http?: typeof fetch };
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string' ? v : '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMPLATE = 'bia_boas_vindas';

export function biaInitialPhone(value: unknown): string {
  const raw = str(value).trim();
  if (!raw || raw.length > 30 || !/^[+\d\s().-]+$/.test(raw)) throw new Error('BIA_PHONE_INVALID');
  let phone = raw.replace(/\D/g, '');
  if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
  if (!/^55[1-9][0-9](?:[2-9][0-9]{7}|9[0-9]{8})$/.test(phone)) throw new Error('BIA_PHONE_INVALID');
  return phone;
}

export async function biaApprovedOpening(credentials: Obj, http: typeof fetch = fetch) {
  if (credentials.enabled !== true || !/^\d{1,64}$/.test(str(credentials.waba_id)) ||
    !/^\d{1,64}$/.test(str(credentials.phone_number_id)) || !/^v\d+\.\d+$/.test(str(credentials.graph_api_version)) ||
    !str(credentials.access_token)) throw new Error('BIA_CHANNEL_DISABLED');
  const url = new URL(`https://graph.facebook.com/${credentials.graph_api_version}/${credentials.waba_id}/message_templates`);
  url.searchParams.set('name', TEMPLATE);
  url.searchParams.set('fields', 'name,status,language,category,components');
  const response = await http(url, { headers: { Authorization: `Bearer ${credentials.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
  const payload: unknown = await response.json();
  if (!response.ok || !object(payload) || !Array.isArray(payload.data)) throw new Error('BIA_TEMPLATE_UNAVAILABLE');
  const template = payload.data.find((t: unknown) => object(t) && t.name === TEMPLATE && t.language === 'pt_BR');
  if (!object(template) || template.status !== 'APPROVED') throw new Error('BIA_TEMPLATE_NOT_APPROVED');
  const components = Array.isArray(template.components) ? template.components : [];
  // Parameterless text, footer and static quick replies need no dynamic send components.
  if (components.some(c => !object(c) || !['BODY', 'FOOTER', 'BUTTONS'].includes(str(c.type)))) throw new Error('BIA_TEMPLATE_CHANGED');
  const bodies = components.filter(c => object(c) && c.type === 'BODY');
  const footers = components.filter(c => object(c) && c.type === 'FOOTER');
  const groups = components.filter(c => object(c) && c.type === 'BUTTONS');
  if (bodies.length !== 1 || footers.length > 1 || groups.length > 1) throw new Error('BIA_TEMPLATE_CHANGED');
  const body = str(bodies[0].text), footer = str(footers[0]?.text);
  const rawButtons = groups.length ? groups[0].buttons : [];
  if (!Array.isArray(rawButtons) || rawButtons.length > 10 || rawButtons.some(b => !object(b) || b.type !== 'QUICK_REPLY' || !str(b.text).trim())) throw new Error('BIA_TEMPLATE_CHANGED');
  const buttons = rawButtons.map(b => str(b.text));
  const plainText = [body, footer, buttons.length ? 'Opções: ' + buttons.join(' · ') : ''].filter(Boolean).join('\n\n');
  if (!body.trim() || plainText.length > 4000 || plainText.includes('{{')) throw new Error('BIA_TEMPLATE_CHANGED');
  const canonical = { name: TEMPLATE, language: 'pt_BR', body, footer, buttons, category: str(template.category) };
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical))));
  return { ...canonical, plainText, status: 'APPROVED', hash: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') };
}

export async function handleBiaOutbound(request: Request, runtime: Runtime): Promise<Response> {
  const origin = request.headers.get('origin') || '';
  const allowed = !origin || origin === 'https://advent-tau.vercel.app' || /^http:\/\/localhost:\d+$/.test(origin);
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'vary': 'Origin' };
  if (allowed && origin) Object.assign(headers, { 'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization,apikey,x-client-info,content-type', 'access-control-allow-methods': 'POST,OPTIONS' });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (!allowed) return json({ ok: false, error: 'BIA_ORIGIN_FORBIDDEN' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ ok: false, error: 'BIA_METHOD_INVALID' }, 405);
  try {
    const bearer = request.headers.get('authorization') || '';
    if (!bearer.startsWith('Bearer ') || bearer.length > 16000) return json({ ok: false, error: 'BIA_AUTH_REQUIRED' }, 401);
    const actor = await runtime.authenticate(bearer.slice(7));
    if (!actor || !uuid.test(actor)) return json({ ok: false, error: 'BIA_AUTH_REQUIRED' }, 401);
    const raw = await request.text();
    if (raw.length > 8192) return json({ ok: false, error: 'BIA_REQUEST_INVALID' }, 400);
    const args: unknown = JSON.parse(raw);
    if (!object(args) || !uuid.test(str(args.organizationId)) || !['preview', 'send', 'status'].includes(str(args.action))) throw new Error('BIA_REQUEST_INVALID');
    return json({ ok: true, data: await executeBiaOutbound(args, actor, runtime) });
  } catch (error) {
    const code = error instanceof Error && /^BIA_[A-Z_]+$/.test(error.message) ? error.message : 'BIA_OUTBOUND_UNAVAILABLE';
    return json({ ok: false, error: code }, code.includes('FORBIDDEN') ? 403 : 400);
  }
}

// Internal service entry point. Callers must verify the actor with Auth; the RPC rechecks organization membership.
export async function executeBiaOutbound(args: Obj, actor: string, runtime: Pick<Runtime, 'rpc' | 'http'>, fromChat = false): Promise<unknown> {
  if (!uuid.test(actor) || !uuid.test(str(args.organizationId))) throw new Error('BIA_OUTBOUND_FORBIDDEN');
    const admin = (action: string, data: Obj = {}) => runtime.rpc('bia_whatsapp_outbound_admin', {
      p_organization_id: args.organizationId, p_actor: actor, p_action: action, p_args: data,
    });
    const access = await admin('access');
    if (args.action === 'status') {
      if (!uuid.test(str(args.id))) throw new Error('BIA_REQUEST_INVALID');
      return await admin('status', { id: args.id });
    }
    if (!object(access) || access.enabled !== true) throw new Error('BIA_CHANNEL_DISABLED');
    const credentials = await runtime.rpc('bia_whatsapp_credentials', { p_organization_id: args.organizationId });
    if (!object(credentials)) throw new Error('BIA_CHANNEL_DISABLED');
    const http = runtime.http || fetch;
    const template = await biaApprovedOpening(credentials, http);
    if (args.action === 'preview') return template;
    const phone = biaInitialPhone(args.phone);
    if (!uuid.test(str(args.id)) || args.consent !== true) throw new Error('BIA_REQUEST_INVALID');
    if (!fromChat && args.hash !== template.hash) throw new Error('BIA_TEMPLATE_CHANGED');
    const started = await admin('start', { id: args.id, phone, consent: true, template: TEMPLATE, hash: template.hash, body: template.plainText });
    if (!object(started) || started.proceed !== true) return started;
    let outcome: Obj = { status: 'unknown', errorCode: 'SEND_UNCONFIRMED' };
    try {
      const response = await http(`https://graph.facebook.com/${credentials.graph_api_version}/${credentials.phone_number_id}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template',
          template: { name: TEMPLATE, language: { code: 'pt_BR' } }, biz_opaque_callback_data: args.id }),
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
      const payload: unknown = await response.json();
      const message = object(payload) && Array.isArray(payload.messages) ? payload.messages[0] : null;
      const contact = object(payload) && Array.isArray(payload.contacts) ? payload.contacts[0] : null;
      if (response.ok && object(message) && str(message.id)) {
        outcome = { status: 'accepted', providerMessageId: message.id, recipientPhone: object(contact) && str(contact.wa_id) ? contact.wa_id : phone };
      } else if (response.status >= 400 && response.status < 500 && object(payload) && object(payload.error)) {
        outcome = { status: 'failed', errorCode: 'META_' + String(payload.error.code || response.status).replace(/[^0-9]/g, '').slice(0, 12) };
      }
    } catch { /* A timeout or malformed success is uncertain, never an automatic retry. */ }
    try { return await admin('finish', { id: args.id, ...outcome }); }
    catch { return { ...started, status: 'unknown', errorCode: 'SEND_UNCONFIRMED' }; }
}
