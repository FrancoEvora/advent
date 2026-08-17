import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
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
  const experience = await experienceOrNull(slug);
  if (!experience) {
    return {
      title: "Atendimento não encontrado — Évora Urbanismo",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${experience.name} — Atendimento com a Vitória`,
    description: experience.subtitle,
    applicationName: "Atendimento Inteligente Évora",
    manifest: "/atendimento/manifest.webmanifest",
    robots: { index: true, follow: true },
    openGraph: {
      title: `${experience.name} — Atendimento inteligente`,
      description: experience.subtitle,
      type: "website",
      locale: "pt_BR",
      siteName: "Évora Urbanismo",
    },
    twitter: {
      card: "summary_large_image",
      title: `${experience.name} — Atendimento inteligente`,
      description: experience.subtitle,
    },
  };
}

export default async function PublicAgentPage({ params }: PageProps) {
  const { slug } = await params;
  const experience = await experienceOrNull(slug);
  if (!experience) notFound();
  return <PublicAgentExperience slug={experience.slug} experience={experience} />;
}
