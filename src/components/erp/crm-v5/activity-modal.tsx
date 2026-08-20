"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import { CommunicationResources } from "../communication/communication-resources";
import type { CrmEnterpriseData } from "./types";

type SavedActivity = {
  id: string;
  leadId: string;
  subject: string;
  completed: boolean;
};

type BrokerBusyInterval = {
  sourceId: string;
  sourceType: string;
  startsAt: string;
  endsAt: string;
  label: string;
  kind: string;
};

type BrokerAvailability = {
  brokerUserId: string;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  slotMinutes: number;
  busy: BrokerBusyInterval[];
  generatedAt: string;
};

const APPOINTMENT_TYPES = new Set(["visita", "reuniao"]);

function toLocalInput(value: Date) {
  const local = new Date(value.getTime());
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 16);
}

function dateValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dayWindow(value: string) {
  const selected = value ? new Date(value) : new Date(0);
  if (!Number.isFinite(selected.getTime())) return null;
  const from = new Date(
    selected.getFullYear(),
    selected.getMonth(),
    selected.getDate(),
    0,
    0,
    0,
    0,
  );
  const to = new Date(from.getTime());
  to.setDate(to.getDate() + 1);
  return { from, to };
}

function timeOnDay(day: Date, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number.isFinite(hour) ? hour : 8,
    Number.isFinite(minute) ? minute : 0,
    0,
    0,
  );
}

function rangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
) {
  return startA < endB && endA > startB;
}

