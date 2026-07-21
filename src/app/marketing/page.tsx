import {ModuleShell} from "@/components/erp/standalone/module-shell";
import {MarketingManagement} from "@/components/erp/marketing/marketing-management";
export default function MarketingPage(){return <ModuleShell eyebrow="INTELIGÊNCIA DE MARCA E AQUISIÇÃO" title="Gestão de Marketing">{context=><MarketingManagement context={context}/>}</ModuleShell>}
