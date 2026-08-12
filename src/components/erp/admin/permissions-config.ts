import type {Role} from "../types";

export type PermissionItem={
 key:string;
 label:string;
 description?:string;
 requires?:string[];
};
export type PermissionGroup={
 name:string;
 description:string;
 items:PermissionItem[];
};

export const roles:Role[]=["admin","diretoria","financeiro","engenharia","comercial","compras","consulta","gestor_crm","sdr","corretor","marketing"];
export const roleNames:Record<Role,string>={admin:"Administrador",diretoria:"Diretoria",financeiro:"Financeiro",engenharia:"Engenharia",comercial:"Comercial",compras:"Compras",consulta:"Consulta",gestor_crm:"Gestor de CRM",sdr:"SDR / Pré-vendas",corretor:"Corretor",marketing:"Marketing"};
export const permissionGroups:PermissionGroup[]=[
 {
  name:"Visão executiva",
  description:"Indicadores consolidados da organização.",
  items:[{key:"dashboard.view",label:"Visualizar dashboard"}],
 },
 {
  name:"Insights e BI",
  description:"Análises automáticas, alertas gerenciais e inteligência integrada de todas as áreas.",
  items:[
   {
   key:"insights.view",
   label:"Visualizar Insights e BI",
    description:"Concede acesso à central consolidada; os acessos diretos continuam sujeitos às permissões de cada setor.",
   },
   {
    key:"insights.manage",
    label:"Executar análises e administrar insights",
    description:"Permite solicitar uma verificação extraordinária e tratar os relatórios gerados.",
    requires:["insights.view"],
   },
  ],
 },
 {
  name:"CRM, leads e vendas",
  description:"Funil comercial, leads, propostas, contratos de venda e campanhas.",
  items:[
   {key:"crm.view",label:"Visualizar CRM, leads e vendas"},
   {
    key:"crm.attribution.view",
    label:"Visualizar atribuição detalhada de mídia",
    description:"Exibe IDs e snapshots de campanha, conjunto, anúncio, criativo e formulário vinculados ao lead.",
    requires:["crm.view"],
   },
   {key:"crm.manage",label:"Operar leads, funis, propostas e campanhas",requires:["crm.view"]},
   {
    key:"crm.integrations.manage",
    label:"Configurar integrações comerciais",
    description:"Permite administrar origens externas e, nas próximas etapas, conexões e rotas do Hub de Integração.",
    requires:["crm.view"],
   },
   {
    key:"crm.copilot.use",
    label:"Usar a Vitória em modo copiloto",
    description:"Permite solicitar análises e rascunhos com base no contexto autorizado do lead.",
    requires:["crm.view"],
   },
   {
    key:"crm.copilot.approve_send",
    label:"Aprovar e enviar respostas da Vitória",
    description:"Autoriza a revisão humana final antes do envio e do registro no histórico.",
    requires:["crm.view","crm.copilot.use"],
   },
   {
    key:"crm.assign",
    label:"Designar SDRs e corretores",
    description:"Permite distribuir atendimentos e redefinir responsáveis por leads e oportunidades.",
    requires:["crm.view"],
   },
   {
    key:"crm.monitor_team",
    label:"Monitorar atendimento da equipe comercial",
    description:"Exibe designações, aceite, prazos, alertas, avanços e resultados de SDRs e corretores.",
    requires:["crm.view"],
   },
  ],
 },
 {
  name:"Agenda e atividades",
  description:"Distribuição, acompanhamento e supervisão das atividades corporativas.",
  items:[
   {
    key:"activities.assign",
    label:"Designar atividades a outros usuários",
    description:"Permite criar compromissos e definir outro colaborador como responsável.",
   },
   {
    key:"activities.manage_team",
    label:"Gerenciar atividades da equipe",
    description:"Permite acompanhar e atualizar atividades de outros usuários da organização.",
   },
  ],
 },
 {
  name:"Pós-venda",
  description:"Carteira, atendimento, cobrança, obras comunicáveis e portal.",
  items:[
   {key:"post_sale.view",label:"Visualizar carteira e jornada"},
   {key:"post_sale.manage",label:"Operar atendimento, cobrança e entregas",requires:["post_sale.view"]},
   {key:"portal.manage",label:"Configurar e publicar o portal do cliente",requires:["post_sale.view"]},
  ],
 },
 {
  name:"Financeiro",
  description:"Lançamentos, caixa, pagamentos e alçadas financeiras.",
  items:[
   {key:"financial.view",label:"Visualizar financeiro e fluxo de caixa"},
   {key:"financial.manage",label:"Criar e alterar lançamentos",requires:["financial.view"]},
   {key:"financial.approve",label:"Aprovar pagamentos e condições",requires:["financial.view"]},
  ],
 },
 {
  name:"Parceiros e pagamentos",
  description:"Portal de fornecedores e credores, comunicações de pagamento e negociações.",
  items:[
   {key:"partners.view",label:"Visualizar parceiros, pagamentos publicados e negociações"},
   {
    key:"partners.payments.publish",
    label:"Publicar previsões e datas de pagamento",
    description:"Não altera o vencimento contábil nem cria promessa automática.",
    requires:["partners.view","financial.view"],
   },
   {
    key:"partners.process",
    label:"Informar processamento e liquidação",
    requires:["partners.view","financial.view"],
   },
   {
    key:"partners.negotiations.view",
    label:"Visualizar negociações com parceiros",
    requires:["partners.view"],
   },
   {
    key:"partners.negotiations.manage",
    label:"Responder e conduzir negociações",
    requires:["partners.view","partners.negotiations.view"],
   },
   {
    key:"partners.negotiations.approve",
    label:"Aprovar ou rejeitar propostas",
    description:"A decisão fica registrada, mas não altera o título financeiro automaticamente.",
    requires:["partners.view","partners.negotiations.view"],
   },
   {
    key:"partners.access.manage",
    label:"Criar, renovar e revogar acessos ao portal",
    requires:["partners.view"],
   },
   {
    key:"partners.landowners.publish",
    label:"Configurar e publicar o painel dos terrenistas",
    description:"Controla os indicadores, detalhes de vendas, repasses e avanço de obra expostos em cada fechamento.",
    requires:["partners.view","financial.view"],
   },
  ],
 },
 {
  name:"Gestão de obras e EAP",
  description:"Planejamento físico, etapas, linha de base e estrutura analítica da obra.",
  items:[
   {key:"construction.view",label:"Visualizar obras, etapas e cronograma"},
   {
    key:"construction.manage",
    label:"Gerir EAP, percentuais, linha de base e avanço",
    description:"Inclui criar, editar e excluir EAPs e seus elementos.",
    requires:["construction.view"],
   },
   {
    key:"construction.approve",
    label:"Aprovar medições e avanço físico da obra",
    requires:["construction.view"],
   },
  ],
 },
 {
  name:"Gestão de contratos e máquinas",
  description:"Contratos operacionais, medições, períodos, equipamentos e horímetros.",
  items:[
   {key:"contracts.view",label:"Visualizar contratos, máquinas e horímetros"},
   {
    key:"contracts.manage",
    label:"Criar e administrar contratos e equipamentos",
    requires:["contracts.view"],
   },
   {
    key:"contracts.period.manage",
    label:"Abrir e administrar períodos de medição",
    requires:["contracts.view"],
   },
   {
    key:"contracts.measure",
    label:"Registrar medições, horas e horímetros",
    requires:["contracts.view"],
   },
   {
    key:"contracts.approve",
    label:"Aprovar ou rejeitar medições",
    requires:["contracts.view"],
   },
   {
    key:"contracts.audit",
    label:"Auditar horas, horímetros e divergências",
    requires:["contracts.view"],
   },
   {
    key:"contracts.documents.submit",
    label:"Enviar documentos de medição",
    requires:["contracts.view"],
   },
   {
    key:"contracts.documents.review_service",
    label:"Revisar comprovação do serviço",
    requires:["contracts.view"],
   },
   {
    key:"contracts.documents.review_invoice",
    label:"Revisar nota fiscal do contrato",
    requires:["contracts.view"],
   },
  ],
 },
 {
  name:"Compras e serviços",
  description:"Solicitações de materiais, serviços, contratação e documentos.",
  items:[
   {key:"procurement.view",label:"Visualizar compras e serviços"},
   {key:"procurement.manage",label:"Solicitar e gerir compras e serviços",requires:["procurement.view"]},
  ],
 },
 {
  name:"Gestão de combustíveis",
  description:"Fluxo segregado de solicitação, aprovação e abastecimento.",
  items:[
   {
    key:"fuel.view",
    label:"Visualizar gestão de combustíveis",
    description:"O acesso ao submenu também requer visualizar Compras e serviços.",
    requires:["procurement.view"],
   },
   {key:"fuel.request",label:"Solicitar combustível",requires:["fuel.view","procurement.view"]},
   {key:"fuel.approve",label:"Aprovar ou rejeitar solicitações",requires:["fuel.view","procurement.view"]},
   {
    key:"fuel.dispense",
    label:"Registrar abastecimento e nota fiscal",
    requires:["fuel.view","procurement.view"],
   },
   {
    key:"fuel.links.manage",
    label:"Gerir vínculos entre contrato, máquina e combustível",
    requires:["fuel.view","procurement.view"],
   },
   {
    key:"fuel.documents.submit",
    label:"Enviar nota fiscal e documentos do abastecimento",
    requires:["fuel.view","procurement.view"],
   },
   {
    key:"fuel.documents.review_operational",
    label:"Revisar comprovantes operacionais",
    requires:["fuel.view","procurement.view"],
   },
   {
    key:"fuel.documents.review_invoice",
    label:"Revisar notas fiscais de combustível",
    requires:["fuel.view","procurement.view"],
   },
  ],
 },
 {
  name:"RH",
  description:"Colaboradores, eventos, folha e provisões.",
  items:[
   {key:"hr.view",label:"Visualizar RH"},
   {key:"hr.manage",label:"Gerir colaboradores e folha",requires:["hr.view"]},
  ],
 },
 {
  name:"Documentos",
  description:"Arquivos e anexos corporativos.",
  items:[
   {key:"documents.view",label:"Visualizar documentos"},
   {key:"documents.manage",label:"Anexar e administrar arquivos",requires:["documents.view"]},
  ],
 },
 {
  name:"Empreendimentos",
  description:"Projetos, centros, cadastros e estoque imobiliário.",
  items:[
   {key:"projects.view",label:"Visualizar empreendimentos"},
   {key:"projects.manage",label:"Alterar projetos e estoque",requires:["projects.view"]},
  ],
 },
 {
  name:"Relatórios corporativos",
  description:"Central executiva com indicadores financeiros, comerciais e operacionais.",
  items:[
   {
   key:"reports.view",
    label:"Acessar a Central de Relatórios",
    description:"Cada área aparece conforme as permissões setoriais do perfil.",
   },
  ],
 },
 {
  name:"Governança e administração",
  description:"Auditoria, usuários, configurações, backup e plataforma.",
  items:[
   {key:"audit.view",label:"Visualizar auditoria"},
   {key:"users.view",label:"Visualizar usuários"},
   {key:"users.manage",label:"Gerir usuários e permissões",requires:["users.view"]},
   {key:"settings.manage",label:"Alterar configurações"},
   {key:"backup.manage",label:"Gerar e baixar backups"},
   {key:"platform.manage",label:"Migrar ou limpar a base"},
  ],
 },
];
export const allPermissionKeys=permissionGroups.flatMap(group=>group.items.map(item=>item.key));
export const permissionItems=permissionGroups.flatMap(group=>group.items);
