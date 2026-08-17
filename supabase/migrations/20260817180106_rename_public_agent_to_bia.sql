begin;

do $migration$
declare
  affected_rows integer;
begin
  if to_regclass('crm_private.public_agent_experiences') is null then
    raise exception 'PUBLIC_AGENT_EXPERIENCES_REQUIRED';
  end if;

  update crm_private.public_agent_experiences experience
  set agent_name = 'Bia',
      title = replace(replace(experience.title, 'Vitória', 'Bia'), 'Vitoria', 'Bia'),
      subtitle = replace(replace(experience.subtitle, 'Vitória', 'Bia'), 'Vitoria', 'Bia'),
      eyebrow = replace(replace(experience.eyebrow, 'Vitória', 'Bia'), 'Vitoria', 'Bia'),
      greeting_text =
        'Oi! Tudo bem? Eu sou a Bia, da Évora. Me conta: você está conhecendo o Solaris para morar, investir ou quer comparar as condições?',
      hero_image_url = '/vitoria/vitoria-avatar.webp',
      avatar = (
        case
          when jsonb_typeof(experience.avatar) = 'object' then experience.avatar
          else '{}'::jsonb
        end
      ) || jsonb_build_object(
        'mode', 'photo',
        'displayName', 'Bia',
        'imageUrl', '/vitoria/vitoria-avatar.webp'
      ),
      knowledge = replace(
        replace(experience.knowledge::text, 'Vitória', 'Bia'),
        'Vitoria',
        'Bia'
      )::jsonb,
      theme = replace(
        replace(experience.theme::text, 'Vitória', 'Bia'),
        'Vitoria',
        'Bia'
      )::jsonb,
      updated_at = now()
  where experience.slug = 'solaris';

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'PUBLIC_AGENT_SOLARIS_PROFILE_EXPECTED_ONCE';
  end if;
end
$migration$;

commit;
