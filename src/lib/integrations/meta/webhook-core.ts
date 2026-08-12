import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const META_WEBHOOK_MAX_BYTES = 1024 * 1024;
export const META_WEBHOOK_MAX_ENTRIES = 1_000;
export const META_WEBHOOK_MAX_CHANGES = 1_000;

const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 40_000;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 32_768;
const META_ID_PATTERN = /^\d{1,64}$/;
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:/-]{3,128}$/;

type JsonObject = Record<string, unknown>;

export type MetaLeadNotification = {
  eventKey: string;
  leadgenId: string;
  pageId: string;
  formId: string | null;
  adId: string | null;
  createdTime: number | null;
  entryIndex: number;
  changeIndex: number;
  value: JsonObject;
};

export type ParsedMetaWebhook = {
  object: "page";
  payload: JsonObject;
  notifications: MetaLeadNotification[];
};

export class MetaWebhookInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "MetaWebhookInputError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asMetaId(value: unknown, field: string, required: true): string;
function asMetaId(value: unknown, field: string, required: false): string | null;
function asMetaId(
  value: unknown,
  field: string,
  required: boolean,
): string | null {
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw new MetaWebhookInputError(
      "INVALID_META_PAYLOAD",
      `O campo ${field} não foi informado.`,
    );
  }

  if (typeof value !== "string" && typeof value !== "number") {
    throw new MetaWebhookInputError(
      "INVALID_META_PAYLOAD",
      `O campo ${field} possui formato inválido.`,
    );
  }

  const normalized = String(value);
  if (!META_ID_PATTERN.test(normalized)) {
    throw new MetaWebhookInputError(
      "INVALID_META_PAYLOAD",
      `O campo ${field} não contém um identificador Meta válido.`,
    );
  }
  return normalized;
}

function asUnixTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? Number(value) : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < 0
  ) {
    throw new MetaWebhookInputError(
      "INVALID_META_PAYLOAD",
      "O horário do evento Meta possui formato inválido.",
    );
  }
  return normalized;
}

function validateJsonComplexity(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new MetaWebhookInputError(
        "META_PAYLOAD_TOO_COMPLEX",
        "O evento Meta excede os limites de complexidade.",
        413,
      );
    }

    if (typeof candidate === "string") {
      if (candidate.length > MAX_STRING_LENGTH) {
        throw new MetaWebhookInputError(
          "META_PAYLOAD_TOO_COMPLEX",
          "O evento Meta contém um texto acima do limite permitido.",
          413,
        );
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }

    if (isObject(candidate)) {
      const entries = Object.entries(candidate);
      if (entries.length > MAX_OBJECT_KEYS) {
        throw new MetaWebhookInputError(
          "META_PAYLOAD_TOO_COMPLEX",
          "O evento Meta contém objetos acima do limite permitido.",
          413,
        );
      }
      for (const [key, item] of entries) {
        if (key.length > 256) {
          throw new MetaWebhookInputError(
            "META_PAYLOAD_TOO_COMPLEX",
            "O evento Meta contém uma chave acima do limite permitido.",
            413,
          );
        }
        visit(item, depth + 1);
      }
    }
  };

  visit(value, 0);
}

export function secureTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function verifyMetaWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function verifyMetaWebhookCandidateCoverage(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  pageIds: string[],
  candidates: Array<{ pageIds: string[]; appSecret: string }>,
): boolean {
  const coverageBySecret = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    let coverage = coverageBySecret.get(candidate.appSecret);
    if (!coverage) {
      coverage = new Set<string>();
      coverageBySecret.set(candidate.appSecret, coverage);
    }
    for (const pageId of candidate.pageIds) coverage.add(pageId);
  }
  for (const [appSecret, coverage] of coverageBySecret) {
    if (
      pageIds.every((pageId) => coverage.has(pageId)) &&
      verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret)
    ) {
      return true;
    }
  }
  return false;
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// Extracao deliberadamente nao confiavel e sem efeitos colaterais. Ela serve
// apenas para reduzir os candidatos de App Secret antes do HMAC; o payload
// completo continua sendo validado somente depois da assinatura corresponder.
export function extractMetaPageIdsForSignature(rawBody: Uint8Array): string[] {
  if (rawBody.byteLength === 0 || rawBody.byteLength > META_WEBHOOK_MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return [];
  }
  if (!isObject(parsed) || !Array.isArray(parsed.entry) || parsed.entry.length > META_WEBHOOK_MAX_ENTRIES) {
    return [];
  }
  const pageIds = new Set<string>();
  let totalChanges = 0;
  for (const entry of parsed.entry) {
    if (!isObject(entry)) continue;
    if ((typeof entry.id === "string" || typeof entry.id === "number") && META_ID_PATTERN.test(String(entry.id))) {
      pageIds.add(String(entry.id));
    }
    if (!Array.isArray(entry.changes)) continue;
    totalChanges += entry.changes.length;
    if (totalChanges > META_WEBHOOK_MAX_CHANGES) return [];
    for (const change of entry.changes) {
      if (!isObject(change) || !isObject(change.value)) continue;
      const pageId = change.value.page_id;
      if ((typeof pageId === "string" || typeof pageId === "number") && META_ID_PATTERN.test(String(pageId))) {
        pageIds.add(String(pageId));
      }
    }
  }
  return [...pageIds];
}

