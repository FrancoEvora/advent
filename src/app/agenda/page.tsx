import {ModuleShell} from "@/components/erp/standalone/module-shell";
import {ActivityPlanner} from "@/components/erp/activities/activity-planner";
export default function AgendaPage(){return <ModuleShell eyebrow="ORGANIZAÇÃO E PRODUTIVIDADE" title="Agenda de Atividades">{context=><ActivityPlanner context={context}/>}</ModuleShell>}
