"use client";

export default function PublicAgentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="conteudo-principal" className="public-agent-page public-agent-state-page">
      <section className="public-agent-state-card" role="alert">
        <div className="public-agent-state-avatar" aria-hidden="true">V</div>
        <div>
          <span>Évora Urbanismo</span>
          <h1>O atendimento está se reconectando</h1>
          <p>Não foi possível abrir a conversa agora. Nenhum cadastro ou bloqueio foi executado.</p>
        </div>
        <button type="button" onClick={reset}>Tentar novamente</button>
      </section>
    </main>
  );
}
