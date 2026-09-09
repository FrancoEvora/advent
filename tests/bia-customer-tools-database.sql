-- Transaction-only fixtures. No model calls, customer outreach or live session changes.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare
 slug text; token text:=encode(extensions.gen_random_bytes(32),'hex'); device text:=encode(extensions.gen_random_bytes(32),'hex');
 other_token text:=encode(extensions.gen_random_bytes(32),'hex'); other_device text:=encode(extensions.gen_random_bytes(32),'hex');
 sid uuid; other_sid uuid; result jsonb; file jsonb; cid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid(); payload jsonb; claim jsonb; msg text; reply jsonb;
begin
 select e.slug into slug from crm_private.public_agent_experiences e where e.active order by e.slug limit 1;
 result:=public.open_bia_conversation_v1(slug,token,device);sid:=(result->>'sessionId')::uuid;
 result:=public.open_bia_conversation_v1(slug,other_token,other_device);other_sid:=(result->>'sessionId')::uuid;
 file:=public.bia_customer_tools_v1(slug,token,device,sid,'files_prepare',jsonb_build_object('clientId',cid,'name','fixture.txt','mime','text/plain','size',24,'sha256',repeat('a',64)));
 if file->>'ready'<>'false' then raise exception 'Upload was trusted before verification';end if;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'files_prepare',jsonb_build_object('clientId',cid,'name','fixture.txt','mime','text/plain','size',24,'sha256',repeat('a',64)));
 if result->>'id'<>file->>'id' then raise exception 'Duplicate upload metadata created another file';end if;
 begin
  perform public.bia_customer_tools_v1(slug,other_token,other_device,other_sid,'files_get',jsonb_build_object('fileId',file->>'id'));
  raise exception 'Cross-device file access succeeded';
 exception when others then if sqlerrm<>'PUBLIC_AGENT_FILE_NOT_FOUND' then raise;end if;end;
 begin
  perform public.bia_customer_tools_v1(slug,token,device,other_sid,'notices');
  raise exception 'Stale conversation was accepted';
 exception when others then if sqlerrm<>'PUBLIC_AGENT_CONVERSATION_CHANGED' then raise;end if;end;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'files_ready',jsonb_build_object('fileId',file->>'id'));
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'files_list');
 if jsonb_array_length(result)<>0 then raise exception 'Unsent document appeared in history';end if;
 payload:=jsonb_build_object('message','Confira o arquivo de teste.','source','text','fileIds',jsonb_build_array(file->>'id'));
 claim:=public.claim_public_agent_request_v4(slug,token,device,rid,'message',payload);
 reply:=jsonb_build_object('reply','Referência A-902 disponível.','stage','discovery','status','completed','attachments','[]'::jsonb);
 result:=public.finish_bia_turn_with_files_v1(slug,token,device,rid,(claim->>'leaseToken')::uuid,payload,reply);
 result:=public.finish_bia_turn_with_files_v1(slug,token,device,rid,(claim->>'leaseToken')::uuid,payload,reply);
 if (select count(*) from crm_private.public_agent_messages where session_id=sid and direction='user')<>1 then raise exception 'Retry duplicated the turn';end if;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'files_list');
 if jsonb_array_length(result)<>1 or result#>>'{0,messageId}' is null or result::text like '%storage_path%' or result::text like '%sha256%' then raise exception 'Saved file DTO invalid';end if;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'notices');
 if (result->>'unread_count')::integer<>1 or jsonb_array_length(result->'items')<>1 then raise exception 'Notification missing or greeting became a notice';end if;
 msg:=result#>>'{items,0,id}';
 result:=public.bia_customer_tools_v1(slug,other_token,other_device,other_sid,'notices');
 if (result->>'unread_count')::integer<>0 then raise exception 'Notices crossed device boundary';end if;
 result:=public.bia_customer_tools_v1(slug,other_token,other_device,other_sid,'notices_read',jsonb_build_object('ids',jsonb_build_array(msg)));
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'notices');
 if (result->>'unread_count')::integer<>1 then raise exception 'Other device changed read state';end if;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'notices_read',jsonb_build_object('ids',jsonb_build_array(msg)));
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'notices');
 if (result->>'unread_count')::integer<>0 then raise exception 'Read state did not persist';end if;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'speech_reply',jsonb_build_object('messageId','assistant-'||rid));
 if result->>'content'<>reply->>'reply' then raise exception 'Optimistic voice message ID was not resolved';end if;
 begin
  perform public.bia_customer_tools_v1(slug,other_token,other_device,other_sid,'speech_reply',jsonb_build_object('messageId',msg));
  raise exception 'Speech accessed another device reply';
 exception when others then if sqlerrm<>'PUBLIC_AGENT_MESSAGE_NOT_FOUND' then raise;end if;end;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'speech_consume','{"characters":100}');
 if result<>'true'::jsonb then raise exception 'Speech quota failed';end if;
 update crm_private.bia_customer_speech_usage set characters=30000 where fingerprint_hash=device;
 result:=public.bia_customer_tools_v1(slug,token,device,sid,'speech_consume','{"characters":100}');
 if result<>'false'::jsonb then raise exception 'Speech exceeded daily quota';end if;
 if has_function_privilege('anon','public.bia_customer_tools_v1(text,text,text,uuid,text,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.finish_bia_turn_with_files_v1(text,text,text,uuid,uuid,jsonb,jsonb)','EXECUTE') then raise exception 'Public role can bypass gateway';end if;
 if (select public from storage.buckets where id='bia-customer-files') then raise exception 'Files bucket is public';end if;
end $$;
rollback;
