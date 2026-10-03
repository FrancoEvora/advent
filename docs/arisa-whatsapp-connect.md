# WhatsApp pessoal do Franco: preparação e bloqueio de onboarding

Revisão documental: 03/10/2026. Página: `/arisa/whatsapp-connect`.

## Limite desta versão

O pedido exige verificar elegibilidade sem registrar ou ativar o número. A documentação atual da Meta não apresenta um modo read-only ou um evento de elegibilidade que permita garantir isso. O Embedded Signup de Coexistence é um fluxo de conexão, com alterações na conta antes do retorno ao site. Não chamar `/register` não impede essas alterações.

Esta versão é uma preparação com diagnóstico, **não uma implementação funcional da verificação de elegibilidade**. O botão “Verificar elegibilidade” fica desabilitado, o servidor não abre OAuth, o callback responde 423 sem interpretar o corpo e o banco impede armazenar ativos não verificados ou ativar automação. Nenhuma variável de ambiente habilita esse fluxo. A ativação futura exige outra revisão e autorização explícita.

## Evidências oficiais

- [Onboarding de usuários do Business App](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users): a conclusão converte a conta existente, compartilha ativos e retorna `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; o número já está registrado e a etapa `/register` deve ser omitida. O processo também desvincula dispositivos acompanhantes. O iPhone principal continua suportado, mas isso não é uma consulta sem alterações.
- [Versão 4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4): configuração v4 no Facebook Login for Business; v2/v3 deixam de ser suportadas em 15/10/2026. A ordem phone-number-first ainda está em implantação. Coexistence continua usando `featureType: whatsapp_business_app_onboarding`.
- [Implementação](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation): o SDK retorna `code` e os eventos de sessão. Fechar a janela na tela final também pode ser conclusão bem-sucedida, não cancelamento. Não foi identificado evento `ELIGIBLE` nem parâmetro `dry_run`.

Os campos `is_on_biz_app=true` e `platform_type=CLOUD_API`, consultados em `GET /v26.0/{PHONE_NUMBER_ID}?fields=is_on_biz_app,platform_type`, confirmam coexistência estabelecida. Não são usados como teste prévio de elegibilidade.

## Integração existente examinada

- Vercel `advent`, repositório `FrancoEvora/advent`, domínio `enterprise.terraragroup.com.br`.
- Supabase `evora-gestao` (`qsdffayasuzsmngteika`).
- Funções publicadas: `arisa-whatsapp` v5, `arisa-whatsapp-webhook` v1, `arisa-whatsapp-replies` v7, `arisa-whatsapp-notifications` v1, `arisa-manager` v23.
- Credenciais em Supabase Vault, com referências no schema `crm_private`. A RPC de credenciais é restrita a runtime service role. Esta implementação não chama essa RPC nem lê segredos.
- Canal próprio administrado por `crm_private.arisa_whatsapp_channel`; identificação existente por `phone_number_id`. Bia mantém canais separados. Nenhum webhook, worker, envio, número ou segredo existente é alterado.

## Componentes

- Página administrativa com sessão Supabase já existente, aparência Évora/Arisa e link no painel de WhatsApp.
- `GET /api/arisa/whatsapp-connect?organizationId=…`: status com bearer autenticado e autorização no banco.
- `POST /api/arisa/whatsapp-connect`: somente diagnóstico interno, body `{organizationId,requestId}`; Origin exata, rejeição cross-site, JSON de até 1 KiB, bearer obrigatório (cookies não autenticam) e idempotência.
- `GET/POST /api/arisa/whatsapp-connect/callback`: 423, não lê body/query, não troca nem registra código.
- `arisa_whatsapp_connections`: intenção de conexão `franco_personal`, separada do canal existente; nesta versão todos os identificadores Meta ficam nulos, elegibilidade `unknown` e automação falsa, garantidos por constraints.
- `arisa_whatsapp_connection_audit`: eventos tipados de diagnóstico e bloqueio, sem payload livre. RLS permite apenas proprietário que continua administrador ativo; clientes não podem inserir/alterar/excluir diretamente.
- RPC pública `arisa_whatsapp_connect`, security invoker, delega a implementação privada com auth.uid e checagem administrativa. Limite de 5 novas tentativas/hora por usuário/organização, lock transacional e retries idempotentes. Histórico exibe as últimas 20 ocorrências. Estados gravados: `checking` → `blocked`; nenhum estado `eligible`, `authorized` ou `connected` é inferido.
- Teste explícito carrega o SDK oficial, sem `FB.init`, `FB.login`, concessão de permissão ou coleta de eventos Meta. Confirma somente o download do script e presença dos métodos.
- Não há nova Edge Function: as rotas Next.js fazem as chamadas autenticadas ao mesmo Supabase com chave publicável e bearer do usuário.

## Próxima versão (não autorizada nesta entrega)

Antes de liberar o popup, obter da Meta um modo documentado de elegibilidade sem efeito colateral ou aprovar explicitamente uma alteração de escopo para onboarding real de Coexistence. Um aviso ou interceptação após `FINISH` não é uma barreira anterior à conexão.

Para onboarding real será necessário verificar no painel Meta o App ID, Config ID v4, permissões Advanced Access, domínios HTTPS e o perfil Solution Partner/Tech Provider. Os nomes reservados no servidor são `ARISA_META_APP_ID` e `ARISA_META_EMBEDDED_SIGNUP_CONFIG_ID`; sua presença não comprova elegibilidade nem habilita o fluxo. Não se reutiliza automaticamente um app de anúncios.

O callback futuro precisa de sessão/nonce única e expiração, origens Meta exatas (não `endsWith`), vinculação à janela/sessão, allowlist de eventos, troca server-side de código, comprovação do vínculo dos ativos usando Graph API e persistência de token exclusivamente no Vault. `FINISH` não deve significar `eligible`; `CANCEL`/`ERROR` não devem significar `not_eligible`. IDs de `postMessage` são pistas não autenticadas até a comprovação no servidor.

Antes de ativar recepção ou sincronização, ampliar o roteamento existente para o canal pessoal com isolamento, política de autonomia explicitamente desativada e tratamento dos webhooks de Coexistence. A sincronização tem requisitos próprios descritos pela Meta. Não existe tentativa automática de offboarding, deregistration, mudança de ownership ou fallback para migração tradicional.

## Validação

Testes executáveis: `node --test tests/arisa-whatsapp-connect.test.mts`. Teste SQL em `supabase/tests/arisa_whatsapp_connect_rollback.sql` roda em transação e termina em rollback. Verificar build e lint, status HTTP em produção, bloqueio do callback, SDK sem login e ausência de mudanças nas funções/canais existentes. Login Meta, elegibilidade do número e funcionamento físico do iPhone **não** são certificados por estes testes.

O prebuild detectou o advisory crítico [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) na dependência Next.js 16.3.4 já existente. Next.js e eslint-config-next foram atualizados para 16.3.8, preservando a mesma versão minor e as versões de React. O gate `npm audit --omit=dev --audit-level=high` permanece ativo.
