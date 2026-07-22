"use client";

import {useState,type MouseEvent} from "react";
import {MarketingManagementV60} from "./marketing-management-v60";
import {MarketingAssetManagerV63} from "./marketing-asset-manager-v63";
import type {Membership,Organization,Profile,Project} from "../types";

type Context={organization:Organization;membership:Membership;profile:Profile|null;projects:Project[];members:Membership[];profiles:Profile[];session:{user:{id:string}}};

export function MarketingManagementV63({context}:{context:Context}){
 const[assetsOpen,setAssetsOpen]=useState(false),[revision,setRevision]=useState(0);
 function interceptAssetAction(event:MouseEvent<HTMLDivElement>){
  const button=(event.target as HTMLElement).closest("button");
  if(!button||!button.textContent?.includes("Registrar ativo"))return;
  event.preventDefault();event.stopPropagation();setAssetsOpen(true);
 }
 return <div className="marketing-v63-shell" onClickCapture={interceptAssetAction}>
  <MarketingManagementV60 key={revision} context={context}/>
  <MarketingAssetManagerV63 context={context} open={assetsOpen} close={()=>setAssetsOpen(false)} onSaved={()=>setRevision(value=>value+1)}/>
 </div>
}
