import { biaInitialPhone } from '../_shared/bia-whatsapp-outbound.ts';

// Public chat may prepare a link, but cannot authenticate an operator or dispatch outreach.
export function biaWhatsAppOpeningLink(candidate: unknown, userMessages: string[]) {
  let phone = '';
  if (typeof candidate === 'string' && candidate.trim()) {
    try { phone = biaInitialPhone(candidate); } catch { return { ok: false, actionExecuted: false, needs: 'numero_com_ddd' }; }
    const evidence = userMessages.some(message => {
      const parts = message.match(/\+?\d[\d\s().-]{8,28}\d/g) || [];
      return parts.some(part => { try { return biaInitialPhone(part) === phone; } catch { return false; } });
    });
    if (!evidence) return { ok: false, actionExecuted: false, needs: 'numero_informado_pelo_usuario' };
  }
  const url = new URL('https://advent-tau.vercel.app/bia/gestao');
  url.searchParams.set('iniciar', '1');
  if (phone) url.searchParams.set('telefone', phone);
  return { ok: true, actionExecuted: false, requiresAdmin: true, requiresReview: true, template: 'bia_indicacao_investimento', url: url.href };
}
