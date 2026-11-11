// Use the proposal's saved indexer; never replace historical terms with today's policy.
export function proposalCorrectionIndex(indexer?: string | null): string {
  const value = indexer?.trim();
  if (!value) return "Não informado";
  return value.toUpperCase() === "IPCA" ? "IPCA" : value;
}

export function proposalCorrectionDescription(indexer?: string | null): string {
  const value = proposalCorrectionIndex(indexer);
  return value === "IPCA" ? "IPCA (Índice Nacional de Preços ao Consumidor Amplo)" : value;
}
