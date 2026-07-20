"use client";
import type {ErpData} from "../types";
import type {PostSaleSection} from "./types";
import {PostSaleEnterprise as LegacyPostSaleEnterprise,postSaleSections} from "./enterprise";
import {usePostSaleData} from "./use-post-sale-data";
import {CommunicationsViewV54} from "./communications-view-v54";
export {postSaleSections};
export function PostSaleEnterpriseV54({data,section,setSection,mutate}:{data:ErpData;section:PostSaleSection;setSection:(s:PostSaleSection)=>void;mutate:(operation:()=>Promise<void>,success:string)=>Promise<void>}){const{postSale,loading,error,reload}=usePostSaleData(data);if(section!=="communications")return <LegacyPostSaleEnterprise data={data} section={section} setSection={setSection} mutate={mutate}/>;return <div className="post-sale-shell"><nav className="post-sale-mobile-tabs">{postSaleSections.map(i=><button key={i.id} className={section===i.id?"active":""} onClick={()=>setSection(i.id)}><b>{i.icon}</b><span>{i.label}</span></button>)}</nav>{loading&&<div className="progress"><i/></div>}{error&&<div className="feedback error">{error}</div>}<CommunicationsViewV54 data={data} ps={postSale} reload={reload}/></div>}
