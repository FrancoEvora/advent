type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
type Runtime = { rpc: Rpc; authenticate: (token: string) => Promise<string | null>; http?: typeof fetch };
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string' ? v : '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const templateNamePattern = /^[a-z0-9_]{1,512}$/;
export const BIA_OUTBOUND_TEMPLATE = 'bia_indicacao_investimento';
export const BIA_INBOUND_TEMPLATE = 'bia_boas_vindas';
const TEMPLATE = BIA_OUTBOUND_TEMPLATE;

export type BiaMetaTemplate = {
  name: string;
  language: string;
  category: string;
  status: 'APPROVED';
  header: string;
  body: string;
  footer: string;
  buttons: string[];
  plainText: string;
  parameterCount: number;
  sendable: boolean;
  compatibilityReason: string | null;
  hash?: string;
};

function assertCredentials(credentials: Obj) {
  if (
    credentials.enabled !== true ||
    !/^\d{1,64}$/.test(str(credentials.waba_id)) ||
    !/^\d{1,64}$/.test(str(credentials.phone_number_id)) ||
    !/^v\d+\.\d+$/.test(str(credentials.graph_api_version)) ||
    !str(credentials.access_token)
  ) throw new Error('BIA_CHANNEL_DISABLED');
}

function parseTemplate(raw: Obj): BiaMetaTemplate | null {
  const name = str(raw.name);
  if (!templateNamePattern.test(name) || raw.status !== 'APPROVED' || raw.language !== 'pt_BR') return null;

  const components = Array.isArray(raw.components) ? raw.components : [];
  const bodies = components.filter(c => object(c) && c.type === 'BODY') as Obj[];
  const headers = components.filter(c => object(c) && c.type === 'HEADER') as Obj[];
  const footers = components.filter(c => object(c) && c.type === 'FOOTER') as Obj[];
  const groups = components.filter(c => object(c) && c.type === 'BUTTONS') as Obj[];
  const unknown = components.filter(c => !object(c) || !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(str(c.type)));

  const body = bodies.length === 1 ? str(bodies[0].text) : '';
  const footer = footers.length === 1 ? str(footers[0].text) : '';
  const headerObj = headers.length === 1 ? headers[0] : null;
  const headerFormat = headerObj ? str(headerObj.format || 'TEXT') : '';
  const header = headerObj && (!headerFormat || headerFormat === 'TEXT') ? str(headerObj.text) : '';
  const rawButtons = groups.length === 1 && Array.isArray(groups[0].buttons) ? groups[0].buttons as unknown[] : [];
  const buttons = rawButtons
    .filter(object)
    .map(button => str(button.text).trim())
    .filter(Boolean);

  const placeholders = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(match => match[1]);
  const unique = [...new Set(placeholders)];
  const parameterCount = unique.length;

  let compatibilityReason: string | null = null;
  if (unknown.length || bodies.length !== 1 || headers.length > 1 || footers.length > 1 || groups.length > 1) {
    compatibilityReason = 'Estrutura do template ainda não suportada pelo disparo automático.';
  } else if (headerObj && headerFormat !== 'TEXT') {
    compatibilityReason = 'O template usa cabeçalho de mídia e precisa de configuração específica.';
  } else if (/\{\{\d+\}\}/.test(header) || /\{\{\d+\}\}/.test(footer)) {
    compatibilityReason = 'O template usa variável fora do corpo da mensagem.';
  } else if (!(parameterCount === 0 || (parameterCount === 1 && unique[0] === '1' && placeholders.length === 1))) {
    compatibilityReason = 'O template exige mais parâmetros do que o nome do contato.';
  } else if (/[{}]/.test(body.replace('{{1}}', '')) || /[{}]/.test(header + footer)) {
    compatibilityReason = 'O template possui parâmetros não reconhecidos.';
  } else if (rawButtons.some(button => {
    if (!object(button)) return true;
    const url = str(button.url);
    return /\{\{\d+\}\}/.test(url);
  })) {
    compatibilityReason = 'O template possui botão com parâmetro dinâmico.';
  }

  const plainText = [
    header,
    body,
    footer,
    buttons.length ? 'Opções: ' + buttons.join(' · ') : '',
  ].filter(Boolean).join('\n\n');

  if (!body.trim()) compatibilityReason ||= 'O template não possui corpo de mensagem.';
  if (plainText.length > 3800) compatibilityReason ||= 'O texto excede o limite operacional do canal.';

  return {
    name,
    language: 'pt_BR',
    category: str(raw.category),
    status: 'APPROVED',
    header,
    body,
    footer,
    buttons,
    plainText,
    parameterCount,
    sendable: compatibilityReason === null,
    compatibilityReason,
  };
}

