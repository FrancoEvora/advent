"use client";
import {ModuleShell} from "@/components/erp/standalone/module-shell";
import {HelpCenterV63} from "@/components/erp/help/help-center-v63";
export default function HelpPage(){return <ModuleShell eyebrow="SUPORTE E CONHECIMENTO" title="Central de Ajuda">{()=> <HelpCenterV63/>}</ModuleShell>}
