"use client";
import {useState} from "react";

const formatter=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});

export function CurrencyInput({name,value,defaultValue=0,onValueChange,required=false,disabled=false,placeholder="R$ 0,00"}:{name?:string;value?:number;defaultValue?:number;onValueChange?:(value:number)=>void;required?:boolean;disabled?:boolean;placeholder?:string}){
 const controlled=value!==undefined;
 const[internal,setInternal]=useState(Number(defaultValue||0));
 const amount=controlled?Number(value||0):internal;
 const display=formatter.format(amount);
 function change(raw:string){const digits=raw.replace(/\D/g,"");const next=digits?Number(digits)/100:0;if(!controlled)setInternal(next);onValueChange?.(next);}
 return <><input value={display} inputMode="decimal" aria-label={name?undefined:"Valor em reais"} placeholder={placeholder} required={required} disabled={disabled} onChange={e=>change(e.target.value)} onFocus={e=>e.currentTarget.select()}/>{name&&<input type="hidden" name={name} value={amount}/>}</>;
}
