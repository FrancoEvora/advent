# Comunicação contextualizada da Arisa

## Acesso

- `/arisa?painel=email`: conta corporativa, envio e sincronização Gmail.
- `/arisa?painel=agenda`: Google Agenda, disponibilidade, Meet e participantes.
- `/arisa?painel=whatsapp`: canal administrativo, templates e histórico.

Todos os painéis exigem administrador ativo da organização. Tokens Google e Meta permanecem no servidor.

## Reunião e e-mail

Uma reunião com convidados exige descrição com objetivo ou pauta. A validação considera também os convidados e a descrição que já existem quando o evento é alterado. Link isolado, saudação e pedido de confirmação não substituem a pauta.

`calendar create` cria o compromisso e solicita os convites do Google; não afirma ter enviado o e-mail de acompanhamento. Se o administrador pedir e-mail, a Arisa executa `send_email` com `calendar_event_id` e `calendar_id`. O servidor lê o evento no Google e acrescenta pauta, início, término, fuso, local e links reais. Meet ainda em processamento ou link divergente interrompe a comunicação antes de qualquer envio.

Exemplo: “Marque com o fornecedor amanhã às 10h para alinharmos o cronograma de drenagem. Gere o Meet e envie um e-mail explicando a pauta.”

O envio conserva MIME e anexos, mantém uma única mensagem por pedido e concilia resultados incertos sem repetir o envio. Aceitação pelo Gmail não comprova entrega, leitura ou presença na reunião.

## WhatsApp administrativo

A Arisa reutiliza as credenciais da Cloud API cadastradas pela Évora, com controle próprio de ativação. Isso não liga o atendimento automático da Bia. Contatos administrativos possuem histórico próprio; iniciar contato com fornecedor não cria um lead.

`whatsapp status` verifica o estado cadastrado; `templates` consulta modelos aprovados na Meta; `send` registra e envia; `list` consulta conversas; `get` e `reconcile` verificam o resultado de uma operação.

Texto livre exige mensagem recebida nas últimas 24 horas. Fora dessa janela é necessário template aprovado compatível. O conteúdo efetivamente aceito para envio, o telefone resolvido e a referência do provedor ficam registrados. Operações incertas não são reenviadas automaticamente.

O webhook existente da Évora recebe o roteamento administrativo antes do CRM. Apenas mensagens reconhecidas como pertencentes à Arisa são tratadas nesse histórico. Assinatura HMAC, número empresarial e organização são conferidos antes da ingestão. Respostas de terceiros são dados de comunicação e nunca recebem os poderes do administrador. Elas podem ser consultadas e usadas pela Arisa na conversa administrativa. O controle de respostas automáticas ativa uma fila própria no canal dedicado da Arisa, sem ativar a Bia. Contatos que iniciam a conversa também recebem atendimento. A IA lê apenas as últimas 20 mensagens daquele interlocutor, sem memória organizacional ou ferramentas administrativas. O worker salva a geração e o uso, confere a janela e os bloqueios antes de enviar, e não repete envios incertos. Pedidos de operações internas continuam exigindo o administrador no painel; receber uma mensagem não comprova identidade nem autoriza uma missão administrativa. Arquivos recebidos no WhatsApp têm seus metadados registrados; a importação do arquivo para o processamento financeiro não faz parte deste canal inicial.

## Verificação operacional

Após publicar funções, migração e interface, o administrador pode verificar a conexão Meta e consultar templates em WhatsApp. A configuração local não comprova validade de token, assinatura do aplicativo Meta nem aprovação de template; erros reais do provedor são mostrados no painel. A ativação do canal é independente e não envia uma mensagem de teste.

Os testes de envio usam provedores simulados; nenhum fornecedor é contatado para validar a implantação. A confirmação de entrega real depende dos eventos da Meta.

## Respostas automáticas

`arisa-whatsapp-replies` autentica o segredo privado do worker, processa a fila ao receber mensagens e tem recuperação por cron a cada minuto. HMAC continua sendo validado pelo webhook antes de inserir a mensagem. Jobs têm chave única por mensagem, lease e serialização por conversa; mensagens em sequência são reunidas no histórico mais recente. Resultados da geração, modelo, uso, mensagem de origem e aceite da Meta são auditáveis. Pausar envios também suspende as respostas. A opção de resposta automática permanece desligada por padrão e só é compatível com o canal dedicado da Arisa (CRM automático desativado). Configurar `auto_reply_enabled` em `whatsapp configure` permite ativar ou pausar pelo painel.
