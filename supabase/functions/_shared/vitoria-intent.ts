export function serviceConsentDecision(
  message: string,
  allowGenericConfirmation: boolean,
): boolean | null {
  const text = message.trim();
  const clauses = text
    .split(/\s*(?:[,;.]|\bmas\b|\bporém\b|\bcontudo\b)\s*/i)
    .filter(Boolean);
  const serviceClauses = clauses.filter((clause) => {
    const explicitServiceObject = /\b(?:contato|atendimento|cadastro|dados|equipe|évora|evora|lig\w*|cham\w*|contat\w*)\b/i.test(clause);
    const genericConsentObject = /\b(?:consentimento|autorização|autorizacao)\b/i.test(clause);
    const marketingObject = /\b(?:marketing|ofertas|novidades|campanhas|lançamentos)\b/i.test(clause);
    return explicitServiceObject || (genericConsentObject && !marketingObject);
  });
  const serviceDenied = serviceClauses.some((clause) =>
    /\b(?:não|nao|nunca)\b.{0,48}\b(?:autorizo|aceito|consinto|permito|quero)\b/i.test(clause)
    || /\b(?:não|nao|nunca)\s+quero\s+(?:ser\s+)?(?:contatad[oa]|cadastrad[oa])\b/i.test(clause)
    || /\b(?:não|nao|nunca)\b.{0,32}\b(?:lig\w*|cham\w*|contat\w*)\b/i.test(clause)
    || /\b(?:revog\w*|retir\w*|cancel\w*)\b/i.test(clause)
    || /\b(?:pare|parar|paro|parem)\b.{0,32}\b(?:lig\w*|cham\w*|contat\w*)\b/i.test(clause)
  );
  if (serviceDenied) return false;

  const explicitPositive = /\b(?:autorizo|aceito|consinto|permito)\b.{0,48}\b(?:contato|atendimento|cadastro|dados|equipe|évora|evora)\b/i.test(text)
    || /\b(?:pode|podem)\s+(?:me\s+)?(?:ligar|chamar|contatar)\b/i.test(text);
  if (explicitPositive) return true;

  if (
    allowGenericConfirmation
    && /^\s*sim[, ]+(?:eu\s+)?(?:autorizo|aceito|consinto|permito)\s*[.!]?\s*$/i.test(text)
  ) return true;
  return null;
}

export function explicitNameFromMessage(message: string): string | null {
  const labelled = message.match(
    /\b(?:meu nome (?:é|e)|me chamo)\s+([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,5})/iu,
  );
  if (!labelled?.[1]) return null;
  const candidate = labelled[1]
    .split(/[.,;:!?]|\s+e\s+(?=(?:quero|gostaria|moro|resido|preciso|pretendo|busco)\b)/iu)[0]
    .trim()
    .replace(/[.'’-]+$/u, "");
  if (!candidate || /\b(?:quero|gostaria|moro|resido|preciso|pretendo|busco)\b/iu.test(candidate)) {
    return null;
  }
  return candidate.slice(0, 180);
}

export function isLocationStatement(message: string): boolean {
  return /\b(?:moro|resido|sou)\s+(?:em|de|do|da|dos|das)\b/iu.test(message);
}

export function cityFromMessage(message: string): string | null {
  const labelled = message.match(
    /\b(?:moro|resido|sou)\s+(?:em|de|do|da|dos|das)\s+([\p{L}][\p{L}\s.'’-]{1,80})/iu,
  );
  if (!labelled?.[1]) return null;
  const candidate = labelled[1]
    .split(/[.,;:!?]|\s+e\s+(?=(?:quero|gostaria|preciso|pretendo|busco|tenho|estou|vou|posso|autorizo|meu|minha|telefone|e-?mail|o\s+lote)\b)/iu)[0]
    .trim()
    .replace(/[.'’-]+$/u, "");
  return candidate ? candidate.slice(0, 180) : null;
}

export function marketingConsentDecision(message: string): boolean | null {
  if (
    /\b(?:não|nao|nunca|revog\w*|retir\w*|cancel\w*)\b.{0,64}\b(?:marketing|ofertas|novidades|campanhas|lançamentos)\b/i.test(message)
    || /\b(?:marketing|ofertas|novidades|campanhas|lançamentos)\b.{0,42}\b(?:não|nao|nunca)\b/i.test(message)
  ) return false;
  if (/\b(?:autorizo|aceito|quero|pode)\b.{0,42}\b(?:marketing|ofertas|novidades|campanhas|lançamentos)\b/i.test(message)) return true;
  return null;
}

export function confirmsHold(message: string, unitCode: string): boolean {
  const expectedUnit = unitCode.trim().toUpperCase();
  const mentionedUnits = message.toUpperCase().match(/\b[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+\b/g) ?? [];
  if (
    !expectedUnit
    || mentionedUnits.length !== 1
    || mentionedUnits[0] !== expectedUnit
  ) return false;
  if (/\b(?:cancelar|cancela|desisti|desistir|não quero|nao quero|deixa pra lá|deixa para la)\b/i.test(message)) return false;
  if (/\b(?:não|nao|nunca)\b.{0,48}\b(?:confirm\w*|bloque\w*|reserv\w*|faça\b.{0,18}\b(?:bloque\w*|reserv\w*))\b/i.test(message)) return false;

  const mentionsAction = /\b(?:bloquear|bloqueio|reservar|reserva)\b/i.test(message);
  const affirmative = /\b(?:confirmo|confirmar|pode|quero|autorizo|sim)\b/i.test(message);
  return mentionsAction && affirmative;
}
