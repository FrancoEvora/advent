import type { PublicAgentSimulation } from "@/lib/public-agent/types";
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export function SimulationView({ simulation }: { simulation: PublicAgentSimulation }) {
  return (
    <section className="public-agent-simulation-card">
      <span>Simulação · {simulation.unitCode}</span>
      <strong>{currency.format(simulation.price)}</strong>
      <p>
        Entrada de {new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(simulation.downPaymentPct * 100)}%
        {simulation.downPaymentInstallments > 1
          ? ` em ${simulation.downPaymentInstallments}x de ${currency.format(simulation.downPaymentInstallmentAmount)}`
          : ` (${currency.format(simulation.downPayment)})`}
      </p>
      <div>
        {simulation.scenarios.map((scenario) => (
          <small key={scenario.months}>
            {scenario.months} meses <b>{currency.format(scenario.monthlyPayment)}/mês</b>
          </small>
        ))}
      </div>
      {simulation.balloonCount > 0 && (
        <em>
          {simulation.balloonCount} balões de {currency.format(simulation.balloonAmount)} a cada {simulation.balloonFrequencyMonths} meses
        </em>
      )}
    </section>
  );
}

