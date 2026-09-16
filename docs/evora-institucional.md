# Site institucional Évora Urbanismo

Publicado pela integração existente GitHub → Vercel. Rota pública: https://advent-tau.vercel.app/evora.

## Separação e escopo
- `public/evora/` contém HTML, CSS, JavaScript e imagens locais. Pode ser hospedado de forma independente, sem banco de dados ou credenciais.
- `src/app/evora/route.ts` entrega o documento público em `/evora`, sem renderizar o layout do ERP, acessar o CRM ou alterar a autenticação.
- A marca e as cores foram recuperadas do Enterprise: `public/evora-brand.svg` e `src/app/styles/v5-brand.css` (#1D5271, #12384F, #79B82B). Nenhuma nova marca foi inventada.
- As imagens são cópias do acervo já publicado em `public/forms/solaris/book/`. Originais preservados. Perspectivas e concepções são identificadas como ilustrativas.
- Apresenta Évora → Parque das Árvores (bairro) → Solaris Residencial Resort (residencial integrado). Sem preços, rentabilidade garantida ou datas de entrega.

## Atendimento
O formulário apenas prepara uma mensagem e abre `https://wa.me/5511917664123`. A pessoa confirma o envio no WhatsApp. Não há gravação de dados neste site nem confirmação fictícia de envio. O CTA específico do Solaris abre o cadastro já existente em `/atendimento/solaris/cadastro`; outros interesses seguem para o contato institucional.

Contatos públicos utilizados: WhatsApp (11) 91766-4123, relacionamento@evoraurbanismo.com.br, escritório Av. Rondon Pacheco, 381, Sala 401, Uberlândia/MG. Fonte: site institucional público www.evoraurbanismo.com.br, consultado em 16/09/2026. Revisar sempre que houver mudança do canal oficial.

## Publicação independente / domínio
A pasta está pronta para ser selecionada como Root Directory de um projeto estático Vercel. O `vercel.json` dentro dela não altera o projeto Next.js que hospeda o Enterprise. Ao configurar um domínio definitivo, atualizar canonical, og:url e JSON-LD no index.html. Nenhuma configuração DNS ou domínio foi modificada nesta entrega.

## Verificação
A rotina `Évora Institutional QA` verifica carregamento das imagens, 4 larguras de tela, links internos, menu móvel, galerias, privacidade e preparação do WhatsApp sem enviar mensagens. Os artefatos incluem capturas e uma cópia ZIP do site. A publicação do Next.js deve permanecer READY antes de considerar a rota entregue.
