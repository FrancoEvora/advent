# Formulário Solaris / Futura Casa

URL: `/atendimento/solaris/cadastro`. Três etapas: nome/WhatsApp e autorização, investir/morar, confirmação após persistência. A pergunta de faixa de investimento foi removida.

`POST /api/forms/solaris` valida campos e origem, limita tamanho, encaminha com a chave pública da aplicação à função Supabase `solaris-form`, que autentica a chave contra `SUPABASE_PUBLISHABLE_KEYS` e usa as credenciais administrativas internas para chamar `submit_solaris_public_form`. Não retorna dados do CRM, somente o recibo do próprio envio. Não cria acesso anônimo de leitura ou escrita às tabelas. Chaves administrativas nunca chegam ao navegador.

Configuração do formulário em `private.crm_public_forms`. O formulário é vinculado à Évora Urbanismo e ao Solaris; o visitante não escolhe organização ou empreendimento. Os registros ficam em `private.crm_public_form_submissions` e vinculados a `public.crm_records`, visíveis em CRM > Leads para os membros autorizados da organização. Nome e telefone juntos localizam uma oportunidade aberta existente; não substituímos observações ou a origem anterior. Respostas e autorização são preservadas na submissão e acrescentadas às notas do lead.

O UUID da submissão é idempotente. Há limites por telefone, origem de rede e volume global; a rede é armazenada somente como hash por hora com expiração. Erros conservam os campos. Não há envio automático de WhatsApp, alteração de permissões existentes do CRM nem configuração de Meta Pixel nesta migração.

Cadastros legados são importados mantendo UUID, respostas, autorização e data original em `original_created_at`. Fazer uma última leitura da origem antes da troca do anúncio. O endereço antigo deve encaminhar os interessados à plataforma para não manter duas bases de captação.


A função `solaris-form` usa `verify_jwt=false` porque autentica a chave moderna no cabeçalho `apikey` em seu próprio código; chave ausente ou desconhecida recebe 401. O acesso é apenas para envio público validado, sem operações de leitura. A permissão de banco continua restrita a `service_role`. Não é necessário copiar segredos administrativos do Supabase para a Vercel. A função depende apenas de `index.ts`, `validation.ts` e `deno.json`; manter a validação sincronizada com `src/lib/forms/solaris.ts`.

Novos envios omitem a faixa de investimento e são persistidos com `budget`, `budget_min` e `budget_max` nulos. A API aceita valores válidos das versões antigas para manter compatibilidade com abas já abertas e preservar respostas históricas. O cadastro só é confirmado depois do salvamento. A migração de banco e a atualização da função Edge devem preceder a publicação da interface.

A partir de 13/09/2026, a autorização de contato é apresentada em aviso junto ao botão Continuar, sem caixa de seleção. O estado de autorização começa falso e só muda para verdadeiro quando o visitante aciona Continuar com nome e WhatsApp válidos. A API mantém a exigência de `consent: true`; o envio final e o registro da autorização no CRM permanecem obrigatórios. A autorização cobre somente o atendimento sobre o Solaris descrito no aviso.

A apresentação da campanha fica visível antes dos campos também em telas de celular: lotes em Monte Carmelo (MG), Plano Safra 2026, obras em andamento e parceria com a JVF Group, conforme o criativo aprovado. É conteúdo da primeira tela, sem nova etapa de cadastro. O aviso de contato e as três etapas permanecem. A marca original é enquadrada por um viewBox SVG proporcional; não depende de um recorte fixo estreitado no breakpoint móvel. A imagem do anúncio é complementar no desktop; no celular, o resumo textual deixa o formulário próximo da apresentação.
