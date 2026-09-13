# Atendimento inicial da Bia por campanha

A rotina inicia o WhatsApp para novos leads de campanhas habilitadas e avisa o administrador pelo mesmo fluxo de notificações já usado pela Arisa. O piloto usa Solaris — Plano Safra 2026. Não existe inscrição retroativa de leads.

## Origem e mensagem

- Formulário do site: configuração interna vinculada ao slug `solaris-futura-casa`; não usa UTM enviada pelo visitante para escolher oferta ou autorizar envio.
- Meta: campanha e formulário exatos configurados no servidor. A fila só é criada no fim da transação de importação, depois de guardar respostas e verificações de identidade.
- Template pt_BR: `bia_plano_safra_2026`, consultado na Graph API antes de cada primeiro envio. Só envia quando APPROVED.
- O modelo de indicação `bia_indicacao_investimento` continua reservado ao fluxo manual já existente.
- A autorização de contato do formulário Meta revisado é restrita ao Solaris. Ela não altera o consentimento geral de marketing do contato.

## Execução e monitoramento

Triggers acionam `bia-campaign-outreach` no servidor. O cron `evora-bia-campaign-outreach-1m` reconcilia cadastros e recupera falhas antes do envio. O processamento não depende da plataforma aberta. O tempo-alvo é até aproximadamente um minuto depois da entrada no CRM; a importação da Meta tem sua própria latência.

A fila guarda identidade do cadastro, origem, telefone, consentimento e respostas conhecidas. Uma reserva atômica revalida campanha, administrador, CRM, opt-out, pausa humana, bloqueio de contato e revisão de identidade. Impede nova abertura automática para telefone já atendido. Limite compartilhado do canal: cinco aberturas por minuto. Cadastros pendentes expiram após 24 horas.

Tentativas com resultado incerto não são reenviadas automaticamente. Webhooks podem reconciliar a confirmação posterior. Novas tentativas antes da reserva usam o mesmo ID de operação.

Quando a Meta aceita a abertura, a transação cria um aviso único no `activity_notifications` e um trabalho na fila `arisa_whatsapp_notice_jobs`. O administrador recebe o modelo atual de aviso via WhatsApp conforme suas preferências existentes; no sino e na agenda ficam o nome, a campanha, final do telefone e os detalhes. O sino oferece acesso ao histórico da Bia. “Aceita pela Meta” não significa entregue ou lida: acompanhe os status no histórico.

A continuação do atendimento recebe o contexto da campanha e a finalidade já informada (morar, investir ou avaliando). A Bia consulta condições atuais nas ferramentas, faz uma pergunta por vez e respeita encaminhamento humano. “Não tenho interesse” interrompe a automação.

## Operação

Configuração privada: `crm_private.bia_campaign_outreach_settings`.
Habilitar uma campanha exige administrador ativo, destinatário de aviso, empreendimento, modelo e fontes verificadas. O marco `activated_at` exclui os registros anteriores. `enabled=false` pausa novos envios sem apagar histórico.

Nunca use modelos que alegam indicação para leads de anúncio. Para outra campanha, revise o texto e a autorização de contato antes de configurar sua origem e seu modelo.

## Validação

- `node --test tests/bia-campaign-outreach.test.mts tests/bia-whatsapp-outbound.test.mts`
- Deno check no worker e no gateway.
- `supabase/tests/bia_campaign_outreach_rollback.sql`: captura do site, idempotência, reserva, consentimento revogado, exclusão de antigos, Meta com contexto após commit, notificação única, contexto de resposta e opt-out. Transação revertida, sem Graph send.

