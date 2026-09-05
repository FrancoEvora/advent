begin;
-- Keep SECURITY INVOKER and RLS. The private schema is deliberately not exposed.
create or replace function public.arisa_archive_search(p_organization_id uuid,p_query text default '',p_kind text default null,p_limit integer default 40,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare rows jsonb; total bigint; q tsquery:=websearch_to_tsquery('portuguese',left(coalesce(p_query,''),300));
begin
  select count(*) into total from public.arisa_archive a where a.organization_id=p_organization_id and (nullif(p_kind,'') is null or a.kind=p_kind) and (nullif(btrim(p_query),'') is null or a.search_vector@@q);
  select coalesce(jsonb_agg(to_jsonb(a)-'search_vector'),'[]') into rows from (
    select a.* from public.arisa_archive a where a.organization_id=p_organization_id and (nullif(p_kind,'') is null or a.kind=p_kind) and (nullif(btrim(p_query),'') is null or a.search_vector@@q)
    order by a.occurred_at desc,a.id desc limit greatest(1,least(coalesce(p_limit,40),100)) offset greatest(0,least(coalesce(p_offset,0),100000))
  ) a;
  return jsonb_build_object('rows',rows,'total',total);
end $$;

create or replace function public.arisa_recall(p_organization_id uuid,p_query text default '',p_subject text default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(m)-'search_vector'),'[]') from (
    select m.* from public.arisa_memories m where m.organization_id=p_organization_id
      and m.status='active' and (m.expires_at is null or m.expires_at>now()) and (p_subject is null or m.subject_key=p_subject)
      and (nullif(btrim(p_query),'') is null or m.search_vector@@websearch_to_tsquery('portuguese',left(p_query,300)))
    order by m.observed_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,20),50))
  ) m;
$$;


create policy arisa_memory_jobs_deny on private.arisa_memory_jobs for all to public using(false) with check(false);
create policy arisa_mail_credentials_deny on private.arisa_mail_credentials for all to public using(false) with check(false);
create policy arisa_mail_states_deny on private.arisa_mail_oauth_states for all to public using(false) with check(false);
commit;
