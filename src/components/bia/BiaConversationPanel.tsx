import { useEffect, useRef } from 'react';
import type { PublicAgentAttachment, PublicAgentProfile, PublicAgentSimulation } from '@/lib/public-agent/types';

export function BiaConversationPanel({ onClose, profile, protocol, simulations, attachments }: {
  onClose: () => void; profile: PublicAgentProfile; protocol: string | null;
  simulations: PublicAgentSimulation[]; attachments: PublicAgentAttachment[];
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = panel.current?.querySelectorAll<HTMLElement>('button,a[href]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <aside ref={panel} className="arisa-conversations bia-conversation-panel" role="dialog" aria-modal="true" aria-labelledby="bia-panel-title">
    <div className="arisa-menu-head"><strong id="bia-panel-title">Seu atendimento com a Bia</strong><button onClick={onClose} aria-label="Fechar detalhes">×</button></div>
    {protocol && <p>Protocolo <strong>{protocol}</strong></p>}
    <section><h2>O que já conversamos</h2>
      {profile.intent && profile.intent !== 'unknown' && <p>Interesse: {profile.intent}.</p>}
      {profile.preferred_city && <p>Cidade: {profile.preferred_city}.</p>}
      {profile.budget_max != null && <p>Orçamento informado: {profile.budget_max.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.</p>}
      {profile.summary ? <p>{profile.summary}</p> : <p>A Bia retoma o contexto desta conversa para você não precisar repetir suas preferências.</p>}
    </section>
    <section><h2>Suas simulações</h2>{simulations.length ? simulations.slice(-5).map((s, i) => <p key={`${s.unitCode}:${i}`}><strong>Lote {s.unitCode}</strong> · {s.area} m²<br />Entrada de {s.downPayment.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}<br /><small>Consulte o cálculo e as condições na conversa. Não representa proposta aprovada.</small></p>) : <p>As simulações que você solicitar ficarão aqui.</p>}</section>
    <section><h2>Materiais recebidos</h2>{attachments.length ? attachments.map((a, i) => <a key={`${a.id}:${i}`} href={a.url || undefined} target="_blank" rel="noopener noreferrer">{a.title}</a>) : <p>Os materiais enviados pela Bia aparecerão aqui.</p>}</section>
    <div className="arisa-menu-links"><a href="/privacidade" target="_blank" rel="noopener noreferrer">Política de Privacidade</a></div>
  </aside>;
}
