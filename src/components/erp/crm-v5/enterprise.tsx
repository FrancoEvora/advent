"use client";
import {useMemo,useState} from "react";
import type {CrmRecord,ErpData} from "../types";
import type {CrmSection} from "./types";
import {useCrmV5} from "./use-data";
import {LeadModal} from "./lead-modal";
import {ActivityModal} from "./activity-modal";
import {OverviewView,ReportsView,AlertsView} from "./views-intelligence";
import {LeadsView} from "./leads-view";
import {PipelineView,OpportunitiesView,AgendaView} from "./views-sales";
import {SdrWorkbench} from "./sdr-workbench";
import {CampaignsView,MaterialsView} from "./views-marketing";
import {AutomationsView,TeamsView,SettingsView} from "./views-admin";
import {useSalesData} from "./sales/use-sales-data";
import {SalesMapView} from "./sales/sales-map-view";
import {InventoryView} from "./sales/inventory-view";
import {NegotiationView} from "./sales/negotiation-view";
import {ProposalsView} from "./sales/proposals-view";
import {ContractsView} from "./sales/contracts-view";
import type {ActivityDeepLinkTarget} from "../activities/activity-links";

export const crmSections:Array<{id:CrmSection;label:string;icon:string;group:string}>=[
{id:"overview",label:"Visão geral",icon:"⌂",group:"Operação"},{id:"leads",label:"Leads",icon:"◎",group:"Operação"},{id:"sdr",label:"SDR / Pré-vendas",icon:"◉",group:"Operação"},{id:"pipelines",label:"Funis",icon:"▥",group:"Operação"},{id:"opportunities",label:"Oportunidades",icon:"◇",group:"Operação"},
{id:"salesmap",label:"Mapa de vendas",icon:"▦",group:"Comercialização"},{id:"inventory",label:"Unidades e estoque",icon:"▧",group:"Comercialização"},{id:"negotiation",label:"Negociação",icon:"%",group:"Comercialização"},{id:"proposals",label:"Propostas",icon:"▤",group:"Comercialização"},{id:"contracts",label:"Contratos",icon:"✦",group:"Comercialização"},
{id:"agenda",label:"Agenda",icon:"◫",group:"Operação"},{id:"campaigns",label:"Campanhas",icon:"◈",group:"Marketing"},{id:"materials",label:"Materiais",icon:"▨",group:"Marketing"},{id:"automations",label:"Automações",icon:"⚡",group:"Inteligência"},{id:"alerts",label:"Alertas e SLAs",icon:"!",group:"Inteligência"},{id:"reports",label:"Relatórios",icon:"▥",group:"Inteligência"},{id:"teams",label:"Equipes e acessos",icon:"♙",group:"Administração"},{id:"settings",label:"Configurações",icon:"⚙",group:"Administração"}
];

