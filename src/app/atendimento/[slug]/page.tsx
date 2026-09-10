import type { Metadata, Viewport } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { PublicAgentExperience } from "@/components/public-agent/PublicAgentExperience";
import {
  getPublicAgentExperience,
  PublicAgentServerError,
} from "@/lib/public-agent/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ slug: string }>;
};

const experienceOrNull = cache(async (slug: string) => {
  try {
    return await getPublicAgentExperience(slug);
  } catch (error) {
    if (error instanceof PublicAgentServerError && error.status === 404) return null;
    throw error;
  }
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d695b",
  colorScheme: "light",
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (slug === "solaris") return { title: "Bia — Gestora comercial da Évora", robots: { index: false, follow: false } };
  const experience = await experienceOrNull(slug);
  if (!experience) {
    return {
      title: "Atendimento não encontrado — Futura Casa",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${experience.name} — Atendimento com a Bia | Futura Casa`,
    description: experience.subtitle,
    applicationName: "Bia — Futura Casa",
    manifest: "/atendimento/manifest.webmanifest",
    icons: { icon: [{ url: "/bia/icon-192-v1.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/bia/apple-touch-icon-v1.png", sizes: "180x180", type: "image/png" }] },
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: "Bia — Futura Casa",
    },
    robots: { index: true, follow: true },
    openGraph: {
      title: `${experience.name} — Futura Casa`,
      description: experience.subtitle,
      type: "website",
      locale: "pt_BR",
      siteName: "Futura Casa · Parceira da Évora Urbanismo",
    },
    twitter: {
      card: "summary_large_image",
      title: `${experience.name} — Futura Casa`,
      description: experience.subtitle,
    },
  };
}

export default async function PublicAgentPage({ params }: PageProps) {
  const { slug } = await params;
  if (slug === "solaris") redirect("/bia");
  const experience = await experienceOrNull(slug);
  if (!experience) notFound();
  return <PublicAgentExperience slug={experience.slug} experience={experience} />;
}