async function fetchTemplatePage(url: URL, credentials: Obj, http: typeof fetch) {
  const response = await http(url, {
    headers: { Authorization: `Bearer ${credentials.access_token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !object(payload) || !Array.isArray(payload.data)) {
    throw new Error('BIA_TEMPLATE_UNAVAILABLE');
  }
  return payload;
}

export async function biaApprovedTemplates(credentials: Obj, http: typeof fetch = fetch): Promise<BiaMetaTemplate[]> {
  assertCredentials(credentials);
  let url: URL | null = new URL(
    `https://graph.facebook.com/${credentials.graph_api_version}/${credentials.waba_id}/message_templates`,
  );
  url.searchParams.set('fields', 'name,status,language,category,components');
  url.searchParams.set('limit', '100');

  const templates: BiaMetaTemplate[] = [];
  for (let page = 0; url && page < 5; page++) {
    const payload = await fetchTemplatePage(url, credentials, http);
    for (const raw of payload.data as unknown[]) {
      if (!object(raw)) continue;
      const parsed = parseTemplate(raw);
      if (parsed) templates.push(parsed);
    }

    const paging = object(payload.paging) ? payload.paging : null;
    const next = paging ? str(paging.next) : '';
    if (!next) break;
    const nextUrl = new URL(next);
    if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'graph.facebook.com') {
      throw new Error('BIA_TEMPLATE_UNAVAILABLE');
    }
    url = nextUrl;
  }

  const deduped = new Map<string, BiaMetaTemplate>();
  for (const template of templates) deduped.set(template.name, template);
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function biaRecipientName(value: unknown): string {
  const name = str(value).trim().replace(/\s+/g, ' ');
  if (!name) return 'tudo bem';
  if (name.length > 80 || !/^[\p{L}\p{M} .’'-]+$/u.test(name)) throw new Error('BIA_RECIPIENT_NAME_INVALID');
  return name;
}

export function biaPersonalizedOpening(template: { body: string; plainText: string }, recipientName: unknown) {
  const needsName = template.body.includes('{{1}}');
  if (!needsName) {
    return { body: template.body, plainText: template.plainText, components: [] as Obj[] };
  }
  const name = biaRecipientName(recipientName);
  return {
    body: template.body.replace('{{1}}', name),
    plainText: template.plainText.replace('{{1}}', name),
    components: [{ type: 'body', parameters: [{ type: 'text', text: name }] }],
  };
}

export function biaInitialPhone(value: unknown): string {
  const raw = str(value).trim();
  if (!raw || raw.length > 30 || !/^[+\d\s().-]+$/.test(raw)) throw new Error('BIA_PHONE_INVALID');
  let phone = raw.replace(/\D/g, '');
  if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
  if (!/^55[1-9][0-9](?:[2-9][0-9]{7}|9[0-9]{8})$/.test(phone)) throw new Error('BIA_PHONE_INVALID');
  return phone;
}

export async function biaApprovedOpening(credentials: Obj, http: typeof fetch = fetch) {
  return biaApprovedTemplate(credentials, BIA_OUTBOUND_TEMPLATE, http);
}

export async function biaApprovedTemplate(credentials: Obj, name: string, http: typeof fetch = fetch) {
  if (!templateNamePattern.test(name)) throw new Error('BIA_TEMPLATE_CHANGED');
  assertCredentials(credentials);
  const url = new URL(
    `https://graph.facebook.com/${credentials.graph_api_version}/${credentials.waba_id}/message_templates`,
  );
  url.searchParams.set('name', name);
  url.searchParams.set('fields', 'name,status,language,category,components');
  const payload = await fetchTemplatePage(url, credentials, http);
  const template = (payload.data as unknown[])
    .filter(object)
    .map(parseTemplate)
    .find((item): item is BiaMetaTemplate => Boolean(item && item.name === name));

  if (!template) throw new Error('BIA_TEMPLATE_NOT_APPROVED');
  if (!template.sendable) throw new Error('BIA_TEMPLATE_CHANGED');

  const canonical = {
    name: template.name,
    language: template.language,
    header: template.header,
    body: template.body,
    footer: template.footer,
    buttons: template.buttons,
    category: template.category,
  };
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical)),
    ),
  );
  return {
    ...template,
    hash: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
  };
}

