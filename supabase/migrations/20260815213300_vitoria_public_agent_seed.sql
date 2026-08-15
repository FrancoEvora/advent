begin;

do $seed$
declare
  organization_key uuid;
  project_key uuid;
  product_key uuid;
  pipeline_key uuid;
  stage_key uuid;
  source_key uuid;
  team_key uuid;
  owner_key uuid;
begin
  select id into organization_key
  from public.organizations
  where name = 'Évora Urbanismo' and active
  order by created_at
  limit 1;

  if organization_key is null then return; end if;

  select id into project_key
  from public.projects
  where organization_id = organization_key
    and name = 'Residencial Solaris Home & Resort'
    and active
  limit 1;

  select id into product_key
  from public.crm_products
  where organization_id = organization_key
    and project_id = project_key
    and name = 'Lotes residenciais'
    and active
  limit 1;

  select id into pipeline_key
  from public.crm_pipelines
  where organization_id = organization_key
    and name = 'Funil Comercial Évora'
    and active
  limit 1;

  select id into stage_key
  from public.crm_stages
  where organization_id = organization_key
    and pipeline_id = pipeline_key
    and code = 'novo'
    and active
  limit 1;

  insert into public.crm_lead_sources (
    organization_id, code, name, provider, channel,
    manual_selectable, active, metadata
  ) values (
    organization_key,
    'WEB_AGENT_VITORIA',
    'Site — Atendimento Inteligente Vitória',
    'first_party',
    'web_agent',
    false,
    true,
    jsonb_build_object('managed_by', 'enterprise', 'public_agent', true)
  )
  on conflict (organization_id, code) do update
  set name = excluded.name,
      provider = excluded.provider,
      channel = excluded.channel,
      manual_selectable = false,
      active = true,
      metadata = excluded.metadata,
      updated_at = now()
  returning id into source_key;

  select id into team_key
  from public.crm_teams
  where organization_id = organization_key
    and name = 'SDR'
    and active
  limit 1;

  select member.user_id into owner_key
  from public.organization_members member
  join public.profiles profile on profile.id = member.user_id
  where member.organization_id = organization_key
    and member.active
    and lower(profile.email) = 'anacarolina@evoraurbanismo.com.br'
  limit 1;

  owner_key := coalesce(
    owner_key,
    (
      select member.user_id
      from public.organization_members member
      where member.organization_id = organization_key
        and member.active
      order by (member.role = 'admin') desc, member.user_id
      limit 1
    )
  );

  if project_key is null or product_key is null or pipeline_key is null
     or stage_key is null or source_key is null or owner_key is null then
    raise exception 'PUBLIC_AGENT_SEED_DEPENDENCY_MISSING';
  end if;

  insert into crm_private.public_agent_experiences (
    organization_id, slug, project_id, product_id,
    pipeline_id, initial_stage_id, lead_source_id,
    team_id, fallback_owner_user_id, assignment_role,
    active, name, agent_name, title, subtitle, eyebrow,
    first_contact_sla_minutes, knowledge, theme
  ) values (
    organization_key,
    'solaris',
    project_key,
    product_key,
    pipeline_key,
    stage_key,
    source_key,
    team_key,
    owner_key,
    'sdr',
    true,
    'Solaris Residencial',
    'Vitória',
    'Encontre o terreno certo para o seu próximo capítulo.',
    'Converse com a Vitória, conheça o Solaris e receba um atendimento personalizado para morar ou investir.',
    'Solaris Residencial • Monte Carmelo/MG',
    60,
    jsonb_build_object(
      'approvedFacts', jsonb_build_array(
        'O Solaris Residencial é um empreendimento fechado inserido no Bairro Parque das Árvores, em Monte Carmelo/MG.',
        'Os terrenos começam a partir de 360 m².',
        'As obras estão em andamento.',
        'O conceito combina a experiência de morar próxima à natureza com segurança e conforto urbano.',
        'O projeto prevê redes subterrâneas, iluminação em LED, represa com deck e pesca, trilhas, academia, yoga, beach tennis, tênis, basquete, campo society, piscina, playground, pet place, bosque e quiosques.',
        'A disponibilidade, os valores e as condições comerciais podem mudar e devem ser confirmados pela equipe comercial.'
      ),
      'guardrails', jsonb_build_array(
        'Não inventar preço, parcela, disponibilidade, desconto, prazo de entrega ou condição financeira.',
        'Não prometer valorização ou rentabilidade.',
        'Não solicitar CPF, RG, renda detalhada, documentos ou dados sensíveis.',
        'Fazer uma pergunta por vez e no máximo duas em uma resposta.',
        'Quando faltar informação factual, oferecer atendimento humano.',
        'Apresentar-se claramente como assistente virtual da Évora Urbanismo.'
      ),
      'qualificationFields', jsonb_build_array(
        'intent', 'budget_max', 'preferred_area_min', 'purchase_horizon',
        'preferred_city', 'financing_interest', 'visit_interest'
      )
    ),
    jsonb_build_object(
      'accent', '#2f6d4f',
      'accentStrong', '#1f4f3a',
      'navy', '#173f59',
      'background', '#f4f1e8',
      'quickReplies', jsonb_build_array('Quero morar', 'Quero investir', 'Quero conhecer o Solaris'),
      'trustItems', jsonb_build_array('Lotes a partir de 360 m²', 'Obras em andamento', 'Atendimento humano disponível'),
      'privacyNotice', 'Seus dados serão usados pela Évora Urbanismo para este atendimento e para o contato comercial solicitado.'
    )
  )
  on conflict (slug) do update
  set organization_id = excluded.organization_id,
      project_id = excluded.project_id,
      product_id = excluded.product_id,
      pipeline_id = excluded.pipeline_id,
      initial_stage_id = excluded.initial_stage_id,
      lead_source_id = excluded.lead_source_id,
      team_id = excluded.team_id,
      fallback_owner_user_id = excluded.fallback_owner_user_id,
      assignment_role = excluded.assignment_role,
      active = true,
      name = excluded.name,
      agent_name = excluded.agent_name,
      title = excluded.title,
      subtitle = excluded.subtitle,
      eyebrow = excluded.eyebrow,
      first_contact_sla_minutes = excluded.first_contact_sla_minutes,
      knowledge = excluded.knowledge,
      theme = excluded.theme,
      updated_at = now();
end
$seed$;

commit;
