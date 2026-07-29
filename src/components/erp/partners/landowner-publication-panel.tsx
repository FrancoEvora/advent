"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSupabase } from "@/lib/supabase";
import type { Contact, ErpData, FinancialEntry } from "../types";
import { dateAtNoon, money, shortDate, statusLabels } from "../utils";

type VisibleSection =
  | "lots"
  | "vgv"
  | "vso"
  | "conditions_summary"
  | "sales_details"
  | "delinquency"
  | "repasses_summary"
  | "repass_details"
  | "construction";

type Visibility = Record<VisibleSection, boolean>;

interface LandownerSnapshot {
  project?: {
    id?: string;
    code?: string;
    name?: string;
  };
  period?: {
    start?: string;
    end?: string;
    calculated_at?: string;
  };
  summary?: {
    total_lots?: number;
    sold_lots?: number;
    available_lots?: number;
    total_vgv?: number;
    sold_vgv?: number;
    sold_vgv_pct?: number;
    sales_in_period?: number;
    vso_pct?: number;
    vso_basis?: string;
  };
  sales_conditions?: {
    average_sale_price?: number;
    average_discount_pct?: number;
    average_installments?: number;
    average_down_payment_pct?: number;
    sales?: unknown[];
  };
  delinquency?: {
    receivable_total?: number;
    open_total?: number;
    overdue_amount?: number;
    overdue_installments?: number;
    overdue_rate_pct?: number;
    basis?: string;
  };
  repasses?: {
    configured?: boolean;
    paid_amount?: number;
    due_not_repassed?: number;
    total_not_repassed?: number;
    due_not_repassed_count?: number;
    basis?: string;
    entries?: unknown[];
  };
  construction?: {
    actual_progress_pct?: number;
    planned_progress_pct?: number;
    deviation_pct?: number;
    stage_count?: number;
    source?: string;
    stages?: unknown[];
  };
}

interface LandownerPublication {
  id: string;
  contact_id: string;
  project_id: string;
  period_start: string;
  period_end: string;
  status: "published" | "archived";
  visible_sections: Partial<Visibility>;
  snapshot: LandownerSnapshot;
  public_note: string | null;
  version: number;
  published_at: string;
}

interface RepassClassification {
  financial_entry_id: string;
  allocated_amount: number;
  notes: string | null;
  registered_at: string;
}

const initialVisibility: Visibility = {
  lots: true,
  vgv: true,
  vso: true,
  conditions_summary: true,
  sales_details: false,
  delinquency: true,
  repasses_summary: true,
  repass_details: false,
  construction: true,
};

const sectionOptions: Array<{
  key: VisibleSection;
  label: string;
  detail: string;
}> = [
  {
    key: "lots",
    label: "Lotes totais e vendidos",
    detail: "Quantidades consolidadas e estoque disponível.",
  },
  {
    key: "vgv",
    label: "VGV total e vendido",
    detail: "Valor potencial do estoque e contratos assinados.",
  },
  {
    key: "vso",
    label: "Velocidade de vendas (VSO)",
    detail: "Absorção comercial calculada para o período informado.",
  },
  {
    key: "conditions_summary",
    label: "Resumo das condições comerciais",
    detail: "Médias de preço, entrada, prazo e desconto.",
  },
  {
    key: "sales_details",
    label: "Detalhes das vendas",
    detail: "Unidades, datas e condições de cada contrato, sem compradores.",
  },
  {
    key: "delinquency",
    label: "Inadimplência",
    detail: "Carteira aberta, parcelas vencidas e índice consolidado.",
  },
  {
    key: "repasses_summary",
    label: "Resumo dos repasses",
    detail: "Total repassado e valores devidos ainda não repassados.",
  },
  {
    key: "repass_details",
    label: "Detalhes dos repasses",
    detail: "Lançamentos, datas, valores e situação de processamento.",
  },
  {
    key: "construction",
    label: "Andamento da obra",
    detail: "Avanço realizado, previsto e etapas da EAP ponderada.",
  },
];

