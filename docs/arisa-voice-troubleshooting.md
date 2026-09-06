# Diagnóstico do modo fala

A síntese usa `gpt-4o-mini-tts` e a voz `coral`. O funcionamento do chat de texto não comprova acesso a esse modelo. Antes de afirmar que a voz está operacional, testar uma síntese curta com a credencial do projeto, sem dados privados, e a reprodução numa sessão administrativa autenticada.

## Erros de autorização

- `SPEECH_MODEL_ACCESS` (HTTP 409): o endpoint de áudio respondeu 403/404. Verificar no projeto da OpenAI **Limits > Model Usage** se `gpt-4o-mini-tts` está autorizado. Verificar também a permissão da chave para criar áudio em `/v1/audio/speech`.
- `SPEECH_CREDENTIALS` (HTTP 409): o provedor recusou a credencial (401). Não significa que a sessão Supabase expirou. Revisar a chave pela configuração segura da integração, nunca enviá-la por chat.
- `SPEECH_LIMIT` (429): limite de uso interno ou do provedor; verificar cota e limites antes de repetir.
- `SPEECH_UNAVAILABLE` (503): demais falhas de síntese, resposta inesperada ou indisponibilidade temporária.

A mudança de mensagem não libera permissões no projeto da OpenAI. Essa autorização exige o proprietário do projeto/organização. Se o modelo não estiver disponível no painel, verificar o acesso da conta com o provedor.

Após corrigir a autorização, usar **Ouvir resposta** na mensagem existente. Não é necessário reenviar o pedido ao agente ou repetir qualquer operação administrativa.

## Preservação de segurança e identidade

Não há troca automática de modelo, voz ou credencial. As políticas de acesso, verificação de administrador ativo, leitura somente de respostas próprias concluídas e limites de uso permanecem ativos. Erros do provedor são classificados pelo status HTTP; o corpo original, identificadores de projeto e credenciais não são expostos nem registrados em logs.

A reprodução no iPhone só pode ser confirmada com teste no aparelho. HTTP 200 da página e testes com provedores simulados não demonstram que a conta tem acesso à síntese.

Referência oficial: https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects
