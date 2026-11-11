export type ShareChannel = "whatsapp" | "email";
export type Recipient = { person_name: string; phone?: string | null; email?: string | null };
export function shareAddress(channel: ShareChannel, lead: Recipient): string {
  if (channel === "email") {
    const email = lead.email?.trim() || "";
    if (!/^[^\s@,;?&]+@[^\s@,;?&]+\.[^\s@,;?&]+$/.test(email)) throw new Error("Cadastre um e-mail válido para este lead antes de enviar.");
    return email;
  }
  let phone = (lead.phone || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  if (!/^[1-9]\d{9,14}$/.test(phone)) throw new Error("Cadastre um telefone válido, com DDD, para este lead.");
  return phone;
}
export function safeResourceUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("O material precisa ter um link HTTP ou HTTPS válido.");
  return url.href;
}
// Open synchronously in the click handler to avoid popup blocking during PDF/signing requests.
export function prepareShareWindow(channel: ShareChannel, lead: Recipient) {
  const address = shareAddress(channel, lead);
  const popup = channel === "whatsapp" ? window.open("about:blank", "_blank") : null;
  if (channel === "whatsapp" && !popup) throw new Error("Permita a abertura de janela para preparar o WhatsApp.");
  if (popup) popup.opener = null;
  return {
    close: () => popup?.close(),
    finish: (subject: string, text: string) => {
      const url = channel === "whatsapp" ? `https://wa.me/${address}?text=${encodeURIComponent(text)}` : `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
      if (popup) popup.location.href = url; else window.location.href = url;
    },
  };
}
