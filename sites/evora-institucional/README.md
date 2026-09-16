# Évora Urbanismo — projeto institucional independente

Site público: https://evora-institucional.vercel.app/
Projeto Vercel: `evora-institucional` (`prj_XtYR9la742vwv5vj5iUzNZvVnbsz`).
O projeto Vercel `advent` continua reservado à plataforma Enterprise e aos fluxos já existentes.

## Build autônomo

```sh
cd sites/evora-institucional
node build.mjs
```

O build usa apenas o acervo público da pasta `template`, cuja integridade é verificada por SHA-256, e gera 17 arquivos estáticos em `dist`. Não instala dependências, não utiliza variáveis de ambiente e não consulta o Enterprise, o CRM ou bancos de dados. A pasta template conserva o design aprovado; o build atualiza metadados e substitui todas as referências ao ambiente interno antes de publicar.

Para manutenção via integração Git, selecionar exclusivamente esta pasta como Root Directory do projeto `evora-institucional`, framework Other e saída `dist`. Não usar a raiz do monorepositório. A publicação inicial foi feita diretamente no projeto pela conexão Vercel, não por um vínculo automático Git.

## Isolamento

- Hospedagem e domínio próprios, sem reescrita ou proxy para o ERP.
- Imagens, CSS e JavaScript locais.
- Nenhuma rota de CRM, financeiro, login interno, API ou service worker é publicada.
- Nenhuma credencial ou configuração de banco de dados é incluída no pacote.
- CSP bloqueia conexões de scripts (`connect-src 'none'`), frames e workers.
- Atendimento institucional e do Solaris por WhatsApp; nenhum CTA leva ao Enterprise.
- A URL antiga `/evora` e seus subcaminhos no Enterprise redirecionam ao site público; os arquivos antes em `public/evora` foram removidos desse diretório.

A separação de hospedagem não substitui autenticação e autorização no Enterprise. Esta entrega não audita nem modifica regras de acesso da aplicação interna, tampouco remove deployments históricos. Não foram alterados DNS ou o domínio institucional anterior. O domínio `evora.terraragroup.com.br` ainda não está associado a este projeto.

## Validação

`tests/evora-site-browser.mjs` compara a versão de produção com este build, verifica respostas 404 de rotas internas inexistentes, CSP, recursos sem origem externa, layout em quatro larguras, galerias, menu, seleção de interesse e preparação do WhatsApp sem enviar mensagens. A rotina está em `.github/workflows/evora-institutional-qa.yml`.
