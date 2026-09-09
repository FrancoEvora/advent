import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const manifest: MetadataRoute.Manifest = {
  name: "Bia — Futura Casa",
  short_name: "Bia Futura Casa",
  description: "Especialista da Futura Casa, parceira da Évora Urbanismo, para o Solaris Residencial Resort em Monte Carmelo.",
  start_url: "/atendimento/solaris",
  scope: "/atendimento/",
  display: "standalone",
  background_color: "#efeae2",
  theme_color: "#0d695b",
  lang: "pt-BR",
  orientation: "portrait-primary",
  icons: [
    { src: "/bia/icon-192-v1.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/bia/icon-512-v1.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "application/manifest+json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