export function parseMetaWebhookPayload(rawBody: Uint8Array): ParsedMetaWebhook {
  if (rawBody.byteLength === 0) {
    throw new MetaWebhookInputError(
      "EMPTY_META_PAYLOAD",
      "O evento Meta está vazio.",
    );
  }
  if (rawBody.byteLength > META_WEBHOOK_MAX_BYTES) {
    throw new MetaWebhookInputError(
      "META_PAYLOAD_TOO_LARGE",
      "O evento Meta excede o limite permitido.",
      413,
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new MetaWebhookInputError(
      "INVALID_META_ENCODING",
      "O evento Meta não está codificado em UTF-8 válido.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new MetaWebhookInputError(
      "INVALID_META_JSON",
      "O evento Meta não contém JSON válido.",
    );
  }

  validateJsonComplexity(parsed);
  if (!isObject(parsed) || parsed.object !== "page") {
    throw new MetaWebhookInputError(
      "UNSUPPORTED_META_OBJECT",
      "O webhook aceita apenas eventos de páginas Meta.",
    );
  }
  if (!Array.isArray(parsed.entry) || parsed.entry.length === 0) {
    throw new MetaWebhookInputError(
      "INVALID_META_PAYLOAD",
      "O evento Meta não contém entradas.",
    );
  }
  if (parsed.entry.length > META_WEBHOOK_MAX_ENTRIES) {
    throw new MetaWebhookInputError(
      "META_PAYLOAD_TOO_COMPLEX",
      "O evento Meta contém entradas acima do limite permitido.",
      413,
    );
  }

  let totalChanges = 0;
  const seenLeadIds = new Set<string>();
  const notifications: MetaLeadNotification[] = [];

  parsed.entry.forEach((entryCandidate, entryIndex) => {
    if (!isObject(entryCandidate)) {
      throw new MetaWebhookInputError(
        "INVALID_META_PAYLOAD",
        "O evento Meta contém uma entrada inválida.",
      );
    }
    const entryPageId = asMetaId(entryCandidate.id, "entry.id", true);
    if (!Array.isArray(entryCandidate.changes)) {
      throw new MetaWebhookInputError(
        "INVALID_META_PAYLOAD",
        "O evento Meta não contém alterações válidas.",
      );
    }

    totalChanges += entryCandidate.changes.length;
    if (totalChanges > META_WEBHOOK_MAX_CHANGES) {
      throw new MetaWebhookInputError(
        "META_PAYLOAD_TOO_COMPLEX",
        "O evento Meta contém alterações acima do limite permitido.",
        413,
      );
    }

    entryCandidate.changes.forEach((changeCandidate, changeIndex) => {
      if (!isObject(changeCandidate)) {
        throw new MetaWebhookInputError(
          "INVALID_META_PAYLOAD",
          "O evento Meta contém uma alteração inválida.",
        );
      }
      if (changeCandidate.field !== "leadgen") return;
      if (!isObject(changeCandidate.value)) {
        throw new MetaWebhookInputError(
          "INVALID_META_PAYLOAD",
          "O evento leadgen não contém dados válidos.",
        );
      }

      const leadgenId = asMetaId(
        changeCandidate.value.leadgen_id,
        "leadgen_id",
        true,
      );
      if (seenLeadIds.has(leadgenId)) return;
      seenLeadIds.add(leadgenId);

      const valuePageId = asMetaId(
        changeCandidate.value.page_id,
        "page_id",
        false,
      );
      if (valuePageId && valuePageId !== entryPageId) {
        throw new MetaWebhookInputError(
          "INVALID_META_PAYLOAD",
          "O Page ID do evento Meta diverge da entrada assinada.",
        );
      }

      notifications.push({
        eventKey: `meta:leadgen:${leadgenId}`,
        leadgenId,
        pageId: valuePageId || entryPageId,
        formId: asMetaId(changeCandidate.value.form_id, "form_id", false),
        adId: asMetaId(changeCandidate.value.ad_id, "ad_id", false),
        createdTime: asUnixTime(changeCandidate.value.created_time),
        entryIndex,
        changeIndex,
        value: changeCandidate.value,
      });
    });
  });

  return { object: "page", payload: parsed, notifications };
}

export function parseMetaVerificationRequest(
  searchParams: URLSearchParams,
  expectedVerifyToken: string,
): string {
  const mode = searchParams.get("hub.mode");
  const suppliedToken = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (
    mode !== "subscribe" ||
    !suppliedToken ||
    !secureTextEqual(suppliedToken, expectedVerifyToken)
  ) {
    throw new MetaWebhookInputError(
      "META_VERIFICATION_DENIED",
      "A verificação do webhook Meta foi recusada.",
      403,
    );
  }
  if (!challenge || challenge.length > 1_024 || !/^[-A-Za-z0-9_.]+$/.test(challenge)) {
    throw new MetaWebhookInputError(
      "INVALID_META_CHALLENGE",
      "O desafio de verificação Meta é inválido.",
    );
  }
  return challenge;
}

export function authorizeBearer(
  authorizationHeader: string | null,
  expectedSecret: string,
): boolean {
  if (!authorizationHeader || !expectedSecret) return false;
  const match = /^Bearer ([^\s]{16,512})$/.exec(authorizationHeader);
  return Boolean(match && secureTextEqual(match[1], expectedSecret));
}

export function isStructurallyValidWorkerAuthorization(
  authorizationHeader: string | null,
): boolean {
  return /^Bearer [^\s]{32,512}$/.test(authorizationHeader || "");
}

export function correlationIdFromHeader(value: string | null): string | null {
  if (!value || !SAFE_CORRELATION_ID_PATTERN.test(value)) return null;
  return value;
}

export function correlationIdOrNew(value: string | null): string {
  return correlationIdFromHeader(value) || randomUUID();
}
