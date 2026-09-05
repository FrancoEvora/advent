import ErpAppV55 from "@/components/erp/erp-app-v55";
import { parseActivityDeepLink } from "@/components/erp/activities/activity-links";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const target = parseActivityDeepLink(params);
  const metaLeads = params.meta === "leads";
  return <ErpAppV55
    initialTarget={target}
    initialView={params.view === "arisa" ? "arisa" : metaLeads ? "crm" : "dashboard"}
    initialCrmSection={metaLeads ? "settings" : "overview"}
  />;
}
