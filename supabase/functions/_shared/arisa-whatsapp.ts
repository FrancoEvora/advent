import { isObject, ManagerError, type Obj } from "./arisa-manager.ts";

export const WHATSAPP_ERRORS: Record<string, string> = {
  WHATSAPP_NOT_CONFIGURED: "O envio pelo WhatsApp da Arisa ainda não está habilitado. Abra Arisa → Comunicações → WhatsApp para conferir a conexão.",
  WHATSAPP_WEBHOOK_REQUIRED: "Cadastre o webhook da plataforma na Meta antes de habilitar o envio da Arisa.",
  WHATSAPP_TEMPLATE_REQUIRED: "Este contato está fora da janela de 24 horas. Para iniciar ou retomar a conversa, use um template aprovado pela Meta.",
  WHATSAPP_TEMPLATE_NOT_FOUND: "O template não está aprovado ou não existe no WhatsApp Business conectado. Consulte os templates antes de enviar.",
  WHATSAPP_CONTACT_NOT_FOUND: "Não encontrei o contato informado na organização.",
  WHATSAPP_PHONE_INVALID: "Informe o WhatsApp com código do país e DDD, ou selecione um contato com telefone válido.",
  WHATSAPP_CONTACT_PHONE_MISMATCH: "O telefone informado difere do cadastro do contato. Confira o destinatário antes de enviar.",
  WHATSAPP_CONTACT_AMBIGUOUS: "Mais de um contato usa esse telefone. Identifique o cadastro correto antes de enviar.",
  WHATSAPP_CONTACT_BLOCKED: "Este contato está bloqueado para comunicação na plataforma.",
  WHATSAPP_INVALID: "A mensagem do WhatsApp está incompleta ou inválida.",
  WHATSAPP_REQUEST_CHANGED: "Esta solicitação já foi registrada com outro conteúdo. Consulte o envio anterior antes de criar outro.",
  WHATSAPP_NOT_FOUND: "O envio do WhatsApp não foi encontrado.",
  WHATSAPP_BUSY: "Este envio já está em andamento. Consulte o resultado antes de tentar novamente.",
  WHATSAPP_LIMIT: "A Meta aplicou um limite temporário ao WhatsApp. O envio não será repetido automaticamente.",
  WHATSAPP_AUTH_REQUIRED: "A conexão com a WhatsApp Business Platform precisa ser renovada.",
  WHATSAPP_UNDELIVERABLE: "A Meta informou que não conseguiu entregar a mensagem a esse destinatário.",
  WHATSAPP_UNAVAILABLE: "A Meta não confirmou o resultado. Consulte o envio antes de tentar novamente para evitar duplicidade.",
};

export function normalizeWhatsAppPhone(value: unknown) {
  if (typeof value !== "string") throw new ManagerError("WHATSAPP_PHONE_INVALID", 422);
  const phone = value.replace(/\D/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) throw new ManagerError("WHATSAPP_PHONE_INVALID", 422);
  return phone;
}
function invalid(): never { throw new ManagerError("WHATSAPP_INVALID", 422); }
function shortText(value: unknown, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return invalid();
  return value;
}

export function templateComponents(value: unknown): Obj[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) return invalid();
  const seen = new Set<string>();
  return value.map(component => {
    if (!isObject(component)) return invalid();
    const type = String(component.type || "").toLowerCase();
    if (!["header", "body", "button"].includes(type)) return invalid();
    const parameters = component.parameters === undefined ? [] : component.parameters;
    if (!Array.isArray(parameters) || parameters.length > 20) return invalid();
    const identity = type === "button" ? `${type}:${component.index}` : type;
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    const clean = parameters.map(parameter => {
      if (!isObject(parameter)) return invalid();
      let output: Obj;
      if (parameter.type === "text") output = { type: "text", text: shortText(parameter.text) };
      else if (parameter.type === "payload" && type === "button" && component.sub_type === "quick_reply") output = { type: "payload", payload: shortText(parameter.payload, 256) };
      else if (parameter.type === "currency" && isObject(parameter.currency)) {
        const currency = parameter.currency;
        if (typeof currency.code !== "string" || !/^[A-Z]{3}$/.test(currency.code) || !Number.isSafeInteger(currency.amount_1000)) return invalid();
        output = { type: "currency", currency: { fallback_value: shortText(currency.fallback_value), code: currency.code, amount_1000: currency.amount_1000 } };
      } else if (parameter.type === "date_time" && isObject(parameter.date_time)) {
        output = { type: "date_time", date_time: { fallback_value: shortText(parameter.date_time.fallback_value) } };
      } else if (["image", "document", "video"].includes(String(parameter.type)) && type === "header") {
        const media = parameter[String(parameter.type)];
        if (!isObject(media)) return invalid();
        const safe: Obj = {};
        if (typeof media.id === "string" && /^[0-9]{1,64}$/.test(media.id)) safe.id = media.id;
        else if (typeof media.link === "string" && media.link.length < 4096) {
          let url: URL; try { url = new URL(media.link); } catch { return invalid(); }
          if (url.protocol !== "https:" || url.username || url.password) return invalid();
          safe.link = url.toString();
        } else return invalid();
        if (parameter.type === "document" && media.filename !== undefined) safe.filename = shortText(media.filename, 240);
        output = { type: parameter.type, [String(parameter.type)]: safe };
      } else return invalid();
      if (parameter.parameter_name !== undefined) {
        if (typeof parameter.parameter_name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(parameter.parameter_name)) return invalid();
        output.parameter_name = parameter.parameter_name;
      }
      return output;
    });
    const output: Obj = { type, parameters: clean };
    if (type === "button") {
      const index = typeof component.index === "string" && /^\d$/.test(component.index) ? Number(component.index) : component.index;
      if (!["quick_reply", "url"].includes(String(component.sub_type)) || !Number.isInteger(index) || Number(index) < 0 || Number(index) > 9) return invalid();
      output.sub_type = component.sub_type; output.index = String(index);
    }
    return output;
  });
}

