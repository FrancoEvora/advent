# Arisa: Google Workspace, arquivo e memória

## Acesso e ativação Google

No menu de `/arisa`, abra **E-mail da Arisa**, **Arquivo e conteúdos** ou **Memória da Arisa**. Links diretos: `/arisa?painel=email`, `?painel=archive`, `?painel=memory`. Todos exigem administrador ativo da organização. O endereço de envio é fixo: `arisa@evoraurbanismo.com.br`.

A implementação não significa que o Google esteja autorizado. No projeto Google Cloud da organização:

1. Habilitar Gmail API e configurar o consentimento OAuth com público interno do Google Workspace.
2. Criar cliente OAuth **Aplicativo da Web**, com URI autorizada exatamente `https://advent-tau.vercel.app/arisa/email/callback`.
3. Disponibilizar `https://www.googleapis.com/auth/gmail.send` e `https://www.googleapis.com/auth/gmail.readonly`.
4. Salvar ID e segredo do cliente na tela de e-mail, nunca no chat ou repositório.
5. Clicar **Conectar Google Workspace** e autorizar a conta exata da Arisa. Usar o mesmo navegador em que a sessão administrativa está aberta; em iPhone instalado, realizar a conexão pelo Safari se o retorno Google abrir outra sessão.

Referência: [OAuth para aplicações Web do Google](https://developers.google.com/identity/protocols/oauth2/web-server). O segredo e o refresh token são armazenados no Supabase Vault. O fluxo usa PKCE S256, state aleatório de uso único, validade de dez minutos e vínculo com usuário e organização. O callback remove código/state da barra de endereço. Não há senha SMTP, token ou código de autorização nos logs operacionais. A mesma conta não pode ser conectada a duas organizações simultaneamente.

## Envio e arquivo

O administrador pode compor e-mail na tela ou solicitar explicitamente o envio pelo chat. A mensagem é registrada antes de enviar. MIME original e cópias dos anexos são preservados no bucket privado `arisa-mail`. Há até dez anexos por e-mail, 18 MB no total; uploads individuais do chat/tela aceitam até 8 MB. Textos, Markdown, CSV e HTML gerados com `create_content` podem ser anexados usando o identificador real do arquivo. Não há promessa de gerar formatos não suportados.

Cada pedido tem identificador estável; um pedido do chat produz no máximo um e-mail, com múltiplos destinatários se solicitado. Timeout, 5xx ou resposta inválida do Gmail resultam em `unknown`, nunca reenvio automático. O trabalhador consulta a pasta de enviados pelo Message-ID RFC 822 para conciliar. `sent` confirma aceitação pelo Gmail, não entrega ou leitura. Falha de arquivamento impede novo envio. Testes não enviam mensagens reais.

A sincronização inicial percorre a caixa em páginas. A incremental usa `history.list`; histórico expirado (404) reinicia leitura completa sem duplicar mensagens. MIME e anexos recebidos são copiados antes de avançar o cursor. Uma concessão impede sincronizações concorrentes. Mensagens removidas do Gmail continuam no arquivo da plataforma. Desconectar revoga a autorização quando possível, descarta o token local e preserva o arquivo.

Anexos recebidos podem ser trazidos ao chat pela ferramenta `import_email_attachment`, com verificação de hash, tamanho, assinatura do arquivo, organização e sessão. A Arisa pode então lê-los ou usar o fluxo financeiro existente, conforme solicitado pelo administrador.

## Conhecimento com evidências

O arquivo imutável preserva versões de mensagens da Arisa, mensagens dos canais CRM/Bia, atividades comerciais (incluindo registros de ligações/reuniões), arquivos, transcrições, operações, insights, conteúdos gerados e resultados das ferramentas. O histórico existente é importado. Credenciais e conteúdo interno de raciocínio do modelo não são arquivados. A busca indexa os primeiros 100 mil caracteres de cada conteúdo; a íntegra permanece disponível na fonte e na exportação.

As fontes alimentam uma fila durável, com concessão, tentativas limitadas, modelo, uso de tokens e resultado registrado. O trabalhador usa a configuração OpenAI da organização. Há no máximo oito itens por ciclo agendado, respeitando o tempo disponível; uma carga histórica grande pode levar vários ciclos. O arquivo já pode ser consultado enquanto a extração estruturada continua.

Memórias incluem afirmação, citação literal conferida no original, fonte, autoria, pessoa/organização, data, confiança e validade. Fatos são fatos **relatados**, não certificação independente. Observações e análises têm confiança limitada a 75% e expiram em 90 dias; preferências expiram em um ano. A saída de uma IA não pode confirmar a si própria como fato ou criar perfil pessoal. Registros feitos pela equipe mantêm sua autoria. Conteúdo de terceiros é dado não confiável, nunca autorização de execução ou envio.

Percepções se limitam ao contexto profissional: comunicação, necessidades, objeções, critérios de decisão e compromissos. Não se inferem diagnósticos, atributos sensíveis, vulnerabilidades, caráter ou aptidão para decisões de crédito/emprego. Nomes não unem identidades; CRM usa identificador de cadastro e e-mail usa correspondência exata e única com o contato. O endereço do remetente não comprova identidade civil.

Memórias da conversa administrativa pertencem ao usuário e organização; o conhecimento comercial e a caixa corporativa são visíveis aos administradores da organização. Revisar/corrigir/invalidar um aprendizado grava antes/depois e justificativa. Memórias invalidadas ou expiradas deixam de ser recuperadas pela Arisa. Ela consulta memórias em novas conversas e pode pesquisar a fonte original. Canais futuros precisam registrar suas interações na plataforma para participar desse arquivo.

## Operação e publicação

Migrações: `20260905221010_arisa_archive_memory.sql`, `20260905221021_arisa_google_workspace.sql`, `20260905225034_arisa_archive_invoker_access.sql`, `20260905225316_arisa_crm_activity_archive.sql`.

Publicar `arisa-mail`, `arisa-background` e `arisa-manager`, com seus imports compartilhados. O JWT legado do gateway permanece desligado; as funções de usuário validam Bearer via `auth.getUser` e administrador ativo antes de acessar recursos de serviço. O cron usa segredo dedicado no Vault. Ativar `evora-arisa-memory-mail-5m` somente após publicar as funções. A cada cinco minutos sincroniza a caixa conectada e processa memória. **Não altera o job de insights das 06h em dias úteis**.

Validação: Node (`arisa-mail-memory`, `arisa-mail-handler`, `arisa-manager`, `arisa-manager-handler`), Deno check das três funções, lint, TypeScript e build. `supabase/tests/arisa_mail_memory_rollback.sql` testa isolamento real sob papel authenticated, imutabilidade, evidência, expiração, revisão, credenciais, OAuth e idempotência em transação revertida. Os testes SQL não chamam provedores nem alteram usuários. A validação Gmail ao vivo depende das credenciais e consentimento do Workspace.
