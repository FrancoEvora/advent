"use client";

import { VitoriaImmersiveExperience } from "./VitoriaImmersiveExperience";
import styles from "./VitoriaPremiumOverride.module.css";

import type { PublicAgentExperience as PublicAgentExperienceType } from "@/lib/public-agent/types";

type Props = {
  slug: string;
  experience: PublicAgentExperienceType;
};

export function PublicAgentExperience(props: Props) {
  return (
    <div className={styles.shell}>
      <VitoriaImmersiveExperience {...props} />
    </div>
  );
}
