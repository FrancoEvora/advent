import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Public institutional document, independent of the ERP layout and authentication.
// Static generation reads only this public HTML. No CRM or customer data is accessed.
export const dynamic = "force-static";
export const runtime = "nodejs";

export async function GET() {
  const source = await readFile(join(process.cwd(), "public/evora/index.html"), "utf8");
  const html = source.replaceAll('="./', '="/evora/');
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
