import { useEffect, useRef } from "react";
import { MessageText } from "../arisa/MessageText";
import { SimulationView } from "../public-agent/ChatSimulation";
import type { BiaCustomerFile, PublicAgentAttachment, PublicAgentProfile, PublicAgentSimulation } from "@/lib/public-agent/types";

export type BiaPanel = "memory" | "simulations" | "archive";
export const biaPanelLabels = { memory: "O que já conversamos", simulations: "Suas simulações", archive: "Materiais recebidos" };

export function BiaWorkspacePanel({ activePanel, onClose, onBack, onRequestSimulation, busy, profile, protocol, simulations, attachments, customerFiles, onOpenFile, messages }: {
  activePanel: BiaPanel; onClose: () => void; onBack: () => void; onRequestSimulation: () => void; busy: boolean;
  profile: PublicAgentProfile; protocol: string | null; simulations: PublicAgentSimulation[];
  customerFiles: BiaCustomerFile[]; onOpenFile: (file: BiaCustomerFile) => void;
  attachments: PublicAgentAttachment[]; messages: { id: string; direction: string; content: string }[];
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const items = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href]");
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose]);
  return <aside ref={panel} className="arisa-conversations bia-conversation-panel" role="dialog" aria-modal="true" aria-labelledby="bia-panel-title">
    <div className="arisa-menu-head"><strong id="bia-panel-title">{biaPanelLabels[activePanel]}</strong><button onClick={onClose} aria-label="Fechar painel">×</button></div>
    <button onClick={onBack}>← Voltar ao menu</button>
    <div className="bia-panel-content">
      {protocol && <p>Protocolo <strong>{protocol}</strong></p>}
      {activePanel === "memory" && <section>
        {profile.summary && <MessageText content={profile.summary} />}
        {profile.intent && profile.intent !== "unknown" && <p>Interesse: {profile.intent}.</p>}
        {profile.preferred_city && <p>Cidade: {profile.preferred_city}.</p>}
        {profile.budget_max != null && <p>Orçamento informado: {profile.budget_max.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.</p>}
        <h2>Conversa atual</h2>
        {messages.some(message => message.direction === "user") ? <>
          <p>Seus últimos pedidos nesta conversa:</p>
          {messages.filter(message => message.direction === "user").slice(-10).map(message => <blockquote key={message.id}><MessageText content={message.content} /></blockquote>)}
        </> : <p>Seus pedidos e preferências aparecerão aqui conforme você conversar com a Bia.</p>}
        <button onClick={onClose}>Abrir conversa completa</button>
      </section>}
      {activePanel === "simulations" && <section>
        {simulations.length ? [...simulations].reverse().map((simulation, i) => <div key={`${simulation.unitCode}:${simulation.generatedAt}:${i}`}><SimulationView simulation={simulation} /><p><small>{simulation.disclaimer || "Simulação indicativa, sujeita à confirmação das condições comerciais."}</small></p></div>) : <p>Você ainda não pediu uma simulação nesta conversa.</p>}
        <button disabled={busy} onClick={onRequestSimulation}>Solicitar nova simulação</button>
      </section>}
      {activePanel === "archive" && <section>{customerFiles.map(file => <button className="arisa-file" type="button" key={file.id} onClick={() => onOpenFile(file)}><span>{file.name}<small>Arquivo enviado por você</small></span></button>)}{attachments.length ? attachments.map((attachment, i) => <a key={`${attachment.id}:${i}`} href={attachment.url || undefined} target="_blank" rel="noopener noreferrer">{attachment.title}</a>) : !customerFiles.length ? <p>Os arquivos que você enviar e os materiais da Bia aparecerão aqui.</p> : null}</section>}
    </div>
  </aside>;
}
