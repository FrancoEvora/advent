"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  ApprovalRequest,
  ApprovalStatus,
  CashRiskLevel,
  ErpData,
  FinancialEntry,
} from "./types";
import { analyzeComprehensivePaymentRisk } from "./operational-cash";
import { dateAtNoon, money, shortDate } from "./utils";
import { PanelTitle } from "./views-dashboard";
import { ArisaEntryEvidence } from "./arisa/entry-evidence";

type ExtendedRequest = ApprovalRequest & {
  negotiated_due_date?: string | null;
};

type ExtendedEntry = FinancialEntry & {
  negotiated_due_date?: string | null;
  due_date_change_reason?: string | null;
};

type EntryDecisionUpdate = {
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  negotiated_due_date: string;
  due_date_change_reason: string;
  cash_risk: boolean;
  cash_risk_level: CashRiskLevel;
  projected_balance: number;
  recommended_due_date: string | null;
  risk_reason: string;
  scheduled_payment_date: string | null;
};

type ApprovalDecisionModalProps = {
  data: ErpData;
  request: ExtendedRequest;
  entry: ExtendedEntry;
  decision: "aprovado" | "rejeitado";
  close: () => void;
  mutate: (
    operation: () => Promise<void>,
    success: string,
  ) => Promise<void>;
};

export function ApprovalDecisionModal({
  data,
  request,
  entry,
  decision,
  close,
  mutate,
}: ApprovalDecisionModalProps) {
  const originalRisk = useMemo(
    () =>
      analyzeComprehensivePaymentRisk(data, {
        amount: Number(entry.amount),
        dueDate: entry.scheduled_payment_date || entry.due_date,
        accountId: entry.bank_account_id,
        excludeEntryId: entry.id,
      }),
    [data, entry],
  );
  const suggested =
    entry.scheduled_payment_date ||
    entry.recommended_due_date ||
    request.recommended_due_date ||
    originalRisk.recommendedDate ||
    entry.due_date;
  const [date, setDate] = useState(suggested);
  const [note, setNote] = useState(
    decision === "aprovado"
      ? "Pagamento analisado e programação aprovada pela administração."
      : "Pagamento rejeitado pela administração.",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const risk = useMemo(
    () =>
      analyzeComprehensivePaymentRisk(data, {
        amount: Number(entry.amount),
        dueDate: date,
        accountId: entry.bank_account_id,
        excludeEntryId: entry.id,
      }),
    [data, entry, date],
  );
  const canSchedule =
    !entry.payment_blocked &&
    (!entry.is_provision ||
      ["liberado", "reconciliado"].includes(
        entry.payment_release_status || "",
      ));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (entry.issue_date && date < entry.issue_date) {
      setError("A programação não pode ser anterior à emissão do título.");
      return;
    }
    setBusy(true);
    try {
      await mutate(
        async () => {
          const client = getSupabase();
          if (!client) throw new Error("Supabase indisponível.");
          const now = new Date().toISOString();
          const requestUpdate = {
            status: decision,
            decided_at: now,
            assigned_to: data.session.user.id,
            comment: note,
            negotiated_due_date: date,
            recommended_due_date:
              originalRisk.recommendedDate ||
              entry.recommended_due_date ||
              request.recommended_due_date ||
              null,
          };
          const entryUpdate: EntryDecisionUpdate = {
            approval_status: decision,
            approved_by:
              decision === "aprovado" ? data.session.user.id : null,
            approved_at: decision === "aprovado" ? now : null,
            negotiated_due_date: date,
            due_date_change_reason: note,
            cash_risk: risk.risky,
            cash_risk_level: risk.level,
            projected_balance: risk.projectedBalance,
            recommended_due_date: risk.recommendedDate,
            risk_reason: risk.reason,
            scheduled_payment_date:
              decision === "aprovado" && canSchedule ? date : null,
          };
          const [requestResult, entryResult] = await Promise.all([
            client
              .from("approval_requests")
              .update(requestUpdate)
              .eq("id", request.id),
            client
              .from("financial_entries")
              .update(entryUpdate)
              .eq("id", entry.id),
          ]);
          if (requestResult.error)
            throw new Error(requestResult.error.message);
          if (entryResult.error) throw new Error(entryResult.error.message);
        },
        decision === "aprovado"
          ? canSchedule
            ? "Pagamento aprovado e incluído na programação."
            : "Pagamento aprovado; programação pendente de liberação documental."
          : "Pagamento rejeitado e decisão registrada.",
      );
      close();
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

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal payment-decision-modal"
        onSubmit={submit}
        onMouseDown={event => event.stopPropagation()}
      >
        <PanelTitle
          eyebrow="DECISÃO FINANCEIRA"
          title={
            decision === "aprovado"
              ? "Aprovar e programar pagamento"
              : "Rejeitar e registrar negociação"
          }
        />
        <button type="button" className="modal-close" onClick={close}>
          ×
        </button>
        <section className="decision-summary">
          <article>
            <small>Compromisso</small>
            <strong>{entry.description}</strong>
            <span>{money.format(Number(entry.amount))}</span>
          </article>
          <article>
            <small>Vencimento contratual</small>
            <strong>{shortDate.format(dateAtNoon(entry.due_date))}</strong>
          </article>
          <article>
            <small>Primeira programação com cobertura</small>
            <strong>
              {originalRisk.recommendedDate
                ? shortDate.format(
                    dateAtNoon(originalRisk.recommendedDate),
                  )
                : originalRisk.risky
                  ? "Sem cobertura no horizonte"
                  : "Vencimento compatível"}
            </strong>
          </article>
        </section>
        <label>
          {decision === "aprovado"
            ? "Data efetiva de programação"
            : "Data considerada na análise"}
          <input
            type="date"
            value={date}
            onChange={event => setDate(event.target.value)}
            required
          />
          <small>O vencimento contratual não será alterado.</small>
        </label>
        {decision === "aprovado" && !canSchedule && (
          <div className="feedback error">
            O título será aprovado, mas somente poderá ser programado após a
            liberação dos bloqueios documentais ou da provisão.
          </div>
        )}
        <div className={`cash-risk-alert ${risk.level}`}>
          <div>
            <b>{risk.risky ? "!" : "✓"}</b>
            <span>
              <strong>
                {risk.risky
                  ? "A data escolhida ainda exige exceção"
                  : "Data compatível com o caixa projetado"}
              </strong>
              <small>
                Saldo após o pagamento:{" "}
                {money.format(risk.projectedBalance)}
              </small>
            </span>
          </div>
          <p>{risk.reason}</p>
          {risk.recommendedDate && risk.recommendedDate !== date && (
            <button
              type="button"
              onClick={() => setDate(risk.recommendedDate!)}
            >
              Aplicar data recomendada:{" "}
              {shortDate.format(dateAtNoon(risk.recommendedDate))}
            </button>
          )}
        </div>
        <label>
          Justificativa e condições da decisão
          <textarea
            rows={4}
            value={note}
            onChange={event => setNote(event.target.value)}
            required
          />
        </label>
        {error && <div className="feedback error">{error}</div>}
        <ArisaEntryEvidence organizationId={data.organization.id} entryId={entry.id} />
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button
            className={decision === "aprovado" ? "primary" : "danger"}
            disabled={busy}
          >
            {busy
              ? "Registrando..."
              : decision === "aprovado"
                ? canSchedule
                  ? "Aprovar e programar"
                  : "Aprovar sem programar"
                : "Confirmar rejeição"}
          </button>
        </footer>
      </form>
    </div>
  );
}
