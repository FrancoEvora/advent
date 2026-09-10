# Bia: vendas e atendimento

A experiência pública permanece em `/atendimento/solaris`; `/bia` encaminha para esse endereço sem trocar os cookies ou apagar sessões. A central administrativa está em `/bia/gestao` e exige administrador ativo da organização. O CRM, contatos e oportunidades existentes são preservados.

A interface compartilha cabeçalho, apresentação de mensagens, cálculo de viewport e estilos de conversa da Arisa. O perfil comercial usa somente as ferramentas de estoque, condições, simulações, materiais aprovados, captura de contato, visitas e encaminhamento humano. Não recebe acesso ao financeiro, e-mails, RH ou permissões administrativas da Arisa. O painel do cliente mostra o contexto, simulações e materiais da própria conversa.

## Canal de WhatsApp

As tabelas `crm_private.bia_whatsapp_*` guardam o canal, associação entre remetente e sessão comercial, mensagens e fila de respostas. As chaves ficam no Vault. A credencial do aplicativo Meta pode ser compartilhada por referência; a conta WhatsApp, o telefone, o token de verificação e o segredo do worker são próprios da Bia.

- `bia-whatsapp-webhook`: recebe a conta da Bia pelo callback alternativo do telefone ou da WABA. Reutiliza o validador HMAC da Arisa com o modo `bia`; rejeita telefone ou organização diferentes.
- `bia-whatsapp-replies`: worker autenticado por segredo exclusivo. Reutiliza o gateway comercial com sessão opaca e estável por remetente.
- `enterprise-bia-agent-gateway`: perfil comercial v6, com contexto de canal obtido no banco. Áudios do WhatsApp são baixados apenas de hosts da Meta e transcritos antes de passar pelo mesmo fluxo comercial.

O recebimento é idempotente por ID da Meta e o worker serializa a conversa. Antes de responder, o banco confere novamente o canal, a pausa humana, a interrupção solicitada pelo cliente e a janela de 24 horas, com margem de cinco minutos. Um envio sem confirmação fica `unknown` e não é repetido automaticamente; callbacks correlacionados pelo ID da operação podem reconciliá-lo.

## Primeira mensagem pelo WhatsApp

Na central `/bia/gestao`, **Iniciar conversa** permite informar um número brasileiro, conferir a mensagem aprovada e confirmar que o contato autorizou mensagens pelo WhatsApp. O endpoint `bia-whatsapp-outbound` exige JWT válido (`verify_jwt=true`), valida o usuário no Auth e a associação administrativa atual à organização. As credenciais Meta continuam exclusivamente no Vault e no servidor.

O modelo é `bia_boas_vindas`, idioma `pt_BR`, sem parâmetros. A prévia vem da Meta, e o envio consulta novamente a aprovação e confere o hash do texto revisado. Outros modelos, inclusive `bia_indicacao_investimento`, permanecem preservados. Não há envio em lote ou campanha automática.

Cada tentativa recebe um UUID persistido antes do envio. Repetir esse UUID apenas consulta o resultado; não despacha novamente. Há bloqueio de outra abertura para o mesmo telefone nas últimas 24 horas (exceto rejeição definitiva) e limite de cinco tentativas por minuto por canal. Pausa humana, opt-out, canal desativado e sessão bloqueada impedem novas aberturas. Uma resposta HTTP incerta não autoriza reenvio automático.

O histórico distingue aceita, enviada, entregue, lida, falha e confirmação pendente. Callbacks verificam canal, operação e destinatário; eventos atrasados não rebaixam uma entrega já confirmada. Variantes brasileiras com e sem o nono dígito são usadas somente para associação, preservando o número informado no envio à Meta. A primeira mensagem não cria uma entrada fictícia nem abre a janela de atendimento; a resposta real do cliente entra na mesma conversa e segue o atendimento comercial existente.

No chat público, a ferramenta `preparar_abertura_whatsapp` abre um link para essa revisão, com o telefone explicitamente informado. Ela não envia mensagens nem concede privilégios a quem se apresenta como administrador no texto. A central continua exigindo autenticação e confirmação. O gateway comercial v9 explica esse fluxo, em vez de afirmar que a Bia não possui WhatsApp.

Validação adicional: `node --test tests/bia-whatsapp-outbound.test.mts`, `supabase/tests/bia_whatsapp_outbound_rollback.sql` (sem envio real, com rollback), `deno check` dos dois endpoints e `npm run check`. O teste real deve usar exclusivamente um destinatário explicitamente autorizado pelo operador, com verificação posterior da entrega. Rejeições de pagamento e limitações da Meta são exibidas como falha, não como envio concluído.

Pedidos registrados de atendimento humano pausam as respostas automáticas. A central permite pausar e retomar respostas às próximas mensagens; isso não remove o opt-out do cliente nem envia mensagens antigas. Arquivos que não sejam áudio são preservados no recebimento, com orientação para o cliente explicar a necessidade por texto ou áudio.

## Publicação e operação

1. Aplicar as migrações de canal e de contato/retomada.
2. Configurar a experiência, telefone, WABA e referências do Vault com o canal desabilitado.
3. Publicar o gateway e os dois novos endpoints com suas dependências relativas. Todos têm autenticação própria; `verify_jwt` permanece desabilitado.
4. Assinar a WABA no aplicativo e registrar o callback alternativo no telefone (`/{PHONE_NUMBER_ID}`, campo `webhook_configuration`) ou em `/{WABA_ID}/subscribed_apps`, incluindo `organizationId` e o token de verificação da Bia. O usuário de sistema da credencial Meta precisa estar atribuído à conta da Bia, com acesso ao gerenciamento do telefone e às mensagens.
5. Consultar `/{PHONE_NUMBER_ID}?fields=webhook_configuration` e confirmar que o callback efetivo aponta para a Bia. Um desafio GET bem-sucedido, isoladamente, não confirma que a Meta salvou a configuração. Somente depois dessa confirmação, habilitar o canal e enviar uma mensagem de teste a partir de outro WhatsApp.

Para interromper respostas, desabilitar o canal da Bia. Isso preserva histórico, contatos e oportunidades e não altera a Arisa. As funções e as tabelas da Arisa não precisam ser desabilitadas ou removidas.

Validação: `node --test tests/bia-whatsapp-channel.test.mts`, os testes existentes de webhook da Arisa e comportamento comercial, `tests/bia-whatsapp-database.sql` (transação com rollback), `npm run check` e inspeção visual. O teste SQL exige canal configurado e deve ser executado antes de começar a receber mensagens reais.
