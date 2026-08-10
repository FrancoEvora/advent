# Évora Gestão 6.24.2

## Auditoria

- Gate de qualidade ampliado para lint integral, TypeScript, auditoria de dependências de produção e build Next.js.
- Cache PWA, manifesto, metadados e identificação visual sincronizados em 6.24.2.
- Acessibilidade preservada com zoom nativo, skip link, foco visível, alvos de toque e suporte a movimento reduzido/cores forçadas.
- RLS e grants de tabelas internas endurecidos; políticas administrativas otimizadas com `(select auth.uid())`.
- Índices adicionados em relacionamentos críticos de CRM, pós-venda, marketing e importação.
- Auditoria financeira confirmou consistência das equações de propostas, vínculos de parcelas e numeração única; 25 lançamentos liquidados continuam sem `settlement_date` e exigem conciliação documental.

## Validação

- Homologação Vercel: READY.
- ESLint integral: 0 erros, 144 avisos de dívida técnica legada.
- TypeScript: aprovado.
- Build Next.js: aprovado, 15 rotas geradas.
- Dependências de produção: sem vulnerabilidade alta; 2 moderadas em PostCSS/Next pendentes de atualização compatível.

## Pendências controladas

- Reduzir progressivamente os 144 avisos de lint.
- Revisar individualmente funções `SECURITY DEFINER` expostas por RPC, sem interromper portais e fluxos por token.
- Ativar proteção contra senhas vazadas no Supabase Auth.
- Migrar `.env.production` versionado para variáveis de ambiente da Vercel e removê-lo do repositório.
- Planejar atualização do Next.js para versão que elimine o advisory atual de PostCSS.
- Conciliar os 25 lançamentos liquidados sem data de liquidação.
