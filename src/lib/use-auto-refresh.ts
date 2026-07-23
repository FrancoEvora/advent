"use client";

import {useEffect,useRef} from "react";
import {AUTO_REFRESH_EVENT} from "@/components/AutoRefreshTicker";

export function useAutoRefresh(callback:()=>void|Promise<void>){
 const callbackRef=useRef(callback);
 useEffect(()=>{callbackRef.current=callback},[callback]);
 useEffect(()=>{
  const handler=()=>{void callbackRef.current()};
  window.addEventListener(AUTO_REFRESH_EVENT,handler);
  return()=>window.removeEventListener(AUTO_REFRESH_EVENT,handler);
 },[]);
}