function formatInterval(interval: BrokerBusyInterval) {
  const start = new Date(interval.startsAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const end = new Date(interval.endsAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${start}–${end}`;
}

function profileName(data: ErpData, userId: string | null | undefined) {
  if (!userId) return "Não atribuído";
  return (
    data.profiles.find((profile) => profile.id === userId)?.full_name ||
    data.profiles.find((profile) => profile.id === userId)?.email ||
    data.members.find((member) => member.user_id === userId)?.role ||
    "Usuário"
  );
}

function isAvailability(value: unknown): value is BrokerAvailability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.brokerUserId === "string" &&
    typeof candidate.workdayStart === "string" &&
    typeof candidate.workdayEnd === "string" &&
    typeof candidate.slotMinutes === "number" &&
    Array.isArray(candidate.busy)
  );
}

export function ActivityModal({
  data,
  crm,
  lead,
  close,
  done,
  canAssignBroker,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  lead: CrmRecord | null;
  close: () => void;
  done: (message: string) => Promise<void>;
  canAssignBroker: boolean;
}) {
  const [saved, setSaved] = useState<SavedActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availability, setAvailability] =
    useState<BrokerAvailability | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [defaultSchedule] = useState(() =>
    toLocalInput(new Date(Date.now() + 60 * 60 * 1000)),
  );
  const [selectedLeadId, setSelectedLeadId] = useState(lead?.id || "");
  const [actionType, setActionType] = useState("contato");
  const [channel, setChannel] = useState("whatsapp");
  const [subject, setSubject] = useState("");
  const [scheduledAt, setScheduledAt] = useState(defaultSchedule);
  const [assignedTo, setAssignedTo] = useState(data.session.user.id);
  const [outcome, setOutcome] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [completeNow, setCompleteNow] = useState(false);
  const [notes, setNotes] = useState("");
  const [brokerUserId, setBrokerUserId] = useState(
    lead?.broker_user_id || "",
  );

  const selectedLead = useMemo(
    () => crm.records.find((item) => item.id === selectedLeadId) || null,
    [crm.records, selectedLeadId],
  );

  const brokerCandidates = useMemo(() => {
    const brokerTeamIds = new Set(
      crm.teams
        .filter(
          (team) =>
            team.active &&
            ["corretor", "corretores", "vendas", "comercial"].includes(
              team.team_type.toLowerCase(),
            ),
        )
        .map((team) => team.id),
    );
    const teamUsers = new Set(
      crm.teamMembers
        .filter(
          (member) =>
            member.active &&
            (brokerTeamIds.has(member.team_id) ||
              member.team_role.toLowerCase().includes("corretor")),
        )
        .map((member) => member.user_id),
    );
    const eligible = data.members.filter(
      (member) =>
        member.active &&
        (member.role === "corretor" || teamUsers.has(member.user_id)),
    );
    const currentBroker = selectedLead?.broker_user_id
      ? data.members.find(
          (member) =>
            member.active && member.user_id === selectedLead.broker_user_id,
        )
      : null;
    return currentBroker &&
      !eligible.some((member) => member.user_id === currentBroker.user_id)
      ? [currentBroker, ...eligible]
      : eligible;
  }, [crm.teamMembers, crm.teams, data.members, selectedLead?.broker_user_id]);

  const appointment =
    !completeNow &&
    (APPOINTMENT_TYPES.has(actionType) || outcome === "visita_agendada");
  const effectiveDuration = Math.max(
    appointment ? 15 : 0,
    Math.min(480, Number(durationMinutes || (appointment ? 60 : 0)) || 0),
  );

  const loadAvailability = useCallback(async () => {
    if (!appointment || !brokerUserId || !scheduledAt) {
      setAvailability(null);
      setAvailabilityError("");
      return;
    }
    const selectedWindow = dayWindow(scheduledAt);
    if (!selectedWindow) {
      setAvailability(null);
      setAvailabilityError("Defina uma data válida para consultar a agenda.");
      return;
    }

    const client = getSupabase();
    if (!client) return;
    setAvailabilityLoading(true);
    setAvailabilityError("");
    const result = await client.rpc("get_crm_broker_availability", {
      p_organization_id: data.organization.id,
      p_broker_user_id: brokerUserId,
      p_from: selectedWindow.from.toISOString(),
      p_to: selectedWindow.to.toISOString(),
    });
    if (result.error || !isAvailability(result.data)) {
      setAvailability(null);
      setAvailabilityError(
        result.error?.message || "A agenda do corretor não pôde ser consultada.",
      );
    } else {
      setAvailability(result.data);
    }
    setAvailabilityLoading(false);
  }, [appointment, brokerUserId, data.organization.id, scheduledAt]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadAvailability(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadAvailability]);

  const selectedRange = useMemo(() => {
    if (!appointment || !scheduledAt || !effectiveDuration) return null;
    const start = dateValue(scheduledAt);
    if (!start) return null;
    return { start, end: start + effectiveDuration * 60 * 1000 };
  }, [appointment, effectiveDuration, scheduledAt]);

  const conflictingIntervals = useMemo(() => {
    if (!selectedRange || !availability) return [];
    return availability.busy.filter((interval) =>
      rangesOverlap(
        selectedRange.start,
        selectedRange.end,
        dateValue(interval.startsAt),
        dateValue(interval.endsAt),
      ),
    );
  }, [availability, selectedRange]);

  const freeSlots = useMemo(() => {
    if (!appointment || !availability || !scheduledAt || !effectiveDuration) {
      return [];
    }
    const selectedWindow = dayWindow(scheduledAt);
    if (!selectedWindow) return [];
    const workdayStart = timeOnDay(
      selectedWindow.from,
      availability.workdayStart,
    );
    const workdayEnd = timeOnDay(selectedWindow.from, availability.workdayEnd);
    const step = Math.max(15, availability.slotMinutes || 30) * 60 * 1000;
    const duration = effectiveDuration * 60 * 1000;
    const minimumStart = openedAt + 15 * 60 * 1000;
    const slots: Date[] = [];

    for (
      let start = workdayStart.getTime();
      start + duration <= workdayEnd.getTime();
      start += step
    ) {
      if (start <= minimumStart) continue;
      const end = start + duration;
      const conflict = availability.busy.some((interval) =>
        rangesOverlap(
          start,
          end,
          dateValue(interval.startsAt),
          dateValue(interval.endsAt),
        ),
      );
      if (!conflict) slots.push(new Date(start));
    }
    return slots;
  }, [
    appointment,
    availability,
    scheduledAt,
    effectiveDuration,
    openedAt,
  ]);

  function selectLead(nextLeadId: string) {
    setSelectedLeadId(nextLeadId);
    const nextLead = crm.records.find((item) => item.id === nextLeadId);
    setBrokerUserId(nextLead?.broker_user_id || "");
    setAvailability(null);
    setAvailabilityError("");
  }

  function selectActionType(next: string) {
    setActionType(next);
    if (APPOINTMENT_TYPES.has(next)) {
      setCompleteNow(false);
      setChannel("presencial");
      if (!Number(durationMinutes)) setDurationMinutes("60");
    }
  }

  function selectOutcome(next: string) {
    setOutcome(next);
    if (next === "visita_agendada") {
      setCompleteNow(false);
      if (!Number(durationMinutes)) setDurationMinutes("60");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!selectedLeadId) {
      setError("Selecione um lead.");
      return;
    }
    if (!subject.trim()) {
      setError("Informe o assunto da atividade.");
      return;
    }
    if (appointment && !brokerUserId) {
      setError("Atribua um corretor antes de agendar a visita ou reunião.");
      return;
    }
    if (appointment && !scheduledAt) {
      setError("Defina a data e o horário do atendimento.");
      return;
    }
    if (appointment && availabilityLoading) {
      setError("Aguarde a consulta da agenda do corretor.");
      return;
    }
    if (appointment && (!availability || availabilityError)) {
      setError(
        availabilityError ||
          "A agenda do corretor precisa estar disponível antes de salvar.",
      );
      return;
    }
    if (appointment && conflictingIntervals.length) {
      setError("O corretor está indisponível neste horário.");
      return;
    }

    setBusy(true);
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const localSchedule = scheduledAt
        ? new Date(scheduledAt).toISOString()
        : null;
      const result = await client.rpc("create_crm_activity_with_broker", {
        p_crm_record_id: selectedLeadId,
        p_action_type: actionType,
        p_channel: channel,
        p_subject: subject.trim(),
        p_scheduled_at: localSchedule,
        p_completed: completeNow,
        p_outcome: outcome || null,
        p_duration_minutes: effectiveDuration || null,
        p_assigned_to: assignedTo || data.session.user.id,
        p_broker_user_id: brokerUserId || null,
        p_notes: notes.trim() || null,
      });
      if (result.error) throw new Error(result.error.message);
      if (!result.data || typeof result.data !== "object") {
        throw new Error("A atividade foi salva sem confirmação do identificador.");
      }
      const response = result.data as Record<string, unknown>;
      const actionId =
        typeof response.action_id === "string" ? response.action_id : "";
      if (!actionId) throw new Error("A atividade não retornou um identificador.");

      setSaved({
        id: actionId,
        leadId: selectedLeadId,
        subject: subject.trim(),
        completed: completeNow,
      });
      await done(
        completeNow
          ? "Contato registrado. Agora você pode anexar e encaminhar materiais."
          : appointment
            ? "Atendimento agendado na agenda do corretor. Materiais podem ser preparados desde já."
            : "Atividade agendada. Materiais podem ser preparados desde já.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível salvar a atividade.",
      );
    } finally {
      setBusy(false);
    }
  }

  const savedLead = saved
    ? crm.records.find((item) => item.id === saved.leadId) || lead
    : lead;
  const savedContact = savedLead?.contact_id
    ? data.contacts.find((item) => item.id === savedLead.contact_id)
    : null;
  const brokerChanged =
    Boolean(brokerUserId) && brokerUserId !== selectedLead?.broker_user_id;
  const scheduleBlocked =
    appointment &&
    (!brokerUserId ||
      !scheduledAt ||
      availabilityLoading ||
      !availability ||
      Boolean(availabilityError) ||
      conflictingIntervals.length > 0);
  const minimumSchedule = toLocalInput(new Date(openedAt + 15 * 60 * 1000));

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="modal extra-large crm5-modal crm5-activity-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-activity-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" type="button" onClick={close}>
          ×
        </button>
        <header>
          <small>ATIVIDADE COMERCIAL</small>
          <h2 id="crm-activity-title">
            {saved
              ? "Materiais do atendimento"
              : lead
                ? "Interação com " + lead.person_name
                : "Nova atividade"}
          </h2>
          <p>
            {saved
              ? "A atividade já foi registrada. Vincule os materiais e prepare o encaminhamento pelo canal do lead."
              : "Registre a interação, atribua o corretor quando necessário e consulte sua disponibilidade antes de confirmar visitas ou reuniões."}
          </p>
        </header>

        {!saved ? (
          <form onSubmit={submit}>
            <div className="form-grid">
              <label className="span-2">
                Lead
                <select
                  value={selectedLeadId}
                  required
                  onChange={(event) => selectLead(event.target.value)}
                >
                  <option value="">Selecione</option>
                  {crm.records
                    .filter((item) => item.record_status !== "arquivada")
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.person_name} ·{" "}
                        {item.company_name || item.phone || "Sem empresa"}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Tipo
                <select
                  value={actionType}
                  onChange={(event) => selectActionType(event.target.value)}
                >
                  <option value="contato">Contato</option>
                  <option value="ligacao">Ligação</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">E-mail</option>
                  <option value="reuniao">Reunião</option>
                  <option value="visita">Visita</option>
                  <option value="proposta">Proposta</option>
                  <option value="tarefa">Tarefa</option>
                </select>
              </label>
              <label>
                Canal
                <select
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                >
                  <option value="whatsapp">WhatsApp</option>
                  <option value="telefone">Telefone</option>
                  <option value="email">E-mail</option>
                  <option value="presencial">Presencial</option>
                  <option value="video">Vídeo</option>
                  <option value="instagram">Instagram</option>
                </select>
              </label>
              <label className="span-2">
                Assunto
                <input
                  value={subject}
                  maxLength={300}
                  required
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="Ex.: Primeiro contato, visita ao empreendimento..."
                />
              </label>
              <label>
                {appointment ? "Data e hora da visita ou reunião" : "Agendamento"}
                <input
                  value={scheduledAt}
                  type="datetime-local"
                  min={minimumSchedule}
                  required={appointment}
                  onChange={(event) => setScheduledAt(event.target.value)}
                />
              </label>
              <label>
                Responsável pela atividade
                <select
                  value={assignedTo}
                  onChange={(event) => setAssignedTo(event.target.value)}
                >
                  {data.members
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.user_id} value={item.user_id}>
                        {profileName(data, item.user_id)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="span-2 broker-assignment-field">
                Corretor atribuído
                <select
                  value={brokerUserId}
                  disabled={!canAssignBroker}
                  required={appointment}
                  onChange={(event) => setBrokerUserId(event.target.value)}
                >
                  <option value="">Sem corretor atribuído</option>
                  {brokerCandidates.map((candidate) => (
                    <option key={candidate.user_id} value={candidate.user_id}>
                      {profileName(data, candidate.user_id)}
                    </option>
                  ))}
                </select>
                <span>
                  {canAssignBroker
                    ? brokerChanged
                      ? "Ao salvar, o corretor será formalmente designado para este lead."
                      : "Selecione o corretor que atenderá a oportunidade."
                    : selectedLead?.broker_user_id
                      ? `Corretor definido pela Direção Comercial: ${profileName(data, selectedLead.broker_user_id)}.`
                      : "A atribuição do corretor depende da Direção Comercial."}
                </span>
              </label>

              {appointment && (
                <section
                  className="span-2 broker-availability"
                  aria-live="polite"
                >
                  <header>
                    <div>
                      <small>AGENDA DO CORRETOR</small>
                      <strong>
                        {brokerUserId
                          ? profileName(data, brokerUserId)
                          : "Selecione um corretor"}
                      </strong>
                    </div>
                    <button
                      type="button"
                      disabled={!brokerUserId || availabilityLoading}
                      onClick={() => void loadAvailability()}
                    >
                      {availabilityLoading
                        ? "Consultando..."
                        : "Atualizar agenda"}
                    </button>
                  </header>

                  {availabilityError && (
                    <p className="broker-availability-error">
                      {availabilityError}
                    </p>
                  )}

                  {availability && (
                    <>
                      <div className="broker-busy-list">
                        <span>Indisponibilidades no dia</span>
                        <div>
                          {availability.busy.map((interval) => (
                            <span
                              key={`${interval.sourceType}-${interval.sourceId}`}
                            >
                              <b>{formatInterval(interval)}</b>
                              {interval.label}
                            </span>
                          ))}
                          {!availability.busy.length && (
                            <em>Nenhum bloqueio registrado para este dia.</em>
                          )}
                        </div>
                      </div>

                      <div className="broker-free-slots">
                        <span>
                          Horários livres sugeridos · {effectiveDuration || 60} min
                        </span>
                        <div>
                          {freeSlots.map((slot) => {
                            const value = toLocalInput(slot);
                            return (
                              <button
                                key={value}
                                type="button"
                                className={scheduledAt === value ? "active" : ""}
                                onClick={() => setScheduledAt(value)}
                              >
                                {slot.toLocaleTimeString("pt-BR", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </button>
                            );
                          })}
                          {!freeSlots.length && (
                            <em>
                              Nenhum horário livre dentro da jornada deste dia.
                            </em>
                          )}
                        </div>
                      </div>

                      {conflictingIntervals.length > 0 ? (
                        <p className="broker-slot-conflict" role="alert">
                          Horário indisponível: coincide com{" "}
                          {conflictingIntervals
                            .map(
                              (interval) =>
                                `${formatInterval(interval)} (${interval.label})`,
                            )
                            .join(", ")}.
                        </p>
                      ) : selectedRange ? (
                        <p className="broker-slot-ok">
                          Horário livre na agenda consultada. A confirmação final
                          será validada novamente ao salvar.
                        </p>
                      ) : null}
                    </>
                  )}
                </section>
              )}

              <label>
                Resultado
                <select
                  value={outcome}
                  onChange={(event) => selectOutcome(event.target.value)}
                >
                  <option value="">Aguardando</option>
                  <option value="atendeu">Atendeu</option>
                  <option value="nao_atendeu">Não atendeu</option>
                  <option value="retornar">Retornar</option>
                  <option value="interessado">Interessado</option>
                  <option value="sem_interesse">Sem interesse</option>
                  <option value="visita_agendada">Visita agendada</option>
                  <option value="proposta_solicitada">
                    Proposta solicitada
                  </option>
                </select>
              </label>
              <label>
                Duração (minutos)
                <input
                  value={durationMinutes}
                  type="number"
                  min="0"
                  max="480"
                  step="15"
                  onChange={(event) => setDurationMinutes(event.target.value)}
                />
              </label>
              <label className="checkbox span-2">
                <input
                  checked={completeNow}
                  type="checkbox"
                  disabled={appointment}
                  onChange={(event) => setCompleteNow(event.target.checked)}
                />
                <span>
                  {appointment
                    ? "Visitas e reuniões futuras são registradas como agendamento."
                    : "Registrar como concluída agora"}
                </span>
              </label>
              <label className="span-2">
                Observações
                <textarea
                  value={notes}
                  maxLength={8000}
                  rows={4}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
            </div>
            {error && <div className="feedback error">{error}</div>}
            <footer>
              <button type="button" onClick={close}>
                Cancelar
              </button>
              <button
                className="primary"
                disabled={busy || scheduleBlocked}
              >
                {busy
                  ? "Salvando..."
                  : appointment
                    ? "Confirmar agenda e selecionar materiais"
                    : "Salvar e selecionar materiais"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="crm5-activity-material-step">
            <div className="crm5-activity-saved">
              <b>✓</b>
              <span>
                <strong>Atividade registrada</strong>
                <small>
                  {saved.completed
                    ? "Contato concluído"
                    : appointment
                      ? "Atendimento agendado"
                      : "Atividade agendada"}{" "}
                  · {saved.subject}
                </small>
              </span>
            </div>
            <CommunicationResources
              data={data}
              entityType="crm_action"
              entityId={saved.id}
              shareTarget={{
                name: savedLead?.person_name || "lead",
                phone: savedLead?.phone || savedContact?.phone,
                email: savedLead?.email || savedContact?.email,
                subject: saved.subject,
                projectId: savedLead?.project_id,
                message:
                  "Conforme nosso contato com a Évora Urbanismo, seguem os materiais selecionados:",
              }}
            />
            <footer>
              <button className="primary" type="button" onClick={close}>
                Concluir atendimento
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
