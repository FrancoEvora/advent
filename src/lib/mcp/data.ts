import { MCP_SCOPE, SOLARIS_PROJECT_ID, type McpIdentity, loadProfile, mcpDatabase } from "@/lib/mcp/oauth";

type JsonObject = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TEXT = /^[\p{L}\p{N} .'-]+$/u;
const UNIT_CODE = /^[A-Za-z0-9-]{1,32}$/;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("invalid_argument");
  const text = value.trim();
  if (!text || text.length > max || !SAFE_TEXT.test(text)) throw new Error("invalid_argument");
  return text;
}

function safeLimit(value: unknown): number {
  if (value === undefined || value === null) return 20;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 50) throw new Error("invalid_argument");
  return Number(value);
}

function safeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid_argument");
  return value;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function inventoryRow(row: JsonObject) {
  const listPrice = numberOrNull(row.list_price);
  const pricePerSqm = numberOrNull(row.price_per_sqm);
  return {
    id: String(row.id || ""),
    unit_code: typeof row.unit_code === "string" ? row.unit_code : null,
    block_code: typeof row.block_code === "string" ? row.block_code : null,
    lot_number: typeof row.lot_number === "string" ? row.lot_number : null,
    unit_type: typeof row.unit_type === "string" ? row.unit_type : null,
    area: numberOrNull(row.area),
    frontage: numberOrNull(row.frontage),
    depth: numberOrNull(row.depth),
    corner: typeof row.corner === "boolean" ? row.corner : null,
    topography: typeof row.topography === "string" ? row.topography : null,
    orientation: typeof row.orientation === "string" ? row.orientation : null,
    status: typeof row.status === "string" ? row.status : null,
    list_price: listPrice && listPrice > 0 ? listPrice : null,
    price_per_sqm: pricePerSqm && pricePerSqm > 0 ? pricePerSqm : null,
    currency: "BRL",
    price_status: listPrice && listPrice > 0 ? "listed" : "not_configured",
    is_binding_offer: false,
    reserved_until: typeof row.reserved_until === "string" ? row.reserved_until : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function ok(data: unknown) {
  const payload = { data_is_untrusted: true, source: "evora_enterprise", data };
  return {
    isError: false,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export async function executeMcpTool(identity: McpIdentity, name: string, input: unknown) {
  if (!identity.scopes.includes(MCP_SCOPE) || !identity.projectIds.includes(SOLARIS_PROJECT_ID)) {
    return fail("A conexão não possui o escopo necessário.");
  }
  const args = object(input) ? input : {};
  const db = mcpDatabase();

  if (name === "get_profile") {
    const profile = await loadProfile(identity);
    return { isError: false, structuredContent: profile, content: [{ type: "text", text: JSON.stringify(profile) }] };
  }

  if (name === "list_projects") {
    const { data, error } = await db.from("projects")
      .select("id,code,name,city,state,status,active,updated_at")
      .eq("id", SOLARIS_PROJECT_ID).eq("organization_id", identity.organizationId).eq("active", true).maybeSingle();
    if (error) return fail("Não foi possível consultar o empreendimento.");
    return ok({ projects: data ? [data] : [], fetched_at: new Date().toISOString() });
  }

  if (name === "search_leads") {
    try {
      const q = safeText(args.q, 80);
      const status = safeText(args.status, 40);
      const limit = safeLimit(args.limit);
      let query = db.from("crm_records")
        .select("id,person_name,stage,record_status,source_channel,temperature,priority,lead_score,next_action_at,last_contact_at,first_response_at,created_at,updated_at")
        .eq("organization_id", identity.organizationId).eq("project_id", SOLARIS_PROJECT_ID)
        .order("updated_at", { ascending: false, nullsFirst: false }).limit(limit);
      if (q) query = query.ilike("person_name", `%${q}%`);
      if (status) query = query.eq("record_status", status);
      const { data, error } = await query;
      if (error) return fail("Não foi possível pesquisar os leads.");
      return ok({ leads: data || [], count: data?.length || 0, fetched_at: new Date().toISOString() });
    } catch {
      return fail("Parâmetros de pesquisa inválidos.");
    }
  }

  if (name === "get_lead") {
    const id = typeof args.id === "string" && UUID.test(args.id) ? args.id : null;
    if (!id) return fail("UUID do lead inválido.");
    const { data, error } = await db.from("crm_records")
      .select("id,person_name,stage,record_status,source_channel,temperature,priority,lead_score,next_action_at,last_contact_at,first_response_at,created_at,updated_at")
      .eq("id", id).eq("organization_id", identity.organizationId).eq("project_id", SOLARIS_PROJECT_ID).maybeSingle();
    if (error) return fail("Não foi possível consultar o lead.");
    return ok({ lead: data || null, fetched_at: new Date().toISOString() });
  }

  if (name === "get_inventory") {
    try {
      const status = safeText(args.status, 40);
      const minArea = safeNumber(args.min_area);
      const maxArea = safeNumber(args.max_area);
      const limit = safeLimit(args.limit);
      if (minArea !== undefined && maxArea !== undefined && minArea > maxArea) return fail("Área mínima maior que a máxima.");
      let query = db.from("crm_inventory_units")
        .select("id,unit_code,block_code,lot_number,unit_type,area,frontage,depth,corner,topography,orientation,status,list_price,price_per_sqm,reserved_until,updated_at")
        .eq("organization_id", identity.organizationId).eq("project_id", SOLARIS_PROJECT_ID).eq("active", true)
        .order("unit_code", { ascending: true }).limit(limit);
      if (status) query = query.eq("status", status);
      if (minArea !== undefined) query = query.gte("area", minArea);
      if (maxArea !== undefined) query = query.lte("area", maxArea);
      const { data, error } = await query;
      if (error) return fail("Não foi possível consultar o estoque.");
      return ok({ lots: (data || []).map((row) => inventoryRow(row as JsonObject)), count: data?.length || 0, fetched_at: new Date().toISOString() });
    } catch {
      return fail("Parâmetros de estoque inválidos.");
    }
  }

  if (name === "get_lot") {
    const id = typeof args.id === "string" && UUID.test(args.id) ? args.id : null;
    const unitCode = typeof args.unit_code === "string" && UNIT_CODE.test(args.unit_code) ? args.unit_code.toUpperCase() : null;
    if ((id ? 1 : 0) + (unitCode ? 1 : 0) !== 1) return fail("Informe exatamente id ou unit_code.");
    let query = db.from("crm_inventory_units")
      .select("id,unit_code,block_code,lot_number,unit_type,area,frontage,depth,corner,topography,orientation,status,list_price,price_per_sqm,reserved_until,updated_at")
      .eq("organization_id", identity.organizationId).eq("project_id", SOLARIS_PROJECT_ID).eq("active", true);
    query = id ? query.eq("id", id) : query.eq("unit_code", unitCode as string);
    const { data, error } = await query.maybeSingle();
    if (error) return fail("Não foi possível consultar o lote.");
    return ok({ lot: data ? inventoryRow(data as JsonObject) : null, fetched_at: new Date().toISOString() });
  }

  return fail("Ferramenta não encontrada.");
}
