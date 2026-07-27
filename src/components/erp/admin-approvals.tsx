"use client";

import { useEffect, useState } from "react";
import type { ActivityDeepLinkTarget } from "./activities/activity-links";
import type { ApprovalRequest, FinancialEntry } from "./types";
import type { AdminProps } from "./views-admin";
import { dateAtNoon, money, shortDate } from "./utils";
import { Empty, Kpi, PanelTitle } from "./views-dashboard";
import { ApprovalDecisionModal } from "./admin-approval-decision-modal";

type Decision = {
  request: ApprovalRequest;
  entry: FinancialEntry;
  decision: "aprovado" | "rejeitado";
};

export function ApprovalsView({ data, mutate, focus }: AdminProps) {
  const [selected, setSelected] = useState<Decision | null>(null);
  const pending = data.approvals.filter(item => item.status === "pendente");
  const cashRisk = pending.filter(item =>
    data.entries.find(entry => entry.id === item.entry_id)?.cash_risk,
  );
  const focusedRequestId =
    focus?.sourceType === "approval_requests" ? focus.recordId : null;
  const focusedRequest = focusedRequestId
    ? data.approvals.find(item => item.id === focusedRequestId)
    : undefined;
  const visibleRequests: ApprovalRequest[] =
    focusedRequest && !pending.some(item => item.id === focusedRequest.id)
      ? [focusedRequest, ...pending]
      : pending;
  const focusedRequestVisible = Boolean(
    focusedRequestId &&
      visibleRequests.some(item => item.id === focusedRequestId),
  );

  useLinkedApprovalFocus(focusedRequestId, focusedRequestVisible);

  return (
    <div className="stack">
      <section className="kpi-grid four">
        <Kpi
          label="Pendentes"
          value={String(pending.length)}
          detail="Aguardando decisão"
          tone="warning"
        />
        <Kpi
          label="Risco de caixa"
          value={String(cashRisk.length)}
          detail="Exigem atenção especial"
          tone="danger"
        />
        <Kpi
          label="Aprovadas"
          value={String(
            data.approvals.filter(item => item.status === "aprovado").length,
          )}
          detail="Histórico"
          tone="positive"
        />
        <Kpi
          label="Alçada automática"
          value={money.format(Number(data.settings.approval_threshold))}
          detail="Limite configurado"
          tone="gold"
        />
      </section>

      <section className="panel">
        <PanelTitle
          eyebrow="ALÇADAS E EXCEÇÕES"
          title="Fila de aprovações"
        />
        {visibleRequests.map(request => {
          const entry = data.entries.find(
            item => item.id === request.entry_id,
          );
          if (!entry) return null;
          const focused = request.id === focusedRequestId;
          const classification =
            data.costCenters.find(center => center.id === entry.cost_center_id)
              ?.name ||
            data.categories.find(category => category.id === entry.category_id)
              ?.name ||
            "Sem classificação";
          return (
            <article
              data-record-id={request.id}
              tabIndex={focused ? -1 : undefined}
              className={`approval-row approval-row-v3 ${
                entry.cash_risk ? "cash-risk" : ""
              } ${focused ? "agenda-linked-target" : ""}`}
              key={request.id}
            >
              <div>
                <span className={`movement-badge ${entry.type}`}>
                  {entry.type === "entrada" ? "↓" : "↑"}
                </span>
                <div>
                  <strong>{entry.description}</strong>
                  <small>
                    Vencimento contratual:{" "}
                    {shortDate.format(dateAtNoon(entry.due_date))}
                    {entry.scheduled_payment_date
                      ? ` · Programado: ${shortDate.format(
                          dateAtNoon(entry.scheduled_payment_date),
                        )}`
                      : entry.type === "saida"
                        ? " · Ainda não programado"
                        : ""}
                    {" · "}
                    {classification}
                  </small>
                  {(request.reason || entry.risk_reason) && (
                    <p>{request.reason || entry.risk_reason}</p>
                  )}
                  {entry.recommended_due_date && (
                    <em>
                      Sugestão de caixa:{" "}
                      {shortDate.format(
                        dateAtNoon(entry.recommended_due_date),
                      )}
                    </em>
                  )}
                </div>
              </div>
              <b>{money.format(Number(entry.amount))}</b>
              <div>
                {request.status === "pendente" ? (
                  <>
                    <button
                      onClick={() =>
                        setSelected({
                          request,
                          entry,
                          decision: "rejeitado",
                        })
                      }
                    >
                      Rejeitar
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        setSelected({
                          request,
                          entry,
                          decision: "aprovado",
                        })
                      }
                    >
                      Analisar e aprovar
                    </button>
                  </>
                ) : (
                  <span className={`approval ${request.status}`}>
                    {request.status}
                  </span>
                )}
              </div>
            </article>
          );
        })}
        {!visibleRequests.length && (
          <Empty text="Nenhuma aprovação pendente." />
        )}
      </section>

      {selected && (
        <ApprovalDecisionModal
          data={data}
          request={selected.request}
          entry={selected.entry}
          decision={selected.decision}
          close={() => setSelected(null)}
          mutate={mutate}
        />
      )}
    </div>
  );
}

function useLinkedApprovalFocus(
  focusedRequestId: ActivityDeepLinkTarget["recordId"] | null,
  visible: boolean,
) {
  useEffect(() => {
    if (!focusedRequestId || !visible) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-record-id="${focusedRequestId}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedRequestId, visible]);
}
