begin;

do $migration$
declare
  affected_rows integer;
begin
  if to_regclass('crm_private.public_agent_experiences') is null then
    raise exception 'PUBLIC_AGENT_EXPERIENCES_REQUIRED';
  end if;

  update crm_private.public_agent_experiences experience
  set hero_image_url = '/vitoria/vitoria-avatar.webp',
      avatar = (
        case
          when jsonb_typeof(experience.avatar) = 'object' then experience.avatar
          else '{}'::jsonb
        end
      ) || jsonb_build_object(
        'mode', 'photo',
        'imageUrl', '/vitoria/vitoria-avatar.webp'
      ),
      updated_at = now()
  where experience.slug = 'solaris';

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'PUBLIC_AGENT_SOLARIS_PROFILE_EXPECTED_ONCE';
  end if;
end
$migration$;

commit;
