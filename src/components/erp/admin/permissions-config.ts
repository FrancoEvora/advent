import type {Role} from "../types";

export type PermissionItem={key:string;label:string};
export type PermissionGroup={name:string;items:PermissionItem[]};

export const roles:Role[]=["admin","diretoria","financeiro","engenharia","comercial","compras","consulta","gestor_crm","sdr","corretor","marketing"];
export const roleNames:Record<Role,string>={admin:"Administrador",diretoria:"Diretoria",financeiro:"Financeiro",engenharia:"Engenharia",comercial:"Comercial",compras:"Compras",consulta:"Consulta",gestor_crm:"Gestor de CRM",sdr:"SDR / Pré-vendas",corretor:"Corretor",marketing:"Marketing"};
export const permissionGroups:PermissionGroup[]=[
 {name:"Visão executiva",items:[{key:"dashboard.view",label:"Visualizar dashboard"}]},
 {name:"CRM",items:[{key:"crm.view",label:"Visualizar CRM"},{key:"crm.manage",label:"Operar leads, funis e campanhas"}]},
 {name:"Pós-venda",items:[{key:"post_sale.view",label:"Visualizar carteira"},{key:"post_sale.manage",label:"Operar atendimento e jornada"},{key:"portal.manage",label:"Configurar portal do cliente"}]},
 {name:"Financeiro",items:[{key:"financial.view",label:"Visualizar financeiro"},{key:"financial.manage",label:"Criar e alterar lançamentos"},{key:"financial.approve",label:"Aprovar pagamentos e condições"}]},
 {name:"Compras",items:[{key:"procurement.view",label:"Visualizar compras"},{key:"procurement.manage",label:"Solicitar e gerir compras"}]},
 {name:"RH",items:[{key:"hr.view",label:"Visualizar RH"},{key:"hr.manage",label:"Gerir colaboradores e folha"}]},
 {name:"Documentos",items:[{key:"documents.view",label:"Visualizar documentos"},{key:"documents.manage",label:"Anexar e administrar arquivos"}]},
 {name:"Empreendimentos",items:[{key:"projects.view",label:"Visualizar empreendimentos"},{key:"projects.manage",label:"Alterar projetos e estoque"}]},
 {name:"Inteligência",items:[{key:"reports.view",label:"Visualizar relatórios"},{key:"audit.view",label:"Visualizar auditoria"}]},
 {name:"Administração",items:[{key:"users.view",label:"Visualizar usuários"},{key:"users.manage",label:"Gerir usuários e permissões"},{key:"settings.manage",label:"Alterar configurações"},{key:"backup.manage",label:"Gerar e baixar backups"},{key:"platform.manage",label:"Migrar ou limpar a base"}]}
];
export const allPermissionKeys=permissionGroups.flatMap(group=>group.items.map(item=>item.key));
