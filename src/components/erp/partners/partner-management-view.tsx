"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getSupabase } from "@/lib/supabase";
import type { Contact, ErpData, FinancialEntry } from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { LandownerPublicationPanel } from "./landowner-publication-panel";

type PartnerTab = "payments" | "landowners" | "negotiations" | "access";
type PublicStatus =
  | "em_analise"
  | "previsto"
  | "programado"
  | "em_processamento"
  | "pago"
  | "suspenso";
type PartnerKind =
  | "fornecedor"
  | "credor_financeiro"
  | "terrenista"
  | "parceiro"
  | "colaborador"
  | "beneficiario";
type NegotiationStatus =
  | "aberta"
  | "em_analise"
  | "contraproposta"
  | "aguardando_parceiro"
  | "aceita_pelo_parceiro"
  | "aprovada"
  | "rejeitada"
  | "cancelada"
  | "encerrada";

interface PartnerPublication {
  id: string;
  organization_id: string;
  contact_id: string;
  financial_entry_id: string;
  public_status: PublicStatus;
  forecast_start: string | null;
  forecast_end: string | null;
  scheduled_date: string | null;
  processing_started_at: string | null;
  paid_at: string | null;
  public_note: string | null;
  visible: boolean;
  version: number;
  published_at: string;
  updated_at: string;
}

interface PartnerPortalLink {
  id: string;
  organization_id: string;
  contact_id: string;
  partner_kind: PartnerKind;
  token_hint: string;
  label: string | null;
  active: boolean;
  expires_at: string;
  last_access_at: string | null;
  access_count: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

interface PartnerNegotiation {
  id: string;
  organization_id: string;
  contact_id: string;
  portal_link_id: string | null;
  financial_entry_id: string | null;
  negotiation_type: string;
  status: NegotiationStatus;
  subject: string;
  current_terms: Record<string, unknown>;
  terms_version: number;
  assigned_to: string | null;
  opened_at: string;
  decided_at: string | null;
  decision_notes: string | null;
  created_by_partner: boolean;
  updated_at: string;
}

interface PartnerNegotiationMessage {
  id: string;
  organization_id: string;
  negotiation_id: string;
  sender_kind: "parceiro" | "equipe" | "sistema";
  sender_name: string | null;
  message_type: string;
  body: string;
  terms_snapshot: Record<string, unknown>;
  terms_version: number | null;
  created_at: string;
}

interface PublicationForm {
  publicStatus: PublicStatus;
  forecastStart: string;
  forecastEnd: string;
  scheduledDate: string;
  publicNote: string;
  visible: boolean;
}

interface ReplyForm {
  message: string;
  nextStatus:
    | "em_analise"
    | "contraproposta"
    | "aguardando_parceiro"
    | "encerrada";
  proposedDueDate: string;
  proposedInstallments: string;
  proposedDiscountPct: string;
  proposedAmount: string;
}

const publicStatusLabels: Record<PublicStatus, string> = {
  em_analise: "Em análise",
  previsto: "Previsão comunicada",
  programado: "Programado",
  em_processamento: "Em processamento",
  pago: "Pago",
  suspenso: "Comunicação suspensa",
};

const negotiationStatusLabels: Record<NegotiationStatus, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  contraproposta: "Contraproposta",
  aguardando_parceiro: "Aguardando parceiro",
  aceita_pelo_parceiro: "Aceita pelo parceiro",
  aprovada: "Aprovada",
  rejeitada: "Rejeitada",
  cancelada: "Cancelada",
  encerrada: "Encerrada",
};

const negotiationTypeLabels: Record<string, string> = {
  prorrogacao: "Alteração de vencimento",
  parcelamento: "Parcelamento",
  antecipacao_desconto: "Antecipação com desconto",
  compensacao: "Compensação",
  contestacao: "Contestação",
  outro: "Outra negociação",
};

const partnerKindLabels: Record<PartnerKind, string> = {
  fornecedor: "Fornecedor ou prestador",
  credor_financeiro: "Credor financeiro",
  terrenista: "Terrenista",
  parceiro: "Parceiro",
  colaborador: "Colaborador",
  beneficiario: "Outro beneficiário",
};

const terminalNegotiationStatuses = new Set<NegotiationStatus>([
  "aprovada",
  "rejeitada",
  "cancelada",
  "encerrada",
]);

const publicationColumns =
  "id,organization_id,contact_id,financial_entry_id,public_status,forecast_start,forecast_end,scheduled_date,processing_started_at,paid_at,public_note,visible,version,published_at,updated_at";
const linkColumns =
  "id,organization_id,contact_id,partner_kind,token_hint,label,active,expires_at,last_access_at,access_count,failed_attempts,locked_until,created_at,revoked_at,revoke_reason";
const negotiationColumns =
  "id,organization_id,contact_id,portal_link_id,financial_entry_id,negotiation_type,status,subject,current_terms,terms_version,assigned_to,opened_at,decided_at,decision_notes,created_by_partner,updated_at";
const messageColumns =
  "id,organization_id,negotiation_id,sender_kind,sender_name,message_type,body,terms_snapshot,terms_version,created_at";

function safeDate(value: string | null | undefined) {
  return value ? shortDate.format(dateAtNoon(value.slice(0, 10))) : "—";
}

function safeDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("pt-BR") : "—";
}

function futureDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function operationError(error: unknown, fallback: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}

function documentDigits(value: string | null | undefined) {
  return (value || "").replace(/\D/g, "");
}

function validPartnerDocument(value: string | null | undefined) {
  return [11, 14].includes(documentDigits(value).length);
}

function partnerName(contact: Contact | undefined) {
  return contact?.trade_name || contact?.name || "Parceiro não identificado";
}

function scheduledPaymentDate(entry: FinancialEntry | undefined) {
  return entry?.scheduled_payment_date || null;
}

function publicTiming(publication: PartnerPublication | undefined) {
  if (!publication) return "Ainda não comunicado";
  if (publication.public_status === "previsto")
    return `${safeDate(publication.forecast_start)} a ${safeDate(
      publication.forecast_end,
    )}`;
  if (publication.public_status === "pago")
    return safeDate(publication.paid_at);
  if (
    ["programado", "em_processamento"].includes(
      publication.public_status,
    )
  )
    return publication.scheduled_date
      ? safeDate(publication.scheduled_date)
      : "Ainda não programado";
  return publicStatusLabels[publication.public_status];
}

