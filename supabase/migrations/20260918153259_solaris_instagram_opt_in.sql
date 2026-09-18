-- Migration version assigned by Supabase when applied to the Enterprise database.
alter table public.crm_records
 add column if not exists instagram_username text,
 add column if not exists instagram_consent boolean not null default false,
 add column if not exists instagram_consent_at timestamptz,
 add column if not exists instagram_consent_version text,
 add column if not exists instagram_source text;
alter table private.crm_public_form_submissions
 add column if not exists instagram_username text,
 add column if not exists instagram_consent boolean not null default false,
 add column if not exists instagram_consent_at timestamptz,
 add column if not exists instagram_consent_version text;
alter table public.crm_records add constraint crm_records_instagram_username_check check (instagram_username is null or (instagram_username ~ '^[a-z0-9_]([a-z0-9._]{0,28}[a-z0-9_])?$' and position('..' in instagram_username)=0));
alter table public.crm_records add constraint crm_records_instagram_consent_check check ((not instagram_consent and instagram_consent_at is null and instagram_consent_version is null) or (instagram_consent and instagram_username is not null and instagram_consent_at is not null and instagram_consent_version='solaris-instagram-v1'));
alter table private.crm_public_form_submissions add constraint solaris_submission_instagram_check check ((instagram_username is null or (instagram_username ~ '^[a-z0-9_]([a-z0-9._]{0,28}[a-z0-9_])?$' and position('..' in instagram_username)=0)) and ((not instagram_consent and instagram_consent_at is null and instagram_consent_version is null) or (instagram_consent and instagram_username is not null and instagram_consent_at is not null and instagram_consent_version='solaris-instagram-v1')));
comment on column public.crm_records.instagram_username is 'Instagram fornecido pelo lead ou cadastrado manualmente; não verifica identidade e não concede acesso a conteúdo.';
comment on column public.crm_records.instagram_consent is 'Opt-in específico de personalização, separado da autorização de contato. Não autoriza contornar restrições de acesso do Instagram.';

create or replace function private.guard_crm_instagram_consent() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_user not in ('postgres','service_role','supabase_admin') then
  if tg_op='UPDATE' then
   if new.instagram_username is not distinct from old.instagram_username then
    if new.instagram_consent and (not old.instagram_consent or new.instagram_consent_at is distinct from old.instagram_consent_at or new.instagram_consent_version is distinct from old.instagram_consent_version) then
     raise exception 'INSTAGRAM_CONSENT_REQUIRES_LEAD_OPT_IN';
    end if;
    new.instagram_source:=old.instagram_source;
   else
    new.instagram_consent:=false;
    new.instagram_source:=case when new.instagram_username is null then null else 'crm_manual' end;
   end if;
  else
   new.instagram_consent:=false;
   new.instagram_source:=case when new.instagram_username is null then null else 'crm_manual' end;
  end if;
  if not new.instagram_consent then new.instagram_consent_at:=null;new.instagram_consent_version:=null;end if;
 end if;
 return new;
end;
$$;
revoke all on function private.guard_crm_instagram_consent() from public,anon,authenticated;
create trigger guard_crm_instagram_consent before insert or update of instagram_username,instagram_consent,instagram_consent_at,instagram_consent_version,instagram_source on public.crm_records for each row execute function private.guard_crm_instagram_consent();

create or replace function public.submit_solaris_public_form(p_submission jsonb,p_fingerprint text) returns jsonb language plpgsql security invoker set search_path='' as $function$
declare
 cfg private.crm_public_forms%rowtype;
 previous private.crm_public_form_submissions%rowtype;
 request_id uuid;
 person text;
 phone_number text;
 objective text;
 investment text;
 attrs jsonb;
 lead_id uuid;
 contact_key uuid;
 detail text;
 counter integer;
 rate_key text;
 ig_username text;
 ig_consent boolean;
 hour_key text:=to_char(now() at time zone 'UTC','YYYY-MM-DD-HH24');
