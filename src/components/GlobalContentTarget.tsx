"use client";

import { usePathname } from "next/navigation";

export function GlobalContentTarget() {
  const pathname = usePathname();
  if (pathname.startsWith("/atendimento/")) return null;
  return <span id="conteudo-principal" tabIndex={-1} />;
}
