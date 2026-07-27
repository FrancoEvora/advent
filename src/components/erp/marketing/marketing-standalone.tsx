"use client";

import { ModuleShell } from "../standalone/module-shell";
import type { ActivityDeepLinkTarget } from "../activities/activity-links";
import { MarketingManagement } from "./marketing-management";

export function MarketingStandalone({
  focus,
}: {
  focus?: ActivityDeepLinkTarget | null;
}) {
  return (
    <ModuleShell
      eyebrow="INTELIGÊNCIA DE MARCA E AQUISIÇÃO"
      title="Gestão de Marketing"
    >
      {(context) => <MarketingManagement context={context} focus={focus} />}
    </ModuleShell>
  );
}
