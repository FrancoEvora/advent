# Segurança

O Évora Gestão usa autenticação Supabase e políticas RLS no PostgreSQL.

- Nunca publique chaves `service_role` no frontend ou no GitHub.
- Use somente `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` no navegador.
- Mantenha as políticas RLS ativas em todas as tabelas expostas.
- Revise dependências e alertas do Dependabot antes de atualizar produção.
- Para comunicar uma vulnerabilidade, use um canal privado da administração da Évora Urbanismo.
