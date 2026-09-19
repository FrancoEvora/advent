import type { ReactNode } from "react";

// The original user-supplied, 23-page PDF. Public, stable object; not an expiring signed URL.
// SHA-256: a929eb889f7adc97bc821cc16a2f1a93bdae0a5b4be6f0be06b491117ab33da2
export const SOLARIS_BOOK_DOWNLOAD_URL = "https://qsdffayasuzsmngteika.supabase.co/storage/v1/object/public/solaris-public/book-comercial-solaris-2026-v6-a929eb88.pdf?download=Solaris_Book_2026_V6.pdf";

export const SOLARIS_EDITORIAL_BOOK_URL = "/forms/solaris/downloads/solaris-seus-proximos-vizinhos-v3.pdf";

export function SolarisBookLink({ className, children, edition = "institutional" }: { className?: string; children: ReactNode; edition?: "institutional" | "editorial" }) {
  const editorial = edition === "editorial";
  return (
    <a className={className} href={editorial ? SOLARIS_EDITORIAL_BOOK_URL : SOLARIS_BOOK_DOWNLOAD_URL} download={editorial ? "Solaris_Seus_Proximos_Vizinhos_2026.pdf" : "Solaris_Book_2026_V6.pdf"} target="_blank" rel="noopener noreferrer" data-solaris-book-download={editorial ? "editorial-v3" : "v6"} title={editorial ? "Seus próximos vizinhos · Edição editorial 2026 · 19 páginas · 16 MB" : "Book comercial Solaris 2026 V6 · PDF completo · 23 páginas · 32 MB"}>
      {children} <span aria-hidden="true">↓</span>
    </a>
  );
}
