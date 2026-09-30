# Bia Dot — conexão autenticada com o Évora Enterprise

## Endpoint

MCP remoto: `https://enterprise.terraragroup.com.br/mcp`

O servidor é stateless, usa JSON-RPC via Streamable HTTP e expõe somente ferramentas de leitura do Residencial Solaris.

## Autenticação

O servidor implementa OAuth 2.1 Authorization Code + PKCE S256 para o cliente oficial do ChatGPT:

- Client ID metadata document: `https://chatgpt.com/oauth/client.json`
- Redirect URI: `https://chatgpt.com/connector_platform_oauth_redirect`
- Resource: `https://enterprise.terraragroup.com.br/mcp`
- Scope: `solaris:read`
- Authorization endpoint: `https://enterprise.terraragroup.com.br/oauth/authorize`
- Token endpoint: `https://enterprise.terraragroup.com.br/api/oauth/token`

A tela de consentimento usa a autenticação Supabase já existente no Enterprise. O backend valida o usuário no Supabase Auth e exige vínculo ativo como `admin` na organização da Évora.

O código de autorização dura 5 minutos. O access token delegado dura 1 hora e o refresh token 30 dias. Tokens são opacos, rotacionados e armazenados somente como SHA-256. A associação administrativa é revalidada em toda chamada MCP.

## Ferramentas

- `get_profile`
- `list_projects`
- `search_leads`
- `get_lead`
- `get_inventory`
- `get_lot`

Não existem ferramentas de envio de WhatsApp, reserva, alteração de lead, mudança de preço ou proposta nesta versão.

Leads não expõem telefone, e-mail, CPF/CNPJ, renda, endereço, notas ou conversas. Estoque não expõe preço mínimo interno ou justificativa estratégica. Preço de tabela é identificado como não vinculante.

## Conexão no ChatGPT

Depois que o deployment estiver em produção, a criação da conexão personalizada depende de uma ação do usuário no ChatGPT:

1. Abrir **Settings > Plugins > Advanced settings** e habilitar **Developer mode**, caso ainda não esteja habilitado.
2. Abrir **Plugins**, selecionar **+** e adicionar um MCP personalizado.
3. Informar `https://enterprise.terraragroup.com.br/mcp`.
4. O ChatGPT descobrirá os metadados OAuth, abrirá a tela de consentimento da Évora e solicitará login administrativo.
5. Autorizar **solaris:read**.
6. No Dot, habilitar o plugin da Évora e solicitar uma consulta de teste, por exemplo: “Consulte o lote SOL-A-03 no Évora Enterprise”.

A instalação/conexão no ChatGPT requer interação explícita do titular da conta. O servidor não cria ou instala um Dot remotamente.

## Evidência de teste

Uma consulta é considerada comprovadamente executada pelo Dot somente quando:

- o Dot registra a chamada de ferramenta MCP;
- o log do Vercel contém `event=evora_mcp_tool` para a mesma janela temporal;
- o dado retornado coincide com a fonte no Enterprise.

Testes locais, chamadas diretas ao Supabase ou chamadas feitas por outra conversa não contam como prova de execução pelo Dot.
