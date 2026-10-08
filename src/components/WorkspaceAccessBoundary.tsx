"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import { isPublicWorkspacePath } from "@/lib/broker-access";
import type { Membership } from "./erp/types";
import { BrokerWorkspace } from "./erp/broker/broker-workspace";

type Access = { session: Session; membership: Membership } | null;

export function WorkspaceAccessBoundary({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const publicPath = isPublicWorkspacePath(path);
  const [state, setState] = useState<{ loading: boolean; access: Access; error: string }>({ loading: true, access: null, error: "" });

  useEffect(() => {
    if (publicPath) return;
    const client = getSupabase();
    if (!client) return;
    let alive = true;
    let revision = 0;
    const check = async () => {
      const request = ++revision;
      try {
        const { data: auth, error } = await client.auth.getSession();
        if (error) throw error;
        if (!auth.session) {
          if (alive && request === revision) setState({ loading: false, access: null, error: "" });
          return;
        }
        const member = await client.from("organization_members").select("*").eq("user_id", auth.session.user.id).eq("active", true).limit(1).maybeSingle();
        if (member.error) throw member.error;
        if (!member.data) throw new Error("Seu acesso está inativo ou sem vínculo com uma organização.");
        if (alive && request === revision) setState({ loading: false, access: { session: auth.session, membership: member.data }, error: "" });
      } catch {
        if (alive && request === revision) setState({ loading: false, access: null, error: "Não foi possível validar seu acesso. Atualize a página ou entre novamente." });
      }
    };
    void check();
    const { data: listener } = client.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT" || event === "SIGNED_IN") setState({ loading: true, access: null, error: "" }); queueMicrotask(() => { if (alive) void check(); }); });
    const refresh = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 60000);
    return () => { alive = false; revision++; listener.subscription.unsubscribe(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(interval); };
  }, [publicPath]);

  if (publicPath) return children;
  if (state.loading) return <main className="splash"><p role="status">Validando acesso…</p></main>;
  if (state.error) return <main className="splash"><p role="alert">{state.error}</p><button onClick={() => location.reload()}>Tentar novamente</button><button onClick={() => getSupabase()?.auth.signOut()}>Sair</button></main>;
  if (state.access?.membership.role === "corretor") return <BrokerWorkspace key={state.access.session.user.id + ":" + state.access.membership.organization_id} {...state.access} initialSection={path.startsWith("/agenda") ? "agenda" : "leads"} />;
  return children;
}
