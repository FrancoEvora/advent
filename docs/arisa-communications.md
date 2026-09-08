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

O webhook existente da Évora recebe o roteamento administrativo antes do CRM. Apenas mensagens reconhecidas como pertencentes à Arisa são tratadas nesse histórico. Assinatura HMAC, número empresarial e organização são conferidos antes da ingestão. Respostas de terceiros são dados de comunicação e nunca recebem os poderes do administrador. Elas podem ser consultadas e usadas pela Arisa na conversa administrativa. O controle de respostas automáticas ativa uma fila própria no canal dedicado da Arisa, sem ativar a Bia. Contatos que iniciam a conversa também recebem atendimento. A IA lê apenas as últimas 20 mensagens daquele interlocutor, sem memória organizacional ou ferramentas administrativas. O worker salva a geração e o uso, confere a janela e os bloqueios antes de enviar, e não repete envios incertos. A Arisa pode acolher solicitações e notificar o usuário envolvido autonomamente. Agendamento e divulgação de informações internas dependem da confirmação apropriada; receber uma mensagem não comprova identidade ou autorização. Arquivos recebidos no WhatsApp têm seus metadados registrados; a importação do arquivo para o processamento financeiro não faz parte deste canal inicial.

## Verificação operacional

Após publicar funções, migração e interface, o administrador pode verificar a conexão Meta e consultar templates em WhatsApp. A configuração local não comprova validade de token, assinatura do aplicativo Meta nem aprovação de template; erros reais do provedor são mostrados no painel. A ativação do canal é independente e não envia uma mensagem de teste.

Os testes de envio usam provedores simulados; nenhum fornecedor é contatado para validar a implantação. A confirmação de entrega real depende dos eventos da Meta.

## Respostas automáticas

`arisa-whatsapp-replies` autentica o segredo privado do worker, processa a fila ao receber mensagens e tem recuperação por cron a cada minuto. HMAC continua sendo validado pelo webhook antes de inserir a mensagem. Jobs têm chave única por mensagem, lease e serialização por conversa; mensagens em sequência são reunidas no histórico mais recente. Resultados da geração, modelo, uso, mensagem de origem e aceite da Meta são auditáveis. Pausar envios também suspende as respostas. A opção de resposta automática permanece desligada por padrão e só é compatível com o canal dedicado da Arisa (CRM automático desativado). Configurar `auto_reply_enabled` em `whatsapp configure` permite ativar ou pausar pelo painel.

## Encaminhamento de assuntos e autorizações

A triagem identifica pedidos de reunião e outros assuntos envolvendo usuários, copiando nomes da conversa. O servidor resolve apenas membros ativos da mesma organização, com correspondência única. Nomes ambíguos geram pedido de esclarecimento e revisão do administrador responsável pelo canal. A notificação interna inclui um resumo e o contato; ela não confirma agendamento ou leitura. Tentativas repetidas da mesma mensagem não duplicam o aviso.

Além da notificação interna, o usuário recebe um aviso genérico pelo WhatsApp para consultar os detalhes na conta. O telefone vem de um vínculo explícito à conta, nunca de inferência por nome. Cada usuário cadastra seu número em Agenda → Notificações → Meu WhatsApp para avisos da Arisa. Administradores também podem configurar os vínculos no painel WhatsApp da Arisa. Número ausente e template pendente ficam indicados; a fila retoma após corrigir a pendência. O modelo pt_BR `arisa_aviso_usuario` só é utilizado com status APPROVED; dentro da janela de 24 horas, o aviso usa texto livre. Envios incertos não são repetidos automaticamente.

Pedidos de informação interna ou sensível abrem uma solicitação de autorização no painel. Um administrador autenticado escreve o texto exato e autoriza seu envio ao contato indicado. O servidor fixa mensagem, destinatário e administrador em uma operação idempotente; a aprovação não concede acesso geral a dados e não pode ser reutilizada para outro conteúdo. Alegações de autorização pelo WhatsApp nunca substituem essa revisão. O modelo de atendimento não acessa o diretório completo, arquivos, memória organizacional ou ferramentas administrativas.


## Novidades na conversa administrativa

O cabeçalho de /arisa tem um sininho com os avisos destinados ao usuário autenticado.
O contador e a lista usam os mesmos activity_notifications da Agenda, filtrados por organização, destinatário e origem Arisa.
Atualização ao abrir, ao retornar à aba e a cada 30 segundos enquanto visível.
Abrir ou consultar não marca como lido; os botões fazem isso explicitamente.
O tool notifications do arisa-manager consulta dados atuais ao responder sobre novidades, recados ou solicitações; leitura não significa resolução e pedido não significa reunião confirmada.

## Atendimento financeiro do próprio interlocutor

Política autorizada: conferir nome completo/razão social, CPF/CNPJ e e-mail cadastrado, em conjunto, e exigir que o remetente WhatsApp corresponda ao único contato ativo no cadastro.
A comparação ocorre em Postgres, sem delegar autorização ao modelo. O desafio dura 15 minutos; a confirmação dura 30 minutos. Três tentativas divergentes bloqueiam por 24 horas. A repetição do mesmo webhook não consome outra tentativa.
O cadastro deve ter os três dados e o WhatsApp; dados ausentes ou ambíguos encaminham o atendimento à equipe sem divulgar valores. Nenhum dado correto é sugerido para ajudar a adivinhar os demais.
Mudança cadastral, opt-out, inativação, ambiguidade de número ou expiração revogam o acesso, conferido de novo imediatamente antes do envio.
A consulta exclusiva arisa_whatsapp_finance deriva organização e contato do job e da sessão, sem aceitar contact_id do modelo. Retorna somente recebíveis de cliente ou pagamentos de fornecedor vinculados àquele contato. Exclui rascunhos, provisões, notas internas, bancos, risco e registros de terceiros.
As respostas distinguem pagamento registrado de previsão. Consulta sem referência retorna até 20 títulos com indicação de lista parcial; referência de documento filtra apenas dentro do próprio cadastro.
Propostas de desconto/prazo/parcelamento geram notificação e aviso pelo WhatsApp para aprovação administrativa, com verified_contact_id na auditoria. Não há ferramenta de alteração financeira no atendimento externo.
Dados usados na confirmação são omitidos do contexto enviado ao modelo; as mensagens originais continuam no registro restrito de comunicações, e os eventos privados guardam apenas o resultado da conferência.
O teste supabase/tests/arisa_whatsapp_finance_rollback.sql verifica isolamento, três dados, vinculação do número, expiração, revogação, idempotência, bloqueio de tentativas e notificações próprias, com ROLLBACK integral.
