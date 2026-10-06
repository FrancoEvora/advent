# Arisa: WhatsApp Business App Coexistence

A página `/arisa/whatsapp-connect` apresenta a preparação pela YCloud Free, autorizada pelo responsável em 05/10/2026. Ela abre somente links externos de cadastro, painel e documentação, sem enviar identificadores do canal. Não carrega o SDK da Meta, não restaura tentativas antigas e não chama begin, exchange ou finalize. A leitura de estado e auditoria continua exigindo administrador ativo da organização.

A Meta recusou a solicitação de `whatsapp_business_management` avançado após as respostas verdadeiras de uso próprio (sem atender empresas clientes). Não foi confirmada a remoção da permissão do rascunho. Configuração de app/SDK não equivale a aprovação, e acesso de administrador não resolveu o erro #2655111 observado no número real.

Esta entrega prepara o encaminhamento para o provedor. Conta YCloud, credenciais, webhook YCloud → Arisa e elegibilidade ainda estão pendentes; a página informa isso explicitamente e não interpreta abrir um link como conexão concluída. O usuário cria a senha e conclui a verificação no site do provedor. Parar antes do QR, vínculo no iPhone ou sincronização do histórico. O plano Free não exige mensalidade/cartão; tarifas de mensagens são separadas.

Antes de ativar: obter a conta autorizada, configurar credenciais em Vault/schema privado e adaptar a recepção aos eventos YCloud. A assinatura `YCloud-Signature` usa timestamp e HMAC-SHA256 sobre `timestamp.rawBody`; o webhook Meta existente não é compatível. Validar assinatura, janela de tempo, deduplicação e roteamento ao canal pessoal, sem alterar Arisa/Bia. Só marcar conectado após confirmação real dos ativos e coexistência. Não há essa integração ativa nesta entrega.

Referências do provedor: [preços](https://www.ycloud.com/pricing?showCompare=true), [coexistência](https://helpdocs.ycloud.com/help-center/whatsapp-accounts-management/create-a-whatsapp-api-account/whatsapp-business-app-coexistence), [webhooks](https://docs.ycloud.com/reference/configure-webhooks), [termos](https://www.ycloud.com/terms-service).

## Implementação direta anterior (preservada no servidor, sem acionamento pela página)

Os endpoints Next encaminham requisições para a Edge Function `arisa-whatsapp-connect` no projeto Supabase existente. A credencial de serviço é obtida no ambiente protegido da Edge Function; não é necessária uma nova chave na Vercel. O mesmo módulo de callback é utilizado pela função e pelos testes. A verificação JWT do gateway fica desativada para receber webhooks, mas as ações do usuário validam JWT e administrador no código, e os webhooks exigem HMAC.

- SDK oficial, Graph v26.0, `featureType: whatsapp_business_app_onboarding`, apenas produto WhatsApp Cloud API e permissões de WhatsApp.
- `POST /api/arisa/whatsapp-connect` cria uma sessão com nonce aleatório de 256 bits. A base armazena somente SHA-256 do nonce; sessão vinculada a administrador, organização e canal, com limite de cinco tentativas por hora.
- `POST /api/arisa/whatsapp-connect/callback` troca o código imediatamente, separado da chegada do postMessage. Código não é persistido ou registrado. GET recusa códigos na URL.
- Tokens são armazenados no Vault. Configuração e referências ficam em schema privado; RPC administrativa é exclusiva da chave de serviço. O navegador recebe somente IDs públicos, estado e número mascarado.
- Finalização exige evento específico de Business App e verifica token/app/scopes na Meta, além de `is_on_biz_app=true` e `platform_type=CLOUD_API`. WABA e Phone Number ID dos canais atuais da Arisa/Bia são protegidos no banco antes de qualquer assinatura.
- O servidor assina webhook específico do segundo canal e solicita contatos e histórico, exigidos pela Meta dentro de 24 horas. Cada operação é registrada antes da chamada. Falhas ambíguas exigem conferência, sem repetição automática de operações permitidas apenas uma vez.
- `connected` significa coexistência verificada e solicitações de sincronização aceitas. Progresso de histórico vem dos webhooks e somente 100% indica recebimento completo.
- `GET/POST /api/arisa/whatsapp-connect/webhook/[connectionId]` faz verificação do challenge, HMAC SHA-256 sobre bytes originais, WABA/phone exatos e deduplicação. Inbox privada guarda eventos assinados, com limpeza de eventos de mais de 30 dias quando novos eventos chegam ao mesmo canal. Nenhum worker de resposta lê essa inbox.
- Eventos `account_update` não suportam override na Meta. O callback existente preserva sua URL e delega somente eventos reconhecidos de WABA pessoal verificada. Arisa/Bia continuam com o proxy e as Edge Functions existentes.
- O navegador guarda na sessionStorage apenas dados temporários da tentativa (nonce, IDs, validade e indicação de autorização); nenhum código OAuth ou token Meta é persistido. Retomada na mesma aba é possível enquanto a sessão de 20 minutos está válida.
- Não há chamada a register, deregister, migração, remoção de número ou envio de mensagens. Respostas automáticas continuam proibidas por constraint no banco.

## Configuração instalada

App Meta Arisa `2341160449962178`, configuração `2669760446794137` (Arisa Coexistence), WhatsApp Cloud API e token de usuário do sistema com expiração de 60 dias. Domínio e retorno OAuth limitados ao Enterprise. Credencial existente do Vault validada na Graph API como pertencente ao Arisa. Campos messages, account_update, history, smb_app_state_sync e smb_message_echoes assinados em v26.0.

Os termos de Provedor de Tecnologia foram aceitos após autorização explícita do usuário. A empresa está verificada, mas o app não tem as permissões avançadas exigidas pelo fluxo de coexistência observado. O pedido direto permanece em rascunho; não declarar aprovação ou elegibilidade. O caminho do provedor foi escolhido para o uso próprio, sem declarar prestação de serviço a terceiros.

## Verificação

Testes de origem, autenticação, administrador, nonce, replay, dados sanitizados, callback, coexistência, proteção dos canais atuais, assinatura de webhook, sync sem repetição e cancelamento. Testes transacionais no Supabase com rollback validaram privilégios, administrador, nonce, replay, proteção do canal primário, campos obrigatórios e automação desativada. Build inclui lint, TypeScript e auditoria npm.

## Fontes

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override
