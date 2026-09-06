begin;
set local lock_timeout='10s';
set local statement_timeout='90s';
alter table private.arisa_mail_oauth_states add column purpose text not null default 'mail' check(purpose in ('mail','calendar'));
alter function public.arisa_mail_service(text,uuid,uuid,jsonb) rename to arisa_mail_service_before_calendar;
alter function public.arisa_mail_service_before_calendar(text,uuid,uuid,jsonb) set schema private;
revoke all on function private.arisa_mail_service_before_calendar(text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.arisa_mail_service(p_action text,p_org uuid,p_actor uuid default null,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; v_purpose text; scopes text[]; required text[]:=array['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'];
  calendar_scopes text[]:=array['https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.events.freebusy','https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
begin
  if p_action='oauth_finish' then
    select s.purpose into v_purpose from private.arisa_mail_oauth_states s where state_hash=p_args->>'state_hash' and organization_id=p_org and actor_user_id=p_actor;
    if v_purpose='calendar' then
      scopes:=array(select jsonb_array_elements_text(coalesce(p_args->'scopes','[]')));
      if not scopes @> (required||calendar_scopes) then raise exception 'CALENDAR_AUTH_REQUIRED'; end if;
    end if;
  end if;
  result:=private.arisa_mail_service_before_calendar(p_action,p_org,p_actor,p_args);
  if p_action='oauth_begin' then
    v_purpose:=case when p_args->>'purpose'='calendar' then 'calendar' else 'mail' end;
    update private.arisa_mail_oauth_states set purpose=v_purpose where state_hash=p_args->>'state_hash' and organization_id=p_org and actor_user_id=p_actor;
    return result||jsonb_build_object('purpose',v_purpose);
  elsif p_action='oauth_consume' then
    select s.purpose into v_purpose from private.arisa_mail_oauth_states s where state_hash=p_args->>'state_hash' and organization_id=p_org and actor_user_id=p_actor;
    return result||jsonb_build_object('purpose',v_purpose,'required_scopes',to_jsonb(case when v_purpose='calendar' then required||calendar_scopes else required end));
  elsif p_action in ('status','runtime') then
    select c.scopes into scopes from private.arisa_mail_credentials c where organization_id=p_org;
    return result||jsonb_build_object('calendar_authorized',coalesce(scopes @> calendar_scopes,false),'calendar_scopes_required',to_jsonb(calendar_scopes));
  elsif p_action='oauth_finish' then
    return result||jsonb_build_object('calendar_authorized',v_purpose='calendar');
  end if;
  return result;
end $$;
revoke all on function public.arisa_mail_service(text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.arisa_mail_service(text,uuid,uuid,jsonb) to service_role;
create table public.arisa_calendar_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 calendar_id text not null, provider_event_id text not null, created_by uuid not null references auth.users(id),
 activity_id uuid references public.user_activities(id), data jsonb not null default '{}',
 updated_at timestamptz not null default now(), unique(organization_id,calendar_id,provider_event_id)
);
create index arisa_calendar_event_actor on public.arisa_calendar_events(created_by);
create index arisa_calendar_event_activity on public.arisa_calendar_events(activity_id);
create table public.arisa_calendar_operations (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 actor_user_id uuid not null references auth.users(id), source_message_id uuid references public.arisa_chat_messages(id),
 operation_key text not null check(operation_key ~ '^[a-f0-9]{64}$'),action text not null check(action in ('create','update','cancel')),
 payload_hash text not null, calendar_id text not null,provider_event_id text not null,
 status text not null default 'running' check(status in ('running','completed','failed','unknown')),
 result jsonb, error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(organization_id,operation_key)
);
create index arisa_calendar_op_actor on public.arisa_calendar_operations(actor_user_id);
create index arisa_calendar_op_source on public.arisa_calendar_operations(source_message_id);
create index arisa_calendar_op_pending on public.arisa_calendar_operations(status,updated_at) where status in ('running','unknown');
alter table public.arisa_calendar_events enable row level security;
alter table public.arisa_calendar_operations enable row level security;
revoke all on public.arisa_calendar_events,public.arisa_calendar_operations from public,anon,authenticated,service_role;
grant select on public.arisa_calendar_events,public.arisa_calendar_operations to authenticated,service_role;
create policy arisa_calendar_events_admin on public.arisa_calendar_events for select to authenticated using(private.arisa_is_admin(organization_id));
create policy arisa_calendar_ops_admin on public.arisa_calendar_operations for select to authenticated using(private.arisa_is_admin(organization_id));
create function public.arisa_calendar_service(p_action text,p_org uuid,p_actor uuid,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.arisa_calendar_operations; stored public.arisa_calendar_events; event jsonb; v_result jsonb; activity uuid; starts timestamptz; ends timestamptz; fresh boolean:=false;
begin
 if not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_action='prepare' then
   if p_args->>'action' not in ('create','update','cancel') or p_args->>'operation_key' !~ '^[a-f0-9]{64}$' or p_args->>'payload_hash' !~ '^[a-f0-9]{64}$' then raise exception 'CALENDAR_INVALID'; end if;
   if nullif(p_args->>'message_id','') is not null and not exists(select 1 from public.arisa_chat_messages m where m.id=(p_args->>'message_id')::uuid and m.organization_id=p_org and m.owner_user_id=p_actor and m.role='user' and m.status='processing' and m.lease_token=(p_args->>'lease')::uuid and m.lease_expires_at>now()) then raise exception 'ARISA_LEASE_CHANGED'; end if;
   insert into public.arisa_calendar_operations(organization_id,actor_user_id,source_message_id,operation_key,action,payload_hash,calendar_id,provider_event_id)
   values(p_org,p_actor,nullif(p_args->>'message_id','')::uuid,p_args->>'operation_key',p_args->>'action',p_args->>'payload_hash',p_args->>'calendar_id',p_args->>'event_id') on conflict(organization_id,operation_key) do nothing returning * into op;
   fresh:=found;
   if not fresh then
     select * into op from public.arisa_calendar_operations where organization_id=p_org and operation_key=p_args->>'operation_key' for update;
     if op.actor_user_id<>p_actor then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
     if op.status='failed' then
       update public.arisa_calendar_operations set status='running',payload_hash=p_args->>'payload_hash',calendar_id=p_args->>'calendar_id',provider_event_id=p_args->>'event_id',error_code=null,updated_at=now() where id=op.id returning * into op;fresh:=true;
     elsif op.payload_hash<>p_args->>'payload_hash' then raise exception 'CALENDAR_REQUEST_CHANGED'; end if;
   end if;
   return to_jsonb(op)||jsonb_build_object('proceed',fresh);
 elsif p_action='get_operation' then
   select * into op from public.arisa_calendar_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor;
   if not found then raise exception 'CALENDAR_NOT_FOUND'; end if;
   return to_jsonb(op);
 elsif p_action='fail' then
   update public.arisa_calendar_operations set status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,error_code=left(p_args->>'error',80),updated_at=now()
     where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor and status<>'completed';
   return jsonb_build_object('ok',true);
 elsif p_action in ('finish','refresh') then
   if p_action='finish' then
     select * into op from public.arisa_calendar_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;
     if not found then raise exception 'CALENDAR_NOT_FOUND'; end if;
     if op.status='completed' then return op.result; end if;
   end if;
   event:=p_args->'event';
   if jsonb_typeof(event)<>'object' or length(coalesce(event->>'id',''))=0 or length(coalesce(event->>'calendar_id',''))=0 then raise exception 'CALENDAR_INVALID'; end if;
   if p_action='finish' and (event->>'id'<>op.provider_event_id or event->>'calendar_id'<>op.calendar_id) then raise exception 'CALENDAR_INVALID'; end if;
   select * into stored from public.arisa_calendar_events where organization_id=p_org and calendar_id=event->>'calendar_id' and provider_event_id=event->>'id' for update;
   if p_action='refresh' and not found then return event; end if;
   if stored.id is null then
     insert into public.arisa_calendar_events(organization_id,calendar_id,provider_event_id,created_by,data) values(p_org,event->>'calendar_id',event->>'id',p_actor,event) returning * into stored;
   end if;
   starts:=nullif(event#>>'{start,dateTime}','')::timestamptz;ends:=nullif(event#>>'{end,dateTime}','')::timestamptz;
   activity:=stored.activity_id;
   if activity is null and starts is not null and ends>starts and event->>'status'<>'cancelled' then
     insert into public.user_activities(organization_id,owner_user_id,assigned_by,title,description,activity_type,status,priority,starts_at,due_at,related_type,related_id,tags)
     values(p_org,p_actor,p_actor,left(coalesce(event->>'title','Reunião'),250),coalesce(event->>'description','')||E'\nGoogle Agenda: '||coalesce(event->>'google_url','')||E'\nGoogle Meet: '||coalesce(event->>'meet_url','Em processamento'),'reuniao','pendente','normal',starts,ends,'arisa_calendar_events',stored.id,array['google-agenda','arisa']) returning id into activity;
   elsif activity is not null then
     update public.user_activities set title=left(coalesce(event->>'title',title),250),starts_at=coalesce(starts,starts_at),due_at=coalesce(ends,due_at),
       description=coalesce(event->>'description','')||E'\nGoogle Agenda: '||coalesce(event->>'google_url','')||E'\nGoogle Meet: '||coalesce(event->>'meet_url','Não disponível'),
       status=case when event->>'status'='cancelled' then 'cancelada' else status end, updated_by=p_actor,updated_at=now()
     where id=activity and organization_id=p_org;
   end if;
   update public.arisa_calendar_events set data=event,activity_id=activity,updated_at=now() where id=stored.id;
   v_result:=jsonb_build_object('ok',true,'event',event,'activity_id',activity,'provider_confirmed',true,'attendee_acceptance_confirmed',false);
   if p_action='finish' then
     update public.arisa_calendar_operations set status='completed',result=v_result||jsonb_build_object('operation_id',op.id),error_code=null,updated_at=now() where id=op.id returning arisa_calendar_operations.result into v_result;
     if op.source_message_id is not null then
       insert into public.arisa_chat_actions(organization_id,actor_user_id,message_id,operation_key,action,entity,record_id,summary,result)
       values(p_org,p_actor,op.source_message_id,op.operation_key,op.action,'google_calendar',stored.id::text,'Google Agenda: '||coalesce(event->>'title',op.provider_event_id),v_result)
       on conflict do nothing;
     end if;
     perform private.arisa_archive_put(p_org,p_actor,'arisa_calendar_operations',op.id::text,'platform','action','arisa','calendar:'||stored.id,'Agenda','Google Agenda: '||coalesce(event->>'title',op.provider_event_id),'Operação confirmada pelo Google.',v_result,now(),false);
   end if;
   return v_result;
 end if;
 raise exception 'CALENDAR_INVALID';
end $$;
revoke all on function public.arisa_calendar_service(text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.arisa_calendar_service(text,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
