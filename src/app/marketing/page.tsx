import {parseActivityDeepLink} from "@/components/erp/activities/activity-links";
import {MarketingStandalone} from "@/components/erp/marketing/marketing-standalone";

type MarketingPageProps={
 searchParams:Promise<Record<string,string|string[]|undefined>>;
};

export default async function MarketingPage({searchParams}:MarketingPageProps){
 const target=parseActivityDeepLink(await searchParams);
 const focus=target?.sourceType==="marketing_requests"?target:null;
 return <MarketingStandalone focus={focus}/>;
}
