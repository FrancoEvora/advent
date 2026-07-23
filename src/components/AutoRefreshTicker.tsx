"use client";

import {useEffect,useRef} from "react";
import {useRouter} from "next/navigation";

export const AUTO_REFRESH_EVENT="evora:auto-refresh";

export function AutoRefreshTicker({intervalMs=60_000}:{intervalMs?:number}){
 const router=useRouter();
 const lastRun=useRef(0);
 useEffect(()=>{
  function refresh(){
   if(document.visibilityState!=="visible")return;
   const now=Date.now();
   if(now-lastRun.current<10_000)return;
   lastRun.current=now;
   window.dispatchEvent(new CustomEvent(AUTO_REFRESH_EVENT,{detail:{at:new Date().toISOString()}}));
   router.refresh();
  }
  const timer=window.setInterval(refresh,intervalMs);
  window.addEventListener("focus",refresh);
  document.addEventListener("visibilitychange",refresh);
  return()=>{window.clearInterval(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh)};
 },[intervalMs,router]);
 return null;
}
