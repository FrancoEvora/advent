begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
  ('vitoria-generated','vitoria-generated',false,10485760,array['image/png','image/jpeg','image/webp']::text[]),
  ('vitoria-knowledge','vitoria-knowledge',false,20971520,array['application/pdf','text/plain','text/markdown','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[])
on conflict(id) do update
set public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

update crm_private.public_agent_experiences
set agent_name='Vitória',
    title='Olá. Como posso ajudar?',
    subtitle='Sua especialista em Évora Urbanismo, empreendimentos e oportunidades imobiliárias. Fale ou escreva naturalmente.',
    eyebrow='Atendimento inteligente • Évora Urbanismo',
    hero_image_url='/vitoria/vitoria-portrait.svg',
    theme=coalesce(theme,'{}'::jsonb) || jsonb_build_object(
      'visualMode','immersive',
      'voice','coral',
      'voiceEnabled',true,
      'autoSpeak',false,
      'avatarMotion',true,
      'capabilities',jsonb_build_array('empreendimentos','estoque','condicoes','documentos','simulacao_visual','visitas','contato_conversacional')
    ),
    knowledge=coalesce(knowledge,'{}'::jsonb) || jsonb_build_object(
      'organizationExpert',true,
      'commercialDataSource','enterprise_realtime',
      'documentKnowledgeSource','openai_file_search',
      'contactCapture','conversation'
    ),
    updated_at=now()
where slug='solaris' and active;

commit;
