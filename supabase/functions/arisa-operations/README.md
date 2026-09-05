# Arisa Operações

Recebe apenas `{ action: "process", organizationId, itemId }`. O arquivo deve existir no bucket privado `arisa-operations` e ter sido registrado pela RPC de entrada.

## Publicação

Aplicar primeiro as migrações `arisa_operations_finance`, `arisa_crm_evidence_operations` e `arisa_operations_fk_indexes`. Publicar esta função incluindo `../_shared/arisa-document.ts`, antes da interface.

A publicação usa `verify_jwt=false` no gateway para compatibilidade com as chaves atuais. A autenticação é obrigatória dentro da função: `auth.getUser()` valida o Bearer, as duas permissões são conferidas e a leitura sob RLS confirma a organização antes de obter a reserva de processamento. Não remover essas verificações. Os testes do handler e chamadas sem sessão devem continuar retornando 401.

As credenciais nativas do Supabase permanecem exclusivamente no servidor. PDF e imagens usam a integração OpenAI já configurada na organização; XML NF-e, CSV e OFX são processados sem IA. A função não envia mensagens comerciais, não aprova pagamentos e não liquida títulos.

## Operação

- Até 8 MB por arquivo; extratos com até 500 movimentos em BRL e uma conta bancária ativa selecionada.
- Cadastro automático de documentos completos começa desabilitado. A política permite definir limite de valor; mesmo habilitada, os títulos criados aguardam aprovação financeira.
- A extração original e o histórico são preservados. Correções ficam separadas, e arquivos repetidos não criam nova obrigação.
- A conciliação registra a correspondência entre extrato e título; não executa baixa. Pendências ficam na fila para tratamento.
- O CRM sincroniza último contato e próxima atividade por evidência. O agendamento de insights existente permanece inalterado.

## Verificação

`node --test tests/arisa-crm-operations.test.mts tests/arisa-document-extraction.test.mts tests/arisa-operations-handler.test.mts`

As fixtures em `supabase/tests/arisa_*_rollback.sql` validam integração em transações descartáveis. Executar o arquivo inteiro, incluindo `ROLLBACK`; não executar trechos isolados nem converter as fixtures em migrações.
