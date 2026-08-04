import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const allowedRoles = new Set([
  "admin",
  "diretoria",
  "financeiro",
  "engenharia",
  "comercial",
  "compras",
  "consulta",
  "gestor_crm",
  "sdr",
  "corretor",
  "marketing",
]);

type AdminAction =
  | "change_password"
  | "delete_profile"
  | "change_role"
  | "set_active";

type RpcPayload = Record<string, unknown> | null;

function jsonResponse(
  payload: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function errorResponse(
  message: string,
  status = 400,
  code?: string,
  supportReference?: string,
): Response {
  return jsonResponse(
    {
      error: message,
      ...(code ? { code } : {}),
      ...(supportReference ? { supportReference } : {}),
    },
    status,
  );
}

function defaultKey(dictionaryName: string): string {
  const raw = Deno.env.get(dictionaryName);
  if (!raw) return "";
  try {
    const dictionary = JSON.parse(raw) as Record<string, unknown>;
    return typeof dictionary.default === "string" ? dictionary.default : "";
  } catch {
    return "";
  }
}

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function rpcErrorResponse(message: string): Response {
  const code = message.toUpperCase();
  if (code.includes("ADMIN_REQUIRED")) {
    return errorResponse(
      "Somente um administrador ativo pode executar esta ação.",
      403,
      "ADMIN_REQUIRED",
    );
  }
  if (code.includes("TARGET_NOT_FOUND")) {
    return errorResponse(
      "O usuário não pertence a esta organização.",
      404,
      "TARGET_NOT_FOUND",
    );
  }
  if (code.includes("LAST_ACTIVE_ADMIN")) {
    return errorResponse(
      "Não é possível remover ou suspender o último administrador ativo da organização.",
      409,
      "LAST_ACTIVE_ADMIN",
    );
  }
  if (
    code.includes("SELF_DELETION") ||
    code.includes("SELF_SUSPENSION") ||
    code.includes("SELF_ADMIN_DEMOTION")
  ) {
    return errorResponse(
      "O administrador conectado não pode remover o próprio acesso.",
      409,
      "SELF_ACCESS_PROTECTED",
    );
  }
  if (code.includes("OTHER_ORGANIZATIONS")) {
    return errorResponse(
      "Este usuário também pertence a outra organização. Remova primeiro os demais vínculos para não afetar acessos externos.",
      409,
      "OTHER_ORGANIZATIONS",
    );
  }
  if (code.includes("INVALID_ROLE")) {
    return errorResponse(
      "O perfil de acesso informado é inválido.",
      400,
      "INVALID_ROLE",
    );
  }
  return errorResponse(
    "A operação administrativa não pôde ser concluída com segurança.",
    409,
    "ADMIN_OPERATION_REJECTED",
  );
}

function authUserAlreadyRemoved(error: {
  code?: string;
  message?: string;
  status?: number;
}): boolean {
  const code = String(error.code || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  return (
    error.status === 404 ||
    code === "user_not_found" ||
    message.includes("user not found")
  );
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Método não permitido.", 405, "METHOD_NOT_ALLOWED");
  }

  const supportReference = `ADM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return errorResponse(
        "Sessão administrativa não informada.",
        401,
        "SESSION_REQUIRED",
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const publishableKey =
      defaultKey("SUPABASE_PUBLISHABLE_KEYS") ||
      Deno.env.get("SUPABASE_ANON_KEY") ||
      "";
    const serviceKey =
      defaultKey("SUPABASE_SECRET_KEYS") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!supabaseUrl || !publishableKey || !serviceKey) {
      console.error("Admin users function configuration unavailable", {
        supportReference,
        hasUrl: Boolean(supabaseUrl),
        hasPublishableKey: Boolean(publishableKey),
        hasServiceKey: Boolean(serviceKey),
      });
      return errorResponse(
        "O serviço administrativo está temporariamente indisponível por configuração do servidor.",
        503,
        "ADMIN_SERVICE_UNAVAILABLE",
        supportReference,
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const organizationId = String(body.organizationId || "");
    const targetUserId = String(body.userId || "");
    const action = String(body.action || "") as AdminAction;

    if (!uuidPattern.test(organizationId) || !uuidPattern.test(targetUserId)) {
      return errorResponse(
        "Organização ou usuário inválido.",
        400,
        "INVALID_TARGET",
      );
    }
    if (
      ![
        "change_password",
        "delete_profile",
        "change_role",
        "set_active",
      ].includes(action)
    ) {
      return errorResponse(
        "Ação administrativa inválida.",
        400,
        "INVALID_ACTION",
      );
    }

    const callerDb = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } =
      await callerDb.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse(
        "A sessão expirou. Entre novamente na plataforma.",
        401,
        "SESSION_EXPIRED",
      );
    }

    const administratorId = authData.user.id;
    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [administratorResult, targetResult] = await Promise.all([
      adminDb
        .from("organization_members")
        .select("id,role,active")
        .eq("organization_id", organizationId)
        .eq("user_id", administratorId)
        .maybeSingle(),
      adminDb
        .from("organization_members")
        .select("id,role,active")
        .eq("organization_id", organizationId)
        .eq("user_id", targetUserId)
        .maybeSingle(),
    ]);
    if (administratorResult.error || targetResult.error) {
      throw administratorResult.error || targetResult.error;
    }
    if (
      !administratorResult.data?.active ||
      administratorResult.data.role !== "admin"
    ) {
      return errorResponse(
        "Somente um administrador ativo pode gerenciar credenciais e perfis.",
        403,
        "ADMIN_REQUIRED",
      );
    }
    if (!targetResult.data) {
      return errorResponse(
        "O usuário não pertence a esta organização.",
        404,
        "TARGET_NOT_FOUND",
      );
    }

    if (action === "change_password" || action === "delete_profile") {
      const administratorPassword = String(
        body.administratorPassword || "",
      );
      if (!administratorPassword) {
        return errorResponse(
          "Confirme sua senha de administrador para executar esta ação.",
          401,
          "ADMIN_REAUTH_REQUIRED",
        );
      }

      const rateLimitStart = new Date(
        Date.now() - 15 * 60 * 1000,
      ).toISOString();
      const sensitiveAttempts = await adminDb
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("user_id", administratorId)
        .in("action", [
          "admin_sensitive_reauthentication_failed",
          "admin_password_change_requested",
          "admin_profile_deletion_prepared",
        ])
        .gte("created_at", rateLimitStart);
      if (sensitiveAttempts.error) throw sensitiveAttempts.error;
      if ((sensitiveAttempts.count || 0) >= 5) {
        return errorResponse(
          "Limite temporário de operações sensíveis atingido. Aguarde 15 minutos e tente novamente.",
          429,
          "RATE_LIMITED",
        );
      }

      const administratorEmail = authData.user.email;
      if (!administratorEmail) {
        return errorResponse(
          "A conta administrativa precisa ter um e-mail confirmado para validar esta operação.",
          409,
          "ADMIN_EMAIL_REQUIRED",
        );
      }

      const verifier = createClient(supabaseUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const verification = await verifier.auth.signInWithPassword({
        email: administratorEmail,
        password: administratorPassword,
      });
      if (verification.error || !verification.data.user) {
        const failedAudit = await adminDb.from("audit_logs").insert({
          organization_id: organizationId,
          user_id: administratorId,
          action: "admin_sensitive_reauthentication_failed",
          entity: "auth_user",
          entity_id: targetUserId,
          old_data: null,
          new_data: {
            requested_action: action,
            failed_at: new Date().toISOString(),
          },
        });
        if (failedAudit.error) {
          console.error("Sensitive reauthentication audit failed", {
            supportReference,
            administratorId,
            error: failedAudit.error.message,
          });
        }
        return errorResponse(
          "A senha administrativa informada não foi confirmada.",
          401,
          "ADMIN_REAUTH_FAILED",
        );
      }
      await verifier.auth.signOut({ scope: "local" });
    }

    if (action === "change_role" || action === "set_active") {
      const role = action === "change_role" ? String(body.role || "") : null;
      const active = action === "set_active" ? body.active : null;
      if (action === "change_role" && !allowedRoles.has(role || "")) {
        return errorResponse(
          "O perfil de acesso informado é inválido.",
          400,
          "INVALID_ROLE",
        );
      }
      if (action === "set_active" && typeof active !== "boolean") {
        return errorResponse(
          "O estado de acesso informado é inválido.",
          400,
          "INVALID_ACCESS_STATE",
        );
      }

      const result = await adminDb.rpc("admin_manage_member_access", {
        p_organization_id: organizationId,
        p_actor_user_id: administratorId,
        p_target_user_id: targetUserId,
        p_action: action,
        p_role: role,
        p_active: active,
      });
      if (result.error) return rpcErrorResponse(result.error.message);

      return jsonResponse({
        message:
          action === "change_role"
            ? "Perfil de acesso atualizado e auditado."
            : active
              ? "Acesso reativado e auditado."
              : "Acesso suspenso e sessões antigas bloqueadas pelos controles de vínculo ativo.",
      });
    }

    if (action === "change_password") {
      const password = String(body.password || "");
      if (!isStrongPassword(password)) {
        return errorResponse(
          "Use ao menos 12 caracteres, com maiúscula, minúscula, número e símbolo.",
          400,
          "PASSWORD_POLICY",
        );
      }

      const requestedAudit = await adminDb.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: administratorId,
        action: "admin_password_change_requested",
        entity: "auth_user",
        entity_id: targetUserId,
        old_data: null,
        new_data: {
          requested_by_administrator: true,
          requested_at: new Date().toISOString(),
        },
      });
      if (requestedAudit.error) throw requestedAudit.error;

      const { error } = await adminDb.auth.admin.updateUserById(targetUserId, {
        password,
      });
      if (error) throw error;

      const completedAudit = await adminDb.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: administratorId,
        action: "admin_password_changed",
        entity: "auth_user",
        entity_id: targetUserId,
        old_data: null,
        new_data: {
          changed_by_administrator: true,
          changed_at: new Date().toISOString(),
        },
      });
      if (completedAudit.error) {
        console.error("Password changed but completion audit failed", {
          supportReference,
          targetUserId,
          error: completedAudit.error.message,
        });
      }

      return jsonResponse({
        message:
          "Senha alterada com segurança. A nova credencial já pode ser utilizada.",
        auditWarning: Boolean(completedAudit.error),
      });
    }

    if (targetUserId === administratorId) {
      return errorResponse(
        "O administrador conectado não pode excluir o próprio perfil.",
        409,
        "SELF_ACCESS_PROTECTED",
      );
    }
    if (String(body.confirmation || "") !== "EXCLUIR") {
      return errorResponse(
        "Digite EXCLUIR para confirmar a remoção do perfil.",
        400,
        "DELETE_CONFIRMATION_REQUIRED",
      );
    }

    const prepared = await adminDb.rpc("admin_prepare_profile_deletion", {
      p_organization_id: organizationId,
      p_actor_user_id: administratorId,
      p_target_user_id: targetUserId,
    });
    if (prepared.error) return rpcErrorResponse(prepared.error.message);

    const preparation = (prepared.data || null) as RpcPayload;
    const operationId = String(preparation?.operation_id || "");
    if (!uuidPattern.test(operationId)) {
      throw new Error("A operação de exclusão não recebeu identificador válido.");
    }

    const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(
      targetUserId,
      true,
    );
    if (authDeleteError && !authUserAlreadyRemoved(authDeleteError)) {
      console.error("Auth deletion pending retry", {
        supportReference,
        operationId,
        targetUserId,
        error: authDeleteError.message,
      });
      return errorResponse(
        "O acesso foi suspenso, mas o serviço de identidade não concluiu a exclusão. A operação está preservada para nova tentativa.",
        502,
        "AUTH_DELETION_PENDING",
        supportReference,
      );
    }

    const finalized = await adminDb.rpc("admin_finalize_profile_deletion", {
      p_organization_id: organizationId,
      p_actor_user_id: administratorId,
      p_target_user_id: targetUserId,
      p_operation_id: operationId,
    });
    if (finalized.error) {
      console.error("Database deletion finalization pending retry", {
        supportReference,
        operationId,
        targetUserId,
        error: finalized.error.message,
      });
      return errorResponse(
        "O login foi revogado, mas a limpeza transacional ficou pendente. Tente novamente para concluir com a mesma operação.",
        502,
        "DELETION_FINALIZATION_PENDING",
        supportReference,
      );
    }

    const finalData = (finalized.data || null) as RpcPayload;
    return jsonResponse({
      message:
        "Perfil excluído, acesso revogado e responsabilidades abertas tratadas. O histórico empresarial foi preservado.",
      operationId,
      activeAssignmentsCancelled: Number(
        finalData?.active_assignments_cancelled || 0,
      ),
    });
  } catch (error) {
    console.error("Admin users function failed", {
      supportReference,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage:
        error instanceof Error ? error.message : "Erro administrativo desconhecido",
    });
    return errorResponse(
      "A conclusão da operação não pôde ser confirmada. Consulte a auditoria com a referência informada antes de tentar novamente.",
      500,
      "ADMIN_OPERATION_FAILED",
      supportReference,
    );
  }
});
