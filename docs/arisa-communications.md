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

O webhook existente da Évora recebe o roteamento administrativo antes do CRM. Apenas mensagens reconhecidas como pertencentes à Arisa são tratadas nesse histórico. Assinatura HMAC, número empresarial e organização são conferidos antes da ingestão. Respostas de terceiros são dados de comunicação e nunca recebem os poderes do administrador. Elas podem ser consultadas e usadas pela Arisa na conversa administrativa. Esta versão não liga respostas automáticas a terceiros: a condução persistente de uma missão por WhatsApp ainda exige um fluxo próprio de delegação. Arquivos recebidos no WhatsApp têm seus metadados registrados; a importação do arquivo para o processamento financeiro não faz parte deste canal inicial.

## Verificação operacional

Após publicar funções, migração e interface, o administrador pode verificar a conexão Meta e consultar templates em WhatsApp. A configuração local não comprova validade de token, assinatura do aplicativo Meta nem aprovação de template; erros reais do provedor são mostrados no painel. A ativação do canal é independente e não envia uma mensagem de teste.

Os testes de envio usam provedores simulados; nenhum fornecedor é contatado para validar a implantação. A confirmação de entrega real depende dos eventos da Meta.
