# Solaris Residencial — Landing page independente

Site editorial de captação de interessados do Solaris, Monte Carmelo/MG. Código próprio, sem importar código do ERP por caminhos relativos.

- Projeto Vercel: `solaris-residencial` (independente de `advent`).
- Domínio-alvo: `https://solarisresidencial.com.br`.
- Fotografias, book PDF e logos estão em `public/forms/solaris/`, dentro da aplicação.
- O formulário público usa uma rota API própria `/api/forms/solaris` que valida e encaminha cadastros ao endpoint existente do CRM via servidor; a interface e mídia independem do Enterprise.
- A integração de captação ainda depende do backend existente. Para independência completa, substituir a URL de destino do backend após provisionar chaves e integrações próprias.

## Desenvolvimento
`npm install`, depois `npm run dev`.
Para separar em repositório exclusivo, copie este diretório como raiz do novo repositório e reconecte o projeto Vercel.

## Segurança
Não adicionar senhas nem variáveis de ambiente ao repositório; avaliar LGPD, consentimento e monitorar erros de captação antes de campanhas de grande escala.
