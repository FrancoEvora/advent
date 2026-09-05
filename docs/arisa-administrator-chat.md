# Arisa — conversa administrativa (6.29)

## Acesso e comportamento

`/arisa` usa o mesmo visual mobile da Bia, mas exige uma sessão Supabase com vínculo administrativo ativo em uma organização ativa. Conversas são privadas por usuário e organização, com endereço `/arisa?conversa=<uuid>`. A Bia e os horários existentes de insights não são alterados.

A Arisa consulta o catálogo atual de dados, resolve nomes para identificadores reais e executa instruções administrativas explícitas. Não há confirmação adicional automática para toda alteração. Ambiguidades e informações ausentes são tratadas na conversa. Consultas e documentos isolados não autorizam mudanças não solicitadas.

## Recursos

### Instalação no iPhone (6.29.1)

Abra `https://advent-tau.vercel.app/arisa` no Safari, use Compartilhar → Adicionar à Tela de Início e mantenha "Abrir como App da Web" ativado, quando disponível. O ícone abre a Arisa em modo aplicativo, sem as barras do Safari; os indicadores do iOS permanecem sob controle do sistema. Um atalho antigo que abre a raiz precisa ser removido e adicionado novamente após a publicação.

A Arisa tem manifesto próprio (`/arisa/manifest.webmanifest`), com `id`, `start_url` e `scope` em `/arisa`. A instalação não fixa o identificador de uma conversa privada. Ícones PNG dedicados (512 px e Apple 180 px) e áreas seguras protegem o cabeçalho, o rodapé e o menu em iPhones com recorte de tela. A configuração de instalação da plataforma e a Bia permanecem inalteradas. Login continua obrigatório; instalar não concede acesso administrativo nem habilita funcionamento offline.

Verificação: `node --test tests/arisa-installation.test.mjs tests/public-agent-mobile-viewport.test.mjs`. A confirmação final da instalação em tela inicial requer um iPhone real.

### Operações

- Consultas e agregações completas (financeiro, CRM, obras, contratos, RH, agenda, marketing, pós-venda e administração).
- Cadastros e alterações em entidades autorizadas no catálogo; controle otimista por revisão para não sobrescrever trabalho concorrente.
- Rotinas transacionais de designação/atividade/arquivamento de CRM, documentos, medições, contratos e obras.
- Aprovação/programação financeira; registro de pagamento já realizado. Não há transferência PIX/TED neste chat.
- Alteração de função, ativação/suspensão de membros e permissões. Credenciais e exclusão de identidade continuam na tela administrativa segura, sem senhas gravadas no chat.
- Documentos privados, até 5 por mensagem, até 8 MB cada: PDF, PNG/JPEG/WebP, XML, CSV, OFX, texto e áudio. O processamento financeiro reutiliza Arisa Operações e sua deduplicação.
- Gravação de até 90 segundos; transcrição revisável antes de enviar. Requer acesso do projeto OpenAI ao modelo de transcrição. Falha de provedor preserva o anexo e permite digitar.
- Não há ferramenta de envio externo de WhatsApp/e-mail neste chat; canais atuais da Bia permanecem separados.

## Arquitetura e segurança

`arisa-manager` valida Bearer via `auth.getUser`, depois chama o catálogo com o token do usuário, antes de consultar credenciais internas. O gateway JWT legado está desligado porque a função realiza essa autenticação explicitamente e suporta as chaves rotacionáveis nativas. Chamadas sem sessão ou com token inválido retornam 401.

Chaves privadas permanecem no Supabase. O cliente nunca recebe a chave de serviço nem a chave OpenAI. Todas as ferramentas de consulta e mutação usam o cliente do próprio usuário. O cliente administrativo serve somente para credenciais internas, concessão/conclusão do processamento e vínculo documental validado.

Tabelas de conversas/anexos/ações têm RLS, leitura privada e nenhuma escrita direta para `authenticated`. Mutações passam por funções com validação administrativa, organização obrigatória, referências da mesma organização, revisão do registro e concessão de execução. Funções `SECURITY DEFINER` públicas são intencionais; o aviso informativo [0029 do Supabase](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) exige esta revisão, não remoção da autorização interna.

Cada mensagem é salva antes da geração. Cada alteração e sua auditoria são atômicas. Chaves semânticas estáveis, independentes da redação do resumo e da revisão, impedem repetir uma operação confirmada da mesma mensagem. Uma concessão expirada não permite que um trabalhador antigo altere dados na concessão nova. A retomada informa ao modelo os identificadores das ações já concluídas. Metadados armazenam modelo, tokens, quantidade de ferramentas e referência de suporte. Estimativa monetária fica explicitamente indisponível até configurar preços; não há preço inventado.

Arquivos e registros consultados são dados não confiáveis, nunca comandos. Não existe ferramenta de SQL livre, acesso a segredos ou execução arbitrária de código. Transferências bancárias e invariantes de contratos assinados não são simuladas por mudanças isoladas de estado.

## Verificação

`node --test tests/arisa-manager.test.mts tests/arisa-manager-handler.test.mts`

O CI também executa `deno check supabase/functions/arisa-manager/index.ts`, as regressões documentais/CRM, lint, TypeScript e build. Testes SQL transacionais com organizações sintéticas verificaram catálogo, CRUD, isolamento, revisões, concessões, idempotência, auditoria, criação financeira, aprovação atômica, baixa e fuso da agenda; todos foram revertidos.

O teste final de conversa e voz com o provedor exige uma sessão administrativa real. Não se criam tokens artificiais nem se alteram usuários reais para contornar essa exigência.

## Publicação

1. Aplicar `20260905144610_arisa_administrator_chat.sql`.
2. Publicar `arisa-manager` com ambos os arquivos compartilhados.
3. Verificar 401 anônimo/token inválido, RLS e contratos SQL.
4. Publicar a interface pelo fluxo GitHub/Vercel, preservando os testes obrigatórios.
5. Conferir `/arisa`, acesso privado e a versão 6.29 no domínio principal.
