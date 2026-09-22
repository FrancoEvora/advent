
create table if not exists crm_private.bia_whatsapp_optins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone_key text not null,
  source_record_id uuid references public.crm_records(id) on delete set null,
  consent_source text not null
    check (consent_source in ('whatsapp','telefone','presencial','formulario','email','outro')),
  consent_at timestamptz not null,
  evidence_note text not null
    check (char_length(btrim(evidence_note)) between 5 and 500),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete restrict
);

alter table crm_private.bia_whatsapp_optins enable row level security;
revoke all on table crm_private.bia_whatsapp_optins from public,anon,authenticated;

create unique index if not exists bia_whatsapp_optins_active_phone_unique
  on crm_private.bia_whatsapp_optins(organization_id,phone_key)
  where revoked_at is null;

create index if not exists bia_whatsapp_optins_record_idx
  on crm_private.bia_whatsapp_optins(source_record_id,created_at desc);

do $$
declare
  ddl text;
begin
  select pg_get_functiondef(
    'crm_private.bia_bulk_consent_for_record(uuid,uuid)'::regprocedure
  ) into ddl;

  if position('crm_private.bia_whatsapp_optins' in ddl)=0 then
    ddl := replace(
      ddl,
      '  v_phone text;'||chr(10),
      '  v_phone text;'||chr(10)||'  manual crm_private.bia_whatsapp_optins;'||chr(10)
    );
    ddl := replace(
      ddl,
      '  return null;'||chr(10)||'end'||chr(10)||'$function$',
      '  select o.* into manual'||chr(10)||
      '  from crm_private.bia_whatsapp_optins o'||chr(10)||
      '  where o.organization_id=cfg.organization_id'||chr(10)||
      '    and o.phone_key=crm_private.bia_phone_key(v_phone)'||chr(10)||
      '    and o.revoked_at is null'||chr(10)||
      '    and o.consent_at<=now()'||chr(10)||
      '  order by o.consent_at desc,o.created_at desc'||chr(10)||
      '  limit 1;'||chr(10)||
      '  if manual.id is not null then'||chr(10)||
      '    return jsonb_build_object('||chr(10)||
      '      ''source'',''manual_admin'',''sourceId'',manual.id,'||chr(10)||
      '      ''version'',''bia-whatsapp-optin-v1'',''at'',manual.consent_at,'||chr(10)||
      '      ''basis'',''documented_whatsapp_opt_in'',''method'',manual.consent_source'||chr(10)||
      '    );'||chr(10)||
      '  end if;'||chr(10)||
      '  return null;'||chr(10)||'end'||chr(10)||'$function$'
    );
    execute ddl;
  end if;
end
$$;

