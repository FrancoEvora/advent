"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../arisa/chat-client";
import { browserVoiceAudio, initialVoiceState, VoiceQueue, type VoiceState } from "../arisa/voice-queue";
import { SPEECH_VERSION } from "../../../supabase/functions/_shared/arisa-speech-text";
import { toolError, type BiaTool } from "./customer-tools-client";

export function useBiaVoice(tool: BiaTool, messages: Message[]) {
  const toolRef=useRef(tool);
  useEffect(()=>{toolRef.current=tool;},[tool]);
  const [state,setState]=useState<VoiceState>(initialVoiceState);
  const queue=useRef<VoiceQueue<AudioBuffer>|null>(null), armed=useRef<string|null>(null), intent=useRef(0);
  const [fullText,setFullText]=useState<string|null>(null);
  useEffect(()=>{
    let live=true;
    const current=new VoiceQueue(browserVoiceAudio(),async(messageId,partIndex,signal)=>{
      const response=await toolRef.current('speech',{messageId,partIndex,version:SPEECH_VERSION},signal);
      if(!response.ok)throw await toolError(response,'Não foi possível gerar a voz agora. A resposta escrita está preservada.');
      if(!response.headers.get('content-type')?.startsWith('audio/'))throw new Error('O áudio não está disponível agora.');
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength<32||bytes.byteLength>3000000)throw new Error('O áudio não está disponível agora.');
      return bytes;
    },next=>{if(live)setState(next);});
    queue.current=current;
    const background=()=>{if(document.hidden){intent.current++;armed.current=null;void current.pause();}};
    const leaving=()=>{intent.current++;armed.current=null;current.stop();};
    document.addEventListener('visibilitychange',background);window.addEventListener('pagehide',leaving);
    return()=>{live=false;leaving();current.destroy();queue.current=null;document.removeEventListener('visibilitychange',background);window.removeEventListener('pagehide',leaving);};
  },[]);
  const stop=useCallback(()=>{intent.current++;armed.current=null;queue.current?.stop();},[]);
  const toggle=useCallback(()=>{const current=queue.current;if(!current)return;if(current.state.enabled){intent.current++;armed.current=null;current.stop(true);}else void current.enable();},[]);
  const prepare=useCallback(()=>{intent.current++;armed.current=null;const current=queue.current;if(!current)return;current.stop();if(current.state.enabled)void current.enable();},[]);
  const arm=useCallback((id:string)=>{if(queue.current?.state.enabled)armed.current=id;},[]);
  const read=useCallback((message:Message)=>{
    if(message.role!=='assistant'||message.status!=='completed')return;
    const current=queue.current;if(!current)return;
    const request=++intent.current;armed.current=null;current.stop();setFullText(message.id);
    void current.enable().then(()=>{if(request===intent.current&&current.state.enabled&&queue.current===current&&!document.hidden)void current.read(message.id,message.content);});
  },[]);
  useEffect(()=>{
    const current=queue.current,parent=armed.current;
    if(!current?.state.enabled||!parent||document.hidden)return;
    const reply=messages.find(m=>m.parent_id===parent&&m.role==='assistant'&&m.status==='completed'&&m.content.trim());
    if(reply){armed.current=null;void current.read(reply.id,reply.content);}
  },[messages]);
  const pause=useCallback(()=>{void queue.current?.pause();},[]),resume=useCallback(()=>{void queue.current?.resume();},[]);
  const reveal=useCallback((id:string)=>setFullText(id),[]);
  return {state,toggle,prepare,arm,stop,read,pause,resume,fullText,reveal};
}

