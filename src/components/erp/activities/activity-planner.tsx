"use client";

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Organization, Profile, Project } from "../types";
import {
  loadOperationalSignals,
  signalAreaMeta,
  type OperationalFeed,
  type OperationalSignal,
  type SignalArea,
} from "./activity-intelligence";

type Ctx = {
  organization: Organization;
  membership: Membership;
  profile: Profile | null;
  projects: Project[];
  members: Membership[];
  profiles: Profile[];
  session: { user: { id: string } };
};

type ChecklistItem = { label: string; done: boolean };

type Activity = {
  id: string;
  organization_id: string;
  owner_user_id: string;
  assigned_by: string;
  updated_by: string | null;
  title: string;
  description: string | null;
  activity_type: string;
  status: string;
  board_status: string;
  priority: string;
  starts_at: string | null;
  due_at: string | null;
  completed_at: string | null;
  project_id: string | null;
  checklist: ChecklistItem[];
  tags: string[];
  estimated_minutes: number | null;
  progress_percent: number;
  progress_note: string | null;
  last_progress_at: string | null;
  related_type: string | null;
  related_id: string | null;
  created_at: string;
  updated_at: string;
};

type Notification = {
  id: string;
  activity_id: string | null;
  notification_type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  actor_user_id: string | null;
};

type Mode = "command" | "board" | "list" | "notifications";
type Horizon = "all" | "late" | "today" | "week" | "month" | "undated";

const columns = [
  { id: "backlog", label: "Planejadas" },
  { id: "em_andamento", label: "Em andamento" },
  { id: "aguardando", label: "Aguardando" },
  { id: "concluida", label: "Concluídas" },
];

const areaOrder: SignalArea[] = [
  "financeiro",
  "aprovacoes",
  "compras",
  "obras",
  "crm",
  "combustiveis",
  "contratos",
  "rh",
  "posvenda",
  "marketing",
];

const initialFeed: OperationalFeed = {
  signals: [],
  availableSources: 0,
  totalSources: areaOrder.length,
  updatedAt: "",
};

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "Sem prazo";
}

function dayLabel(value: string | null) {
  return value ? new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "Sem data";
}

