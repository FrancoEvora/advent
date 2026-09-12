# Formulário Solaris / Futura Casa

URL: `/atendimento/solaris/cadastro`. Quatro etapas: nome/WhatsApp e autorização, investir/morar, faixa de valor, confirmação após persistência.

`POST /api/forms/solaris` valida campos e origem, limita tamanho, usa as credenciais de servidor Supabase já existentes e chama `submit_solaris_public_form`. Não retorna dados do CRM, somente o recibo do próprio envio. Não cria acesso anônimo de leitura ou escrita às tabelas. Chaves administrativas nunca chegam ao navegador.

Configuração do formulário em `private.crm_public_forms`. O formulário é vinculado à Évora Urbanismo e ao Solaris; o visitante não escolhe organização ou empreendimento. Os registros ficam em `private.crm_public_form_submissions` e vinculados a `public.crm_records`, visíveis em CRM > Leads para os membros autorizados da organização. Nome e telefone juntos localizam uma oportunidade aberta existente; não substituímos observações ou a origem anterior. Respostas e autorização são preservadas na submissão e acrescentadas às notas do lead.

O UUID da submissão é idempotente. Há limites por telefone, origem de rede e volume global; a rede é armazenada somente como hash por hora com expiração. Erros conservam os campos. Não há envio automático de WhatsApp, alteração de permissões existentes do CRM nem configuração de Meta Pixel nesta migração.

Cadastros legados são importados mantendo UUID, respostas, autorização e data original em `original_created_at`. Fazer uma última leitura da origem antes da troca do anúncio. O endereço antigo deve encaminhar os interessados à plataforma para não manter duas bases de captação.