export async function handleBiaOutbound(request: Request, runtime: Runtime): Promise<Response> {
  const origin = request.headers.get('origin') || '';
  const allowed =
    !origin ||
    origin === 'https://enterprise.terraragroup.com.br' ||
    origin === 'https://advent-tau.vercel.app' ||
    /^http:\/\/localhost:\d+$/.test(origin);
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'vary': 'Origin',
  };
  if (allowed && origin) {
    Object.assign(headers, {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization,apikey,x-client-info,content-type',
      'access-control-allow-methods': 'POST,OPTIONS',
    });
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (!allowed) return json({ ok: false, error: 'BIA_ORIGIN_FORBIDDEN' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ ok: false, error: 'BIA_METHOD_INVALID' }, 405);
  try {
    const bearer = request.headers.get('authorization') || '';
    if (!bearer.startsWith('Bearer ') || bearer.length > 16000) {
      return json({ ok: false, error: 'BIA_AUTH_REQUIRED' }, 401);
    }
    const actor = await runtime.authenticate(bearer.slice(7));
    if (!actor || !uuid.test(actor)) return json({ ok: false, error: 'BIA_AUTH_REQUIRED' }, 401);
    const raw = await request.text();
    if (raw.length > 8192) return json({ ok: false, error: 'BIA_REQUEST_INVALID' }, 400);
    const args: unknown = JSON.parse(raw);
    if (
      !object(args) ||
      !uuid.test(str(args.organizationId)) ||
      !['templates', 'preview', 'send', 'status'].includes(str(args.action))
    ) throw new Error('BIA_REQUEST_INVALID');
    return json({ ok: true, data: await executeBiaOutbound(args, actor, runtime) });
  } catch (error) {
    const code =
      error instanceof Error && /^BIA_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'BIA_OUTBOUND_UNAVAILABLE';
    return json({ ok: false, error: code }, code.includes('FORBIDDEN') ? 403 : 400);
  }
}

export async function executeBiaOutbound(
  args: Obj,
  actor: string,
  runtime: Pick<Runtime, 'rpc' | 'http'>,
  fromChat = false,
): Promise<unknown> {
  if (!uuid.test(actor) || !uuid.test(str(args.organizationId))) {
    throw new Error('BIA_OUTBOUND_FORBIDDEN');
  }

  const admin = (action: string, data: Obj = {}) =>
    runtime.rpc('bia_whatsapp_outbound_admin', {
      p_organization_id: args.organizationId,
      p_actor: actor,
      p_action: action,
      p_args: data,
    });

  const access = await admin('access');
  if (args.action === 'status') {
    if (!uuid.test(str(args.id))) throw new Error('BIA_REQUEST_INVALID');
    return await admin('status', { id: args.id });
  }
  if (!object(access) || access.enabled !== true) throw new Error('BIA_CHANNEL_DISABLED');

  const credentials = await runtime.rpc('bia_whatsapp_credentials', {
    p_organization_id: args.organizationId,
  });
  if (!object(credentials)) throw new Error('BIA_CHANNEL_DISABLED');
  const http = runtime.http || fetch;

  if (args.action === 'templates') {
    return await biaApprovedTemplates(credentials, http);
  }

  const template = await biaApprovedOpening(credentials, http);
  if (args.action === 'preview') return template;

  const phone = biaInitialPhone(args.phone);
  if (!uuid.test(str(args.id)) || args.consent !== true) throw new Error('BIA_REQUEST_INVALID');
  if (!fromChat && args.hash !== template.hash) throw new Error('BIA_TEMPLATE_CHANGED');

  const recipient = await admin('recipient', { phone });
  const opening = biaPersonalizedOpening(
    template,
    args.recipientName || (object(recipient) ? recipient.name : ''),
  );
  const started = await admin('start', {
    id: args.id,
    phone,
    consent: true,
    template: TEMPLATE,
    hash: template.hash,
    body: opening.plainText,
  });
  if (!object(started) || started.proceed !== true) return started;

  let outcome: Obj = { status: 'unknown', errorCode: 'SEND_UNCONFIRMED' };
  try {
    const templatePayload: Obj = {
      name: TEMPLATE,
      language: { code: 'pt_BR' },
    };
    if (opening.components.length) templatePayload.components = opening.components;

    const response = await http(
      `https://graph.facebook.com/${credentials.graph_api_version}/${credentials.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'template',
          template: templatePayload,
          biz_opaque_callback_data: args.id,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      },
    );
    const payload: unknown = await response.json();
    const message =
      object(payload) && Array.isArray(payload.messages) ? payload.messages[0] : null;
    const contact =
      object(payload) && Array.isArray(payload.contacts) ? payload.contacts[0] : null;
    if (response.ok && object(message) && str(message.id)) {
      outcome = {
        status: 'accepted',
        providerMessageId: message.id,
        recipientPhone:
          object(contact) && str(contact.wa_id) ? contact.wa_id : phone,
      };
    } else if (
      response.status >= 400 &&
      response.status < 500 &&
      object(payload) &&
      object(payload.error)
    ) {
      outcome = {
        status: 'failed',
        errorCode:
          'META_' +
          String(payload.error.code || response.status)
            .replace(/[^0-9]/g, '')
            .slice(0, 12),
      };
    }
  } catch {
    // A timeout or malformed success is uncertain, never an automatic retry.
  }

  try {
    return await admin('finish', { id: args.id, ...outcome });
  } catch {
    return { ...started, status: 'unknown', errorCode: 'SEND_UNCONFIRMED' };
  }
}
