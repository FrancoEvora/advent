import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vitória — Atendimento Évora",
    short_name: "Vitória Évora",
    description: "Atendimento comercial digital da Évora Urbanismo.",
    start_url: "/atendimento/solaris",
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
}
