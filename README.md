# Évora Gestão — Versão Móbile

Aplicação financeira e gerencial responsiva da Évora Urbanismo, preparada para desktop, iPhone e outros smartphones.

## Funcionalidades

- dashboard financeiro executivo;
- contas a pagar e contas a receber;
- fluxo de caixa projetado em 7, 30 e 90 dias;
- alertas de vencimento;
- inclusão, liquidação e exclusão de lançamentos;
- autenticação com Supabase;
- dados protegidos por Row Level Security;
- exportação CSV e relatório para PDF;
- modo PWA instalável na tela inicial do iPhone;
- modo demonstração local quando as variáveis do Supabase não estão configuradas.

## Tecnologia

- Next.js 16;
- React 19;
- TypeScript;
- Supabase Auth e PostgreSQL;
- Vercel;
- PWA com Service Worker.

## Configuração local

```bash
npm install
cp .env.example .env.local
npm run dev
```

A aplicação será aberta em `http://localhost:3000`.

## Variáveis de ambiente

```env
NEXT_PUBLIC_SUPABASE_URL=https://qsdffayasuzsmngteika.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sua_chave_publicavel
```

A chave publicável pode ser cadastrada com segurança na Vercel. Nunca utilize a chave `service_role` no frontend.

## Banco de dados

O esquema versionado está em:

```text
supabase/migrations/20260718220700_initial_financial_schema.sql
```

O projeto Supabase de produção já foi criado na região de São Paulo.

## Validação

```bash
npm run lint
npm run build
```

O GitHub Actions executa as mesmas verificações a cada envio para a branch `main`.

## Publicação na Vercel

1. Importe o repositório `FrancoEvora/advent` na Vercel.
2. Cadastre as duas variáveis públicas do Supabase.
3. Use o framework Next.js e o comando padrão `npm run build`.
4. Publique o ambiente de produção.

## Instalação no iPhone

Abra o endereço publicado no Safari, toque em **Compartilhar** e escolha **Adicionar à Tela de Início**.