create or replace function public.bia_strategy_queue_record_optin(
  p_organization_id uuid,
  p_crm_record_id uuid,
  p_source text,
  p_consent_at timestamptz,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid:=auth.uid();
  lead public.crm_records%rowtype;
  contact public.contacts%rowtype;
  v_phone text;
  v_key text;
  optin crm_private.bia_whatsapp_optins%rowtype;
begin
  if actor is null or not exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=actor
      and m.organization_id=p_organization_id
      and m.active
      and lower(m.role)='admin'
      and o.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  if p_source not in ('whatsapp','telefone','presencial','formulario','email','outro')
     or p_consent_at is null
     or p_consent_at>now()+interval '5 minutes'
     or p_consent_at<now()-interval '5 years'
     or char_length(btrim(coalesce(p_note,''))) not between 5 and 500 then
    raise exception 'BIA_OPTIN_EVIDENCE_INVALID';
  end if;

  select * into lead
  from public.crm_records
  where id=p_crm_record_id
    and organization_id=p_organization_id
    and record_status='aberta';

  if lead.id is null then
    raise exception 'BIA_CAMPAIGN_LEAD_INACTIVE';
  end if;

  v_phone:=regexp_replace(coalesce(lead.phone,''),'[^0-9]','','g');
  if length(v_phone) in(10,11) then v_phone:='55'||v_phone; end if;
  if coalesce(v_phone,'') !~ '^55[1-9][0-9]([2-9][0-9]{7}|9[0-9]{8})$' then
    raise exception 'BIA_PHONE_INVALID';
  end if;
  v_key:=crm_private.bia_phone_key(v_phone);

  select * into contact from public.contacts where id=lead.contact_id;
  if contact.id is not null and (
    not contact.active
    or contact.do_not_contact_at is not null
    or contact.marketing_consent_status in ('denied','revoked')
  ) then
    raise exception 'BIA_CONTACT_PAUSED';
  end if;

  if exists(
    select 1
    from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
    where ch.organization_id=p_organization_id
      and crm_private.bia_phone_key(t.peer_phone)=v_key
      and t.opted_out_at is not null
  ) then
    raise exception 'BIA_CONTACT_PAUSED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bia-optin:'||p_organization_id::text||':'||v_key,0));

  update crm_private.bia_whatsapp_optins
  set revoked_at=now(),revoked_by=actor
  where organization_id=p_organization_id
    and phone_key=v_key
    and revoked_at is null;

  insert into crm_private.bia_whatsapp_optins(
    organization_id,phone_key,source_record_id,consent_source,consent_at,
    evidence_note,recorded_by
  )
  values(
    p_organization_id,v_key,lead.id,p_source,p_consent_at,btrim(p_note),actor
  )
  returning * into optin;

  if contact.id is not null then
    update public.contacts
    set marketing_consent_status='granted',
        marketing_consent_at=p_consent_at,
        marketing_consent_source='bia_manual_'||p_source,
        preferred_channel=coalesce(preferred_channel,'whatsapp'),
        updated_at=now()
    where id=contact.id
      and organization_id=p_organization_id
      and do_not_contact_at is null
      and marketing_consent_status not in('denied','revoked');
  end if;

  update crm_private.bia_strategy_queue q
  set last_error=case
        when q.recommended_settings_id is null then q.last_error
        else crm_private.bia_bulk_candidate_reason(q.recommended_settings_id,q.crm_record_id)
      end,
      updated_at=now()
  where q.organization_id=p_organization_id
    and q.status='staged'
    and q.crm_record_id in (
      select r.id
      from public.crm_records r
      where r.organization_id=p_organization_id
        and crm_private.bia_phone_key(
          case
            when length(regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')) in (10,11)
              then '55'||regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
            else regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
          end
        )=v_key
    );

  return jsonb_build_object(
    'ok',true,
    'id',optin.id,
    'phoneKey',v_key,
    'consentAt',optin.consent_at,
    'source',optin.consent_source
  );
end
$function$;

revoke all on function public.bia_strategy_queue_record_optin(uuid,uuid,text,timestamptz,text)
  from public,anon;
grant execute on function public.bia_strategy_queue_record_optin(uuid,uuid,text,timestamptz,text)
  to authenticated;

create or replace function public.bia_strategy_queue_find_thread(
  p_organization_id uuid,
  p_queue_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid:=auth.uid();
  lead public.crm_records%rowtype;
  v_phone text;
  v_key text;
  thread crm_private.bia_whatsapp_threads%rowtype;
begin
  if actor is null or not exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=actor
      and m.organization_id=p_organization_id
      and m.active
      and lower(m.role)='admin'
      and o.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  select r.* into lead
  from crm_private.bia_strategy_queue q
  join public.crm_records r
    on r.id=q.crm_record_id
   and r.organization_id=q.organization_id
  where q.id=p_queue_id
    and q.organization_id=p_organization_id;

  if lead.id is null then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end if;

  v_phone:=regexp_replace(coalesce(lead.phone,''),'[^0-9]','','g');
  if length(v_phone) in(10,11) then v_phone:='55'||v_phone; end if;
  v_key:=crm_private.bia_phone_key(v_phone);

  select t.* into thread
  from crm_private.bia_whatsapp_threads t
  join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
  where ch.organization_id=p_organization_id
    and crm_private.bia_phone_key(t.peer_phone)=v_key
  order by t.last_inbound_at desc nulls last,t.created_at desc
  limit 1;

  return jsonb_build_object(
    'threadId',thread.id,
    'phone',coalesce(thread.peer_phone,v_phone),
    'found',thread.id is not null
  );
end
$function$;

revoke all on function public.bia_strategy_queue_find_thread(uuid,uuid)
  from public,anon;
grant execute on function public.bia_strategy_queue_find_thread(uuid,uuid)
  to authenticated;
