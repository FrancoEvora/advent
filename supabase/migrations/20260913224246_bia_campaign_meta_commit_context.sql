-- Meta writes its answer payload and identity-review actions after attribution insertion.
-- Enqueue at transaction completion so Bia sees the complete, committed lead.
drop trigger bia_campaign_meta_lead_created on public.crm_opportunity_attributions;
create constraint trigger bia_campaign_meta_lead_created after insert on public.crm_opportunity_attributions
deferrable initially deferred for each row execute function crm_private.bia_campaign_source_created();
CREATE OR REPLACE FUNCTION crm_private.bia_campaign_block_reason(p_job uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; lead public.crm_records; contact public.contacts; v_phone text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if j.id is null or not coalesce(cfg.enabled,false) then return 'BIA_CAMPAIGN_DISABLED';end if;
 if not private.arisa_actor_admin(cfg.organization_id,cfg.actor_user_id) then return 'BIA_CAMPAIGN_ACTOR_INACTIVE';end if;
 select * into lead from public.crm_records where id=j.crm_record_id;
 select * into contact from public.contacts where id=lead.contact_id;
 if lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id or lead.record_status<>'aberta'
   or lead.created_at<cfg.activated_at then return 'BIA_CAMPAIGN_LEAD_INACTIVE';end if;
 if exists(select 1 from public.crm_actions a where a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.action_status='pendente' and a.metadata->>'requires_human_review'='true' and a.metadata->>'no_external_delivery'='true') then return 'BIA_CONTACT_PAUSED';end if;
 if j.created_at<now()-interval '24 hours' then return 'BIA_CAMPAIGN_EXPIRED';end if;
 v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
 if v_phone is distinct from j.phone then return 'BIA_CAMPAIGN_PHONE_CHANGED';end if;
 if contact.id is not null and (not contact.active or contact.do_not_contact_at is not null or contact.marketing_consent_status in('denied','revoked')) then return 'BIA_CONTACT_PAUSED';end if;
 if j.source_type='public_form' then
  if not exists(select 1 from private.crm_public_form_submissions s where s.id=j.source_id and s.form_slug=cfg.public_form_slug and s.organization_id=cfg.organization_id and s.crm_record_id=lead.id and s.original_created_at is null and s.created_at>=cfg.activated_at and s.consent_version='solaris-whatsapp-v1' and regexp_replace(s.phone,'[^0-9]','','g')=j.phone) then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 elsif j.source_type='meta' then
  if not exists(select 1 from public.crm_opportunity_attributions a where a.id=j.source_id and a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.provider='meta' and a.campaign_id=cfg.meta_campaign_id and a.form_id=cfg.meta_form_id and a.captured_at>=cfg.activated_at) then return 'BIA_CAMPAIGN_SOURCE_CHANGED';end if;
  -- The reviewed published form explicitly requests WhatsApp service on submission. This is scoped
  -- contact consent, not broad marketing permission; it must not change the contact's global preference.
  if nullif(trim(cfg.meta_consent_notice),'') is null or cfg.meta_consent_verified_at is null
    or (j.consent->>'at')::timestamptz<cfg.meta_consent_verified_at
    or j.consent->>'notice' is distinct from cfg.meta_consent_notice then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 end if;
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.opted_out_at is not null or t.human_requested)) then return 'BIA_CONTACT_PAUSED';end if;
 -- Never open a second automated conversation for an already contacted phone, even under another lead ID.
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.last_inbound_at is not null or exists(select 1 from crm_private.bia_whatsapp_outbound o where o.thread_id=t.id and o.id<>j.id and o.status<>'failed'))) then return 'BIA_CAMPAIGN_ALREADY_CONTACTED';end if;
 return null;
end $function$
;

