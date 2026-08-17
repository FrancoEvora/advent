import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const manifest: MetadataRoute.Manifest = {
  name: "Vitória — Atendimento Évora",
  short_name: "Vitória Évora",
  description: "Atendimento comercial digital da Évora Urbanismo.",
  start_url: "/atendimento/solaris",
  scope: "/atendimento/",
  display: "standalone",
  background_color: "#efeae2",
  theme_color: "#0d695b",
  lang: "pt-BR",
  orientation: "portrait-primary",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
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
