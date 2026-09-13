-- The current form does not ask an investment range; preserve historical answers.
alter table private.crm_public_form_submissions alter column budget drop not null;

CREATE OR REPLACE FUNCTION public.submit_solaris_public_form(p_submission jsonb, p_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 hour_key text:=to_char(now() at time zone 'UTC','YYYY-MM-DD-HH24');
begin
 if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'FORM_FORBIDDEN'; end if;
 if jsonb_typeof(p_submission) is distinct from 'object' or pg_column_size(p_submission)>8192
    or p_submission->>'requestId' is null or p_submission->>'requestId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'FORM_INVALID'; end if;
 request_id:=(p_submission->>'requestId')::uuid;
 person:=regexp_replace(trim(p_submission->>'name'),'\s+',' ','g');
 phone_number:=p_submission->>'phone'; objective:=p_submission->>'purpose'; investment:=p_submission->>'budget';
 attrs:=coalesce(p_submission->'attribution','{}'::jsonb);
 if person is null or length(person) not between 3 and 120 or phone_number is null or phone_number !~ '^\+55[1-9][0-9][2-9][0-9]{7,8}$'
    or (p_submission->'consent') is distinct from 'true'::jsonb or objective is null or objective not in ('investir','morar')
    or (investment is not null and investment not in ('300_500','acima_500')) or jsonb_typeof(attrs)<>'object' or pg_column_size(attrs)>4096 then raise exception 'FORM_INVALID'; end if;
 select * into cfg from private.crm_public_forms where slug='solaris-futura-casa' and active;
 if not found then raise exception 'FORM_UNAVAILABLE'; end if;
 -- One transaction owns each request, so an uncertain HTTP retry cannot duplicate a lead.
 perform pg_advisory_xact_lock(hashtextextended('solaris-request:'||request_id::text,0));
 select * into previous from private.crm_public_form_submissions where id=request_id;
 if found then
   if previous.person_name<>person or previous.phone<>phone_number or previous.purpose<>objective or previous.budget is distinct from investment then raise exception 'FORM_ID_CONFLICT'; end if;
   return jsonb_build_object('id',request_id,'duplicate',true);
 end if;
 delete from private.crm_public_form_limits where expires_at<now();
 foreach rate_key in array array['ip:'||p_fingerprint,'phone:'||md5(phone_number)||':'||hour_key,'all:'||hour_key] loop
   insert into private.crm_public_form_limits(key,count,expires_at) values(rate_key,1,now()+interval '2 hours')
   on conflict(key) do update set count=private.crm_public_form_limits.count+1 returning count into counter;
   if counter>(case when rate_key like 'all:%' then 500 when rate_key like 'phone:%' then 5 else 20 end) then raise exception 'FORM_RATE_LIMIT'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(cfg.organization_id::text||':solaris:'||phone_number||':'||lower(person),0));
 -- Match both name and phone: shared phone numbers must not merge different people.
 select id,contact_id into lead_id,contact_key from public.crm_records
 where organization_id=cfg.organization_id and project_id=cfg.project_id and record_status='aberta'
 and lower(trim(person_name))=lower(person) and regexp_replace(phone,'[^0-9]','','g') in (substring(phone_number from 2),substring(phone_number from 4))
 order by created_at desc,id limit 1;
 detail:='Formulário Futura Casa / Solaris. Registro '||upper(left(request_id::text,8))||'. Objetivo: '||objective||case when investment='300_500' then '. Faixa: entre R$ 300 mil e R$ 500 mil' when investment='acima_500' then '. Faixa: acima de R$ 500 mil' else '' end||'. Autorização de contato por WhatsApp sobre o Solaris: aceita ('||'solaris-whatsapp-v1'||').';
 if lead_id is null then
   select id into contact_key from public.contacts where organization_id=cfg.organization_id and active and lower(trim(name))=lower(person)
     and regexp_replace(phone,'[^0-9]','','g') in (substring(phone_number from 2),substring(phone_number from 4)) order by created_at desc,id limit 1;
   if contact_key is null then
     insert into public.contacts(organization_id,contact_type,name,phone,preferred_channel,data_processing_basis,notes)
     values(cfg.organization_id,'prospect',person,phone_number,'whatsapp','consent',detail) returning id into contact_key;
   end if;
   insert into public.crm_records(organization_id,contact_id,person_name,phone,project_id,pipeline_id,stage_id,stage,record_status,source,source_channel,lead_source_id,notes,tags,budget_min,budget_max,preferred_city,landing_page,utm_source,utm_medium,utm_campaign,utm_content)
   values(cfg.organization_id,contact_key,person,phone_number,cfg.project_id,cfg.pipeline_id,cfg.stage_id,'novo','aberta','Futura Casa — Formulário Solaris','web_form',cfg.lead_source_id,detail,array['formulario_futura_casa','solaris',objective],case when investment='300_500' then 300000 when investment='acima_500' then 500000 else null end,case when investment='300_500' then 500000 else null end,'Monte Carmelo',cfg.landing_page,left(attrs->>'utm_source',200),left(attrs->>'utm_medium',200),left(attrs->>'utm_campaign',200),left(attrs->>'utm_content',200)) returning id into lead_id;
 else
   update public.crm_records set notes=concat_ws(E'\n\n',nullif(notes,''),detail),
     tags=array(select distinct unnest(coalesce(tags,'{}'::text[])||array['formulario_futura_casa','solaris',objective])),
     updated_at=now() where id=lead_id;
 end if;
 insert into private.crm_public_form_submissions(id,form_slug,organization_id,crm_record_id,person_name,phone,purpose,budget,consent_version,attribution)
 values(request_id,cfg.slug,cfg.organization_id,lead_id,person,phone_number,objective,investment,'solaris-whatsapp-v1',attrs);
 return jsonb_build_object('id',request_id,'duplicate',false);
end;
$function$;
