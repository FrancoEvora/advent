export async function blobToBase64(blob:Blob){return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob)})}

export async function gzipJson(value:unknown){const raw=new TextEncoder().encode(JSON.stringify(value));if(typeof CompressionStream==="undefined")return new Blob([raw],{type:"application/json"});const stream=new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));return await new Response(stream).blob()}

export async function checksum(blob:Blob){const hash=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,"0")).join("")}

export function downloadBlob(blob:Blob,fileName:string){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=fileName;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}