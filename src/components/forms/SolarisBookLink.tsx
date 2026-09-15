import type { ReactNode } from "react";

// The original user-supplied, 23-page PDF. Public, stable object; not an expiring signed URL.
// SHA-256: a929eb889f7adc97bc821cc16a2f1a93bdae0a5b4be6f0be06b491117ab33da2
export const SOLARIS_BOOK_DOWNLOAD_URL = "https://qsdffayasuzsmngteika.supabase.co/storage/v1/object/public/solaris-public/book-comercial-solaris-2026-v6-a929eb88.pdf?download=Solaris_Book_2026_V6.pdf";

export function SolarisBookLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a className={className} href={SOLARIS_BOOK_DOWNLOAD_URL} download="Solaris_Book_2026_V6.pdf" target="_blank" rel="noopener noreferrer" data-solaris-book-download="v6" title="Book comercial Solaris 2026 V6 · PDF completo · 23 páginas · 32 MB">
      {children} <span aria-hidden="true">↓</span>
    </a>
  );
}
