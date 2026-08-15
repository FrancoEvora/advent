"use client";

import {useEffect} from "react";
import {usePathname} from "next/navigation";

export function HelpMenuShortcutV63(){const pathname=usePathname();useEffect(()=>{if(pathname.startsWith("/atendimento/"))return;const id="evora-help-menu-v63";const attach=()=>{if(document.getElementById(id))return;const sidebar=document.querySelector(".erp-sidebar");if(!sidebar)return;const spans=Array.from(sidebar.querySelectorAll("button span"));const span=spans.find(node=>node.textContent?.trim()==="Administração da plataforma");const target=span?.closest("button");if(!target)return;const link=document.createElement("a");link.id=id;link.href="/ajuda";link.className="help-menu-shortcut-v63";link.innerHTML="<b>?</b><span>Central de Ajuda</span>";target.insertAdjacentElement("afterend",link)};attach();const observer=new MutationObserver(attach);observer.observe(document.body,{childList:true,subtree:true});return()=>{observer.disconnect();document.getElementById(id)?.remove()}},[pathname]);return null}