export function CrmEnterprise({
  data,
  section,
  setSection,
  focus = null,
  can = () => false,
}: {
  data: ErpData;
  section: CrmSection;
  setSection: (value: CrmSection) => void;
  focus?: ActivityDeepLinkTarget | null;
  can?: (permission: string) => boolean;
}) {
  const { crm, loading, error, reload, markRecordArchived } = useCrmV5(data);
  const archivedRecordIds = useMemo(
    () =>
      new Set(
        crm.records
          .filter((record) => record.record_status === "arquivada")
          .map((record) => record.id),
      ),
    [crm.records],
  );
  const activeRecordIds = useMemo(
    () =>
      new Set(
        crm.records
          .filter((record) => record.record_status !== "arquivada")
          .map((record) => record.id),
      ),
    [crm.records],
  );
  const activeCrm = useMemo(
    () => ({
      ...crm,
      records: crm.records.filter(
        (record) => record.record_status !== "arquivada",
      ),
      actions: crm.actions.filter(
        (action) =>
          !action.crm_record_id || activeRecordIds.has(action.crm_record_id),
      ),
      alerts: crm.alerts.filter(
        (alert) =>
          !alert.crm_record_id || activeRecordIds.has(alert.crm_record_id),
      ),
      assignments: crm.assignments.filter((assignment) =>
        activeRecordIds.has(assignment.crm_record_id),
      ),
    }),
    [activeRecordIds, crm],
  );
  const activeData = useMemo(
    () => ({
      ...data,
      crmRecords: data.crmRecords.filter(
        (record) =>
          record.record_status !== "arquivada" &&
          !archivedRecordIds.has(record.id),
      ),
      crmActions: data.crmActions.filter(
        (action) =>
          !action.crm_record_id || !archivedRecordIds.has(action.crm_record_id),
      ),
    }),
    [archivedRecordIds, data],
  );
  const {
    sales,
    loading: salesLoading,
    error: salesError,
    reload: reloadSales,
  } = useSalesData(activeData);
  const [lead, setLead] = useState<CrmRecord | "new" | null>(null);
  const [activity, setActivity] = useState<
    CrmRecord | null | undefined
  >(undefined);
  const [notice, setNotice] = useState("");

  async function done(message: string) {
    setNotice(message);
    await reload();
  }

  const openLead = (value?: CrmRecord) => setLead(value || "new");
  const openActivity = (value?: CrmRecord) => setActivity(value || null);
  const focusId = focus?.sourceType === "crm_records" ? focus.recordId : null;

  return (
    <div className="crm5-shell">
      <nav className="crm5-mobile-tabs">
        {crmSections.map((item) => (
          <button
            key={item.id}
            className={section === item.id ? "active" : ""}
            onClick={() => setSection(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {(error || salesError) && (
        <div className="feedback error">{error || salesError}</div>
      )}
      {(loading || salesLoading) && (
        <div className="progress">
          <i />
        </div>
      )}
      <main className="crm5-content">
        {section === "overview" && (
          <OverviewView
            data={activeData}
            crm={activeCrm}
            openLead={() => openLead()}
            openActivity={() => openActivity()}
            setSection={setSection}
          />
        )}
        {section === "leads" && (
          <LeadsView
            data={data}
            crm={crm}
            openLead={openLead}
            openActivity={openActivity}
            reload={reload}
            onArchived={markRecordArchived}
            focusId={focusId}
          />
        )}
        {section === "sdr" && (
          <SdrWorkbench
            data={activeData}
            crm={activeCrm}
            openActivity={openActivity}
            reload={reload}
            can={can}
          />
        )}
        {section === "pipelines" && (
          <PipelineView
            data={activeData}
            crm={activeCrm}
            openLead={openLead}
            reload={reload}
          />
        )}
        {section === "opportunities" && (
          <OpportunitiesView
            data={activeData}
            crm={activeCrm}
            openLead={openLead}
          />
        )}
        {section === "salesmap" && (
          <SalesMapView
            data={activeData}
            sales={sales}
            reload={reloadSales}
            setSection={setSection}
          />
        )}
        {section === "inventory" && (
          <InventoryView
            data={activeData}
            sales={sales}
            reload={reloadSales}
          />
        )}
        {section === "negotiation" && (
          <NegotiationView
            data={activeData}
            sales={sales}
            reload={reloadSales}
          />
        )}
        {section === "proposals" && (
          <ProposalsView
            data={activeData}
            sales={sales}
            reload={reloadSales}
          />
        )}
        {section === "contracts" && (
          <ContractsView
            data={activeData}
            sales={sales}
            reload={reloadSales}
          />
        )}
        {section === "agenda" && (
          <AgendaView
            data={activeData}
            crm={activeCrm}
            openActivity={openActivity}
            reload={reload}
          />
        )}
        {section === "campaigns" && (
          <CampaignsView data={activeData} crm={activeCrm} reload={reload} />
        )}
        {section === "materials" && (
          <MaterialsView data={activeData} crm={activeCrm} reload={reload} />
        )}
        {section === "automations" && (
          <AutomationsView data={activeData} crm={activeCrm} reload={reload} />
        )}
        {section === "alerts" && (
          <AlertsView data={activeData} crm={activeCrm} reload={reload} />
        )}
        {section === "reports" && (
          <ReportsView data={activeData} crm={activeCrm} />
        )}
        {section === "teams" && (
          <TeamsView data={activeData} crm={activeCrm} reload={reload} />
        )}
        {section === "settings" && (
          <SettingsView
            data={activeData}
            crm={activeCrm}
            reload={reload}
            can={can}
          />
        )}
      </main>
      {lead && (
        <LeadModal
          data={data}
          crm={crm}
          lead={lead === "new" ? null : lead}
          close={() => setLead(null)}
          done={done}
        />
      )}
      {activity !== undefined && (
        <ActivityModal
          data={activeData}
          crm={activeCrm}
          lead={activity}
          close={() => setActivity(undefined)}
          done={done}
        />
      )}
    </div>
  );
}
