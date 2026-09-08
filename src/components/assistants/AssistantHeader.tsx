import Image from 'next/image';
import type { ReactNode } from 'react';

/** Shared presentation only: access, tools and customer memory remain in each assistant's runtime. */
export function AssistantHeader({ name, subtitle, organization, avatar, onAvatarError, children }: {
  name: string; subtitle: string; organization: string; avatar?: string; onAvatarError?: () => void; children?: ReactNode;
}) {
  return <header className="public-agent-chat-head">
    <div className="public-agent-avatar arisa-avatar">
      {avatar ? <Image src={avatar} alt={`Foto de perfil da ${name}`} width={42} height={42} priority unoptimized={Boolean(onAvatarError)} onError={onAvatarError} /> : name.charAt(0)}
    </div>
    <div><strong>{name}</strong><span>{subtitle}</span><small>{organization}</small></div>
    {children}
  </header>;
}
