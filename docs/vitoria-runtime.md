# Vitória — runtime nativo do Évora Enterprise

A Vitória possui dois contextos separados no mesmo Enterprise:

- **assistência interna em modo sombra**, que continua produzindo somente rascunhos;
- **atendimento público**, isolado do shell administrativo, autorizado a consultar dados comerciais públicos, captar prospect com consentimento e solicitar bloqueio temporário de unidade.

O visitante não recebe usuário, cookie administrativo, JWT do Supabase nem `service_role`. O canal público usa uma sessão opaca e anônima; gateway, runtime e RPCs internas executam no servidor.

## Fonte canônica

- Conversas e estado: `crm_private.public_agent_sessions`, `public_agent_messages`, `public_agent_dialog_states`.
- Idempotência e recuperação: `crm_private.public_agent_requests`, por sessão e `client_request_id`.
- Cadastro: `contacts`, `crm_records`, conversa e atribuição do CRM por `convert_public_agent_lead`.
- Estoque e bloqueio: `crm_inventory_units` e `crm_unit_reservations` por RPC transacional.
- Condições: `crm_negotiation_parameters`; a simulação v4 lê a política e o preço vigentes no servidor.
- Documentos e mídia: catálogos aprovados e buckets privados, compartilhados por URL assinada.
- Credenciais de IA e bearer interno: Supabase Vault; nunca entram na resposta pública.

## Fluxo público v4

1. `/atendimento/[slug]` abre ou retoma uma sessão anônima HttpOnly.
2. Cada mensagem recebe um UUID estável; retries reutilizam o mesmo identificador.
3. O runtime reivindica um recibo com lease e fencing token antes de executar IA.
4. Estado pendente, nome, telefone, consentimento e unidade ficam no Enterprise, não no navegador.
5. Cadastro e bloqueio são concluídos em uma única transação com a mensagem final.
6. O bloqueio exige autorização de atendimento e confirmação específica da unidade. Marketing permanece opt-in separado.
7. A resposta persistida contém o payload público necessário para restaurar cards comerciais e anexos.
8. Simulações e PDFs são derivados do snapshot canônico de unidade e política; valores enviados pelo navegador não são aceitos como autoridade.

## Integração com a OpenAI

- O navegador nunca chama a OpenAI. Ele fala somente com `/api/public-agent/*` no Next.js.
- O BFF deriva `enterprise-vitoria-agent-gateway` de `NEXT_PUBLIC_SUPABASE_URL` e envia `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` no header `apikey`. O gateway compara esse valor em tempo constante com as chaves válidas de `SUPABASE_PUBLISHABLE_KEYS` e obtém pelo Vault um bearer separado para chamar o runtime interno.
- O runtime usa `POST /v1/responses`, `store: false` e Structured Outputs estrito. A OpenAI interpreta linguagem e devolve intenção estruturada; cadastro, consentimento, simulação e bloqueio são validados e executados pelo Enterprise.
- A chave OpenAI é tenant-scoped em `crm_private.ai_runtime_settings` e permanece no Supabase Vault. O frontend recebe somente estado de disponibilidade, nunca o segredo.
- Áudio gravado é enviado ao BFF, transcrito server-side por `/v1/audio/transcriptions`, persistido em bucket privado e associado ao mesmo turno da conversa.
- A base documental aprovada entra por `file_search` usando `knowledge_vector_store_id`; ausência do vector store não libera fatos fora do contexto comercial canônico.

## Configuração por ambiente

Vercel/Next.js, reutilizando a configuração já exigida pelo ERP:

- `NEXT_PUBLIC_SUPABASE_URL`: URL HTTPS raiz do projeto Supabase daquele ambiente.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: chave publicável correspondente ao mesmo projeto, enviada como `apikey` pelo BFF.

Supabase Edge Functions:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` e `SUPABASE_SERVICE_ROLE_KEY`: variáveis gerenciadas pelo ambiente Supabase.
- bearer interno e chave OpenAI: bindings do Vault já administrados pelo Enterprise.

Não existem defaults nem identificadores de projeto embutidos no código. O gateway só é derivado da URL configurada, exige que a chave esteja entre as chaves publicáveis do mesmo ambiente e mantém o bearer Edge→runtime separado no Vault. Configuração ausente ou divergente falha fechada antes de criar sessão ou chamar a OpenAI. Como `apikey` é publicável, quotas, limites e idempotência permanecem como as barreiras contra abuso; ela não substitui o bearer interno.

## Garantias

- nenhuma autenticação administrativa é compartilhada com visitantes;
- um retry não duplica turno, lead ou reserva;
- duas sessões não conseguem manter bloqueios ativos conflitantes para a mesma unidade;
- um “sim” genérico não concede marketing nem confirma lote;
- a confirmação negativa vence qualquer expressão positiva ambígua;
- o estado “online” e os resultados comerciais não são inferidos apenas pela existência de variáveis de ambiente;
- dados de outros leads, preço mínimo, margem e informações internas não entram no contexto público;
- URLs de documentos e mídia são privadas/assinadas e os tipos compartilháveis usam allowlist.

## Política de implantação

1. Manter no Git todas as migrations já aplicadas no projeto remoto.
2. Validar histórico, reset limpo, lint, tipos, build e testes de contrato.
3. Aplicar migrations aditivas antes do Edge v4.
4. Publicar gateway/runtime com canário de leitura; habilitar escrita somente após smoke tests de consentimento, idempotência e concorrência.
5. Fazer um único corte de escrita. Não executar dual-write de lead ou reserva entre Sites e Enterprise.
6. O Sites pode permanecer como canal visual temporário, mas não deve conter regra de domínio.

### Ordem de release

1. Confirmar que as migrations remotas reconciliadas existem no Git com os mesmos timestamps.
2. Aplicar `20260817031140`, `20260817031143` e `20260817031147` no ambiente de homologação.
3. Publicar `enterprise-vitoria-agent` e depois `enterprise-vitoria-agent-gateway` com os secrets daquele ambiente.
4. Publicar o Next.js apontando exclusivamente para o gateway de homologação.
5. Executar os smoke tests abaixo; só então repetir a ordem em produção.
6. Em rollback, retirar o tráfego do Next/gateway primeiro. As migrations são aditivas e podem permanecer sem serem chamadas.

### Smoke tests obrigatórios

- visitante anônimo inicia e retoma sessão sem JWT administrativo;
- cadastro por conversa com consentimento de serviço e marketing desativado;
- revogação explícita impede nova mutação;
- dois pedidos concorrentes do mesmo lote produzem somente um bloqueio;
- retry do mesmo UUID devolve o mesmo resultado sem duplicar turno, lead ou reserva;
- simulação usa preço/política vigentes e o PDF reproduz o mesmo snapshot;
- áudio grava, transcreve, responde e reaparece após recarregar;
- foto, vídeo e PDF aprovados usam URL assinada;
- indisponibilidade da OpenAI mantém o atendimento recuperável e não executa ação parcial.

### Observabilidade mínima

- correlacionar `clientMessageId`, request do BFF, receipt v4 e IDs de resposta OpenAI;
- registrar somente códigos, duração, modelo, ação e status — nunca prompt completo, telefone, e-mail, áudio, chave ou bearer;
- alertar por taxa de timeout, resposta incompleta, degradação, conflito de idempotência e falha de bloqueio;
- medir latência do agente e do supervisor separadamente antes de definir o perfil final de modelo/esforço.

Geração de imagem e outros trabalhos longos devem usar job durável com polling; não podem compartilhar o lease de uma mensagem síncrona.