function termsSummary(terms: Record<string, unknown>) {
  const values: string[] = [];
  if (typeof terms.proposed_due_date === "string" && terms.proposed_due_date)
    values.push(`Vencimento: ${safeDate(terms.proposed_due_date)}`);
  if (Number(terms.proposed_installments) > 0)
    values.push(`${Number(terms.proposed_installments)} parcela(s)`);
  if (Number(terms.proposed_discount_pct) > 0)
    values.push(
      `Desconto: ${Number(terms.proposed_discount_pct).toLocaleString(
        "pt-BR",
      )}%`,
    );
  if (Number(terms.proposed_amount) > 0)
    values.push(`Valor: ${money.format(Number(terms.proposed_amount))}`);
  return values.length ? values.join(" · ") : "Sem condições estruturadas";
}

export function PartnerManagementView({
  data,
  can,
}: {
  data: ErpData;
  can: (permission: string) => boolean;
}) {
  const [tab, setTab] = useState<PartnerTab>("payments");
  const [publications, setPublications] = useState<PartnerPublication[]>([]);
  const [links, setLinks] = useState<PartnerPortalLink[]>([]);
  const [negotiations, setNegotiations] = useState<PartnerNegotiation[]>([]);
  const [messages, setMessages] = useState<PartnerNegotiationMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [referenceTime, setReferenceTime] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [paymentEntryId, setPaymentEntryId] = useState<string | null>(null);
  const [publicationForm, setPublicationForm] = useState<PublicationForm>({
    publicStatus: "em_analise",
    forecastStart: futureDate(7),
    forecastEnd: futureDate(14),
    scheduledDate: futureDate(7),
    publicNote: "",
    visible: true,
  });
  const [selectedNegotiationId, setSelectedNegotiationId] = useState<
    string | null
  >(null);
  const [replyForm, setReplyForm] = useState<ReplyForm>({
    message: "",
    nextStatus: "em_analise",
    proposedDueDate: "",
    proposedInstallments: "",
    proposedDiscountPct: "",
    proposedAmount: "",
  });
  const [decision, setDecision] = useState<"aprovada" | "rejeitada">(
    "aprovada",
  );
  const [decisionNotes, setDecisionNotes] = useState("");
  const [linkContactId, setLinkContactId] = useState("");
  const [linkKind, setLinkKind] = useState<PartnerKind>("fornecedor");
  const [linkDocument, setLinkDocument] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkExpiresAt, setLinkExpiresAt] = useState(futureDate(60));
  const [generatedLink, setGeneratedLink] = useState("");

  const organizationId = data.organization.id;
  const canViewNegotiations = can("partners.negotiations.view");
  const canManageNegotiations = can("partners.negotiations.manage");
  const canApproveNegotiations = can("partners.negotiations.approve");
  const canPublishPayments = can("partners.payments.publish");
  const canPublishLandowners = can("partners.landowners.publish");
  const canProcessPayments = can("partners.process");
  const canManageAccess = can("partners.access.manage");

  const loadTab = useCallback(
    async (target: PartnerTab) => {
      const client = getSupabase();
      if (!client) {
        setError("Supabase indisponível.");
        return;
      }
      setLoading(true);
      setError("");
      try {
        if (target === "payments") {
          const result = await client
            .from("partner_payment_publications")
            .select(publicationColumns)
            .eq("organization_id", organizationId)
            .order("updated_at", { ascending: false });
          if (result.error) throw result.error;
          setPublications(
            (result.data || []) as unknown as PartnerPublication[],
          );
        } else if (target === "negotiations") {
          if (!canViewNegotiations) {
            setNegotiations([]);
            setMessages([]);
            return;
          }
          const [negotiationResult, messageResult] = await Promise.all([
            client
              .from("partner_negotiations")
              .select(negotiationColumns)
              .eq("organization_id", organizationId)
              .order("updated_at", { ascending: false }),
            client
              .from("partner_negotiation_messages")
              .select(messageColumns)
              .eq("organization_id", organizationId)
              .order("created_at"),
          ]);
          if (negotiationResult.error) throw negotiationResult.error;
          if (messageResult.error) throw messageResult.error;
          setNegotiations(
            (negotiationResult.data ||
              []) as unknown as PartnerNegotiation[],
          );
          setMessages(
            (messageResult.data ||
              []) as unknown as PartnerNegotiationMessage[],
          );
        } else if (target === "access") {
          const result = await client
            .from("partner_portal_links")
            .select(linkColumns)
            .eq("organization_id", organizationId)
            .order("created_at", { ascending: false });
          if (result.error) throw result.error;
          setLinks((result.data || []) as unknown as PartnerPortalLink[]);
        }
        setReferenceTime(Date.now());
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Não foi possível carregar a central de parceiros.",
        );
      } finally {
        setLoading(false);
      }
    },
    [canViewNegotiations, organizationId],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadTab(tab);
    });
    return () => {
      active = false;
    };
  }, [loadTab, tab]);

  const contactsById = useMemo(
    () => new Map(data.contacts.map((contact) => [contact.id, contact])),
    [data.contacts],
  );
  const projectsById = useMemo(
    () => new Map(data.projects.map((project) => [project.id, project])),
    [data.projects],
  );
  const entriesById = useMemo(
    () => new Map(data.entries.map((entry) => [entry.id, entry])),
    [data.entries],
  );
  const publicationsByEntry = useMemo(
    () =>
      new Map(
        publications.map((publication) => [
          publication.financial_entry_id,
          publication,
        ]),
      ),
    [publications],
  );

  const payables = useMemo(
    () =>
      data.entries
        .filter(
          (entry) => entry.type === "saida" && entry.status !== "cancelado",
        )
        .sort((left, right) => left.due_date.localeCompare(right.due_date)),
    [data.entries],
  );

  const partnerContacts = useMemo(() => {
    const payableContactIds = new Set(
      payables
        .map((entry) => entry.contact_id)
        .filter((value): value is string => Boolean(value)),
    );
    return data.contacts
      .filter(
        (contact) =>
          contact.active &&
          (payableContactIds.has(contact.id) ||
            [
              "fornecedor",
              "ambos",
              "terrenista",
              "colaborador",
              "beneficiario",
            ].includes(contact.contact_type)),
      )
      .sort((left, right) =>
        partnerName(left).localeCompare(partnerName(right), "pt-BR"),
      );
  }, [data.contacts, payables]);
  const selectedLinkContact = contactsById.get(linkContactId);
  const linkDocumentReady = validPartnerDocument(linkDocument);
  const selectedContactHasDocument = validPartnerDocument(
    selectedLinkContact?.document,
  );

  const filteredPayables = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return payables.filter((entry) => {
      const publication = publicationsByEntry.get(entry.id);
      if (
        statusFilter !== "todos" &&
        (statusFilter === "nao_publicado"
          ? Boolean(publication)
          : publication?.public_status !== statusFilter)
      )
        return false;
      if (!normalized) return true;
      const contact = contactsById.get(entry.contact_id || "");
      const project = projectsById.get(entry.project_id || "");
      return [
        entry.description,
        entry.document_number,
        partnerName(contact),
        project?.name,
      ]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase("pt-BR").includes(normalized),
        );
    });
  }, [
    contactsById,
    payables,
    projectsById,
    publicationsByEntry,
    query,
    statusFilter,
  ]);

  const filteredNegotiations = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return negotiations.filter((negotiation) => {
      if (
        statusFilter !== "todos" &&
        negotiation.status !== statusFilter
      )
        return false;
      if (!normalized) return true;
      const contact = contactsById.get(negotiation.contact_id);
      const entry = entriesById.get(negotiation.financial_entry_id || "");
      return [
        negotiation.subject,
        partnerName(contact),
        entry?.description,
        negotiationTypeLabels[negotiation.negotiation_type],
      ]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase("pt-BR").includes(normalized),
        );
    });
  }, [
    contactsById,
    entriesById,
    negotiations,
    query,
    statusFilter,
  ]);

  const filteredLinks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return links.filter((link) => {
      if (
        statusFilter !== "todos" &&
        (statusFilter === "ativo" ? !link.active : link.active)
      )
        return false;
      if (!normalized) return true;
      const contact = contactsById.get(link.contact_id);
      return [partnerName(contact), link.label, link.token_hint]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase("pt-BR").includes(normalized),
        );
    });
  }, [contactsById, links, query, statusFilter]);

  const selectedNegotiation = negotiations.find(
    (negotiation) => negotiation.id === selectedNegotiationId,
  );
  const selectedMessages = messages.filter(
    (message) => message.negotiation_id === selectedNegotiationId,
  );

  const paymentKpis = useMemo(
    () => ({
      unpublished: payables.filter(
        (entry) => !publicationsByEntry.has(entry.id),
      ).length,
      forecast: publications.filter(
        (publication) => publication.public_status === "previsto",
      ).length,
      scheduled: publications.filter(
        (publication) => publication.public_status === "programado",
      ).length,
      processing: publications.filter(
        (publication) => publication.public_status === "em_processamento",
      ).length,
    }),
    [payables, publications, publicationsByEntry],
  );

  function selectTab(next: PartnerTab) {
    setTab(next);
    setQuery("");
    setStatusFilter("todos");
    setError("");
    setNotice("");
    setSelectedNegotiationId(null);
  }

  function openPublication(entry: FinancialEntry) {
    const publication = publicationsByEntry.get(entry.id);
    const effectiveScheduledDate = scheduledPaymentDate(entry);
    const scheduleReleased =
      entry.approval_status === "aprovado" &&
      !entry.payment_blocked &&
      (!entry.is_provision ||
        ["liberado", "reconciliado"].includes(
          entry.payment_release_status || "",
        ));
    const allowedStatuses: PublicStatus[] = [
      ...(canPublishPayments
        ? (["em_analise", "previsto", "suspenso"] as PublicStatus[])
        : []),
      ...(canPublishPayments && scheduleReleased
        ? (["programado"] as PublicStatus[])
        : []),
      ...(canProcessPayments && scheduleReleased
        ? (["em_processamento"] as PublicStatus[])
        : []),
      ...(canProcessPayments && entry.status === "pago"
        ? (["pago"] as PublicStatus[])
        : []),
    ];
    const currentStatus: PublicStatus =
      entry.status === "pago"
        ? "pago"
        : publication?.public_status || "em_analise";
    const defaultStatus = allowedStatuses.includes(currentStatus)
      ? currentStatus
      : allowedStatuses[0];
    if (!defaultStatus) {
      setError(
        "Seu perfil não possui uma ação disponível para a situação atual deste título.",
      );
      return;
    }
    setPaymentEntryId(entry.id);
    setPublicationForm({
      publicStatus: defaultStatus,
      forecastStart: publication?.forecast_start || futureDate(7),
      forecastEnd: publication?.forecast_end || futureDate(14),
      scheduledDate:
        effectiveScheduledDate ||
        publication?.scheduled_date ||
        (entry.due_date >= new Date().toISOString().slice(0, 10)
          ? entry.due_date
          : futureDate(7)),
      publicNote: publication?.public_note || "",
      visible: publication?.visible ?? true,
    });
    setError("");
  }

  async function submitPublication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paymentEntryId) return;
    if (
      publicationForm.publicStatus === "previsto" &&
      (!publicationForm.forecastStart ||
        !publicationForm.forecastEnd ||
        publicationForm.forecastEnd < publicationForm.forecastStart)
    ) {
      setError("Informe uma janela de previsão válida.");
      return;
    }
    if (
      ["programado", "em_processamento"].includes(
        publicationForm.publicStatus,
      ) &&
      !publicationForm.scheduledDate
    ) {
      setError("Informe a data programada.");
      return;
    }
    const targetEntry = entriesById.get(paymentEntryId);
    const scheduleReleased =
      targetEntry?.approval_status === "aprovado" &&
      !targetEntry.payment_blocked &&
      (!targetEntry.is_provision ||
        ["liberado", "reconciliado"].includes(
          targetEntry.payment_release_status || "",
        ));
    if (
      ["programado", "em_processamento"].includes(
        publicationForm.publicStatus,
      ) &&
      !scheduleReleased
    ) {
      setError(
        "O título precisa estar aprovado, liberado e conciliado antes dessa comunicação.",
      );
      return;
    }
    if (
      publicationForm.publicStatus === "pago" &&
      targetEntry?.status !== "pago"
    ) {
      setError("A situação Pago exige baixa financeira confirmada.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("publish_partner_payment", {
        p_organization_id: organizationId,
        p_financial_entry_id: paymentEntryId,
        p_public_status: publicationForm.publicStatus,
        p_forecast_start:
          publicationForm.publicStatus === "previsto"
            ? publicationForm.forecastStart
            : null,
        p_forecast_end:
          publicationForm.publicStatus === "previsto"
            ? publicationForm.forecastEnd
            : null,
        p_scheduled_date: ["programado", "em_processamento"].includes(
          publicationForm.publicStatus,
        )
          ? publicationForm.scheduledDate || null
          : null,
        p_public_note: publicationForm.publicNote || null,
        p_visible: publicationForm.visible,
      });
      if (result.error) throw result.error;
      setPaymentEntryId(null);
      setNotice("Informação de pagamento publicada com segurança.");
      await loadTab("payments");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível publicar a atualização.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!linkContactId) {
      setError("Selecione o parceiro.");
      return;
    }
    if (!linkDocumentReady) {
      setError(
        "Informe um CPF com 11 dígitos ou um CNPJ com 14 dígitos para proteger o acesso.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setGeneratedLink("");
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const normalizedDocument = documentDigits(linkDocument);
      if (
        normalizedDocument !== documentDigits(selectedLinkContact?.document)
      ) {
        const contactUpdate = await client
          .from("contacts")
          .update({ document: normalizedDocument })
          .eq("organization_id", organizationId)
          .eq("id", linkContactId)
          .select("id")
          .maybeSingle();
        if (contactUpdate.error)
          throw new Error(contactUpdate.error.message);
        if (!contactUpdate.data)
          throw new Error(
            "Não foi possível salvar o CPF/CNPJ no cadastro do parceiro.",
          );
      }
      const expiresAt = new Date(`${linkExpiresAt}T23:59:59`).toISOString();
      const result = await client.rpc("create_partner_portal_link", {
        p_organization_id: organizationId,
        p_contact_id: linkContactId,
        p_partner_kind: linkKind,
        p_label: linkLabel || null,
        p_expires_at: expiresAt,
      });
      if (result.error) throw new Error(result.error.message);
      const payload = result.data as {
        token?: string;
        expires_at?: string;
      } | null;
      if (!payload?.token)
        throw new Error("O acesso foi criado, mas o token não foi retornado.");
      const url = `${location.origin}/parceiro#acesso=${payload.token}`;
      setGeneratedLink(url);
      setNotice(
        "CPF/CNPJ validado e acesso criado. Copie o endereço agora: o token não será exibido novamente.",
      );
      await loadTab("access");
    } catch (cause) {
      setError(
        operationError(cause, "Não foi possível criar o acesso."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function revokeLink(link: PartnerPortalLink) {
    if (
      !window.confirm(
        `Revogar o acesso de ${partnerName(
          contactsById.get(link.contact_id),
        )}?`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("revoke_partner_portal_link", {
        p_organization_id: organizationId,
        p_link_id: link.id,
        p_reason: "Acesso revogado pela administração.",
      });
      if (result.error) throw result.error;
      setNotice("Acesso revogado.");
      await loadTab("access");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível revogar o acesso.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function replyNegotiation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedNegotiation) return;
    setBusy(true);
    setError("");
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const terms =
        replyForm.nextStatus === "contraproposta"
          ? {
              proposed_due_date: replyForm.proposedDueDate || null,
              proposed_installments:
                Number(replyForm.proposedInstallments) || null,
              proposed_discount_pct:
                Number(replyForm.proposedDiscountPct) || null,
              proposed_amount: Number(replyForm.proposedAmount) || null,
            }
          : null;
      const result = await client.rpc("reply_partner_negotiation", {
        p_organization_id: organizationId,
        p_negotiation_id: selectedNegotiation.id,
        p_message: replyForm.message.trim(),
        p_next_status: replyForm.nextStatus,
        p_terms: terms,
      });
      if (result.error) throw result.error;
      setReplyForm({
        message: "",
        nextStatus: "em_analise",
        proposedDueDate: "",
        proposedInstallments: "",
        proposedDiscountPct: "",
        proposedAmount: "",
      });
      setNotice("Resposta registrada no histórico da negociação.");
      await loadTab("negotiations");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível responder à negociação.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function decideNegotiation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedNegotiation) return;
    setBusy(true);
    setError("");
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("decide_partner_negotiation", {
        p_organization_id: organizationId,
        p_negotiation_id: selectedNegotiation.id,
        p_decision: decision,
        p_decision_notes: decisionNotes.trim(),
      });
      if (result.error) throw result.error;
      setDecisionNotes("");
      setNotice(
        decision === "aprovada"
          ? "Negociação aprovada para formalização."
          : "Negociação rejeitada com fundamentação registrada.",
      );
      await loadTab("negotiations");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível registrar a decisão.",
      );
    } finally {
      setBusy(false);
    }
  }

  function selectNegotiation(negotiation: PartnerNegotiation) {
    setSelectedNegotiationId(negotiation.id);
    setReplyForm({
      message: "",
      nextStatus: "em_analise",
      proposedDueDate:
        typeof negotiation.current_terms.proposed_due_date === "string"
          ? negotiation.current_terms.proposed_due_date
          : "",
      proposedInstallments: negotiation.current_terms.proposed_installments
        ? String(negotiation.current_terms.proposed_installments)
        : "",
      proposedDiscountPct: negotiation.current_terms.proposed_discount_pct
        ? String(negotiation.current_terms.proposed_discount_pct)
        : "",
      proposedAmount: negotiation.current_terms.proposed_amount
        ? String(negotiation.current_terms.proposed_amount)
        : "",
    });
    setDecisionNotes("");
    setError("");
  }

  const paymentEntry = paymentEntryId
    ? entriesById.get(paymentEntryId)
    : undefined;
  const paymentEntryPublication = paymentEntryId
    ? publicationsByEntry.get(paymentEntryId)
    : undefined;
  const paymentEntryScheduledDate =
    scheduledPaymentDate(paymentEntry) ||
    paymentEntryPublication?.scheduled_date ||
    null;
  const paymentEntryCanSchedule =
    paymentEntry?.approval_status === "aprovado" &&
    !paymentEntry.payment_blocked &&
    (!paymentEntry.is_provision ||
      ["liberado", "reconciliado"].includes(
        paymentEntry.payment_release_status || "",
      ));

  return (
    <div className="partner-management">
      <section className="partner-hero">
        <div className="partner-hero-copy">
          <small>RELACIONAMENTO FINANCEIRO E GOVERNANÇA</small>
          <h2>Central de Parceiros e Pagamentos</h2>
          <p>
            Publique previsões com clareza, acompanhe o processamento e conduza
            negociações sem expor informações internas de caixa.
          </p>
        </div>
        <div className="partner-hero-actions">
          <span>
            <small>Última sincronização</small>
            <strong>{new Date(referenceTime).toLocaleTimeString("pt-BR")}</strong>
          </span>
          <button
            className="partner-button partner-button-secondary"
            type="button"
            disabled={loading}
            onClick={() => void loadTab(tab)}
          >
            {loading ? "Atualizando..." : "Atualizar dados"}
          </button>
        </div>
      </section>

      <nav className="partner-tabs" aria-label="Áreas da central de parceiros">
        <button
          type="button"
          className={tab === "payments" ? "partner-tab-active" : ""}
          onClick={() => selectTab("payments")}
        >
          <b>01</b>
          <span>
            Pagamentos e previsões
            <small>Comunicação dos próximos pagamentos</small>
          </span>
        </button>
        <button
          type="button"
          className={tab === "landowners" ? "partner-tab-active" : ""}
          onClick={() => selectTab("landowners")}
        >
          <b>02</b>
          <span>
            Portal do terrenista
            <small>Fechamentos, indicadores e publicação</small>
          </span>
        </button>
        {canViewNegotiations && (
          <button
            type="button"
            className={tab === "negotiations" ? "partner-tab-active" : ""}
            onClick={() => selectTab("negotiations")}
          >
            <b>03</b>
            <span>
              Negociações
              <small>Propostas, contrapropostas e decisões</small>
            </span>
          </button>
        )}
        <button
          type="button"
          className={tab === "access" ? "partner-tab-active" : ""}
          onClick={() => selectTab("access")}
        >
          <b>{canViewNegotiations ? "04" : "03"}</b>
          <span>
            Acessos
            <small>Links protegidos por parceiro</small>
          </span>
        </button>
      </nav>

      {(notice || error) && (
        <section
          className={`partner-feedback ${error ? "partner-feedback-error" : ""}`}
          aria-live="polite"
        >
          <span>{error || notice}</span>
          <button
            type="button"
            onClick={() => {
              setNotice("");
              setError("");
            }}
            aria-label="Fechar mensagem"
          >
            ×
          </button>
        </section>
      )}

      {tab === "landowners" && (
        <LandownerPublicationPanel
          data={data}
          canPublish={canPublishLandowners}
        />
      )}

      {tab === "payments" && (
        <section className="partner-module partner-payments">
          <div className="partner-kpis">
            <article>
              <small>A comunicar</small>
              <strong>{paymentKpis.unpublished}</strong>
              <span>Títulos ainda não publicados</span>
            </article>
            <article>
              <small>Previsões</small>
              <strong>{paymentKpis.forecast}</strong>
              <span>Janelas comunicadas</span>
            </article>
            <article>
              <small>Programados</small>
              <strong>{paymentKpis.scheduled}</strong>
              <span>Datas aprovadas e publicadas</span>
            </article>
            <article>
              <small>Em processamento</small>
              <strong>{paymentKpis.processing}</strong>
              <span>Ordens encaminhadas</span>
            </article>
          </div>

          <div className="partner-toolbar">
            <label>
              <span>Buscar</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Fornecedor, título, documento ou empreendimento"
              />
            </label>
            <label>
              <span>Situação comunicada</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="todos">Todas</option>
                <option value="nao_publicado">Ainda não publicado</option>
                {Object.entries(publicStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="partner-payment-list">
            {filteredPayables.map((entry) => {
              const publication = publicationsByEntry.get(entry.id);
              const contact = contactsById.get(entry.contact_id || "");
              const project = projectsById.get(entry.project_id || "");
              const canonicalScheduledDate = scheduledPaymentDate(entry);
              const effectiveScheduledDate =
                canonicalScheduledDate || publication?.scheduled_date || null;
              return (
                <article
                  key={entry.id}
                  className={
                    publication?.visible === false
                      ? "partner-payment-hidden"
                      : ""
                  }
                >
                  <div className="partner-payment-main">
                    <span
                      className={`partner-status partner-status-${
                        publication?.public_status || "unpublished"
                      }`}
                    >
                      {publication
                        ? publicStatusLabels[publication.public_status]
                        : "Não publicado"}
                    </span>
                    <strong>{entry.description}</strong>
                    <small>
                      {partnerName(contact)} · {project?.name || "Corporativo"}
                    </small>
                    {!entry.contact_id && (
                      <em>Vincule um fornecedor antes de publicar.</em>
                    )}
                  </div>
                  <div className="partner-payment-contractual">
                    <small>Emissão e vencimento contratual</small>
                    <strong>
                      {entry.issue_date
                        ? safeDate(entry.issue_date)
                        : "Emissão não informada"}
                    </strong>
                    <span>Vence em {safeDate(entry.due_date)}</span>
                  </div>
                  <div className="partner-payment-scheduled">
                    <small>Programação efetiva</small>
                    <strong>
                      {effectiveScheduledDate
                        ? safeDate(effectiveScheduledDate)
                        : entry.status === "pago"
                          ? "Não registrada"
                          : "Ainda não programado"}
                    </strong>
                    <span>
                      {effectiveScheduledDate
                        ? canonicalScheduledDate
                          ? "Data registrada no lançamento"
                          : "Programação publicada; sincronização confirmada"
                        : "Nenhuma data foi definida"}
                    </span>
                  </div>
                  <div className="partner-payment-public">
                    <small>Informação ao parceiro</small>
                    <strong>{publicTiming(publication)}</strong>
                    <span>
                      {publication
                        ? `Atualizada em ${safeDateTime(publication.updated_at)}`
                        : "Nenhuma promessa externa foi criada"}
                    </span>
                  </div>
                  <div className="partner-payment-value">
                    <strong>{money.format(Number(entry.amount || 0))}</strong>
                    <small>
                      {entry.installment_total > 1
                        ? `${entry.installment_number}/${entry.installment_total}`
                        : "Parcela única"}
                    </small>
                  </div>
                  {(canPublishPayments || canProcessPayments) && (
                    <button
                      className="partner-button partner-button-primary"
                      type="button"
                      disabled={!entry.contact_id}
                      onClick={() => openPublication(entry)}
                    >
                      {publication
                        ? "Atualizar comunicação"
                        : "Publicar informação"}
                    </button>
                  )}
                  {publication?.public_note && (
                    <p className="partner-payment-note">
                      <b>Mensagem publicada:</b> {publication.public_note}
                    </p>
                  )}
                </article>
              );
            })}
            {!loading && filteredPayables.length === 0 && (
              <div className="partner-empty">
                <b>▤</b>
                <strong>Nenhum pagamento encontrado</strong>
                <p>Revise os filtros ou cadastre títulos no Financeiro.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {tab === "negotiations" && canViewNegotiations && (
        <section className="partner-module partner-negotiations">
          <div className="partner-kpis">
            <article>
              <small>Novas</small>
              <strong>
                {
                  negotiations.filter(
                    (negotiation) => negotiation.status === "aberta",
                  ).length
                }
              </strong>
              <span>Aguardando primeira análise</span>
            </article>
            <article>
              <small>Em tratativa</small>
              <strong>
                {
                  negotiations.filter((negotiation) =>
                    [
                      "em_analise",
                      "contraproposta",
                      "aguardando_parceiro",
                      "aceita_pelo_parceiro",
                    ].includes(negotiation.status),
                  ).length
                }
              </strong>
              <span>Conversas em andamento</span>
            </article>
            <article>
              <small>Aguardando parceiro</small>
              <strong>
                {
                  negotiations.filter(
                    (negotiation) =>
                      negotiation.status === "aguardando_parceiro",
                  ).length
                }
              </strong>
              <span>Contrapropostas enviadas</span>
            </article>
            <article>
              <small>Para decisão</small>
              <strong>
                {
                  negotiations.filter(
                    (negotiation) =>
                      negotiation.status === "aceita_pelo_parceiro",
                  ).length
                }
              </strong>
              <span>Exigem alçada interna</span>
            </article>
          </div>

          <div className="partner-toolbar">
            <label>
              <span>Buscar negociação</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Parceiro, assunto ou título"
              />
            </label>
            <label>
              <span>Situação</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="todos">Todas</option>
                {Object.entries(negotiationStatusLabels).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>

          <div className="partner-negotiation-layout">
            <div className="partner-negotiation-list">
              {filteredNegotiations.map((negotiation) => {
                const contact = contactsById.get(negotiation.contact_id);
                const entry = entriesById.get(
                  negotiation.financial_entry_id || "",
                );
                return (
                  <button
                    type="button"
                    key={negotiation.id}
                    className={
                      selectedNegotiationId === negotiation.id
                        ? "partner-negotiation-active"
                        : ""
                    }
                    onClick={() => selectNegotiation(negotiation)}
                  >
                    <span
                      className={`partner-status partner-negotiation-status-${negotiation.status}`}
                    >
                      {negotiationStatusLabels[negotiation.status]}
                    </span>
                    <strong>{negotiation.subject}</strong>
                    <small>
                      {partnerName(contact)} ·{" "}
                      {negotiationTypeLabels[negotiation.negotiation_type] ||
                        negotiation.negotiation_type}
                    </small>
                    <span>{entry?.description || "Negociação geral"}</span>
                    <em>{safeDateTime(negotiation.updated_at)}</em>
                  </button>
                );
              })}
              {!loading && filteredNegotiations.length === 0 && (
                <div className="partner-empty">
                  <b>↔</b>
                  <strong>Nenhuma negociação encontrada</strong>
                  <p>Novas solicitações do portal aparecerão nesta fila.</p>
                </div>
              )}
            </div>

            <aside className="partner-negotiation-detail">
              {selectedNegotiation ? (
                <>
                  <header>
                    <div>
                      <small>HISTÓRICO DA NEGOCIAÇÃO</small>
                      <h3>{selectedNegotiation.subject}</h3>
                      <p>
                        {partnerName(
                          contactsById.get(selectedNegotiation.contact_id),
                        )}{" "}
                        · versão {selectedNegotiation.terms_version}
                      </p>
                    </div>
                    <span
                      className={`partner-status partner-negotiation-status-${selectedNegotiation.status}`}
                    >
                      {negotiationStatusLabels[selectedNegotiation.status]}
                    </span>
                  </header>

                  <section className="partner-current-terms">
                    <small>CONDIÇÕES EM ANÁLISE</small>
                    <strong>
                      {termsSummary(selectedNegotiation.current_terms)}
                    </strong>
                    <span>
                      O aceite interno não substitui termo, aditivo ou
                      formalização contratual.
                    </span>
                  </section>

                  <div className="partner-message-thread">
                    {selectedMessages.map((message) => (
                      <article
                        key={message.id}
                        data-sender={message.sender_kind}
                      >
                        <header>
                          <strong>
                            {message.sender_name ||
                              (message.sender_kind === "parceiro"
                                ? "Parceiro"
                                : "Equipe Évora")}
                          </strong>
                          <span>{safeDateTime(message.created_at)}</span>
                        </header>
                        <p>{message.body}</p>
                        {Object.keys(message.terms_snapshot || {}).length >
                          0 && (
                          <small>
                            {termsSummary(message.terms_snapshot)}
                          </small>
                        )}
                      </article>
                    ))}
                    {!selectedMessages.length && (
                      <p className="partner-thread-empty">
                        O histórico ainda não possui mensagens.
                      </p>
                    )}
                  </div>

                  {!terminalNegotiationStatuses.has(
                    selectedNegotiation.status,
                  ) &&
                    canManageNegotiations && (
                      <form
                        className="partner-reply-form"
                        onSubmit={replyNegotiation}
                      >
                        <h4>Responder ao parceiro</h4>
                        <label>
                          <span>Próxima situação</span>
                          <select
                            value={replyForm.nextStatus}
                            onChange={(event) =>
                              setReplyForm((current) => ({
                                ...current,
                                nextStatus: event.target
                                  .value as ReplyForm["nextStatus"],
                              }))
                            }
                          >
                            <option value="em_analise">
                              Manter em análise
                            </option>
                            <option value="contraproposta">
                              Enviar contraproposta
                            </option>
                            <option value="aguardando_parceiro">
                              Aguardar parceiro
                            </option>
                            <option value="encerrada">Encerrar conversa</option>
                          </select>
                        </label>
                        {replyForm.nextStatus === "contraproposta" && (
                          <div className="partner-counterproposal-fields">
                            <label>
                              <span>Nova data</span>
                              <input
                                type="date"
                                value={replyForm.proposedDueDate}
                                onChange={(event) =>
                                  setReplyForm((current) => ({
                                    ...current,
                                    proposedDueDate: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Parcelas</span>
                              <input
                                type="number"
                                min="1"
                                max="120"
                                value={replyForm.proposedInstallments}
                                onChange={(event) =>
                                  setReplyForm((current) => ({
                                    ...current,
                                    proposedInstallments: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Desconto (%)</span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={replyForm.proposedDiscountPct}
                                onChange={(event) =>
                                  setReplyForm((current) => ({
                                    ...current,
                                    proposedDiscountPct: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Valor proposto</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={replyForm.proposedAmount}
                                onChange={(event) =>
                                  setReplyForm((current) => ({
                                    ...current,
                                    proposedAmount: event.target.value,
                                  }))
                                }
                              />
                            </label>
                          </div>
                        )}
                        <label>
                          <span>Mensagem</span>
                          <textarea
                            rows={4}
                            required
                            maxLength={4000}
                            value={replyForm.message}
                            onChange={(event) =>
                              setReplyForm((current) => ({
                                ...current,
                                message: event.target.value,
                              }))
                            }
                            placeholder="Explique as condições e os próximos passos."
                          />
                        </label>
                        <button
                          className="partner-button partner-button-primary"
                          disabled={busy}
                        >
                          {busy ? "Registrando..." : "Registrar resposta"}
                        </button>
                      </form>
                    )}

                  {!terminalNegotiationStatuses.has(
                    selectedNegotiation.status,
                  ) &&
                    canApproveNegotiations && (
                      <form
                        className="partner-decision-form"
                        onSubmit={decideNegotiation}
                      >
                        <h4>Decisão por alçada</h4>
                        <label>
                          <span>Decisão</span>
                          <select
                            value={decision}
                            onChange={(event) =>
                              setDecision(
                                event.target.value as
                                  | "aprovada"
                                  | "rejeitada",
                              )
                            }
                          >
                            <option value="aprovada">
                              Aprovar para formalização
                            </option>
                            <option value="rejeitada">
                              Rejeitar condições
                            </option>
                          </select>
                        </label>
                        <label>
                          <span>Fundamentação</span>
                          <textarea
                            rows={3}
                            required
                            minLength={3}
                            maxLength={2000}
                            value={decisionNotes}
                            onChange={(event) =>
                              setDecisionNotes(event.target.value)
                            }
                          />
                        </label>
                        <button
                          className={`partner-button ${
                            decision === "aprovada"
                              ? "partner-button-primary"
                              : "partner-button-danger"
                          }`}
                          disabled={busy}
                        >
                          {busy
                            ? "Registrando..."
                            : decision === "aprovada"
                              ? "Aprovar negociação"
                              : "Rejeitar negociação"}
                        </button>
                      </form>
                    )}
                </>
              ) : (
                <div className="partner-empty">
                  <b>↔</b>
                  <strong>Selecione uma negociação</strong>
                  <p>
                    O histórico, as condições e as decisões aparecerão aqui.
                  </p>
                </div>
              )}
            </aside>
          </div>
        </section>
      )}

      {tab === "access" && (
        <section className="partner-module partner-access">
          <div className="partner-kpis">
            <article>
              <small>Acessos ativos</small>
              <strong>{links.filter((link) => link.active).length}</strong>
              <span>Links válidos atualmente</span>
            </article>
            <article>
              <small>Acessos registrados</small>
              <strong>
                {links.reduce(
                  (total, link) => total + Number(link.access_count || 0),
                  0,
                )}
              </strong>
              <span>Consultas autenticadas</span>
            </article>
            <article>
              <small>Expiram em 15 dias</small>
              <strong>
                {
                  links.filter((link) => {
                    if (!link.active) return false;
                    const days =
                      (new Date(link.expires_at).getTime() - referenceTime) /
                      86400000;
                    return days >= 0 && days <= 15;
                  }).length
                }
              </strong>
              <span>Requerem renovação</span>
            </article>
            <article>
              <small>Revogados</small>
              <strong>{links.filter((link) => !link.active).length}</strong>
              <span>Histórico preservado</span>
            </article>
          </div>

          {canManageAccess && (
            <form className="partner-access-form" onSubmit={createLink}>
              <header>
                <div>
                  <small>NOVO ACESSO PROTEGIDO</small>
                  <h3>Gerar link para o parceiro</h3>
                  <p>
                    O parceiro confirmará os quatro últimos dígitos do CPF ou
                    CNPJ antes de consultar os pagamentos.
                  </p>
                </div>
              </header>
              <div className="partner-access-fields">
                <label className="partner-access-partner">
                  <span>Parceiro</span>
                  <select
                    value={linkContactId}
                    onChange={(event) => {
                      const contactId = event.target.value;
                      setLinkContactId(contactId);
                      setLinkDocument(
                        contactsById.get(contactId)?.document || "",
                      );
                      setError("");
                    }}
                    required
                  >
                    <option value="">Selecione</option>
                    {partnerContacts
                      .filter(
                        (contact) =>
                          linkKind !== "terrenista" ||
                          contact.contact_type === "terrenista",
                      )
                      .map((contact) => (
                        <option key={contact.id} value={contact.id}>
                          {partnerName(contact)}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="partner-access-kind">
                  <span>Categoria</span>
                  <select
                    value={linkKind}
                    onChange={(event) => {
                      setLinkKind(event.target.value as PartnerKind);
                      setLinkContactId("");
                      setLinkDocument("");
                      setError("");
                    }}
                  >
                    {Object.entries(partnerKindLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="partner-access-document">
                  <span>CPF / CNPJ para validação</span>
                  <input
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={18}
                    value={linkDocument}
                    onChange={(event) => setLinkDocument(event.target.value)}
                    placeholder="11 dígitos para CPF ou 14 para CNPJ"
                    aria-describedby="partner-access-document-help"
                    required
                  />
                  <small
                    id="partner-access-document-help"
                    className={
                      linkContactId && !selectedContactHasDocument
                        ? "partner-field-warning"
                        : undefined
                    }
                  >
                    {!linkContactId
                      ? "Selecione o parceiro para verificar o cadastro."
                      : !selectedContactHasDocument
                        ? "Documento ausente. Preencha aqui; ele será salvo no cadastro ao gerar o acesso."
                        : "Usado somente para confirmar os quatro últimos dígitos no portal."}
                  </small>
                </label>
                <label className="partner-access-label">
                  <span>Identificação do acesso</span>
                  <input
                    value={linkLabel}
                    onChange={(event) => setLinkLabel(event.target.value)}
                    placeholder="Ex.: Financeiro do fornecedor"
                  />
                </label>
                <label className="partner-access-expiry">
                  <span>Validade</span>
                  <input
                    type="date"
                    min={futureDate(1)}
                    max={futureDate(365)}
                    value={linkExpiresAt}
                    onChange={(event) => setLinkExpiresAt(event.target.value)}
                    required
                  />
                </label>
                <button
                  className="partner-button partner-button-primary"
                  disabled={busy || !linkContactId || !linkDocumentReady}
                >
                  {busy ? "Gerando..." : "Gerar acesso"}
                </button>
              </div>
            </form>
          )}

          {generatedLink && (
            <section className="partner-generated-link">
              <div>
                <small>LINK GERADO · EXIBIÇÃO ÚNICA</small>
                <strong>{generatedLink}</strong>
                <span>
                  Guarde ou encaminhe este endereço agora. Depois, somente um
                  novo link poderá ser gerado.
                </span>
              </div>
              <button
                className="partner-button partner-button-primary"
                type="button"
                onClick={() => void navigator.clipboard.writeText(generatedLink)}
              >
                Copiar link
              </button>
            </section>
          )}

          <div className="partner-toolbar">
            <label>
              <span>Buscar acesso</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Parceiro, identificação ou final do token"
              />
            </label>
            <label>
              <span>Situação</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="todos">Todos</option>
                <option value="ativo">Ativos</option>
                <option value="revogado">Revogados</option>
              </select>
            </label>
          </div>

          <div className="partner-access-list">
            {filteredLinks.map((link) => {
              const contact = contactsById.get(link.contact_id);
              const expired =
                new Date(link.expires_at).getTime() < referenceTime;
              return (
                <article key={link.id}>
                  <div className="partner-access-identity">
                    <span
                      className={`partner-status ${
                        link.active && !expired
                          ? "partner-status-active"
                          : "partner-status-inactive"
                      }`}
                    >
                      {link.active && !expired
                        ? "Ativo"
                        : expired
                          ? "Expirado"
                          : "Revogado"}
                    </span>
                    <strong>{partnerName(contact)}</strong>
                    <small>
                      {partnerKindLabels[link.partner_kind]} ·{" "}
                      {link.label || "Acesso principal"}
                    </small>
                  </div>
                  <div>
                    <small>Validade</small>
                    <strong>{safeDateTime(link.expires_at)}</strong>
                    <span>Token final •••{link.token_hint}</span>
                  </div>
                  <div>
                    <small>Uso do acesso</small>
                    <strong>{link.access_count} acesso(s)</strong>
                    <span>Último: {safeDateTime(link.last_access_at)}</span>
                  </div>
                  {link.locked_until &&
                    new Date(link.locked_until).getTime() > referenceTime && (
                      <p className="partner-access-warning">
                        Acesso temporariamente bloqueado após tentativas
                        inválidas.
                      </p>
                    )}
                  {link.active && canManageAccess && (
                    <button
                      className="partner-button partner-button-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void revokeLink(link)}
                    >
                      Revogar acesso
                    </button>
                  )}
                </article>
              );
            })}
            {!loading && filteredLinks.length === 0 && (
              <div className="partner-empty">
                <b>↗</b>
                <strong>Nenhum acesso encontrado</strong>
                <p>Gere um link protegido para iniciar o relacionamento.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {paymentEntryId && paymentEntry && (
        <div
          className="partner-modal-backdrop"
          role="presentation"
          onMouseDown={() => setPaymentEntryId(null)}
        >
          <form
            className="partner-modal partner-publication-modal"
            onSubmit={submitPublication}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>COMUNICAÇÃO EXTERNA CONTROLADA</small>
                <h3>Publicar andamento do pagamento</h3>
                <p>
                  {paymentEntry.description} ·{" "}
                  {partnerName(
                    contactsById.get(paymentEntry.contact_id || ""),
                  )}
                </p>
              </div>
              <button
                type="button"
                className="partner-modal-close"
                onClick={() => setPaymentEntryId(null)}
                aria-label="Fechar"
              >
                ×
              </button>
            </header>
            <section className="partner-publication-summary">
              <span>
                <small>Valor</small>
                <strong>
                  {money.format(Number(paymentEntry.amount || 0))}
                </strong>
              </span>
              <span>
                <small>Emissão</small>
                <strong>
                  {paymentEntry.issue_date
                    ? safeDate(paymentEntry.issue_date)
                    : "Não informada"}
                </strong>
              </span>
              <span>
                <small>Vencimento contratual</small>
                <strong>{safeDate(paymentEntry.due_date)}</strong>
              </span>
              <span>
                <small>Programação efetiva atual</small>
                <strong>
                  {paymentEntryScheduledDate
                    ? safeDate(paymentEntryScheduledDate)
                    : paymentEntry.status === "pago"
                      ? "Não registrada"
                      : "Ainda não programado"}
                </strong>
              </span>
            </section>
            <label>
              <span>Situação que será mostrada ao parceiro</span>
              <select
                value={publicationForm.publicStatus}
                onChange={(event) =>
                  setPublicationForm((current) => ({
                    ...current,
                    publicStatus: event.target.value as PublicStatus,
                  }))
                }
              >
                {canPublishPayments && (
                  <>
                    <option value="em_analise">Em análise</option>
                    <option value="previsto">
                      Previsão — janela estimada
                    </option>
                    <option
                      value="programado"
                      disabled={!paymentEntryCanSchedule}
                    >
                      Programado — data efetiva registrada
                    </option>
                    <option value="suspenso">Suspender comunicação</option>
                  </>
                )}
                {canProcessPayments && (
                  <>
                    <option
                      value="em_processamento"
                      disabled={!paymentEntryCanSchedule}
                    >
                      Em processamento
                    </option>
                    <option
                      value="pago"
                      disabled={paymentEntry.status !== "pago"}
                    >
                      Pago — baixa confirmada
                    </option>
                  </>
                )}
              </select>
            </label>
            {publicationForm.publicStatus === "previsto" && (
              <div className="partner-publication-dates">
                <label>
                  <span>Início da previsão</span>
                  <input
                    type="date"
                    value={publicationForm.forecastStart}
                    onChange={(event) =>
                      setPublicationForm((current) => ({
                        ...current,
                        forecastStart: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  <span>Final da previsão</span>
                  <input
                    type="date"
                    value={publicationForm.forecastEnd}
                    onChange={(event) =>
                      setPublicationForm((current) => ({
                        ...current,
                        forecastEnd: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
              </div>
            )}
            {["programado", "em_processamento"].includes(
              publicationForm.publicStatus,
            ) && (
              <label>
                <span>
                  {publicationForm.publicStatus === "programado"
                    ? "Data efetiva da programação"
                    : "Data programada em processamento"}
                </span>
                <input
                  type="date"
                  value={publicationForm.scheduledDate}
                  onChange={(event) =>
                    setPublicationForm((current) => ({
                      ...current,
                      scheduledDate: event.target.value,
                    }))
                  }
                  required
                />
              </label>
            )}
            <label>
              <span>Mensagem pública</span>
              <textarea
                rows={4}
                maxLength={1200}
                value={publicationForm.publicNote}
                onChange={(event) =>
                  setPublicationForm((current) => ({
                    ...current,
                    publicNote: event.target.value,
                  }))
                }
                placeholder="Explique a situação e os próximos passos sem mencionar dados internos de caixa."
              />
            </label>
            <label className="partner-check">
              <input
                type="checkbox"
                checked={publicationForm.visible}
                onChange={(event) =>
                  setPublicationForm((current) => ({
                    ...current,
                    visible: event.target.checked,
                  }))
                }
              />
              <span>Exibir este título no portal do parceiro</span>
            </label>
            <aside className="partner-publication-warning">
              <b>!</b>
              <p>
                “Previsão” é apenas uma estimativa. “Programado” registra a
                data efetiva da programação atual, mas não confirma a
                liquidação. Somente “Pago” indica pagamento concluído. O
                portal não exibirá fluxo de caixa, risco ou justificativas
                internas.
              </p>
            </aside>
            <footer>
              <button
                className="partner-button partner-button-secondary"
                type="button"
                onClick={() => setPaymentEntryId(null)}
              >
                Cancelar
              </button>
              <button
                className="partner-button partner-button-primary"
                disabled={busy}
              >
                {busy ? "Publicando..." : "Confirmar publicação"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

export default PartnerManagementView;
