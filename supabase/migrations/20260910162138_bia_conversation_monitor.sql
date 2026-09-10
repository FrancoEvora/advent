begin;
create function public.bia_whatsapp_monitor(p_organization_id uuid,p_thread_id uuid default null,p_search text default '',p_filter text default 'all',p_offset integer default 0,p_message_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; result jsonb; selected jsonb; messages jsonb; message_count bigint;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'BIA_INBOX_FORBIDDEN' using errcode='42501'; end if;
  if p_filter is null or p_filter not in ('all','human','automatic','opted_out') or p_offset is null or p_offset not between 0 and 100000 or p_message_offset is null or p_message_offset not between 0 and 1000000 or char_length(coalesce(p_search,''))>120 then raise exception 'BIA_MONITOR_INPUT_INVALID'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id;
  if p_thread_id is not null and not exists(select 1 from crm_private.bia_whatsapp_threads t where t.id=p_thread_id and t.channel_id=ch.id) then raise exception 'BIA_THREAD_NOT_FOUND'; end if;
  with candidates as (
    select t.id,t.peer_phone,t.human_requested,t.opted_out_at,s.crm_record_id,
      coalesce(nullif(s.contact_capture->>'name',''),r.person_name) as customer_name,
      greatest(t.created_at,t.last_inbound_at,last_message.occurred_at) as last_activity_at,
      left(last_message.content,160) as last_message,
      case when last_message.delivery_status='sending' and last_message.occurred_at<now()-interval '2 minutes' then 'unknown' else last_message.delivery_status end as delivery_status
    from crm_private.bia_whatsapp_threads t join crm_private.public_agent_sessions s on s.id=t.session_id
    left join public.crm_records r on r.id=s.crm_record_id and r.organization_id=p_organization_id
    left join lateral(select m.content,m.delivery_status,m.occurred_at from crm_private.bia_whatsapp_messages m where m.thread_id=t.id order by m.occurred_at desc,m.id desc limit 1) last_message on true
    where t.channel_id=ch.id
      and (nullif(trim(p_search),'') is null or concat_ws(' ',s.contact_capture->>'name',r.person_name,t.peer_phone) ilike '%'||trim(p_search)||'%' or (regexp_replace(p_search,'[^0-9]','','g')<>'' and t.peer_phone like '%'||regexp_replace(p_search,'[^0-9]','','g')||'%'))
      and (p_filter='all' or p_filter='human' and t.human_requested and t.opted_out_at is null or p_filter='automatic' and not t.human_requested and t.opted_out_at is null or p_filter='opted_out' and t.opted_out_at is not null)
  ), page as (select * from candidates order by last_activity_at desc,id desc limit 25 offset p_offset)
  select jsonb_build_object('threads',coalesce((select jsonb_agg(to_jsonb(p) order by p.last_activity_at desc,p.id desc) from page p),'[]'::jsonb),'total',(select count(*) from candidates)) into result;
  select jsonb_build_object('id',t.id,'peer_phone',t.peer_phone,'customer_name',coalesce(nullif(s.contact_capture->>'name',''),r.person_name),'human_requested',t.human_requested,'opted_out_at',t.opted_out_at,'crm_record_id',s.crm_record_id) into selected
    from crm_private.bia_whatsapp_threads t join crm_private.public_agent_sessions s on s.id=t.session_id left join public.crm_records r on r.id=s.crm_record_id and r.organization_id=p_organization_id where t.id=p_thread_id and t.channel_id=ch.id;
  select count(*) into message_count from crm_private.bia_whatsapp_messages m join crm_private.bia_whatsapp_threads t on t.id=m.thread_id where t.channel_id=ch.id and t.id=p_thread_id;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.occurred_at,page.id),'[]'::jsonb) into messages from (
    select m.id,m.direction,m.content,m.message_type,case when m.delivery_status='sending' and m.created_at<now()-interval '2 minutes' then 'unknown' else m.delivery_status end as delivery_status,m.metadata->>'error_code' as error_code,m.occurred_at
    from crm_private.bia_whatsapp_messages m join crm_private.bia_whatsapp_threads t on t.id=m.thread_id where t.channel_id=ch.id and t.id=p_thread_id order by m.occurred_at desc,m.id desc limit 50 offset p_message_offset
  ) page;
  return result||jsonb_build_object('enabled',coalesce(ch.enabled,false),'verified',ch.webhook_verified_at is not null,'phone',ch.display_phone_number,'selected',selected,'messages',messages,'message_total',message_count,'offset',p_offset,'message_offset',p_message_offset,'updated_at',now());
end $$;
revoke all on function public.bia_whatsapp_monitor(uuid,uuid,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.bia_whatsapp_monitor(uuid,uuid,text,text,integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;

