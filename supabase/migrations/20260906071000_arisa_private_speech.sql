-- Private speech counters only. No audio, credentials or conversation content are retained here.
create table if not exists public.arisa_speech_usage (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  characters_used integer not null default 0 check (characters_used >= 0),
  minute_started timestamptz not null default now(),
  minute_requests integer not null default 0 check (minute_requests >= 0),
  primary key (organization_id,user_id,usage_day)
);
create index if not exists arisa_speech_usage_user_idx on public.arisa_speech_usage(user_id);
alter table public.arisa_speech_usage enable row level security;
revoke all on public.arisa_speech_usage from public, anon, authenticated;
grant all on public.arisa_speech_usage to service_role;
create or replace function public.arisa_speech_consume(p_organization_id uuid,p_user_id uuid,p_characters integer)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
  if p_characters is null or p_characters < 1 or p_characters > 4096 then raise exception 'SPEECH_INVALID'; end if;
  if not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.organization_id=p_organization_id and m.user_id=p_user_id and m.active and m.role='admin' and o.active) then
    raise exception 'ADMIN_REQUIRED' using errcode='42501';
  end if;
  insert into public.arisa_speech_usage(organization_id,user_id,usage_day,characters_used,minute_started,minute_requests)
  values(p_organization_id,p_user_id,(now() at time zone 'America/Sao_Paulo')::date,p_characters,now(),1)
  on conflict(organization_id,user_id,usage_day) do update set
    characters_used=arisa_speech_usage.characters_used+p_characters,
    minute_requests=case when arisa_speech_usage.minute_started < now()-interval '1 minute' then 1 else arisa_speech_usage.minute_requests+1 end,
    minute_started=case when arisa_speech_usage.minute_started < now()-interval '1 minute' then now() else arisa_speech_usage.minute_started end
  where arisa_speech_usage.characters_used+p_characters <= 180000 and
    (arisa_speech_usage.minute_started < now()-interval '1 minute' or arisa_speech_usage.minute_requests < 60);
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function public.arisa_speech_consume(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.arisa_speech_consume(uuid,uuid,integer) to service_role;
