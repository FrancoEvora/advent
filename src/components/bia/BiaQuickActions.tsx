import type { WorkspacePanel } from '../arisa/workspace-navigation';
import styles from './bia-clean-layout.module.css';

const actions = [
  { panel: 'whatsapp', label: 'Conversas', description: 'Acompanhe os atendimentos no WhatsApp', icon: 'chat' },
  { panel: 'leads', label: 'Leads e funil', description: 'Consulte contatos e próximas ações', icon: 'people' },
  { panel: 'simulations', label: 'Simulações', description: 'Explore lotes e condições de compra', icon: 'home' },
  { panel: 'agenda', label: 'Agenda', description: 'Organize visitas e reuniões', icon: 'calendar' },
] as const;

function ActionIcon({ kind }: { kind: typeof actions[number]['icon'] }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'chat' ? <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0ZM7 9h8M7 13h5" />
      : kind === 'people' ? <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>
        : kind === 'home' ? <><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" /></>
          : <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 11h18m-13 5h2m4 0h2" /></>}
  </svg>;
}

export function BiaQuickActions({ onOpen, disabled = false, welcome = false }: {
  onOpen: (panel: WorkspacePanel) => void; disabled?: boolean; welcome?: boolean;
}) {
  return <nav className={welcome ? styles.actionGrid : styles.quickNav} aria-label={welcome ? 'Começar com a Bia' : 'Atalhos comerciais da Bia'}>
    {actions.map(action => <button key={action.panel} type="button" disabled={disabled} onClick={() => onOpen(action.panel)}>
      <ActionIcon kind={action.icon} />
      <span><strong>{action.label}</strong>{welcome && <small>{action.description}</small>}</span>
      {welcome && <span className={styles.arrow} aria-hidden="true">↗</span>}
    </button>)}
  </nav>;
}

export function BiaWelcome({ onOpen, disabled }: { onOpen: (panel: WorkspacePanel) => void; disabled: boolean }) {
  return <section className={styles.welcome} aria-labelledby="bia-welcome-title">
    <span className={styles.eyebrow}>SEU ESPAÇO COMERCIAL</span>
    <h1 id="bia-welcome-title">Vamos cuidar das suas próximas oportunidades?</h1>
    <p>Sou a Bia, sua gestora comercial da Évora. Acompanhe seus leads, consulte simulações ou organize uma visita. Estou aqui para ajudar.</p>
    <BiaQuickActions onOpen={onOpen} disabled={disabled} welcome />
    <p className={styles.hint}>Você também pode me pedir por mensagem, áudio ou anexar um arquivo.</p>
  </section>;
}
