# Évora Enterprise — canais e atendimento

## Entrega

- Nova área `/crm/comunicacao`, integrada à navegação do CRM existente.
- Fila baseada nos leads reais carregados, com filtros por responsável, origem, tag, ausência de primeira resposta registrada e retorno vencido. Os números não são apresentados como contagem de mensagens não lidas.
- Acesso à ficha, histórico de conversas, registro de atendimento, retorno e distribuição já existentes.
- Respostas rápidas compartilhadas com criação, edição, busca, pausa e cópia. Estas respostas não são templates aprovados pela Meta e não enviam mensagens automaticamente.
- WhatsApp Embedded Signup com troca do código no servidor, verificação da vinculação número/WABA, armazenamento no Vault e solicitação da assinatura do webhook existente.
- Instagram Login com retorno autenticado, token de longa duração no Vault, identificação do perfil e data de expiração. A renovação é feita pelo mesmo botão.
- Estado OAuth assinado, vinculado ao usuário, organização, cookie HttpOnly e prazo de dez minutos; cada tentativa é consumida uma vez no banco.

## Preservação das assistentes

A Arisa mantém o canal administrativo, permissões de administrador e histórico próprios. A Bia mantém a identidade da Futura Casa, supervisão, automações e consultas comerciais existentes. Nenhum prompt, motor de IA, webhook receptor, regra de envio, gatilho de CRM ou histórico das assistentes foi substituído.

A conexão não altera `enabled` ou `mode` da Bia, nem a configuração independente da Arisa. Número/WABA já cadastrados não podem ser trocados pelo novo fluxo. Renovações conferem o aplicativo existente antes de salvar novas credenciais.

## Configuração inicial exigida

A migration `20260907103037_enterprise_meta_onboarding.sql` foi aplicada ao projeto Supabase existente. Adiciona tabelas privadas e funções com verificação de permissão; não migra registros nem ativa canais.

Configure no ambiente de destino os nomes documentados em `.env.example`:

- `META_ONBOARDING_ORIGIN`: origem HTTPS exata do Enterprise, sem barra final.
- `META_ONBOARDING_STATE_SECRET`: segredo aleatório com ao menos 32 caracteres.
- `META_APP_ID`, `META_APP_SECRET`, `META_WHATSAPP_CONFIG_ID`: aplicativo e configuração de Embedded Signup.
- `META_INSTAGRAM_APP_ID`, `META_INSTAGRAM_APP_SECRET`: credenciais do Instagram Login.
- `META_GRAPH_API_VERSION`: versão explicitamente configurada, preservando a convenção do projeto.
- Configuração Supabase pública e chave exclusiva de servidor já utilizadas pelas integrações existentes.

Cadastre na Meta o redirect exato `<META_ONBOARDING_ORIGIN>/integrations/meta/callback`, domínios autorizados e os produtos/permissões correspondentes. A Meta exige autorizações da empresa e eventuais revisões do aplicativo. A interface mantém os botões indisponíveis enquanto o servidor/banco estiverem incompletos. Previews com origem diferente não podem conectar contas reais.

## Limites explícitos

- Instagram: esta entrega conecta e armazena a autorização do perfil. A ingestão e resposta a Direct, comentários e encaminhamento automático à Bia não estão implementados. A tela informa essa pendência e não afirma que o Direct funciona.
- WhatsApp: a assinatura do webhook pode ser recusada pela Meta. Nesse caso o resultado informa credenciais salvas e recebimento pendente. Registro do número, aprovação, cobrança e restrições da Meta não são tratados como concluídos pelo login.
- Nenhum envio real foi usado para teste. A ativação das assistentes continua pelos controles existentes.
- Os filtros usam a origem do lead, que pode ser diferente do canal de suas conversas.
- Sem novas campanhas em massa ou alteração das cadências em funcionamento.

## Verificação

- Build completo, TypeScript e lint sem erros; avisos preexistentes no projeto.
- 41 testes de autorização OAuth e regressão dos contratos de WhatsApp/Arisa passaram.
- Migration aplicada; verificados RLS, ausência de leitura direta das tabelas por `authenticated` e ausência de execução anônima das funções públicas.
- Os avisos informativos de RLS sem políticas nas duas tabelas privadas são intencionais: leitura direta é negada; apenas funções autorizadas acessam os registros.
- O fluxo com contas reais Meta depende da configuração do aplicativo e da autorização do titular; não foi exercitado.
