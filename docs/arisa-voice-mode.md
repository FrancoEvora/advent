# Arisa — modo fala privado

- Acionar **Modo fala** no cabeçalho habilita respostas faladas somente nesta sessão. A voz não começa ao abrir o histórico.
- Voz sintética `coral`, `gpt-4o-mini-tts`, português brasileiro, ritmo 0,96; instrução fixa profissional, feminina adulta, suave, delicada e acolhedora. Não é clonagem da pessoa da fotografia.
- Cada resposta nova é narrada em trechos, com apresentação progressiva do texto CONFIRMADO. O processamento administrativo não é reexecutado e não há narração especulativa de resultados de ferramentas.
- A implementação não transmite tokens provisórios do raciocínio/modelo: a resposta é gravada antes da leitura. O áudio começa pelo primeiro trecho, sem esperar a síntese de todos os demais.
- **Pausar / Continuar / Parar** controlam somente o som; o texto continua preservado. **Ouvir resposta** pode reler o histórico sem reenviar o comando.
- Gravar áudio, trocar conversa, abrir painel ou sair interrompe a leitura. Ao ocultar a página, a fala pausa; não retoma sozinha. iOS pode exigir novo toque para liberar áudio.
- Conteúdo completo pode ser exibido a qualquer momento. Preferência de movimento reduzido mantém o texto integral.

## Servidor

`arisa-speech` usa a chave OpenAI já configurada para a organização. Revalida JWT, administrador ativo e organização, aplica RLS e consulta a resposta por proprietário. Aceita somente IDs, índice do trecho e versão, nunca texto arbitrário. Apenas mensagens `assistant/completed` são elegíveis.

Autenticação customizada: gateway `verify_jwt=false` compatível com publishable keys; corpo usa `auth.getUser()` e `arisa_admin_catalog` antes de service-role. Endpoint não expõe ferramentas de escrita, Gmail, WhatsApp, agenda ou credenciais. Áudio retorna no-store/private; buffers limitados ficam na memória da página, nunca em bucket público ou localStorage.

Migração `20260906071000_arisa_private_speech.sql` cria contadores service-only, 60 chamadas/minuto e 180.000 caracteres/dia/administrador/organização. Não contém dados pessoais ou mensagens. Falhas de provedor preservam resposta escrita e não vazam corpos internos.

## Validação

`node --test tests/arisa-speech.test.mjs`: autenticação, proprietário, acesso negado, mensagens incompletas, textos longos, cifras/decimais, falha e cancelamento, limite, reprodução ordenada, não execução de ações no replay.

Concluir validação de percepção de voz e reprodução no iPhone/PWA em sessão real do administrador. Não usar registros financeiros privados em fixtures nem criar credenciais de teste em produção.