function matchesHorizon(value: string | null, horizon: Horizon, now: Date) {
  if (horizon === "all") return true;
  if (!value) return horizon === "undated";
  const time = new Date(value).getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;
  if (horizon === "late") return time < now.getTime();
  if (horizon === "today") return time >= dayStart && time < dayEnd;
  if (horizon === "week") return time >= now.getTime() && time <= now.getTime() + 7 * 86_400_000;
  if (horizon === "month") return time >= now.getTime() && time <= now.getTime() + 30 * 86_400_000;
  return false;
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function ActivityPlanner({ context }: { context: Ctx }) {
  const [items, setItems] = useState<Activity[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [feed, setFeed] = useState<OperationalFeed>(initialFeed);
  const [mode, setMode] = useState<Mode>("command");
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("todos");
  const [ownerFilter, setOwnerFilter] = useState("todos");
  const [horizon, setHorizon] = useState<Horizon>("all");
  const [progressTarget, setProgressTarget] = useState<Activity | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressNote, setProgressNote] = useState("");

  const role = String(context.membership.role || "").toLowerCase();
  const canAssign = ["admin", "administrador", "diretoria", "diretor"].includes(role);
  const currentUser = context.session.user.id;
  const organizationId = context.organization.id;

  const memberName = useCallback((id: string | null | undefined) =>
    context.profiles.find(profile => profile.id === id)?.full_name
    || context.profiles.find(profile => profile.id === id)?.email
    || "Usuário", [context.profiles]);

  const projectName = useCallback((id: string | null | undefined) =>
    context.projects.find(project => project.id === id)?.name || "Corporativo", [context.projects]);

  const canEdit = useCallback((item: Activity) =>
    canAssign || item.owner_user_id === currentUser, [canAssign, currentUser]);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    setLoading(true);
    await supabase.rpc("generate_my_overdue_activity_notifications", { p_organization_id: organizationId });
    const [activitiesResult, notificationsResult, operationalFeed] = await Promise.all([
      supabase
        .from("user_activities")
        .select("*")
        .eq("organization_id", organizationId)
        .order("position")
        .order("due_at", { ascending: true }),
      supabase
        .from("activity_notifications")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("recipient_user_id", currentUser)
        .order("created_at", { ascending: false })
        .limit(100),
      loadOperationalSignals(organizationId),
    ]);
    if (activitiesResult.error) setMessage(activitiesResult.error.message);
    else setItems((activitiesResult.data || []) as Activity[]);
    if (notificationsResult.error) setMessage(notificationsResult.error.message);
    else setNotifications((notificationsResult.data || []) as Notification[]);
    setFeed(operationalFeed);
    setLoading(false);
  }, [currentUser, organizationId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const now = new Date();
  const unread = notifications.filter(item => !item.read_at).length;
  const openItems = items.filter(item => item.board_status !== "concluida");
  const myItems = items.filter(item => item.owner_user_id === currentUser);
  const overdueItems = openItems.filter(item => item.due_at && new Date(item.due_at) < now);
  const blockedItems = openItems.filter(item => item.board_status === "aguardando");
  const dueSoon = openItems.filter(item => item.due_at && matchesHorizon(item.due_at, "week", now));
  const criticalSignals = feed.signals.filter(item => item.severity === "critical");

  const filteredItems = useMemo(() => {
    const query = normalize(search.trim());
    return items.filter(item => {
      const searchable = normalize(`${item.title} ${item.description || ""} ${(item.tags || []).join(" ")}`);
      return (!query || searchable.includes(query))
        && (projectFilter === "todos" || item.project_id === projectFilter)
        && (ownerFilter === "todos" || item.owner_user_id === ownerFilter)
        && (horizon !== "late" || item.board_status !== "concluida")
        && matchesHorizon(item.due_at, horizon, new Date());
    });
  }, [horizon, items, ownerFilter, projectFilter, search]);

  const filteredSignals = useMemo(() => {
    const query = normalize(search.trim());
    return feed.signals.filter(item => {
      const searchable = normalize(`${item.title} ${item.detail} ${item.recommendation} ${signalAreaMeta[item.area].label}`);
      return (!query || searchable.includes(query))
        && (projectFilter === "todos" || item.projectId === projectFilter)
        && (ownerFilter === "todos" || item.ownerUserId === ownerFilter)
        && matchesHorizon(item.dueAt, horizon, new Date());
    });
  }, [feed.signals, horizon, ownerFilter, projectFilter, search]);

  const capacity = context.members
    .map(member => {
      const memberItems = openItems.filter(item => item.owner_user_id === member.user_id);
      const estimated = memberItems.reduce((sum, item) => sum + Number(item.estimated_minutes || 0), 0);
      return {
        id: member.user_id,
        name: memberName(member.user_id),
        count: memberItems.length,
        estimated,
        unestimated: memberItems.filter(item => !item.estimated_minutes).length,
        load: Math.min(100, Math.round(estimated / 2400 * 100)),
      };
    })
    .filter(item => item.count)
    .sort((a, b) => b.estimated - a.estimated || b.count - a.count)
    .slice(0, 7);

  const areaRadar = areaOrder.map(area => {
    const signals = feed.signals.filter(item => item.area === area);
    const taggedTasks = openItems.filter(item => item.tags?.includes(area));
    return {
      area,
      count: signals.length + taggedTasks.length,
      critical: signals.filter(item => item.severity === "critical").length,
    };
  });

  const decisionCount = criticalSignals.length + overdueItems.length + blockedItems.length;
  const averageProgress = openItems.length
    ? openItems.reduce((sum, item) => sum + Number(item.progress_percent || 0), 0) / openItems.length
    : items.length ? 100 : 0;
  const executionIndex = items.length || feed.signals.length || unread
    ? Math.max(0, Math.min(100, Math.round(
        50 + averageProgress * 0.5
        - overdueItems.length * 6
        - blockedItems.length * 4
        - criticalSignals.length * 3
        - Math.min(8, unread)
      )))
    : null;
  const executionTone = executionIndex === null ? "neutral" : executionIndex < 45 ? "critical" : executionIndex < 70 ? "attention" : "stable";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const supabase = getSupabase();
    if (!supabase) return;
    const owner = canAssign ? String(form.get("owner_user_id") || currentUser) : currentUser;
    const checklist = String(form.get("checklist") || "")
      .split("\n")
      .map(value => value.trim())
      .filter(Boolean)
      .map(label => ({ label, done: false }));
    const tags = String(form.get("tags") || "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    const result = await supabase.from("user_activities").insert({
      organization_id: organizationId,
      owner_user_id: owner,
      assigned_by: currentUser,
      updated_by: currentUser,
      title: form.get("title"),
      description: form.get("description") || null,
      activity_type: form.get("activity_type"),
      status: "pendente",
      board_status: "backlog",
      priority: form.get("priority"),
      starts_at: form.get("starts_at") || null,
      due_at: form.get("due_at") || null,
      project_id: form.get("project_id") || null,
      estimated_minutes: Number(form.get("estimated_minutes") || 0) || null,
      checklist,
      tags,
      progress_percent: 0,
    });
    if (result.error) setMessage(result.error.message);
    else {
      setShow(false);
      await load();
    }
  }

  async function createFromSignal(signal: OperationalSignal) {
    const existing = items.find(item => item.related_type === signal.sourceType && item.related_id === signal.sourceId);
    if (existing) {
      setMessage(`Este sinal já está acompanhado pela atividade “${existing.title}”.`);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    const eligibleOwner = context.members.some(member => member.user_id === signal.ownerUserId)
      ? signal.ownerUserId
      : currentUser;
    const result = await supabase.from("user_activities").insert({
      organization_id: organizationId,
      owner_user_id: canAssign ? eligibleOwner : currentUser,
      assigned_by: currentUser,
      updated_by: currentUser,
      title: signal.title,
      description: `${signal.detail}\n\nAção recomendada: ${signal.recommendation}`,
      activity_type: "tarefa",
      status: "pendente",
      board_status: "backlog",
      priority: signal.severity === "critical" ? "urgente" : "alta",
      due_at: signal.dueAt,
      project_id: signal.projectId,
      estimated_minutes: 30,
      checklist: [{ label: "Analisar causa e impacto", done: false }, { label: "Registrar decisão e responsável", done: false }],
      tags: [signal.area, "gerada-automaticamente"],
      progress_percent: 0,
      related_type: signal.sourceType,
      related_id: signal.sourceId,
    });
    if (result.error) setMessage(result.error.message);
    else {
      setMessage("Sinal convertido em atividade com vínculo à origem.");
      await load();
    }
  }

  async function move(item: Activity, status: string) {
    if (!canEdit(item)) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const concluded = status === "concluida";
    const result = await supabase.from("user_activities").update({
      board_status: status,
      status: concluded ? "concluida" : "pendente",
      progress_percent: concluded ? 100 : item.progress_percent,
      completed_at: concluded ? new Date().toISOString() : null,
      updated_by: currentUser,
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (result.error) setMessage(result.error.message);
    else await load();
  }

  function openProgress(item: Activity) {
    setProgressTarget(item);
    setProgressPercent(item.progress_percent || 0);
    setProgressNote(item.progress_note || "");
  }

  async function saveProgress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!progressTarget || !canEdit(progressTarget)) return;
    const percent = Math.max(0, Math.min(100, Number(progressPercent)));
    const supabase = getSupabase();
    if (!supabase) return;
    const completed = percent === 100;
    const result = await supabase.from("user_activities").update({
      progress_percent: percent,
      progress_note: progressNote.trim() || null,
      last_progress_at: new Date().toISOString(),
      updated_by: currentUser,
      board_status: completed ? "concluida" : progressTarget.board_status,
      status: completed ? "concluida" : "pendente",
      completed_at: completed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("id", progressTarget.id);
    if (result.error) setMessage(result.error.message);
    else {
      setProgressTarget(null);
      await load();
    }
  }

  async function markRead(id: string) {
    const supabase = getSupabase();
    if (!supabase) return;
    const readAt = new Date().toISOString();
    const result = await supabase.from("activity_notifications").update({ read_at: readAt }).eq("id", id);
    if (!result.error) setNotifications(current => current.map(item => item.id === id ? { ...item, read_at: readAt } : item));
  }

  async function markAllRead() {
    const supabase = getSupabase();
    if (!supabase) return;
    const readAt = new Date().toISOString();
    const result = await supabase
      .from("activity_notifications")
      .update({ read_at: readAt })
      .eq("recipient_user_id", currentUser)
      .is("read_at", null);
    if (!result.error) setNotifications(current => current.map(item => ({ ...item, read_at: item.read_at || readAt })));
  }

  const taskCard = (item: Activity) => {
    const isOverdue = item.due_at && new Date(item.due_at) < now && item.board_status !== "concluida";
    return <article className={`task-card ${isOverdue ? "overdue" : ""} ${item.board_status === "aguardando" ? "blocked" : ""}`} key={item.id}>
      <header>
        <i data-priority={item.priority}>{item.priority}</i>
        <time>{dateTime(item.due_at)}</time>
      </header>
      <h3>{item.title}</h3>
      <p>{item.description || "Sem descrição"}</p>
      <div className="task-progress"><i><b style={{ width: `${item.progress_percent || 0}%` }} /></i><span>{item.progress_percent || 0}%</span></div>
      {item.progress_note && <p className="task-progress-note">{item.progress_note}</p>}
      <div className="task-tags">{(item.tags || []).map(tag => <span key={tag}>{tag}</span>)}</div>
      <div className="task-context">
        <small>Responsável: {memberName(item.owner_user_id)}</small>
        <small>{projectName(item.project_id)}</small>
        {item.estimated_minutes ? <small>{item.estimated_minutes} min estimados</small> : <small>Sem estimativa</small>}
      </div>
      <footer>
        <span>{item.checklist?.filter(value => value.done).length || 0}/{item.checklist?.length || 0} itens</span>
        {canEdit(item) && <button type="button" onClick={() => openProgress(item)}>Atualizar</button>}
        <select aria-label={`Situação de ${item.title}`} value={item.board_status || "backlog"} disabled={!canEdit(item)} onChange={event => move(item, event.target.value)}>
          {columns.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}
        </select>
      </footer>
    </article>;
  };

  return <div className="agenda-shell agenda-v69">
    {message && <button className="notice agenda-notice" onClick={() => setMessage("")}>{message}<span>×</span></button>}

    <section className="decision-hero" data-tone={executionTone}>
      <div>
        <small>CENTRAL DE DECISÕES · DADOS INTEGRADOS</small>
        <h2>{loading
          ? "Atualizando o pulso da empresa…"
          : decisionCount
            ? `${decisionCount} assunto${decisionCount === 1 ? "" : "s"} exige${decisionCount === 1 ? "" : "m"} prioridade`
            : "Operação sem bloqueio crítico identificado"}</h2>
        <p>{loading
          ? "Consolidando prazos, riscos, atividades e sinais dos módulos autorizados."
          : decisionCount
            ? "A fila combina prazos, riscos, atividades e sinais dos módulos para orientar a próxima ação."
            : "Continue alimentando responsáveis, prazos e avanços para preservar uma leitura confiável."}</p>
        <div className="decision-hero-chips">
          <span><b>{feed.availableSources}/{feed.totalSources}</b> fontes conectadas</span>
          <span><b>{criticalSignals.length}</b> sinais críticos</span>
          <span><b>{unread}</b> notificações novas</span>
          <span><b>{openItems.length}</b> atividades abertas</span>
          {feed.updatedAt && <span><b>↻</b> {new Date(feed.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
      </div>
      <div className="execution-score" style={{ "--score": executionIndex || 0 } as CSSProperties}>
        <i><strong>{executionIndex === null ? "—" : executionIndex}</strong><span>/100</span></i>
        <small>Índice de execução</small>
        <b>{executionIndex === null ? "Base insuficiente" : executionTone === "critical" ? "Crítico" : executionTone === "attention" ? "Atenção" : "Controlado"}</b>
      </div>
    </section>

    <section className="agenda-command-bar">
      <nav aria-label="Visões da agenda">
        <button className={mode === "command" ? "active" : ""} onClick={() => setMode("command")}>Cockpit</button>
        <button className={mode === "board" ? "active" : ""} onClick={() => setMode("board")}>Quadro</button>
        <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>Lista</button>
        <button className={mode === "notifications" ? "active" : ""} onClick={() => setMode("notifications")}>Notificações {unread ? `(${unread})` : ""}</button>
      </nav>
      <div>
        <button type="button" className="agenda-refresh" onClick={() => load()} disabled={loading} aria-label="Atualizar cockpit">↻</button>
        <button type="button" className="primary" onClick={() => setShow(true)}>+ Nova atividade</button>
      </div>
    </section>

    <section className="agenda-kpis agenda-decision-kpis">
      <article className={criticalSignals.length ? "danger" : ""}><small>Decisões críticas</small><strong>{criticalSignals.length}</strong><span>geradas pela operação</span></article>
      <article className={overdueItems.length ? "danger" : ""}><small>Atividades atrasadas</small><strong>{overdueItems.length}</strong><span>exigem plano de ação</span></article>
      <article className={blockedItems.length ? "warning" : ""}><small>Dependências</small><strong>{blockedItems.length}</strong><span>itens aguardando desbloqueio</span></article>
      <article><small>Próximos 7 dias</small><strong>{dueSoon.length}</strong><span>compromissos planejados</span></article>
    </section>

    <section className="agenda-smart-filters" aria-label="Filtros do cockpit">
      <label className="agenda-search">Buscar<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Assunto, área, ação ou tag" /></label>
      <label>Empreendimento<select value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="todos">Todos</option>{context.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>Responsável<select value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)}><option value="todos">Todos</option>{context.members.map(member => <option key={member.user_id} value={member.user_id}>{memberName(member.user_id)}</option>)}</select></label>
      <label>Horizonte<select value={horizon} onChange={event => setHorizon(event.target.value as Horizon)}><option value="all">Todos os prazos</option><option value="late">Atrasados</option><option value="today">Hoje</option><option value="week">Próximos 7 dias</option><option value="month">Próximos 30 dias</option><option value="undated">Sem prazo</option></select></label>
    </section>

    {mode === "command" && <>
      <section className="decision-command-grid">
        <article className="decision-queue">
          <header>
            <div><small>FILA PRIORIZADA</small><h3>Decisões recomendadas</h3></div>
            <span>{filteredSignals.length} sinais no recorte</span>
          </header>
          <div>
            {filteredSignals.slice(0, 8).map(signal => {
              const linked = items.some(item => item.related_type === signal.sourceType && item.related_id === signal.sourceId);
              const meta = signalAreaMeta[signal.area];
              return <article key={signal.id} data-severity={signal.severity}>
                <b>{signal.score}</b>
                <i>{meta.icon}</i>
                <div>
                  <small>{meta.label} · {signal.sourceLabel}</small>
                  <h4>{signal.title}</h4>
                  <p>{signal.detail}</p>
                  <span><strong>Ação:</strong> {signal.recommendation}</span>
                  <footer>
                    <em>{dayLabel(signal.dueAt)}</em>
                    {signal.impact && <em>{signal.impact}</em>}
                    <em>{projectName(signal.projectId)}</em>
                  </footer>
                </div>
                <button type="button" disabled={linked} onClick={() => createFromSignal(signal)}>{linked ? "Em acompanhamento" : "Criar atividade"}</button>
              </article>;
            })}
            {!filteredSignals.length && <div className="decision-empty">
              <b>✓</b>
              <div><strong>Nenhum sinal operacional neste recorte</strong><p>Isso pode significar operação controlada ou ausência de dados. A cobertura atual é de {feed.availableSources} entre {feed.totalSources} fontes.</p></div>
            </div>}
          </div>
        </article>

        <article className="decision-timeline">
          <header><div><small>LINHA DO TEMPO</small><h3>Foco da equipe</h3></div><span>{filteredItems.length} atividades</span></header>
          <div>
            {filteredItems.filter(item => item.board_status !== "concluida").slice(0, 9).map(item => <button type="button" key={item.id} onClick={() => openProgress(item)}>
              <time data-late={Boolean(item.due_at && new Date(item.due_at) < now)}>{dayLabel(item.due_at)}</time>
              <span><strong>{item.title}</strong><small>{memberName(item.owner_user_id)} · {projectName(item.project_id)}</small></span>
              <i>{item.progress_percent || 0}%</i>
            </button>)}
            {!filteredItems.some(item => item.board_status !== "concluida") && <div className="decision-empty compact"><b>+</b><div><strong>Sem atividades abertas</strong><p>Converta um sinal da fila ou crie uma atividade planejada.</p></div></div>}
          </div>
          <footer><span>Minhas abertas</span><strong>{myItems.filter(item => item.board_status !== "concluida").length}</strong></footer>
        </article>
      </section>

      <section className="agenda-intelligence-grid">
        <article className="operation-radar">
          <header><div><small>RADAR EMPRESARIAL</small><h3>Pressão por área</h3></div><span>tarefas + sinais</span></header>
          <div>{areaRadar.map(item => {
            const meta = signalAreaMeta[item.area];
            return <article key={item.area} data-critical={item.critical > 0}>
              <i>{meta.icon}</i><span><strong>{meta.label}</strong><small>{item.critical ? `${item.critical} crítico(s)` : "Sem crítico"}</small></span><b>{item.count}</b>
            </article>;
          })}</div>
        </article>

        <article className="team-capacity">
          <header><div><small>CAPACIDADE</small><h3>Carga planejada da equipe</h3></div><span>referência de 40 h/semana</span></header>
          <div>{capacity.map(member => <article key={member.id}>
            <span><strong>{member.name}</strong><small>{member.count} atividade(s){member.unestimated ? ` · ${member.unestimated} sem estimativa` : ""}</small></span>
            <i><b style={{ width: `${member.load}%` }} /></i>
            <em>{member.estimated ? `${Math.round(member.estimated / 60)} h` : "—"}</em>
          </article>)}</div>
          {!capacity.length && <div className="decision-empty compact"><b>◇</b><div><strong>Capacidade ainda não mensurável</strong><p>Informe tempo estimado nas atividades para visualizar sobrecarga e ociosidade.</p></div></div>}
        </article>
      </section>
    </>}

    {mode === "board" && <section className="agenda-card agenda-board-card">
      <header><div><small>EXECUÇÃO COLABORATIVA</small><h2>Quadro de atividades</h2><p>Organize a execução depois de priorizar as decisões no cockpit.</p></div></header>
      <div className="task-board">{columns.map(column => {
        const columnItems = filteredItems.filter(item => (item.board_status || "backlog") === column.id);
        return <section key={column.id}><header><strong>{column.label}</strong><span>{columnItems.length}</span></header><div>{columnItems.map(taskCard)}{!columnItems.length && <p className="board-empty">Nenhuma atividade</p>}</div></section>;
      })}</div>
    </section>}

    {mode === "list" && <section className="agenda-card">
      <header><div><small>VISÃO ANALÍTICA</small><h2>Lista de atividades</h2><p>{filteredItems.length} registro(s) no recorte selecionado.</p></div></header>
      <div className="agenda-list">{filteredItems.map(taskCard)}{!filteredItems.length && <p className="empty-state">Nenhuma atividade encontrada.</p>}</div>
    </section>}

    {mode === "notifications" && <section className="agenda-card">
      <div className="activity-notifications">
        <header><div><strong>Central de notificações</strong><span>Designações, alterações, progresso, contratos e atrasos.</span></div>{unread > 0 && <button onClick={markAllRead}>Marcar todas como lidas</button>}</header>
        {notifications.map(notification => <article key={notification.id} className={notification.read_at ? "read" : "unread"} onClick={() => !notification.read_at && markRead(notification.id)}>
          <i data-type={notification.notification_type}>●</i>
          <div><strong>{notification.title}</strong><p>{notification.message}</p><small>{notification.actor_user_id ? `${memberName(notification.actor_user_id)} · ` : ""}{new Date(notification.created_at).toLocaleString("pt-BR")}</small></div>
          {!notification.read_at && <b>Nova</b>}
        </article>)}
        {!notifications.length && <p className="empty-state">Nenhuma notificação registrada.</p>}
      </div>
    </section>}

    {show && <div className="modal-backdrop" onMouseDown={() => setShow(false)}>
      <form className="modal" onSubmit={save} onMouseDown={event => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setShow(false)}>×</button>
        <header><small>NOVA ATIVIDADE</small><h2>Planejar e distribuir</h2></header>
        <div className="form-grid">
          <label className="span-2">Título<input name="title" required /></label>
          <label>Tipo<select name="activity_type"><option value="tarefa">Tarefa / decisão</option><option value="reuniao">Reunião</option><option value="ligacao">Ligação</option><option value="visita">Visita</option><option value="prazo">Prazo</option><option value="follow_up">Follow-up</option></select></label>
          <label>Prioridade<select name="priority"><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option></select></label>
          {canAssign && <label>Responsável<select name="owner_user_id" defaultValue={currentUser}>{context.members.map(member => <option key={member.user_id} value={member.user_id}>{memberName(member.user_id)}</option>)}</select></label>}
          <label>Empreendimento<select name="project_id"><option value="">Corporativo</option>{context.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label>Início<input name="starts_at" type="datetime-local" /></label>
          <label>Prazo<input name="due_at" type="datetime-local" /></label>
          <label>Estimativa em minutos<input name="estimated_minutes" type="number" min="0" /></label>
          <label>Tags<input name="tags" placeholder="obras, cliente, decisão" /></label>
          <label className="span-2">Descrição<textarea name="description" rows={3} /></label>
          <label className="span-2">Checklist — um item por linha<textarea name="checklist" rows={4} /></label>
        </div>
        <footer><button type="button" onClick={() => setShow(false)}>Cancelar</button><button className="primary">Salvar atividade</button></footer>
      </form>
    </div>}

    {progressTarget && <div className="modal-backdrop" onMouseDown={() => setProgressTarget(null)}>
      <form className="modal agenda-progress-modal" onSubmit={saveProgress} onMouseDown={event => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setProgressTarget(null)}>×</button>
        <header><small>ATUALIZAÇÃO EXECUTIVA</small><h2>{progressTarget.title}</h2><p>{projectName(progressTarget.project_id)} · Responsável: {memberName(progressTarget.owner_user_id)}</p></header>
        <label>Percentual concluído <strong>{progressPercent}%</strong><input type="range" min="0" max="100" step="5" value={progressPercent} onChange={event => setProgressPercent(Number(event.target.value))} /></label>
        <label>Resumo do andamento<textarea rows={5} value={progressNote} onChange={event => setProgressNote(event.target.value)} placeholder="O que avançou, o que bloqueia e qual é a próxima ação?" /></label>
        <footer><button type="button" onClick={() => setProgressTarget(null)}>Cancelar</button><button className="primary">Registrar avanço</button></footer>
      </form>
    </div>}
  </div>;
}
