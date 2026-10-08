export const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const date = (value?: string | null) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "A definir";
export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
export const localInput = (value?: string | null) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value ? new Date(value) : new Date()).replace(" ", "T");