const historyColumns =
  "id,contact_id,project_id,period_start,period_end,status,visible_sections,snapshot,public_note,version,published_at";
const repassColumns =
  "financial_entry_id,allocated_amount,notes,registered_at";

function isoToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function startOfYear() {
  return `${new Date().getFullYear()}-01-01`;
}

function isLandowner(contact: Contact) {
  return contact.contact_type
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .includes("terren");
}

function contactName(contact: Contact | undefined) {
  return contact?.trade_name || contact?.name || "Contato não identificado";
}

function numberValue(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function entryBaseAmount(entry: FinancialEntry) {
  return numberValue(entry.original_amount) || numberValue(entry.amount);
}

function percent(value: unknown) {
  return `${numberValue(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  })}%`;
}

function safeDate(value: string | null | undefined) {
  return value ? shortDate.format(dateAtNoon(value.slice(0, 10))) : "—";
}

function safeDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("pt-BR") : "—";
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Não foi possível concluir a operação.";
}

function publicationVisibilityCount(publication: LandownerPublication) {
  return sectionOptions.filter(
    ({ key }) => publication.visible_sections?.[key] === true,
  ).length;
}

function entryPlanningDate(entry: FinancialEntry) {
  return entry.scheduled_payment_date || entry.due_date;
}

export function LandownerPublicationPanel({
  data,
  canPublish,
}: {
  data: ErpData;
  canPublish: boolean;
}) {
  const activeContacts = useMemo(
    () =>
      data.contacts
        .filter((contact) => contact.active && isLandowner(contact))
        .sort((left, right) =>
          contactName(left).localeCompare(contactName(right), "pt-BR"),
        ),
    [data.contacts],
  );
  const activeProjects = useMemo(
    () =>
      data.projects
        .filter((project) => project.active)
        .sort((left, right) => left.name.localeCompare(right.name, "pt-BR")),
    [data.projects],
  );
  const [contactId, setContactId] = useState(
    () => activeContacts[0]?.id || "",
  );
  const [projectId, setProjectId] = useState(
    () => activeProjects[0]?.id || "",
  );
  const [periodStart, setPeriodStart] = useState(startOfYear);
  const [periodEnd, setPeriodEnd] = useState(isoToday);
  const [visibleSections, setVisibleSections] =
    useState<Visibility>(initialVisibility);
  const [publicNote, setPublicNote] = useState("");
  const [preview, setPreview] = useState<LandownerSnapshot | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [history, setHistory] = useState<LandownerPublication[]>([]);
  const [classifiedEntryIds, setClassifiedEntryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [allocationDrafts, setAllocationDrafts] = useState<
    Record<string, string>
  >({});
  const [loadingContext, setLoadingContext] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [updatingEntryId, setUpdatingEntryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const contextRequest = useRef(0);

  useEffect(() => {
    const refreshBusinessDate = () => {
      const currentDate = isoToday();
      setPeriodEnd((previous) =>
        previous === currentDate ? previous : currentDate,
      );
    };
    const timer = window.setInterval(refreshBusinessDate, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const effectiveContactId = activeContacts.some(
    (contact) => contact.id === contactId,
  )
    ? contactId
    : activeContacts[0]?.id || "";
  const effectiveProjectId = activeProjects.some(
    (project) => project.id === projectId,
  )
    ? projectId
    : activeProjects[0]?.id || "";
  const currentSelectionKey = [
    effectiveContactId,
    effectiveProjectId,
    periodStart,
    periodEnd,
  ].join(":");
  const previewIsCurrent = Boolean(preview) && previewKey === currentSelectionKey;
  const visibleCount = sectionOptions.filter(
    ({ key }) => visibleSections[key],
  ).length;

  const repassCandidates = useMemo(
    () =>
      data.entries
        .filter(
          (entry) =>
            entry.type === "saida" &&
            entry.status !== "cancelado" &&
            entry.contact_id === effectiveContactId &&
            entry.project_id === effectiveProjectId,
        )
        .sort((left, right) =>
          entryPlanningDate(left).localeCompare(entryPlanningDate(right)),
        ),
    [data.entries, effectiveContactId, effectiveProjectId],
  );

  const loadGovernance = useCallback(async () => {
    const requestId = contextRequest.current + 1;
    contextRequest.current = requestId;
    if (!effectiveContactId || !effectiveProjectId) {
      setHistory([]);
      setClassifiedEntryIds(new Set());
      return;
    }

    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }

    setLoadingContext(true);
    setError("");
    try {
      const [historyResult, classificationResult] = await Promise.all([
        client
          .from("partner_landowner_publications")
          .select(historyColumns)
          .eq("organization_id", data.organization.id)
          .eq("contact_id", effectiveContactId)
          .eq("project_id", effectiveProjectId)
          .order("published_at", { ascending: false }),
        client
          .from("partner_landowner_repass_entries")
          .select(repassColumns)
          .eq("organization_id", data.organization.id)
          .eq("contact_id", effectiveContactId)
          .eq("project_id", effectiveProjectId)
          .order("registered_at", { ascending: false }),
      ]);

      if (historyResult.error) throw historyResult.error;
      if (classificationResult.error) throw classificationResult.error;
      if (requestId !== contextRequest.current) return;

      setHistory(
        (historyResult.data || []) as unknown as LandownerPublication[],
      );
      const classifications = (classificationResult.data ||
        []) as unknown as RepassClassification[];
      setClassifiedEntryIds(
        new Set(classifications.map((row) => row.financial_entry_id)),
      );
      setAllocationDrafts((current) => {
        const next = { ...current };
        classifications.forEach((row) => {
          next[row.financial_entry_id] = String(row.allocated_amount);
        });
        return next;
      });
    } catch (caught) {
      if (requestId === contextRequest.current) {
        setError(errorMessage(caught));
      }
    } finally {
      if (requestId === contextRequest.current) {
        setLoadingContext(false);
      }
    }
  }, [
    data.organization.id,
    effectiveContactId,
    effectiveProjectId,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void loadGovernance();
    });
    return () => cancelAnimationFrame(frame);
  }, [loadGovernance]);

  function validateSelection() {
    if (!effectiveContactId || !effectiveProjectId) {
      setError("Selecione um terrenista e um empreendimento.");
      return false;
    }
    if (!periodStart || !periodEnd || periodEnd < periodStart) {
      setError("Informe um período inicial e final válido.");
      return false;
    }
    const periodDays =
      (dateAtNoon(periodEnd).getTime() - dateAtNoon(periodStart).getTime()) /
      86400000;
    if (periodDays > 1095) {
      setError("O período máximo para a publicação é de três anos.");
      return false;
    }
    return true;
  }

  async function generatePreview() {
    if (!canPublish) {
      setError("Seu perfil não pode gerar ou publicar dados de terrenistas.");
      return;
    }
    if (!validateSelection()) return;

    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }

    setPreviewing(true);
    setError("");
    setNotice("");
    try {
      const result = await client.rpc(
        "preview_landowner_portal_publication",
        {
          p_organization_id: data.organization.id,
          p_contact_id: effectiveContactId,
          p_project_id: effectiveProjectId,
          p_period_start: periodStart,
          p_period_end: periodEnd,
        },
      );
      if (result.error) throw result.error;
      if (!result.data || typeof result.data !== "object") {
        throw new Error("A prévia retornou um formato inválido.");
      }
      setPreview(result.data as unknown as LandownerSnapshot);
      setPreviewKey(currentSelectionKey);
      setNotice(
        "Prévia calculada a partir das fontes comerciais, financeiras e da Gestão de Obras.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  }

  async function publishSnapshot() {
    if (!canPublish) {
      setError("Seu perfil não pode publicar dados de terrenistas.");
      return;
    }
    if (!validateSelection()) return;
    if (!previewIsCurrent) {
      setError("Gere uma prévia atualizada antes de publicar.");
      return;
    }
    if (!visibleCount) {
      setError("Selecione ao menos uma informação para publicação.");
      return;
    }

    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }

    setPublishing(true);
    setError("");
    setNotice("");
    try {
      const result = await client.rpc("publish_landowner_portal_snapshot", {
        p_organization_id: data.organization.id,
        p_contact_id: effectiveContactId,
        p_project_id: effectiveProjectId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_visible_sections: visibleSections,
        p_public_note: publicNote.trim() || null,
      });
      if (result.error) throw result.error;
      setNotice(
        "Atualização publicada. A versão anterior foi arquivada e o portal exibirá somente este fechamento.",
      );
      await loadGovernance();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPublishing(false);
    }
  }

  async function archiveSnapshot() {
    if (!canPublish) {
      setError("Seu perfil não pode retirar publicações de terrenistas.");
      return;
    }
    if (
      !confirm(
        "Retirar o fechamento vigente deste terrenista? O histórico será preservado e nada ficará publicado para este empreendimento.",
      )
    ) {
      return;
    }

    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }

    setArchiving(true);
    setError("");
    setNotice("");
    try {
      const result = await client.rpc(
        "archive_landowner_portal_snapshot",
        {
          p_organization_id: data.organization.id,
          p_contact_id: effectiveContactId,
          p_project_id: effectiveProjectId,
          p_reason: "Publicação retirada pelo painel administrativo.",
        },
      );
      if (result.error) throw result.error;
      setNotice(
        result.data
          ? "Fechamento retirado do portal. A versão permanece no histórico."
          : "Não havia fechamento vigente para retirar.",
      );
      await loadGovernance();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setArchiving(false);
    }
  }

  async function setRepassEntry(
    entryId: string,
    enabled: boolean,
    allocatedAmount?: number,
  ) {
    if (!canPublish) {
      setError("Seu perfil não pode classificar repasses.");
      return;
    }
    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }

    setUpdatingEntryId(entryId);
    setError("");
    setNotice("");
    try {
      if (
        enabled &&
        (!Number.isFinite(allocatedAmount) || Number(allocatedAmount) <= 0)
      ) {
        throw new Error("Informe um valor de repasse maior que zero.");
      }
      const result = await client.rpc("set_landowner_repass_entry", {
        p_organization_id: data.organization.id,
        p_contact_id: effectiveContactId,
        p_project_id: effectiveProjectId,
        p_financial_entry_id: entryId,
        p_enabled: enabled,
        p_allocated_amount: enabled ? allocatedAmount : null,
        p_notes: null,
      });
      if (result.error) throw result.error;
      setClassifiedEntryIds((current) => {
        const next = new Set(current);
        if (enabled) next.add(entryId);
        else next.delete(entryId);
        return next;
      });
      setPreviewKey("");
      setNotice(
        enabled
          ? "Alocação de repasse salva. Gere uma nova prévia."
          : "Lançamento retirado da base de repasses. Gere uma nova prévia.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setUpdatingEntryId(null);
    }
  }

  function toggleSection(section: VisibleSection) {
    setVisibleSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  const selectedContact = activeContacts.find(
    (contact) => contact.id === effectiveContactId,
  );
  const selectedProject = activeProjects.find(
    (project) => project.id === effectiveProjectId,
  );
  const hasPublishedSnapshot = history.some(
    (publication) => publication.status === "published",
  );

  return (
    <section
      className="partner-landowner-panel partner-module"
      aria-labelledby="landowner-publication-title"
    >
      <header className="partner-landowner-heading">
        <div>
          <small>GOVERNANÇA DO PORTAL DO TERRENISTA</small>
          <h3 id="landowner-publication-title">Fechamentos e publicações</h3>
          <p>
            Calcule uma prévia, escolha exatamente o que ficará visível e
            publique uma versão auditável para cada terrenista e
            empreendimento.
          </p>
        </div>
        <span className="partner-status partner-status-active">
          Snapshot controlado
        </span>
      </header>

      {!canPublish && (
        <div className="partner-publication-warning" role="note">
          <b>Somente leitura</b>
          <p>
            Seu perfil pode consultar o histórico, mas não gerar prévias,
            classificar repasses ou publicar novas versões.
          </p>
        </div>
      )}

      {(notice || error) && (
        <div
          className={`partner-feedback ${
            error ? "partner-feedback-error" : ""
          }`}
          aria-live="polite"
        >
          <span>{error || notice}</span>
          <button
            type="button"
            aria-label="Fechar mensagem"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="partner-access-form">
        <header>
          <div>
            <small>RECORTE DA INFORMAÇÃO</small>
            <h3>Preparar fechamento</h3>
            <p>
              O período orienta vendas e VSO. Inadimplência, repasses e obra
              representam a posição atual congelada no momento da publicação.
            </p>
          </div>
        </header>
        <div className="partner-access-fields">
          <label>
            <span>Terrenista</span>
            <select
              value={effectiveContactId}
              onChange={(event) => {
                setContactId(event.target.value);
                setPreviewKey("");
              }}
              disabled={!activeContacts.length}
            >
              {!activeContacts.length && (
                <option value="">Nenhum terrenista cadastrado</option>
              )}
              {activeContacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contactName(contact)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Empreendimento</span>
            <select
              value={effectiveProjectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setPreviewKey("");
              }}
              disabled={!activeProjects.length}
            >
              {!activeProjects.length && (
                <option value="">Nenhum empreendimento ativo</option>
              )}
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>De</span>
            <input
              type="date"
              value={periodStart}
              max={periodEnd}
              onChange={(event) => {
                setPeriodStart(event.target.value);
                setPreviewKey("");
              }}
            />
          </label>
          <label>
            <span>Posição em</span>
            <input
              type="date"
              value={periodEnd}
              min={periodStart || undefined}
              readOnly
              aria-describedby="landowner-position-help"
            />
            <small id="landowner-position-help">
              Fechamento atual; o histórico fica preservado por versão.
            </small>
          </label>
          <button
            className="partner-button partner-button-secondary"
            type="button"
            disabled={
              !canPublish ||
              previewing ||
              !effectiveContactId ||
              !effectiveProjectId
            }
            onClick={() => void generatePreview()}
          >
            {previewing ? "Calculando..." : "Gerar prévia"}
          </button>
        </div>
      </div>

      {preview && (
        <section
          className={`partner-landowner-preview ${
            previewIsCurrent ? "" : "partner-landowner-preview-stale"
          }`}
          aria-labelledby="landowner-preview-title"
        >
          <header>
            <div>
              <small>PRÉVIA INTERNA · NÃO PUBLICADA</small>
              <h3 id="landowner-preview-title">
                {preview.project?.name || selectedProject?.name || "Fechamento"}
              </h3>
              <p>
                {safeDate(preview.period?.start || periodStart)} a{" "}
                {safeDate(preview.period?.end || periodEnd)}
                {preview.period?.calculated_at
                  ? ` · calculado em ${safeDateTime(
                      preview.period.calculated_at,
                    )}`
                  : ""}
              </p>
            </div>
            {!previewIsCurrent && (
              <span className="partner-status partner-status-suspenso">
                Prévia desatualizada
              </span>
            )}
          </header>

          <div className="partner-kpis">
            <article>
              <small>Lotes vendidos</small>
              <strong>
                {numberValue(preview.summary?.sold_lots).toLocaleString(
                  "pt-BR",
                )}
              </strong>
              <span>
                de{" "}
                {numberValue(preview.summary?.total_lots).toLocaleString(
                  "pt-BR",
                )}{" "}
                lotes ativos
              </span>
            </article>
            <article>
              <small>VGV total</small>
              <strong>
                {money.format(numberValue(preview.summary?.total_vgv))}
              </strong>
              <span>Potencial das unidades ativas</span>
            </article>
            <article>
              <small>VGV vendido</small>
              <strong>
                {money.format(numberValue(preview.summary?.sold_vgv))}
              </strong>
              <span>{percent(preview.summary?.sold_vgv_pct)} do VGV total</span>
            </article>
            <article>
              <small>VSO do período</small>
              <strong>{percent(preview.summary?.vso_pct)}</strong>
              <span>
                {numberValue(preview.summary?.sales_in_period)} venda(s) no
                período
              </span>
            </article>
            <article>
              <small>Inadimplência</small>
              <strong>
                {money.format(
                  numberValue(preview.delinquency?.overdue_amount),
                )}
              </strong>
              <span>
                {percent(preview.delinquency?.overdue_rate_pct)} da carteira
                aberta
              </span>
            </article>
            <article>
              <small>Valores repassados</small>
              <strong>
                {preview.repasses?.configured === false
                  ? "Base não configurada"
                  : money.format(numberValue(preview.repasses?.paid_amount))}
              </strong>
              <span>
                {preview.repasses?.configured === false
                  ? "Classifique os títulos antes de publicar"
                  : "Repasses classificados e com baixa confirmada"}
              </span>
            </article>
            <article>
              <small>Devido e não repassado</small>
              <strong>
                {preview.repasses?.configured === false
                  ? "—"
                  : money.format(
                      numberValue(preview.repasses?.due_not_repassed),
                    )}
              </strong>
              <span>
                {numberValue(preview.repasses?.due_not_repassed_count)}{" "}
                lançamento(s)
              </span>
            </article>
            <article>
              <small>Andamento da obra</small>
              <strong>
                {percent(preview.construction?.actual_progress_pct)}
              </strong>
              <span>
                Previsto:{" "}
                {percent(preview.construction?.planned_progress_pct)}
              </span>
            </article>
          </div>

          <dl className="partner-landowner-condition-summary">
            <div>
              <dt>Preço médio vendido</dt>
              <dd>
                {money.format(
                  numberValue(preview.sales_conditions?.average_sale_price),
                )}
              </dd>
            </div>
            <div>
              <dt>Entrada média</dt>
              <dd>
                {percent(
                  preview.sales_conditions?.average_down_payment_pct,
                )}
              </dd>
            </div>
            <div>
              <dt>Prazo médio</dt>
              <dd>
                {numberValue(
                  preview.sales_conditions?.average_installments,
                ).toLocaleString("pt-BR", {
                  maximumFractionDigits: 1,
                })}{" "}
                parcela(s)
              </dd>
            </div>
            <div>
              <dt>Desconto médio</dt>
              <dd>
                {percent(preview.sales_conditions?.average_discount_pct)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <div className="partner-landowner-governance-grid">
        <fieldset className="partner-landowner-visibility">
          <legend>Informações visíveis no portal</legend>
          <p>
            O portal recebe apenas o snapshot publicado. Desmarcar uma opção
            impede a exposição daquele conjunto de dados.
          </p>
          <div className="partner-landowner-section-options">
            {sectionOptions.map((option) => (
              <label className="partner-check" key={option.key}>
                <input
                  type="checkbox"
                  checked={visibleSections[option.key]}
                  disabled={!canPublish}
                  onChange={() => toggleSection(option.key)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="partner-landowner-selection-count">
            {visibleCount} de {sectionOptions.length} seções selecionadas
          </p>
        </fieldset>

        <section className="partner-landowner-publish">
          <header>
            <small>COMUNICAÇÃO AO PARCEIRO</small>
            <h3>Nota do fechamento</h3>
            <p>
              Contextualize o período sem expor informações internas de caixa
              ou dados pessoais de compradores.
            </p>
          </header>
          <label>
            <span>Nota pública opcional</span>
            <textarea
              rows={6}
              maxLength={1600}
              value={publicNote}
              disabled={!canPublish}
              onChange={(event) => setPublicNote(event.target.value)}
              placeholder="Ex.: Fechamento comercial e financeiro consolidado até a data informada."
            />
            <small>{publicNote.length}/1600 caracteres</small>
          </label>
          <div className="partner-publication-warning">
            <b>Confirmação necessária</b>
            <p>
              Publicar arquiva a versão vigente de{" "}
              {contactName(selectedContact)} para {selectedProject?.name} e
              disponibiliza este novo fechamento no link protegido.
            </p>
          </div>
          <button
            className="partner-button partner-button-primary"
            type="button"
            disabled={
              !canPublish ||
              !previewIsCurrent ||
              !visibleCount ||
              publishing
            }
            onClick={() => void publishSnapshot()}
          >
            {publishing ? "Publicando..." : "Publicar fechamento no portal"}
          </button>
          {hasPublishedSnapshot && (
            <button
              className="partner-button partner-button-secondary"
              type="button"
              disabled={!canPublish || archiving}
              onClick={() => void archiveSnapshot()}
            >
              {archiving
                ? "Retirando..."
                : "Retirar fechamento vigente do portal"}
            </button>
          )}
        </section>
      </div>

      <section
        className="partner-landowner-repasses"
        aria-labelledby="landowner-repasses-title"
      >
        <header>
          <div>
            <small>BASE EXPLÍCITA DE REPASSES</small>
            <h3 id="landowner-repasses-title">
              Classificar contas do terrenista
            </h3>
            <p>
              Somente lançamentos marcados abaixo integram os valores
              repassados e devidos no fechamento. A alteração é auditada.
            </p>
          </div>
          <span>
            {classifiedEntryIds.size} de {repassCandidates.length} marcado(s)
          </span>
        </header>

        {loadingContext ? (
          <div className="partner-empty">
            <b>↻</b>
            <strong>Carregando repasses</strong>
            <p>Consultando as classificações do fechamento.</p>
          </div>
        ) : repassCandidates.length ? (
          <div
            className="partner-landowner-repass-table"
            role="region"
            aria-label="Contas a pagar classificáveis como repasse"
            tabIndex={0}
          >
            <table>
              <caption>
                Contas a pagar de {contactName(selectedContact)} em{" "}
                {selectedProject?.name}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Publicar como repasse</th>
                  <th scope="col">Lançamento</th>
                  <th scope="col">Documento</th>
                  <th scope="col">Data financeira</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Valor do título</th>
                  <th scope="col">Valor alocado ao repasse</th>
                </tr>
              </thead>
              <tbody>
                {repassCandidates.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <label className="partner-check">
                        <input
                          type="checkbox"
                          checked={classifiedEntryIds.has(entry.id)}
                          disabled={
                            !canPublish || updatingEntryId === entry.id
                          }
                          onChange={(event) =>
                            void setRepassEntry(
                              entry.id,
                              event.target.checked,
                              Number(
                                allocationDrafts[entry.id] ??
                                  entryBaseAmount(entry),
                              ),
                            )
                          }
                        />
                        <span>
                          {updatingEntryId === entry.id
                            ? "Salvando..."
                            : classifiedEntryIds.has(entry.id)
                              ? "Incluído"
                              : "Não incluído"}
                        </span>
                      </label>
                    </td>
                    <td>
                      <strong>{entry.description}</strong>
                    </td>
                    <td>{entry.document_number || "—"}</td>
                    <td>
                      <strong>{safeDate(entryPlanningDate(entry))}</strong>
                      <small>
                        {entry.scheduled_payment_date
                          ? "Programação efetiva"
                          : "Vencimento"}
                      </small>
                    </td>
                    <td>
                      <span className={`partner-status partner-status-${entry.status}`}>
                        {statusLabels[entry.status]}
                      </span>
                    </td>
                    <td>
                      <strong>{money.format(numberValue(entry.amount))}</strong>
                    </td>
                    <td>
                      <div className="partner-landowner-allocation">
                        <input
                          type="number"
                          min="0.01"
                          max={entryBaseAmount(entry)}
                          step="0.01"
                          aria-label={`Valor do repasse de ${entry.description}`}
                          value={
                            allocationDrafts[entry.id] ??
                            String(entryBaseAmount(entry))
                          }
                          disabled={
                            !canPublish || updatingEntryId === entry.id
                          }
                          onChange={(event) =>
                            setAllocationDrafts((current) => ({
                              ...current,
                              [entry.id]: event.target.value,
                            }))
                          }
                        />
                        {classifiedEntryIds.has(entry.id) && (
                          <button
                            className="partner-button partner-button-secondary"
                            type="button"
                            disabled={
                              !canPublish || updatingEntryId === entry.id
                            }
                            onClick={() =>
                              void setRepassEntry(
                                entry.id,
                                true,
                                Number(
                                  allocationDrafts[entry.id] ??
                                    entryBaseAmount(entry),
                                ),
                              )
                            }
                          >
                            Salvar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="partner-empty">
            <b>R$</b>
            <strong>Nenhuma conta classificável</strong>
            <p>
              Cadastre uma conta a pagar vinculada ao mesmo terrenista e
              empreendimento para incluí-la nos repasses.
            </p>
          </div>
        )}
      </section>

      <section
        className="partner-landowner-history"
        aria-labelledby="landowner-history-title"
      >
        <header>
          <div>
            <small>RASTREABILIDADE</small>
            <h3 id="landowner-history-title">Histórico de publicações</h3>
            <p>
              Cada nova versão preserva período, conteúdo publicado e data do
              fechamento anterior.
            </p>
          </div>
          <button
            className="partner-button partner-button-secondary"
            type="button"
            disabled={loadingContext}
            onClick={() => void loadGovernance()}
          >
            {loadingContext ? "Atualizando..." : "Atualizar histórico"}
          </button>
        </header>

        {history.length ? (
          <div className="partner-access-list">
            {history.map((publication) => (
              <article key={publication.id}>
                <div className="partner-access-identity">
                  <small>VERSÃO {publication.version}</small>
                  <strong>
                    {safeDate(publication.period_start)} a{" "}
                    {safeDate(publication.period_end)}
                  </strong>
                  <span>
                    {publicationVisibilityCount(publication)} seção(ões)
                    publicada(s)
                  </span>
                </div>
                <div>
                  <small>Situação</small>
                  <strong>
                    {publication.status === "published"
                      ? "Vigente no portal"
                      : "Arquivada"}
                  </strong>
                  <span>
                    {publication.status === "published"
                      ? "Último fechamento aprovado"
                      : "Preservada para auditoria"}
                  </span>
                </div>
                <div>
                  <small>Publicação</small>
                  <strong>{safeDateTime(publication.published_at)}</strong>
                  <span>{publication.public_note || "Sem nota pública"}</span>
                </div>
                <span
                  className={`partner-status ${
                    publication.status === "published"
                      ? "partner-status-active"
                      : "partner-status-inactive"
                  }`}
                >
                  {publication.status === "published" ? "Vigente" : "Arquivada"}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="partner-empty">
            <b>01</b>
            <strong>Nenhum fechamento publicado</strong>
            <p>
              Gere uma prévia e publique a primeira versão para este terrenista
              e empreendimento.
            </p>
          </div>
        )}
      </section>
    </section>
  );
}
