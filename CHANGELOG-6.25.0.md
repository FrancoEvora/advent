# Évora Gestão 6.25.0

## CRM canônico e Meta Lead Ads

- Pessoa, oportunidade, produto, origem e atribuição de mídia permanecem entidades canônicas do Évora Enterprise, sem CRM paralelo.
- Entrada de Formulários Instantâneos da Meta com validação HMAC, idempotência por `meta_lead_id`, inbox durável, retry, dead-letter e retenção minimizada.
- Enriquecimento de campanha, conjunto, anúncio, criativo e formulário pela Graph API, com trilha auditável para o Campaign Control.
- Identificação conservadora por WhatsApp/e-mail, múltiplas oportunidades por contato e bloqueio de conflitos de identidade para revisão humana.
- Distribuição para SDR/corretor com continuidade, fallback obrigatório, SLA de primeiro contato e histórico append-only.

## Configuração e segurança

- Administração de páginas, formulários e roteamento Meta dentro das configurações do CRM.
- Credenciais Meta armazenadas criptografadas no Supabase Vault e manipuladas por endpoints/RPCs server-side; segredos nunca retornam ao navegador.
- Rotas começam inativas e só podem ser ativadas com contexto comercial, responsável de contingência e credenciais válidas.
- Dados brutos de webhook ficam fora da Data API, com acesso negado aos papéis do frontend e política de retenção.

## Validação da entrega

- Migration PostgreSQL analisada com controles de tenant, ACL/RLS, fencing de leases e locks de concorrência.
- Testes de webhook, assinatura, normalização e contratos RPC aprovados.
- TypeScript, ESLint direcionado e build Next.js aprovados antes da publicação.

## Ativação do piloto Solaris

- Página Meta prevista: `1296933085661158`.
- A ativação depende do ID do Formulário Instantâneo, credenciais Meta válidas, equipe/responsável de fallback e teste real de lead.
- A Edge Function temporária insegura identificada na auditoria deve ser desativada e suas credenciais rotacionadas antes do piloto em produção.
