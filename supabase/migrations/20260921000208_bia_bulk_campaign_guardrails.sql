create or replace function crm_private.bia_campaign_block_reason(p_job uuid)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  j crm_private.bia_campaign_outreach_jobs;
  cfg crm_private.bia_campaign_outreach_settings;
  lead public.crm_records;
  contact public.contacts;
  v_phone text;
  bulk_rec crm_private.bia_bulk_campaign_recipients;
  bulk_campaign crm_private.bia_bulk_campaigns;
begin
  select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
  select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
  if j.id is null or not coalesce(cfg.enabled,false) then return 'BIA_CAMPAIGN_DISABLED';end if;
  if not private.arisa_actor_admin(cfg.organization_id,cfg.actor_user_id) then return 'BIA_CAMPAIGN_ACTOR_INACTIVE';end if;
  select * into lead from public.crm_records where id=j.crm_record_id;
  select * into contact from public.contacts where id=lead.contact_id;
  if lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id or lead.record_status<>'aberta'
    or (j.source_type<>'bulk' and lead.created_at<cfg.activated_at) then return 'BIA_CAMPAIGN_LEAD_INACTIVE';end if;
  if exists(select 1 from public.crm_actions a where a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.action_status='pendente' and a.metadata->>'requires_human_review'='true' and a.metadata->>'no_external_delivery'='true') then return 'BIA_CONTACT_PAUSED';end if;
  if j.source_type<>'bulk' and j.created_at<now()-interval '24 hours' then return 'BIA_CAMPAIGN_EXPIRED';end if;
  v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
  if v_phone is distinct from j.phone then return 'BIA_CAMPAIGN_PHONE_CHANGED';end if;
  if contact.id is not null and (not contact.active or contact.do_not_contact_at is not null or contact.marketing_consent_status in('denied','revoked')) then return 'BIA_CONTACT_PAUSED';end if;

  if j.source_type='public_form' then
    if not exists(select 1 from private.crm_public_form_submissions s where s.id=j.source_id and s.form_slug=cfg.public_form_slug and s.organization_id=cfg.organization_id and s.crm_record_id=lead.id and s.original_created_at is null and s.created_at>=cfg.activated_at and s.consent_version='solaris-whatsapp-v1' and regexp_replace(s.phone,'[^0-9]','','g')=j.phone) then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
  elsif j.source_type='meta' then
    if not exists(select 1 from public.crm_opportunity_attributions a where a.id=j.source_id and a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.provider='meta' and a.campaign_id=cfg.meta_campaign_id and a.form_id=cfg.meta_form_id and a.captured_at>=cfg.activated_at) then return 'BIA_CAMPAIGN_SOURCE_CHANGED';end if;
    if nullif(trim(cfg.meta_consent_notice),'') is null or cfg.meta_consent_verified_at is null
      or (j.consent->>'at')::timestamptz<cfg.meta_consent_verified_at
      or j.consent->>'notice' is distinct from cfg.meta_consent_notice then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
  elsif j.source_type='bulk' then
    select * into bulk_rec from crm_private.bia_bulk_campaign_recipients where id=j.source_id and crm_record_id=lead.id;
    select * into bulk_campaign from crm_private.bia_bulk_campaigns where id=bulk_rec.campaign_id and settings_id=cfg.id and organization_id=cfg.organization_id;
    if bulk_rec.id is null or bulk_campaign.id is null then return 'BIA_CAMPAIGN_SOURCE_CHANGED'; end if;
    if bulk_campaign.status='cancelled' then return 'BIA_BULK_CANCELLED'; end if;
    if bulk_rec.eligibility_status<>'eligible' then return coalesce(bulk_rec.block_reason,'BIA_BULK_CONSENT_REQUIRED'); end if;
    if crm_private.bia_bulk_consent_for_record(cfg.id,lead.id) is null then return 'BIA_BULK_CONSENT_REQUIRED'; end if;
  else
    return 'BIA_CAMPAIGN_SOURCE_CHANGED';
  end if;

  if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.opted_out_at is not null or t.human_requested)) then return 'BIA_CONTACT_PAUSED';end if;
  if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.last_inbound_at is not null or exists(select 1 from crm_private.bia_whatsapp_outbound o where o.thread_id=t.id and o.id<>j.id and o.status<>'failed'))) then return 'BIA_CAMPAIGN_ALREADY_CONTACTED';end if;
  return null;
end
$function$;

create or replace function crm_private.bia_campaign_notice(p_job uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; o crm_private.bia_whatsapp_outbound; n uuid; link text; message text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 if j.source_type='bulk' then return; end if;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if cfg.id is null then return;end if;
 select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
 link:=case when o.thread_id is not null then '/bia?painel=whatsapp&atendimento='||o.thread_id else '/bia?painel=whatsapp' end;
 message:=case when p_kind='started' then 'A Bia iniciou o contato com '||j.recipient_name||' pelo WhatsApp. Mensagem aceita pela Meta; acompanhe a entrega e as respostas no histórico.'
 else 'O primeiro contato da Bia com '||j.recipient_name||' aguarda atenção. '||case coalesce(j.error_code,o.error_code,j.status)
 when 'BIA_CAMPAIGN_CONSENT_REQUIRED' then 'O cadastro ainda não registra a autorização de contato pelo WhatsApp.'
 when 'BIA_TEMPLATE_NOT_APPROVED' then 'O modelo da campanha aguarda aprovação da Meta.'
 when 'BIA_TEMPLATE_UNAVAILABLE' then 'Não foi possível verificar o modelo da campanha na Meta.'
 when 'BIA_CHANNEL_DISABLED' then 'O WhatsApp da Bia está temporariamente indisponível.'
 when 'BIA_CONTACT_PAUSED' then 'O contato está pausado ou pediu para não receber mensagens.'
 when 'BIA_CAMPAIGN_ALREADY_CONTACTED' then 'Já existe atendimento para esse telefone; a abertura não foi repetida.'
 when 'BIA_CAMPAIGN_PHONE_CHANGED' then 'O telefone do cadastro mudou antes do envio.'
 when 'BIA_CAMPAIGN_EXPIRED' then 'O primeiro contato ficou pendente por mais de 24 horas.'
 when 'META_131042' then 'A Meta recusou o envio por uma pendência na forma de pagamento.'
 else 'O envio não foi confirmado. Consulte o histórico antes de tentar novamente.' end end;
 message:=message||E'\nCampanha: '||coalesce(cfg.campaign_context->>'name','Campanha Solaris')||E'\nTelefone final: '||right(j.phone,4);
 insert into public.activity_notifications(organization_id,recipient_user_id,actor_user_id,notification_type,title,message,metadata,dedupe_key)
 values(cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id,'bia_conversation_'||p_kind,
 case when p_kind='started' then 'Bia iniciou uma conversa' else 'Contato da Bia requer atenção' end,message,
 jsonb_build_object('source','bia_whatsapp','campaign_id',cfg.campaign_id,'crm_record_id',j.crm_record_id,'outbound_id',j.id,'thread_id',o.thread_id,'href',link,'whatsapp_status','pending'),
 'bia-campaign:'||j.id||':'||p_kind)
 on conflict do nothing returning id into n;
 if n is not null then
  insert into crm_private.arisa_whatsapp_notice_jobs(id,organization_id,recipient_user_id,actor_user_id)
  values(n,cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id) on conflict do nothing;
 end if;
end
$function$;
