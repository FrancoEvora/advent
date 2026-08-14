# Vitória — runtime tenant da Évora Enterprise

A Vitória opera exclusivamente em modo sombra nesta etapa.

## Fonte de configuração

A configuração principal é tenant-scoped e persistida pelo CRM. A chave da API OpenAI é armazenada no Supabase Vault; tabelas da aplicação mantêm apenas o identificador do segredo e metadados seguros. Variáveis `OPENAI_*` e `CRM_AI_SHADOW_ENABLED` de ambiente permanecem apenas como compatibilidade legada e não substituem uma configuração tenant persistida.

## Fluxo

1. Lead Meta é ingerido pelo modelo canônico do CRM.
2. A primeira atribuição Meta aciona o trigger `crm_opportunity_attributions_vitoria_enqueue`.
3. O trigger só enfileira quando a organização está habilitada e possui vínculo de chave no Vault.
4. O dispatch imediato chama `enterprise-ai-worker`; um recovery queue-aware roda a cada minuto.
5. O Edge worker valida bearer interno armazenado no Vault, carrega o runtime tenant e processa a fila.
6. Vitória gera um rascunho e o Supervisor de Excelência revisa `approve`, `revise` ou `block`.
7. Apenas rascunhos aprovados/revisados são gravados, sempre com `delivery_status = draft`.

## Garantias desta versão

- nenhuma mensagem externa é enviada;
- preço, estoque, desconto, proposta e reserva continuam bloqueados;
- runtime desabilitado cancela jobs antes de chamar a OpenAI;
- duplicidades Meta não geram múltiplos jobs para a mesma oportunidade;
- a chave OpenAI nunca é devolvida pela API administrativa nem exibida após ser salva;
- `anon` e `authenticated` não acessam a tabela privada nem as credenciais de runtime;
- falhas da camada IA são fail-open em relação à captação Meta.
