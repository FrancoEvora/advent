# Évora institucional — migração para projeto independente

Em 16/09/2026, a pedido de Franco, o institucional foi separado da hospedagem Enterprise.

- Site público: https://evora-institucional.vercel.app/
- Projeto Vercel exclusivo: `evora-institucional`, ID `prj_XtYR9la742vwv5vj5iUzNZvVnbsz`.
- Código e build autônomos: `sites/evora-institucional/`.
- A antiga rota Next.js `src/app/evora/route.ts` e a pasta pública `public/evora` foram removidas. `next.config.ts` contém apenas um redirecionamento permanente de `/evora/:path*` ao novo site.
- Preservados os demais módulos, os cadastros comerciais existentes, a autenticação e as configurações do Enterprise.
- O novo site não aponta para o cadastro comercial interno do Solaris: seu CTA seleciona Solaris no formulário do próprio institucional e abre o WhatsApp.
- O projeto público é estático, não herda segredos do projeto `advent` e não publica serviços de backend.
- Nenhuma alteração de DNS. A associação de `evora.terraragroup.com.br` permanece uma etapa separada; não divulgar esse endereço como ativo.

A fonte permanece versionada no monorepositório GitHub, mas fora do diretório público do Enterprise. Hospedagem, domínio, build e recursos entregues ao visitante são distintos. Não há vínculo automático de Git configurado no novo projeto; a publicação inicial foi direta pela conexão Vercel. O projeto Vercel independente já foi verificado como READY antes da remoção da instalação antiga.

A separação de projetos reduz a superfície compartilhada, mas não constitui auditoria integral de segurança. Autenticação, autorização e proteção dos endpoints internos continuam obrigatórias. Deployments históricos não foram apagados; o redirecionamento é aplicado à versão de produção atual.
