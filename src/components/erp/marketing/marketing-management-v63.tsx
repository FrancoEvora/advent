"use client";

import {useState} from "react";
import {MarketingManagementV60} from "./marketing-management-v60";
import {MarketingAssetManagerV63} from "./marketing-asset-manager-v63";
import type {Membership,Organization,Profile,Project} from "../types";

type Context={organization:Organization;membership:Membership;profile:Profile|null;projects:Project[];members:Membership[];profiles:Profile[];session:{user:{id:string}}};

export function MarketingManagementV63({context}:{context:Context}){
 const[assetsOpen,setAssetsOpen]=useState(false),[revision,setRevision]=useState(0);
 return <div className="marketing-v63-shell"><div className="marketing-assets-action-v63"><div><strong>Biblioteca de materiais</strong><span>Cadastre arquivos, links, versões e direitos de uso.</span></div><button className="primary" onClick={()=>setAssetsOpen(true)}>+ Adicionar ativo</button></div><MarketingManagementV60 key={revision} context={context}/><MarketingAssetManagerV63 context={context} open={assetsOpen} close={()=>setAssetsOpen(false)} onSaved={()=>setRevision(v=>v+1)}/></div>
}