function parameterText(parameter: Obj) {
  if (parameter.type === "text") return String(parameter.text);
  if (parameter.type === "currency" && isObject(parameter.currency)) return String(parameter.currency.fallback_value);
  if (parameter.type === "date_time" && isObject(parameter.date_time)) return String(parameter.date_time.fallback_value);
  return invalid();
}
/** Archive the actual approved template rendered with its supplied parameters. */
export function renderedTemplate(template: Obj, components: Obj[]) {
  const approved = Array.isArray(template.components) ? template.components.filter(isObject) : [];
  const lines: string[] = [];
  for (const component of approved) {
    const type = String(component.type || "").toLowerCase();
    if (typeof component.text !== "string") continue;
    const supplied = components.find(item => item.type === type);
    const parameters = supplied && Array.isArray(supplied.parameters) ? supplied.parameters.filter(isObject) : [];
    const used = new Set<number>();
    const text = component.text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, name: string) => {
      const index = /^\d+$/.test(name) ? Number(name) - 1 : parameters.findIndex(parameter => parameter.parameter_name === name);
      const parameter = parameters[index];
      if (!parameter || index < 0) return invalid();
      used.add(index); return parameterText(parameter);
    });
    if (parameters.length !== used.size) return invalid();
    lines.push(text);
  }
  if (!lines.length || lines.join("\n\n").length > 12000) return invalid();
  return lines.join("\n\n");
}

export type WhatsAppRuntime = { organization_id?: string; enabled: boolean; configured?: boolean; waba_id: string; phone_number_id: string; graph_api_version: string; access_token: string; display_phone_number?: string };
export function whatsappRuntime(value: unknown, requireEnabled = true): WhatsAppRuntime {
  if (!isObject(value) || (requireEnabled && value.enabled !== true)) throw new ManagerError("WHATSAPP_NOT_CONFIGURED", 409);
  for (const key of ["waba_id", "phone_number_id", "graph_api_version", "access_token"]) {
    if (typeof value[key] !== "string" || !String(value[key]).trim()) throw new ManagerError("WHATSAPP_NOT_CONFIGURED", 409);
  }
  if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(String(value.graph_api_version)) || !/^[0-9]{1,64}$/.test(String(value.waba_id)) || !/^[0-9]{1,64}$/.test(String(value.phone_number_id))) throw new ManagerError("WHATSAPP_NOT_CONFIGURED", 409);
  return value as unknown as WhatsAppRuntime;
}
export async function metaWhatsApp(runtime: WhatsAppRuntime, path: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<Obj> {
  let response: Response;
  try {
    response = await request(`https://graph.facebook.com/${runtime.graph_api_version}/${path}`, {
      ...options, headers: { "content-type": "application/json", ...options.headers, authorization: "Bearer " + runtime.access_token }, signal: AbortSignal.timeout(20000), redirect: "error",
    });
  } catch { throw new ManagerError("WHATSAPP_UNAVAILABLE", 503); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = isObject(body) && isObject(body.error) ? body.error : {}, code = Number(error.code || 0), sub = Number(error.error_subcode || 0);
    if (response.status === 401 || code === 190) throw new ManagerError("WHATSAPP_AUTH_REQUIRED", 401);
    if (response.status === 429 || [4, 80007, 130429].includes(code)) throw new ManagerError("WHATSAPP_LIMIT", 429);
    if (code === 131047 || sub === 2494010) throw new ManagerError("WHATSAPP_TEMPLATE_REQUIRED", 409);
    if (code === 131026) throw new ManagerError("WHATSAPP_UNDELIVERABLE", 422);
    if ([132000, 132001, 132005, 132012, 132015, 132016].includes(code)) throw new ManagerError("WHATSAPP_TEMPLATE_NOT_FOUND", 422);
    if (response.status >= 500) throw new ManagerError("WHATSAPP_UNAVAILABLE", 503);
    throw new ManagerError("WHATSAPP_INVALID", response.status || 422);
  }
  if (!isObject(body)) throw new ManagerError("WHATSAPP_UNAVAILABLE", 502);
  return body;
}