begin
 if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'FORM_FORBIDDEN';end if;
 if jsonb_typeof(p_submission) is distinct from 'object' or pg_column_size(p_submission)>8192
  or p_submission->>'requestId' is null or p_submission->>'requestId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'FORM_INVALID';end if;
 request_id:=(p_submission->>'requestId')::uuid;
 person:=regexp_replace(trim(p_submission->>'name'),'[[:space:]]+',' ','g');
 phone_number:=p_submission->>'phone';objective:=p_submission->>'purpose';investment:=p_submission->>'budget';
 attrs:=coalesce(p_submission->'attribution','{}'::jsonb);
 if person is null or length(person) not between 3 and 120 or phone_number is null or phone_number !~ '^[+]55[1-9][0-9][2-9][0-9]{7,8}$'
  or (p_submission->'consent') is distinct from 'true'::jsonb or objective is null or objective not in ('investir','morar')
  or (investment is not null and investment not in ('300_500','acima_500')) or jsonb_typeof(attrs)<>'object' or pg_column_size(attrs)>4096 then raise exception 'FORM_INVALID';end if;
 if p_submission ? 'instagram' and jsonb_typeof(p_submission->'instagram') not in ('string','null') then raise exception 'FORM_INVALID';end if;
 if p_submission ? 'instagramConsent' and jsonb_typeof(p_submission->'instagramConsent')<>'boolean' then raise exception 'FORM_INVALID';end if;
 ig_username:=nullif(lower(trim(p_submission->>'instagram')),'');
 ig_consent:=coalesce(p_submission->'instagramConsent','false'::jsonb)='true'::jsonb;
 if (ig_username is not null and (ig_username !~ '^[a-z0-9_]([a-z0-9._]{0,28}[a-z0-9_])?$' or position('..' in ig_username)>0 or ig_username in ('p','reel','reels','stories','explore','accounts','direct','about','developer','legal','privacy','terms'))) or (ig_consent and ig_username is null) then raise exception 'FORM_INVALID';end if;
 select * into cfg from private.crm_public_forms where slug='solaris-futura-casa' and active;
 if not found then raise exception 'FORM_UNAVAILABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended('solaris-request:'||request_id::text,0));
 select * into previous from private.crm_public_form_submissions where id=request_id;
 if found then
  if previous.person_name<>person or previous.phone<>phone_number or previous.purpose<>objective or previous.budget is distinct from investment or previous.instagram_username is distinct from ig_username or previous.instagram_consent is distinct from ig_consent then raise exception 'FORM_ID_CONFLICT';end if;
  return jsonb_build_object('id',request_id,'duplicate',true);
 end if;
 delete from private.crm_public_form_limits where expires_at<now();
 foreach rate_key in array array['ip:'||p_fingerprint,'phone:'||md5(phone_number)||':'||hour_key,'all:'||hour_key] loop
  insert into private.crm_public_form_limits(key,count,expires_at) values(rate_key,1,now()+interval '2 hours')
  on conflict(key) do update set count=private.crm_public_form_limits.count+1 returning count into counter;
  if counter>(case when rate_key like 'all:%' then 500 when rate_key like 'phone:%' then 5 else 20 end) then raise exception 'FORM_RATE_LIMIT';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(cfg.organization_id::text||':solaris:'||phone_number||':'||lower(person),0));
 select id,contact_id into lead_id,contact_key from public.crm_records
 where organization_id=cfg.organization_id and project_id=cfg.project_id and record_status='aberta'
 and lower(trim(person_name))=lower(person) and regexp_replace(phone,'[^0-9]','','g') in (substring(phone_number from 2),substring(phone_number from 4))
 order by created_at desc,id limit 1;
 detail:='Formulário Futura Casa / Solaris. Registro '||upper(left(request_id::text,8))||'. Objetivo: '||objective||case when investment='300_500' then '. Faixa: entre R$ 300 mil e R$ 500 mil' when investment='acima_500' then '. Faixa: acima de R$ 500 mil' else '' end||'. Autorização de contato por WhatsApp sobre o Solaris: aceita (solaris-whatsapp-v1).';
 if ig_username is not null then detail:=detail||E'\nInstagram informado: @'||ig_username||'. Personalização pelo Instagram: '||case when ig_consent then 'autorizada (solaris-instagram-v1)' else 'não autorizada' end||'. Perfil não verificado; nenhum conteúdo foi consultado automaticamente.';end if;
 if lead_id is null then
  select id into contact_key from public.contacts where organization_id=cfg.organization_id and active and lower(trim(name))=lower(person)
  and regexp_replace(phone,'[^0-9]','','g') in (substring(phone_number from 2),substring(phone_number from 4)) order by created_at desc,id limit 1;
  if contact_key is null then
   insert into public.contacts(organization_id,contact_type,name,phone,preferred_channel,data_processing_basis,notes)
   values(cfg.organization_id,'prospect',person,phone_number,'whatsapp','consent',detail) returning id into contact_key;
  end if;
  insert into public.crm_records(organization_id,contact_id,person_name,phone,project_id,pipeline_id,stage_id,stage,record_status,source,source_channel,lead_source_id,notes,tags,budget_min,budget_max,preferred_city,landing_page,utm_source,utm_medium,utm_campaign,utm_content,instagram_username,instagram_consent,instagram_consent_at,instagram_consent_version,instagram_source)
  values(cfg.organization_id,contact_key,person,phone_number,cfg.project_id,cfg.pipeline_id,cfg.stage_id,'novo','aberta','Futura Casa — Formulário Solaris','web_form',cfg.lead_source_id,detail,array['formulario_futura_casa','solaris',objective],case when investment='300_500' then 300000 when investment='acima_500' then 500000 else null end,case when investment='300_500' then 500000 else null end,'Monte Carmelo',cfg.landing_page,left(attrs->>'utm_source',200),left(attrs->>'utm_medium',200),left(attrs->>'utm_campaign',200),left(attrs->>'utm_content',200),ig_username,ig_consent,case when ig_consent then now() else null end,case when ig_consent then 'solaris-instagram-v1' else null end,case when ig_username is not null then 'solaris_landing_page' else null end) returning id into lead_id;
 else
  update public.crm_records set notes=concat_ws(E'\n\n',nullif(notes,''),detail),
   tags=array(select distinct unnest(coalesce(tags,'{}'::text[])||array['formulario_futura_casa','solaris',objective])),updated_at=now() where id=lead_id;
  if ig_username is not null then
   update public.crm_records set instagram_username=ig_username,instagram_consent=ig_consent,instagram_consent_at=case when ig_consent then now() else null end,instagram_consent_version=case when ig_consent then 'solaris-instagram-v1' else null end,instagram_source='solaris_landing_page' where id=lead_id;
  end if;
 end if;
 insert into private.crm_public_form_submissions(id,form_slug,organization_id,crm_record_id,person_name,phone,purpose,budget,consent_version,attribution,instagram_username,instagram_consent,instagram_consent_at,instagram_consent_version)
 values(request_id,cfg.slug,cfg.organization_id,lead_id,person,phone_number,objective,investment,'solaris-whatsapp-v1',attrs,ig_username,ig_consent,case when ig_consent then now() else null end,case when ig_consent then 'solaris-instagram-v1' else null end);
 return jsonb_build_object('id',request_id,'duplicate',false);
end;
$function$;
revoke all on function public.submit_solaris_public_form(jsonb,text) from public,anon,authenticated;
grant execute on function public.submit_solaris_public_form(jsonb,text) to service_role;
notify pgrst,'reload schema';
