import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Política de Privacidade | Arisa e Évora Gestão",
  description: "Como a Évora Urbanismo trata dados pessoais na plataforma Évora Gestão, na Arisa e nas integrações com Google Workspace e WhatsApp.",
  alternates: { canonical: "https://advent-tau.vercel.app/privacidade" },
  robots: { index: true, follow: true },
};

const topics = [
  ["responsavel", "Responsável e abrangência"],
  ["dados", "Dados e finalidades"],
  ["bases", "Bases legais"],
  ["arisa", "Inteligência artificial e voz"],
  ["google", "Google Workspace"],
  ["whatsapp", "WhatsApp e Meta"],
  ["compartilhamento", "Compartilhamento e transferências"],
  ["seguranca", "Segurança e armazenamento local"],
  ["retencao", "Retenção e exclusão"],
  ["direitos", "Seus direitos"],
  ["contato", "Contato e solicitações"],
  ["atualizacoes", "Atualizações"],
] as const;

export default function PrivacyPage() {
  return <div className={styles.page}>
    <header className={styles.header}>
      <Link href="/" aria-label="Évora Gestão — início"><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={160} height={55} priority /></Link>
      <nav aria-label="Acessar os serviços"><Link href="/">Plataforma</Link><Link href="/arisa">Acessar a Arisa ↗</Link></nav>
    </header>
    <main id="conteudo-principal" tabIndex={-1}>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>ARISA + ÉVORA GESTÃO</p>
        <h1>Política de<br />Privacidade</h1>
        <p className={styles.lead}>Transparência sobre os seus dados, em cada interação.</p>
        <p>Conheça as informações utilizadas pelos nossos serviços, suas finalidades e os caminhos para exercer seus direitos.</p>
        <div className={styles.stamp}>Última atualização: <time dateTime="2026-09-07">7 de setembro de 2026</time> · Versão 1.0</div>
      </div>
      <div className={styles.layout}>
        <aside className={styles.index}><nav aria-label="Nesta política"><p className={styles.eyebrow}>NESTA PÁGINA</p>{topics.map(([id, label], index) => <a key={id} href={`#${id}`}><span>{String(index + 1).padStart(2, "0")}</span>{label}</a>)}</nav><a className={styles.contactLink} href="#contato">Solicitar atendimento sobre dados ↗</a></aside>
        <article className={styles.article}>
          <section id="responsavel"><h2>01. Responsável e abrangência</h2>
            <p>Esta política se aplica à plataforma <strong>Évora Gestão</strong>, à assistente administrativa <strong>Arisa</strong> e aos módulos e canais vinculados a esses serviços, operados pela <strong>Évora Urbanismo</strong>, no endereço advent-tau.vercel.app.</p>
            <p>A Évora Urbanismo é responsável pelas decisões sobre o tratamento realizado em suas próprias operações. Quando uma empresa ou sociedade de propósito específico utiliza a plataforma para administrar seu empreendimento, a responsabilidade pelos dados da relação contratual é definida conforme sua participação na operação e os contratos aplicáveis. A Arisa é uma funcionalidade de inteligência artificial, não uma pessoa jurídica controladora independente.</p>
            <p>A política abrange usuários autorizados, clientes, interessados em imóveis, parceiros, fornecedores, prestadores e pessoas cujos dados sejam inseridos ou recebidos pelos canais integrados. Links externos e serviços de terceiros também estão sujeitos às respectivas políticas.</p>
          </section>
          <section id="dados"><h2>02. Dados tratados e suas finalidades</h2>
            <p>As informações variam conforme o módulo utilizado, as permissões do usuário e as integrações habilitadas. Podemos receber dados diretamente de você, de pessoas autorizadas da organização, de documentos e dos provedores conectados.</p>
            <div className={styles.tableWrap}><table><caption>Principais categorias de dados</caption><thead><tr><th scope="col">Informações</th><th scope="col">Para que são utilizadas</th></tr></thead><tbody>
              <tr><td>Nome, e-mail, telefone, empresa, perfil de acesso e identificadores de conta.</td><td>Identificar usuários e contatos, autenticar acesso e administrar permissões e relacionamento.</td></tr>
              <tr><td>CPF/CNPJ, endereços, propostas, contratos, lotes, negociações e histórico comercial.</td><td>Atendimento, CRM, preparação e execução de contratos e acompanhamento de clientes e parceiros.</td></tr>
              <tr><td>Boletos, notas fiscais, extratos, dados bancários e registros de pagamentos ou recebimentos.</td><td>Leitura documental, classificação, conciliação, controle financeiro e prestação de contas.</td></tr>
              <tr><td>Dados de obras, compras, fornecedores, equipe, atividades e documentos administrativos.</td><td>Organizar a operação, acompanhar compromissos, custos, entregas e obrigações.</td></tr>
              <tr><td>Mensagens, arquivos, imagens, áudios, transcrições, e-mails, eventos e respostas de participantes.</td><td>Comunicação, assistência por IA, agendamento, consulta ao histórico e execução de tarefas autorizadas.</td></tr>
              <tr><td>Registros de acesso, horários, identificadores técnicos, endereço IP e informações do navegador, quando registrados pela infraestrutura.</td><td>Segurança, prevenção de abuso, diagnóstico de falhas e auditoria das operações.</td></tr>
            </tbody></table></div>
            <p>Solicitamos apenas os dados pertinentes à atividade. Evite inserir senhas ou dados sensíveis sem necessidade. Documentos que contenham dados de saúde, biometria ou outras informações sensíveis exigem finalidade específica e hipótese legal adequada. Os serviços não são direcionados a crianças; eventual tratamento de seus dados deve observar seu melhor interesse e os requisitos legais aplicáveis.</p>
          </section>
          <section id="bases"><h2>03. Bases legais</h2>
            <p>Conforme a finalidade, o tratamento pode decorrer da execução de contrato ou de procedimentos preliminares solicitados pelo titular; do cumprimento de obrigação legal ou regulatória; do exercício regular de direitos; ou de legítimo interesse, após avaliação de necessidade, expectativas e impacto sobre o titular. Utilizamos consentimento quando ele for exigido, inclusive para funcionalidades opcionais que dele dependam.</p>
            <p>A permissão técnica para conectar uma conta Google ou acessar o microfone não representa autorização irrestrita para qualquer uso dos dados. A simples leitura desta política também não constitui consentimento genérico. Dados sensíveis seguem as hipóteses específicas da legislação.</p>
          </section>
          <section id="arisa"><h2>04. Arisa, inteligência artificial e voz</h2>
            <p>A Arisa processa solicitações, consulta dados acessíveis ao usuário, analisa documentos e executa ações administrativas conforme as instruções e permissões da organização. Conteúdo de conversas, documentos, registros recuperados e resultados de ferramentas podem ser encaminhados ao provedor de IA utilizado pela plataforma, incluindo a OpenAI, para produzir a resposta ou executar a funcionalidade solicitada.</p>
            <p>O histórico pode alimentar um arquivo de consulta e memórias operacionais com fontes, compromissos e preferências profissionais. Memória da Arisa significa recuperação de informações da organização para dar continuidade ao atendimento; não é treinamento de um modelo público. Os dados obtidos das APIs Google não são utilizados para desenvolver, melhorar ou treinar modelos gerais de IA.</p>
            <p>Ao gravar e enviar uma mensagem, o áudio é processado para transcrição e atendimento. O modo fala encaminha o texto da resposta para síntese de voz. A voz é gerada por IA. Você pode interromper a gravação ou reprodução e revogar o acesso ao microfone nas configurações do navegador ou aparelho.</p>
            <p>Conversas, documentos, transcrições e ações podem permanecer no histórico e na auditoria, conforme a finalidade e os critérios de retenção. Análises e memórias podem conter erros e ser corrigidas. É possível solicitar revisão de decisões tomadas exclusivamente por tratamento automatizado que afetem seus interesses, nos termos da legislação.</p>
          </section>
          <section id="google"><h2>05. Google Workspace: Gmail, Agenda e Meet</h2>
            <p>A conexão é opcional e depende de autorização na conta Google. De acordo com as permissões concedidas, a Arisa pode:</p>
            <ul><li>Ler e sincronizar mensagens do Gmail, remetentes, destinatários, assuntos, conteúdo e anexos; pesquisar o histórico e enviar e-mails solicitados.</li><li>Consultar calendários, compromissos e disponibilidade; criar, alterar ou cancelar eventos; registrar participantes e acompanhar respostas aos convites.</li><li>Gerar links do Google Meet associados aos eventos e incluí-los nas comunicações.</li></ul>
            <p>Cópias de e-mails e anexos, eventos e resultados das ações podem ser armazenadas na plataforma e utilizadas nas consultas e memórias operacionais da Arisa. A caixa corporativa conectada e seu arquivo ficam disponíveis aos administradores autorizados da organização. Trechos necessários podem ser processados pela IA para as funções descritas nesta política. Gerar um link Meet não concede, por si só, acesso ao áudio, vídeo ou gravação da reunião.</p>
            <p>O uso e a transferência de informações recebidas das APIs Google seguem a <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, incluindo os requisitos de <em>Limited Use</em> (uso limitado). Esses dados não são vendidos, utilizados para publicidade personalizada ou avaliação de crédito. Acesso humano ao conteúdo deve ficar restrito às autorizações específicas e às exceções previstas nessa política do Google.</p>
            <div className={styles.note}><strong>Desconectar não é excluir o histórico.</strong><p>Você pode desconectar a integração na Arisa e remover sua autorização em <a href="https://myaccount.google.com/connections">Conexões da Conta Google</a>. Isso interrompe novos acessos autorizados pela conexão, mas não apaga automaticamente cópias previamente arquivadas. A exclusão dessas cópias deve ser solicitada pelo canal indicado abaixo.</p></div>
          </section>
          <section id="whatsapp"><h2>06. WhatsApp e serviços da Meta</h2>
            <p>Quando o canal estiver habilitado, utilizamos a WhatsApp Business Platform para enviar e receber comunicações empresariais. São tratados número de telefone, identificação disponível do contato, conteúdo das mensagens, identificadores de conversa, datas, respostas, estados de envio ou entrega e metadados de arquivos recebidos. O conteúdo de arquivos pode ser tratado quando importado para uma funcionalidade da plataforma.</p>
            <p>As mensagens podem ser vinculadas ao cadastro e ao histórico administrativo ou comercial correspondente. Os envios seguem as autorizações aplicáveis e as regras da Meta para início de conversa e modelos de mensagem. Você pode solicitar a interrupção de comunicações promocionais pelo próprio canal ou pelo contato de privacidade.</p>
            <p>Meta e WhatsApp também tratam dados conforme seus termos e a <a href="https://www.whatsapp.com/legal/privacy-policy">Política de Privacidade do WhatsApp</a>. Desvincular o canal não elimina automaticamente as mensagens já arquivadas nem aquelas presentes no aparelho do destinatário.</p>
          </section>
          <section id="compartilhamento"><h2>07. Compartilhamento e transferências internacionais</h2>
            <p>Os dados podem ser acessados por colaboradores e prestadores autorizados conforme sua função, por destinatários de mensagens e convites e por parceiros envolvidos na operação solicitada. Também podem ser tratados por fornecedores de hospedagem, banco de dados, autenticação, comunicação e IA, como Vercel, Supabase, Google, Meta/WhatsApp e OpenAI, conforme o serviço utilizado.</p>
            <p>Compartilhamos informações necessárias à execução das funcionalidades e, quando cabível, ao cumprimento de obrigações legais, ordens de autoridades ou defesa de direitos. Não comercializamos dados pessoais. Informações enviadas a destinatários externos passam também a integrar os sistemas sob responsabilidade desses destinatários.</p>
            <p>Alguns fornecedores podem processar ou armazenar dados fora do Brasil. Essas transferências devem observar os mecanismos e garantias aplicáveis da LGPD e da regulamentação da ANPD, inclusive instrumentos contratuais pertinentes. A localização e as condições de tratamento dependem do fornecedor e da configuração do serviço.</p>
          </section>
          <section id="seguranca"><h2>08. Segurança, cookies e armazenamento local</h2>
            <p>A plataforma utiliza conexão HTTPS, autenticação, controle de acesso por organização e perfil, armazenamento privado de documentos e registros de operações. Credenciais de integrações são tratadas no servidor. Nenhum sistema elimina integralmente o risco de incidentes; ocorrências relevantes devem ser avaliadas e comunicadas conforme os requisitos legais.</p>
            <p>Cookies e armazenamento local do navegador podem manter a sessão, preferências e o funcionamento da aplicação. Registros técnicos da infraestrutura ajudam a identificar erros e abuso. Bloquear ou apagar esses dados pode encerrar sua sessão e alterar preferências. Esta página de política não adiciona ferramentas de publicidade ou rastreamento analítico.</p>
            <p>Permissões de microfone, câmera ou localização, quando uma funcionalidade as solicitar, são controladas pelo navegador ou dispositivo e podem ser revogadas.</p>
          </section>
          <section id="retencao"><h2>09. Retenção e exclusão</h2>
            <p>Conservamos dados enquanto necessários à finalidade, à relação contratual, ao cumprimento de obrigações, à auditoria ou ao exercício de direitos. A duração depende da categoria do registro e das exigências aplicáveis; não há um prazo único para todos os dados.</p>
            <p>Encerrar uma conta, apagar um e-mail no Gmail, invalidar uma memória ou desconectar uma integração não apaga automaticamente documentos, cópias e registros de auditoria da plataforma. A solicitação de exclusão é analisada para abranger as fontes, cópias e dados derivados pertinentes. Quando a eliminação não for cabível, informaremos o motivo da conservação e as restrições aplicáveis.</p>
            <p>Dados sem necessidade de conservação devem ser eliminados ou anonimizados de forma adequada. Cópias de segurança podem permanecer até sua substituição conforme o ciclo aplicável, com acesso restrito. Não oferecemos nesta página um apagamento automático: o pedido é encaminhado à equipe responsável.</p>
          </section>
          <section id="direitos"><h2>10. Seus direitos</h2>
            <p>Nos termos da LGPD, você pode solicitar:</p>
            <ul><li>Confirmação de tratamento, acesso e correção de dados.</li><li>Informação sobre compartilhamentos e sobre a possibilidade e as consequências de não fornecer consentimento.</li><li>Anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade.</li><li>Eliminação de dados tratados com consentimento, ressalvadas as hipóteses legais de conservação, e revogação desse consentimento.</li><li>Portabilidade, observada a regulamentação, e oposição a tratamento realizado em desconformidade com a lei.</li><li>Revisão de decisões exclusivamente automatizadas que afetem seus interesses e informações sobre os critérios utilizados, resguardados os segredos comercial e industrial.</li></ul>
            <p>As solicitações são gratuitas e podem exigir confirmação proporcional de identidade. Respondemos nos prazos e condições legais. Você também pode apresentar petição à <a href="https://www.gov.br/anpd/pt-br">Agência Nacional de Proteção de Dados (ANPD)</a> e aos órgãos competentes.</p>
          </section>
          <section id="contato"><h2>11. Contato e solicitações sobre dados</h2>
            <p>Para dúvidas, acesso, correção, exclusão ou outras solicitações, envie um e-mail ao canal corporativo abaixo, destinado ao encaminhamento à equipe responsável:</p>
            <a className={styles.email} href="mailto:arisa@evoraurbanismo.com.br?subject=Privacidade%20-%20Solicita%C3%A7%C3%A3o%20do%20titular">arisa@evoraurbanismo.com.br ↗</a>
            <p>Use o assunto <strong>“Privacidade — Solicitação do titular”</strong>. Informe seu nome, um meio de retorno, a relação com a Évora e o que deseja solicitar. Para exclusão, indique os serviços envolvidos, como conta, conversa, e-mail, WhatsApp ou documento. Não envie senhas, tokens ou documentos de identificação completos no primeiro contato.</p>
            <p>Não é necessário possuir login na plataforma para enviar a solicitação. Uma resposta automática de recebimento não significa que os dados já tenham sido excluídos; a conclusão depende da análise e confirmação da equipe responsável.</p>
          </section>
          <section id="atualizacoes"><h2>12. Atualizações desta política</h2>
            <p>Esta política pode ser atualizada para refletir alterações nos serviços, finalidades ou requisitos aplicáveis. A versão vigente e a data de atualização ficam disponíveis nesta página. Mudanças relevantes serão comunicadas pelos canais apropriados; quando necessário, será solicitada nova autorização antes do novo tratamento.</p>
            <p>Referência legal: <a href="https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/L13709compilado.htm">Lei nº 13.709/2018 — Lei Geral de Proteção de Dados Pessoais</a>.</p>
          </section>
        </article>
      </div>
    </main>
    <footer className={styles.footer}><span>Évora Urbanismo · Arisa e Évora Gestão</span><a href="#conteudo-principal">Voltar ao início ↑</a></footer>
  </div>;
}
