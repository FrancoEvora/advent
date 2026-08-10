# Évora Gestão 6.24.3

## Auditoria

- Auditoria incremental de GitHub, Supabase e Vercel cobrindo qualidade, segurança, desempenho, acessibilidade, responsividade, integridade financeira e UX.
- Gate integral mantido: ESLint de toda a base, TypeScript, auditoria de dependências de produção e build Next.js.
- Acessibilidade e responsividade da versão 6.24.2 preservadas: zoom nativo, skip link, foco visível, alvos de toque, reduced motion, forced colors e viewport com safe area.
- Advisors de segurança do Supabase revisados; fluxos públicos por token/assinatura permanecem preservados e funções SECURITY DEFINER seguem em revisão individual.
- Integridade financeira revalidada em 1.040 lançamentos, 18 propostas e 842 parcelas.

## Correções e melhorias

- PostCSS atualizado por override de 8.5.18 para 8.5.23, eliminando os advisories de produção sem alterar a versão do Next.js.
- Links do Portal do Cliente: carregamento estabilizado, logs tipados e geração de expiração sem função impura durante renderização.
- Conteúdo do Portal: carregamento estabilizado, feedback de erro/sucesso efetivamente exibido e tratamento de falha em ativação/desativação.
- Configurações do Portal: dependências do carregamento explicitadas, remoção de `any` no payload e sincronização de estado mais previsível.
- Dívida de lint reduzida de 144 para 135 avisos, sem desabilitar a análise integral da base.
- Uma tipagem estrutural mais rígida do pós-venda foi testada em homologação e não foi promovida após revelar incompatibilidades em telas legadas; a alteração foi revertida antes da aprovação.

## Validação

- Homologação Vercel: READY.
- ESLint integral: 0 erros, 135 avisos legados.
- TypeScript: aprovado.
- Build Next.js 16.2.12: aprovado, 15 rotas geradas.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- Integridade financeira: nenhum valor não positivo, nenhum vínculo cruzado de organização, nenhuma divergência nas equações de preço/financiamento e nenhuma duplicidade de números de proposta ou contrato.

## Pendências controladas

- 25 lançamentos com status pago/recebido continuam sem `settlement_date`; exigem conciliação documental/bancária e não foram preenchidos automaticamente.
- Reduzir progressivamente os 135 avisos legados de lint.
- Revisar individualmente RPCs `SECURITY DEFINER`, distinguindo funções públicas por token das funções estritamente internas.
- Ativar proteção contra senhas vazadas no Supabase Auth.
- Migrar `.env.production` versionado para variáveis gerenciadas na Vercel antes de removê-lo do repositório.
- Revisar advisories de desempenho do Supabase (índices e políticas RLS) de forma progressiva, orientada por uso real.
