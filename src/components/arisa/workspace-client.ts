import { client, errorText } from "./chat-client";

export type WorkspacePanel = "email" | "archive" | "memory";
export async function workspaceCall(name: "arisa-mail" | "arisa-background", body: Record<string, unknown>) {
  const { data, error } = await client().functions.invoke(name, { body });
  if (error) {
    if ("context" in error && error.context instanceof Response) {
      const result = await error.context.json().catch(() => null);
      if (typeof result?.message === "string") throw new Error(result.message);
    }
    throw new Error(errorText(error));
  }
  if (!data?.ok) throw new Error(data?.message || "A operação não foi confirmada. Consulte o arquivo antes de repetir um envio.");
  return data;
}
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = name.replace(/[\\/\r\n]/g, "-"); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function downloadStored(bucket: string, path: string, name: string) {
  const tab = window.open("about:blank", "_blank"); if (tab) tab.opener = null;
  try {
    const result = await client().storage.from(bucket).createSignedUrl(path, 120, { download: name });
    if (result.error || !result.data?.signedUrl) throw result.error || new Error("Arquivo indisponível.");
    if (tab) tab.location.replace(result.data.signedUrl); else window.location.assign(result.data.signedUrl);
  } catch (error) { tab?.close(); throw error; }
}
export function displayDate(value: string | null | undefined) { return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Ainda não realizada"; }
