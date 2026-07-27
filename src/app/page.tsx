import ErpAppV55 from "@/components/erp/erp-app-v55";
import { parseActivityDeepLink } from "@/components/erp/activities/activity-links";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const target = parseActivityDeepLink(await searchParams);
  return <ErpAppV55 initialTarget={target} />;
}
