import {CustomerPortal} from "@/components/erp/post-sale/customer-portal";
export default async function CustomerPage({params}:{params:Promise<{token:string}>}){const{token}=await params;return <CustomerPortal token={token}/>}
