export default function PublicAgentLoading() {
  return (
    <main id="conteudo-principal" className="public-agent-page public-agent-state-page" aria-busy="true">
      <section className="public-agent-state-card" aria-label="Iniciando atendimento">
        <div className="public-agent-state-avatar" aria-hidden="true">B</div>
        <div>
          <span>Évora Urbanismo</span>
          <h1>Iniciando a conversa com a Bia</h1>
          <p>Preparando o atendimento e consultando o Enterprise.</p>
        </div>
        <i className="public-agent-state-progress" aria-hidden="true" />
      </section>
    </main>
  );
}
