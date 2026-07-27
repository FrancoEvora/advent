"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  ConstructionWorkPackage,
  ErpData,
  Project,
} from "../types";
import type { ActivityDeepLinkTarget } from "../activities/activity-links";
import { PanelTitle } from "../views-dashboard";

type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;

interface EapDeletionDependency {
  key: string;
  label: string;
  count: number;
}

interface EapDeletionPreview {
  scope: "package" | "eap";
  element_count: number;
  target_token: string;
  descendant_count: number;
  dependency_total: number;
  can_delete: boolean;
  dependencies: EapDeletionDependency[];
}

type EapDeletionTarget =
  | { scope: "eap" }
  | { scope: "package"; item: ConstructionWorkPackage };

const percent = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

const date = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const disciplineOptions = [
  ["geral", "Geral"],
  ["projetos", "Projetos"],
  ["terraplenagem", "Terraplenagem"],
  ["drenagem", "Drenagem"],
  ["pavimentacao", "Pavimentação"],
  ["agua", "Abastecimento de água"],
  ["esgoto", "Esgotamento sanitário"],
  ["energia", "Energia"],
  ["iluminacao", "Iluminação"],
  ["paisagismo", "Paisagismo"],
  ["edificacoes", "Edificações"],
  ["sinalizacao", "Sinalização"],
  ["ambiental", "Ambiental"],
  ["seguranca", "Segurança"],
  ["comissionamento", "Comissionamento"],
  ["outro", "Outro"],
] as const;

const phaseOptions = [
  ["planejamento", "Planejamento"],
  ["mobilizacao", "Mobilização"],
  ["execucao", "Execução"],
  ["comissionamento", "Comissionamento"],
  ["entrega", "Entrega"],
] as const;

const statusOptions = [
  ["planejado", "Planejado"],
  ["liberado", "Liberado"],
  ["em_execucao", "Em execução"],
  ["bloqueado", "Bloqueado"],
  ["concluido", "Concluído"],
  ["cancelado", "Cancelado"],
] as const;

const priorityOptions = [
  ["baixa", "Baixa"],
  ["normal", "Normal"],
  ["alta", "Alta"],
  ["critica", "Crítica"],
] as const;

function labelFor(
  options: readonly (readonly [string, string])[],
  value: string,
) {
  return options.find(([key]) => key === value)?.[1] || value.replaceAll("_", " ");
}

function inputDateToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function dateLabel(value: string | null) {
  return value ? date.format(new Date(`${value}T12:00:00`)) : "Sem data";
}

function calculateDepth(
  item: ConstructionWorkPackage,
  byId: Map<string, ConstructionWorkPackage>,
) {
  let depth = 0;
  let parentId = item.parent_id;
  const visited = new Set<string>();
  while (parentId && depth < 6 && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parent_id || null;
  }
  return depth;
}

function descendantsOf(
  itemId: string,
  packages: ConstructionWorkPackage[],
) {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    packages.forEach((item) => {
      if (
        item.parent_id &&
        (item.parent_id === itemId || descendants.has(item.parent_id)) &&
        !descendants.has(item.id)
      ) {
        descendants.add(item.id);
        changed = true;
      }
    });
  }
  return descendants;
}

function nextWbsCode(
  packages: ConstructionWorkPackage[],
  parentId: string | null,
) {
  const siblings = packages.filter((item) => item.parent_id === parentId);
  const parent = packages.find((item) => item.id === parentId);
  const parentCode = parent?.wbs_code || parent?.package_code || "";
  const prefix = parentCode ? `${parentCode}.` : "";
  const largestSuffix = siblings.reduce((largest, sibling) => {
    const code = String(
      sibling.wbs_code || sibling.package_code || "",
    ).trim();
    if (prefix && !code.startsWith(prefix)) return largest;
    const suffix = prefix ? code.slice(prefix.length) : code;
    return /^\d+$/.test(suffix)
      ? Math.max(largest, Number(suffix))
      : largest;
  }, 0);
  return `${prefix}${largestSuffix + 1}`;
}

function sortHierarchically(packages: ConstructionWorkPackage[]) {
  const byParent = new Map<string | null, ConstructionWorkPackage[]>();
  const ids = new Set(packages.map((item) => item.id));
  const compare = (
    left: ConstructionWorkPackage,
    right: ConstructionWorkPackage,
  ) =>
    left.sort_order - right.sort_order ||
    String(left.wbs_code || left.code).localeCompare(
      String(right.wbs_code || right.code),
      "pt-BR",
      { numeric: true },
    );

  packages.forEach((item) => {
    const parentId =
      item.parent_id && ids.has(item.parent_id) ? item.parent_id : null;
    const siblings = byParent.get(parentId) || [];
    siblings.push(item);
    byParent.set(parentId, siblings);
  });
  byParent.forEach((siblings) => siblings.sort(compare));

  const result: ConstructionWorkPackage[] = [];
  const visited = new Set<string>();
  const append = (parentId: string | null) => {
    (byParent.get(parentId) || []).forEach((item) => {
      if (visited.has(item.id)) return;
      visited.add(item.id);
      result.push(item);
      append(item.id);
    });
  };
  append(null);
  packages
    .filter((item) => !visited.has(item.id))
    .sort(compare)
    .forEach((item) => result.push(item));
  return result;
}

function parseDeletionPreview(value: unknown): EapDeletionPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A análise de exclusão retornou uma resposta inválida.");
  }

  const result = value as Record<string, unknown>;
  const scope = result.scope === "package" ? "package" : "eap";
  const elementCount = Math.max(0, Number(result.element_count || 0));
  const targetToken =
    typeof result.target_token === "string" ? result.target_token.trim() : "";
  const descendantCount = Math.max(0, Number(result.descendant_count || 0));
  const dependencyTotal = Math.max(0, Number(result.dependency_total || 0));
  const dependencies = Array.isArray(result.dependencies)
    ? result.dependencies.flatMap((dependency) => {
        if (
          !dependency ||
          typeof dependency !== "object" ||
          Array.isArray(dependency)
        ) {
          return [];
        }
        const entry = dependency as Record<string, unknown>;
        const count = Math.max(0, Number(entry.count || 0));
        if (!count) return [];
        return [
          {
            key: String(entry.key || "dependency"),
            label: String(entry.label || "Registros vinculados"),
            count,
          },
        ];
      })
    : [];

  if (
    !targetToken ||
    !Number.isFinite(elementCount) ||
    !Number.isFinite(descendantCount) ||
    !Number.isFinite(dependencyTotal)
  ) {
    throw new Error("A análise de exclusão retornou contagens inválidas.");
  }

  return {
    scope,
    element_count: elementCount,
    target_token: targetToken,
    descendant_count: descendantCount,
    dependency_total: dependencyTotal,
    can_delete: result.can_delete === true && dependencyTotal === 0,
    dependencies,
  };
}

export function EapManagement({
  data,
  project,
  packages,
  mutate,
  canManage,
  onMeasure,
  focus,
}: {
  data: ErpData;
  project: Project;
  packages: ConstructionWorkPackage[];
  mutate: Mutate;
  canManage: boolean;
  onMeasure: (item: ConstructionWorkPackage) => void;
  focus?: ActivityDeepLinkTarget | null;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editor, setEditor] = useState<{
    item: ConstructionWorkPackage | null;
    parentId: string | null;
  } | null>(null);
  const [deletion, setDeletion] = useState<EapDeletionTarget | null>(null);
  const sorted = useMemo(() => sortHierarchically(packages), [packages]);
  const focusedPackageId =
    focus?.sourceType === "construction_work_packages"
      ? focus.recordId
      : null;
  const focusedPackageVisible = Boolean(
    focusedPackageId && sorted.some((item) => item.id === focusedPackageId),
  );
  const byId = useMemo(
    () => new Map(sorted.map((item) => [item.id, item])),
    [sorted],
  );
  const leafPackages = sorted.filter((item) => !item.is_summary);
  const executable = leafPackages.filter((item) => item.status !== "cancelado");
  const summaryPackages = sorted.filter((item) => item.is_summary);
  const totalWeight = executable.reduce(
    (sum, item) => sum + Number(item.weight_pct || 0),
    0,
  );
  const templateCode =
    sorted.find((item) => item.template_code)?.template_code || null;
  const template = data.constructionEapTemplates.find(
    (item) => item.template_code === templateCode,
  );

  useEffect(() => {
    if (!focusedPackageId || !focusedPackageVisible) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-record-id="${focusedPackageId}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedPackageId, focusedPackageVisible]);

  return (
    <>
      <section className="panel eap-management">
        <div className="eap-management-heading">
          <PanelTitle
            eyebrow="EAP · ESTRUTURA ANALÍTICA"
            title="Planejamento, hierarquia e etapas da obra"
          />
          {canManage && (
            <div className="eap-management-actions">
              <button type="button" onClick={() => setCatalogOpen(true)}>
                {templateCode ? "Consultar modelos" : "Modelos predefinidos"}
              </button>
              {!!sorted.length && (
                <button
                  className="eap-danger-button"
                  type="button"
                  onClick={() => setDeletion({ scope: "eap" })}
                >
                  Excluir EAP
                </button>
              )}
              <button
                className="primary"
                type="button"
                onClick={() => setEditor({ item: null, parentId: null })}
              >
                + Nova etapa
              </button>
            </div>
          )}
        </div>

        <div className="eap-summary-strip">
          <span>
            <small>Origem da estrutura</small>
            <strong>{template?.name || (sorted.length ? "EAP personalizada" : "Não criada")}</strong>
          </span>
          <span>
            <small>Pacotes</small>
            <strong>
              {leafPackages.length} executáveis · {summaryPackages.length} grupos
            </strong>
          </span>
          <span className={Math.abs(totalWeight - 100) < 0.01 ? "balanced" : "review"}>
            <small>Peso das etapas</small>
            <strong>{percent.format(totalWeight)}%</strong>
          </span>
          <span>
            <small>Orçamento das etapas</small>
            <strong>
              {money.format(
                executable.reduce(
                  (sum, item) => sum + Number(item.budget_amount || 0),
                  0,
                ),
              )}
            </strong>
          </span>
        </div>

        {!sorted.length ? (
          <div className="eap-empty">
            <span>▦</span>
            <div>
              <strong>Este empreendimento ainda não possui uma EAP.</strong>
              <p>
                Comece com um dos dez modelos técnicos ou monte a estrutura
                manualmente. Todas as etapas geradas poderão ser editadas.
              </p>
            </div>
            {canManage && (
              <div className="eap-empty-actions">
                <button className="primary" onClick={() => setCatalogOpen(true)}>
                  Escolher modelo de EAP
                </button>
                <button onClick={() => setEditor({ item: null, parentId: null })}>
                  Criar manualmente
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="eap-structure">
            <div className="eap-structure-head">
              <span>Estrutura / etapa</span>
              <span>Planejamento</span>
              <span>Avanço físico</span>
              <span>Responsabilidade</span>
              <span>Ações</span>
            </div>
            {sorted.map((item) => {
              const depth = calculateDepth(item, byId);
              const planned = Number(item.planned_progress || 0);
              const actual = Number(item.actual_progress || 0);
              const profile = data.profiles.find(
                (candidate) => candidate.id === item.responsible_user_id,
              );
              const center = data.costCenters.find(
                (candidate) => candidate.id === item.cost_center_id,
              );
              return (
                <article
                  key={item.id}
                  data-record-id={item.id}
                  tabIndex={item.id === focusedPackageId ? -1 : undefined}
                  className={`${item.is_summary ? "summary" : "work-package"} ${
                    item.status === "cancelado" ? "cancelled" : ""
                  } ${item.id === focusedPackageId ? "agenda-linked-target" : ""}`}
                  style={{ "--eap-depth": depth } as CSSProperties}
                >
                  <div className="eap-package-identity">
                    <span className="eap-tree-marker">
                      {item.is_summary ? "▦" : "◆"}
                    </span>
                    <div>
                      <small>
                        {item.wbs_code || item.package_code || item.code}
                        {item.is_summary ? " · GRUPO" : ` · PESO ${percent.format(Number(item.weight_pct))}%`}
                      </small>
                      <strong>{item.name}</strong>
                      <em>
                        {labelFor(disciplineOptions, item.discipline)} ·{" "}
                        {labelFor(phaseOptions, item.phase)}
                      </em>
                    </div>
                  </div>
                  <div className="eap-package-plan">
                    <strong>
                      {dateLabel(item.planned_start)} → {dateLabel(item.planned_end)}
                    </strong>
                    <small>
                      {money.format(Number(item.budget_amount || 0))} ·{" "}
                      {labelFor(priorityOptions, item.priority)}
                    </small>
                  </div>
                  {item.is_summary ? (
                    <div className="eap-summary-label">
                      <strong>Consolidador</strong>
                      <small>Não duplica o avanço ponderado</small>
                    </div>
                  ) : (
                    <div className="eap-package-progress">
                      <span>
                        <small>Realizado</small>
                        <strong>{percent.format(actual)}%</strong>
                      </span>
                      <i
                        role="progressbar"
                        aria-label={`Avanço realizado de ${item.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={actual}
                      >
                        <b style={{ width: `${Math.min(100, Math.max(0, actual))}%` }} />
                      </i>
                      <span>
                        <small>Previsto {percent.format(planned)}%</small>
                        <em className={actual < planned ? "late" : "ok"}>
                          {actual - planned > 0 ? "+" : ""}
                          {percent.format(actual - planned)} pp
                        </em>
                      </span>
                    </div>
                  )}
                  <div className="eap-package-owner">
                    <strong>{profile?.full_name || "Não definido"}</strong>
                    <small>{center?.name || labelFor(statusOptions, item.status)}</small>
                  </div>
                  <div className="eap-package-actions">
                    {canManage && !item.is_summary && (
                      <button
                        aria-label={`Medir ${item.name}`}
                        onClick={() => onMeasure(item)}
                      >
                        Medir
                      </button>
                    )}
                    {canManage && item.is_summary && (
                      <button
                        aria-label={`Adicionar subetapa em ${item.name}`}
                        onClick={() =>
                          setEditor({ item: null, parentId: item.id })
                        }
                      >
                        + Subetapa
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="primary"
                        aria-label={`Editar ${item.name}`}
                        onClick={() =>
                          setEditor({ item, parentId: item.parent_id })
                        }
                      >
                        Editar
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="eap-danger-button"
                        aria-label={`Excluir ${item.name}`}
                        onClick={() =>
                          setDeletion({ scope: "package", item })
                        }
                      >
                        Excluir
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {catalogOpen && (
        <EapTemplateCatalog
          data={data}
          project={project}
          packages={packages}
          mutate={mutate}
          close={() => setCatalogOpen(false)}
        />
      )}

      {editor && (
        <EapPackageEditor
          key={editor.item?.id || `new-${editor.parentId || "root"}`}
          data={data}
          project={project}
          packages={packages}
          item={editor.item}
          initialParentId={editor.parentId}
          mutate={mutate}
          close={() => setEditor(null)}
        />
      )}

      {deletion && (
        <EapDeletionModal
          key={
            deletion.scope === "eap"
              ? `eap-${project.id}`
              : `package-${deletion.item.id}`
          }
          data={data}
          project={project}
          packages={packages}
          target={deletion}
          mutate={mutate}
          close={() => setDeletion(null)}
        />
      )}
    </>
  );
}

function EapDeletionModal({
  data,
  project,
  packages,
  target,
  mutate,
  close,
}: {
  data: ErpData;
  project: Project;
  packages: ConstructionWorkPackage[];
  target: EapDeletionTarget;
  mutate: Mutate;
  close: () => void;
}) {
  const [preview, setPreview] = useState<EapDeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"delete" | "archive" | null>(null);
  const itemCode =
    target.scope === "package"
      ? target.item.wbs_code || target.item.package_code || target.item.code
      : "";
  const confirmationPhrase =
    target.scope === "eap" ? "EXCLUIR EAP" : `EXCLUIR ${itemCode}`;
  const title =
    target.scope === "eap"
      ? `Excluir a EAP de ${project.name}`
      : `Excluir ${itemCode} · ${target.item.name}`;

  useEffect(() => {
    let ignore = false;

    async function loadPreview() {
      setPreview(null);
      setPreviewError("");
      const client = getSupabase();
      if (!client) {
        setPreviewError("Supabase indisponível.");
        return;
      }

      const response =
        target.scope === "eap"
          ? await client.rpc("preview_construction_eap_deletion", {
              p_organization_id: data.organization.id,
              p_project_id: project.id,
            })
          : await client.rpc("preview_construction_work_package_deletion", {
              p_organization_id: data.organization.id,
              p_package_id: target.item.id,
            });

      if (ignore) return;
      if (response.error) {
        setPreviewError(response.error.message);
        return;
      }

      try {
        setPreview(parseDeletionPreview(response.data));
      } catch (error) {
        setPreviewError(
          error instanceof Error
            ? error.message
            : "Não foi possível analisar os vínculos da EAP.",
        );
      }
    }

    void loadPreview();
    return () => {
      ignore = true;
    };
  }, [
    data.organization.id,
    project.id,
    reloadToken,
    target,
  ]);

  async function archive() {
    if (busy) return;
    let archived = false;
    setBusy("archive");
    try {
      await mutate(async () => {
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const payload = {
          status: "cancelado",
          updated_at: new Date().toISOString(),
        };
        const response =
          target.scope === "eap"
            ? await client
                .from("construction_work_packages")
                .update(payload)
                .eq("organization_id", data.organization.id)
                .eq("project_id", project.id)
            : await client
                .from("construction_work_packages")
                .update(payload)
                .eq("organization_id", data.organization.id)
                .eq("project_id", project.id)
                .in("id", [
                  target.item.id,
                  ...descendantsOf(target.item.id, packages),
                ]);
        if (response.error) throw response.error;
        archived = true;
      }, target.scope === "eap"
        ? "EAP arquivada como cancelada."
        : "Etapa e suas subetapas arquivadas como canceladas.");
    } finally {
      setBusy(null);
    }
    if (archived) close();
  }

  async function remove() {
    if (
      busy ||
      !preview?.can_delete ||
      confirmation.trim() !== confirmationPhrase
    ) {
      return;
    }
    let removed = false;
    setBusy("delete");
    try {
      await mutate(async () => {
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const response =
          target.scope === "eap"
            ? await client.rpc("delete_construction_eap", {
                p_organization_id: data.organization.id,
                p_project_id: project.id,
                p_expected_count: preview.element_count,
                p_expected_token: preview.target_token,
              })
            : await client.rpc("delete_construction_work_package", {
                p_organization_id: data.organization.id,
                p_package_id: target.item.id,
                p_expected_count: preview.element_count,
                p_expected_token: preview.target_token,
                p_include_descendants: preview.descendant_count > 0,
              });
        if (response.error) throw response.error;
        removed = true;
      }, target.scope === "eap"
        ? "EAP excluída permanentemente."
        : "Elemento da EAP excluído permanentemente.");
    } finally {
      setBusy(null);
    }
    if (removed) close();
  }

  const blocked = !!preview && !preview.can_delete;
  const confirmed = confirmation.trim() === confirmationPhrase;

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : close}>
      <section
        className="modal eap-deletion-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eap-deletion-title"
        aria-describedby="eap-deletion-description"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) close();
        }}
      >
        <div>
          <small className="eap-deletion-eyebrow">ZONA DE EXCLUSÃO</small>
          <h2 id="eap-deletion-title">{title}</h2>
        </div>
        <button
          className="modal-close"
          type="button"
          aria-label="Fechar confirmação de exclusão"
          autoFocus
          disabled={!!busy}
          onClick={close}
        >
          ×
        </button>

        <p id="eap-deletion-description" className="eap-modal-intro">
          A exclusão permanente remove somente a estrutura desta obra. Os
          modelos predefinidos da biblioteca continuam disponíveis e não são
          alterados.
        </p>

        {!preview && !previewError && (
          <div className="eap-deletion-loading" role="status">
            Analisando hierarquia e vínculos operacionais...
          </div>
        )}

        {previewError && (
          <div className="eap-deletion-error" role="alert">
            <strong>Não foi possível concluir a análise de segurança.</strong>
            <span>{previewError}</span>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Tentar novamente
            </button>
          </div>
        )}

        {preview && (
          <>
            <div className="eap-deletion-counts">
              <span>
                <small>Elementos afetados</small>
                <strong>{preview.element_count}</strong>
              </span>
              <span>
                <small>Subetapas incluídas</small>
                <strong>{preview.descendant_count}</strong>
              </span>
              <span className={preview.dependency_total ? "blocked" : "clear"}>
                <small>Vínculos operacionais</small>
                <strong>{preview.dependency_total}</strong>
              </span>
            </div>

            {blocked ? (
              <div className="eap-deletion-blocked">
                <strong>Exclusão permanente bloqueada</strong>
                <p>
                  Existem registros operacionais vinculados. Para preservar o
                  histórico e a rastreabilidade, arquive/cancele a estrutura ou
                  trate os vínculos antes de excluir.
                </p>
                <ul>
                  {preview.dependencies.map((dependency) => (
                    <li key={dependency.key}>
                      <span>{dependency.label}</span>
                      <strong>{dependency.count}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="eap-deletion-confirmation">
                <strong>Esta ação não poderá ser desfeita.</strong>
                {preview.descendant_count > 0 && (
                  <p>
                    O elemento selecionado possui subetapas. A confirmação
                    excluirá toda a subárvore em uma única operação.
                  </p>
                )}
                <label htmlFor="eap-deletion-confirmation">
                  Digite <b>{confirmationPhrase}</b> para confirmar
                  <input
                    id="eap-deletion-confirmation"
                    value={confirmation}
                    autoComplete="off"
                    disabled={!!busy}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              </div>
            )}
          </>
        )}

        <div className="eap-deletion-archive">
          <strong>Alternativa recomendada: arquivar/cancelar</strong>
          <p>
            Mantém os registros vinculados e retira a estrutura dos cálculos
            ativos, permitindo consulta posterior.
          </p>
        </div>

        <footer>
          <button type="button" disabled={!!busy} onClick={close}>
            Voltar
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void archive()}
          >
            {busy === "archive" ? "Arquivando..." : "Arquivar/cancelar"}
          </button>
          {preview?.can_delete && (
            <button
              className="eap-delete-confirm"
              type="button"
              disabled={!confirmed || !!busy}
              onClick={() => void remove()}
            >
              {busy === "delete" ? "Excluindo..." : "Excluir permanentemente"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function EapTemplateCatalog({
  data,
  project,
  packages,
  mutate,
  close,
}: {
  data: ErpData;
  project: Project;
  packages: ConstructionWorkPackage[];
  mutate: Mutate;
  close: () => void;
}) {
  const existingTemplateCode =
    packages.find((item) => item.template_code)?.template_code || null;
  const templates = data.constructionEapTemplates;
  const [selectedCode, setSelectedCode] = useState(
    existingTemplateCode || templates[0]?.template_code || "",
  );
  const [submitting, setSubmitting] = useState(false);
  const selected = templates.find(
    (template) => template.template_code === selectedCode,
  );
  const items = data.constructionEapTemplateItems
    .filter((item) => item.template_code === selectedCode)
    .sort((left, right) => left.sequence - right.sequence);
  const leafItems = items.filter((item) => !item.is_summary);
  const topGroups = items.filter(
    (item) => item.is_summary && item.parent_item_key !== null,
  );

  async function applyTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.currentTarget);
    const startDate = String(form.get("start_date") || "");
    const totalBudget = Number(form.get("total_budget") || 0);
    if (!selectedCode) return;
    let applied = false;
    setSubmitting(true);
    try {
      await mutate(async () => {
        if (packages.length) {
          throw new Error(
            "Este empreendimento já possui uma EAP. Edite a estrutura existente para evitar códigos ou pesos duplicados.",
          );
        }
        if (!startDate) throw new Error("Informe a data de início da EAP.");
        if (!Number.isFinite(totalBudget) || totalBudget < 0) {
          throw new Error("O orçamento-base não pode ser negativo.");
        }
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const { error } = await client.rpc("apply_construction_eap_template", {
          p_organization_id: data.organization.id,
          p_project_id: project.id,
          p_template_code: selectedCode,
          p_start_date: startDate,
          p_total_budget: totalBudget,
        });
        if (error) throw error;
        applied = true;
      }, `Modelo “${selected?.name || selectedCode}” aplicado à obra.`);
    } finally {
      setSubmitting(false);
    }
    if (applied) close();
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal eap-template-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Modelos predefinidos de EAP"
        onSubmit={applyTemplate}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <PanelTitle
          eyebrow="BIBLIOTECA TÉCNICA"
          title="Modelos predefinidos de EAP"
        />
        <button
          className="modal-close"
          type="button"
          aria-label="Fechar biblioteca de modelos"
          autoFocus
          onClick={close}
        >
          ×
        </button>
        <p className="eap-modal-intro">
          Selecione a estrutura mais adequada para {project.name}. O modelo
          gera a hierarquia, pesos, prazos e orçamento inicial; depois, cada
          etapa permanece totalmente editável.
        </p>

        <div className="eap-template-layout">
          <div className="eap-template-list">
            {templates.map((template) => {
              const count = data.constructionEapTemplateItems.filter(
                (item) =>
                  item.template_code === template.template_code &&
                  !item.is_summary,
              ).length;
              return (
                <button
                  key={template.template_code}
                  type="button"
                  className={
                    selectedCode === template.template_code ? "active" : ""
                  }
                  onClick={() => setSelectedCode(template.template_code)}
                >
                  <b>{template.icon}</b>
                  <span>
                    <small>{template.category}</small>
                    <strong>{template.name}</strong>
                    <em>
                      {count} etapas · {template.estimated_duration_days} dias
                    </em>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="eap-template-preview">
            {selected ? (
              <>
                <header>
                  <span>{selected.icon}</span>
                  <div>
                    <small>
                      {selected.category} · VERSÃO {selected.version}
                    </small>
                    <h3>{selected.name}</h3>
                    <p>{selected.description}</p>
                  </div>
                </header>
                <div className="eap-template-stats">
                  <span>
                    <small>Etapas executáveis</small>
                    <strong>{leafItems.length}</strong>
                  </span>
                  <span>
                    <small>Grupos da estrutura</small>
                    <strong>{items.length - leafItems.length}</strong>
                  </span>
                  <span>
                    <small>Soma dos pesos</small>
                    <strong>
                      {percent.format(
                        leafItems.reduce(
                          (sum, item) => sum + Number(item.weight_pct),
                          0,
                        ),
                      )}
                      %
                    </strong>
                  </span>
                </div>
                <div className="eap-template-groups">
                  <small>MACROETAPAS INCLUÍDAS</small>
                  {topGroups.map((item) => (
                    <span key={item.item_key}>
                      <b>{item.wbs_code}</b>
                      {item.name}
                    </span>
                  ))}
                </div>
                <div className="form-grid eap-template-parameters">
                  <label>
                    Início da obra
                    <input
                      type="date"
                      name="start_date"
                      defaultValue={project.start_date || inputDateToday()}
                      required
                    />
                  </label>
                  <label>
                    Orçamento-base
                    <input
                      type="number"
                      name="total_budget"
                      min="0"
                      step="0.01"
                      defaultValue={Number(project.total_budget || 0)}
                      required
                    />
                  </label>
                </div>
              </>
            ) : (
              <div className="eap-catalog-empty">
                Nenhum modelo técnico está disponível.
              </div>
            )}
          </div>
        </div>

        {existingTemplateCode ? (
          <div className="info-box">
            Este empreendimento já utiliza o modelo{" "}
            <strong>
              {templates.find(
                (template) =>
                  template.template_code === existingTemplateCode,
              )?.name || existingTemplateCode}
            </strong>
            . Para preservar a estrutura existente, edite as etapas diretamente
            na tela da EAP.
          </div>
        ) : packages.length ? (
          <div className="info-box">
            A obra já possui uma EAP manual. Para evitar códigos, pesos e
            hierarquias duplicados, os modelos ficam disponíveis apenas para
            consulta; edite a estrutura existente diretamente na tela.
          </div>
        ) : (
          <div className="info-box">
            Os pesos das etapas executáveis totalizam 100%. Datas e valores são
            distribuídos automaticamente a partir dos parâmetros acima.
          </div>
        )}

        <footer>
          <button type="button" onClick={close}>
            Fechar
          </button>
          {!packages.length && (
            <button className="primary" disabled={!selected || submitting}>
              {submitting ? "Criando EAP..." : "Aplicar modelo e criar EAP"}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}

function EapPackageEditor({
  data,
  project,
  packages,
  item,
  initialParentId,
  mutate,
  close,
}: {
  data: ErpData;
  project: Project;
  packages: ConstructionWorkPackage[];
  item: ConstructionWorkPackage | null;
  initialParentId: string | null;
  mutate: Mutate;
  close: () => void;
}) {
  const [isSummary, setIsSummary] = useState(item?.is_summary || false);
  const [submitting, setSubmitting] = useState(false);
  const blockedParents = item ? descendantsOf(item.id, packages) : new Set<string>();
  if (item) blockedParents.add(item.id);
  const parentOptions = packages
    .filter(
      (candidate) =>
        candidate.is_summary && !blockedParents.has(candidate.id),
    )
    .sort((left, right) => left.sort_order - right.sort_order);
  const defaultWbs =
    item?.wbs_code || nextWbsCode(packages, initialParentId || null);
  const defaultSort =
    item?.sort_order ??
    Math.max(0, ...packages.map((candidate) => candidate.sort_order)) + 1;
  const parent = packages.find(
    (candidate) => candidate.id === initialParentId,
  );
  const availableCenters = data.costCenters.filter(
    (center) => center.active || center.id === item?.cost_center_id,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.currentTarget);
    const plannedStart = String(form.get("planned_start") || "") || null;
    const plannedEnd = String(form.get("planned_end") || "") || null;
    const weight = isSummary ? 0 : Number(form.get("weight_pct") || 0);
    const plannedProgress = isSummary
      ? 0
      : Number(form.get("planned_progress") || 0);
    const budget = isSummary ? 0 : Number(form.get("budget_amount") || 0);
    const forecast = isSummary
      ? 0
      : Number(form.get("forecast_amount") || 0);
    const sortOrder = Number(form.get("sort_order") || 0);
    const parentId = String(form.get("parent_id") || "") || null;
    const wbsCode = String(form.get("wbs_code") || "").trim();
    let saved = false;

    setSubmitting(true);
    try {
      await mutate(async () => {
        if (!wbsCode) throw new Error("Informe o código EAP da etapa.");
        if (
          packages.some(
            (candidate) =>
              candidate.id !== item?.id &&
              String(candidate.wbs_code || candidate.package_code || "")
                .trim()
                .toLocaleLowerCase("pt-BR") ===
                wbsCode.toLocaleLowerCase("pt-BR"),
          )
        ) {
          throw new Error(`O código EAP ${wbsCode} já está em uso nesta obra.`);
        }
        if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
          throw new Error("O término previsto não pode anteceder o início.");
        }
        if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
          throw new Error("O peso da etapa deve ficar entre 0% e 100%.");
        }
        if (
          !Number.isFinite(plannedProgress) ||
          plannedProgress < 0 ||
          plannedProgress > 100
        ) {
          throw new Error("O avanço previsto deve ficar entre 0% e 100%.");
        }
        if (
          !Number.isFinite(budget) ||
          budget < 0 ||
          !Number.isFinite(forecast) ||
          forecast < 0
        ) {
          throw new Error("Orçamento e previsão de custo devem ser positivos.");
        }
        if (!Number.isInteger(sortOrder) || sortOrder < 0) {
          throw new Error(
            "A ordem da etapa deve ser um número inteiro positivo.",
          );
        }

        const payload = {
          parent_id: parentId,
          wbs_code: wbsCode,
          name: String(form.get("name") || "").trim(),
          description: String(form.get("description") || "").trim() || null,
          discipline: String(form.get("discipline") || "geral"),
          phase: String(form.get("phase") || "planejamento"),
          status: String(form.get("status") || "planejado"),
          responsible_user_id:
            String(form.get("responsible_user_id") || "") || null,
          cost_center_id: String(form.get("cost_center_id") || "") || null,
          priority: String(form.get("priority") || "normal"),
          planned_start: plannedStart,
          planned_end: plannedEnd,
          weight_pct: weight,
          planned_progress: plannedProgress,
          budget_amount: budget,
          forecast_amount: forecast,
          notes: String(form.get("notes") || "").trim() || null,
          sort_order: sortOrder,
          is_summary: isSummary,
          updated_at: new Date().toISOString(),
        };
        if (!payload.name) throw new Error("Informe o nome da etapa.");

        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        if (item) {
          const { error } = await client
            .from("construction_work_packages")
            .update(payload)
            .eq("id", item.id)
            .eq("organization_id", data.organization.id)
            .eq("project_id", project.id);
          if (error) throw error;
        } else {
          const { error } = await client
            .from("construction_work_packages")
            .insert({
              ...payload,
              organization_id: data.organization.id,
              project_id: project.id,
              code: "",
              package_code: null,
              actual_progress: 0,
              committed_amount: 0,
              measured_amount: 0,
              paid_amount: 0,
              created_by: data.session.user.id,
            });
          if (error) throw error;
        }
        saved = true;
      }, item ? "Etapa da EAP atualizada." : "Nova etapa adicionada à EAP.");
    } finally {
      setSubmitting(false);
    }
    if (saved) close();
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal eap-package-modal"
        role="dialog"
        aria-modal="true"
        aria-label={item ? `Editar ${item.name}` : "Adicionar etapa à EAP"}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <PanelTitle
          eyebrow={item ? "EDITAR EAP" : "NOVA ETAPA"}
          title={item?.name || (parent ? `Subetapa de ${parent.name}` : "Criar etapa da obra")}
        />
        <button
          className="modal-close"
          type="button"
          aria-label="Fechar editor da EAP"
          autoFocus
          onClick={close}
        >
          ×
        </button>

        <div className="eap-editor-kind">
          <label className={isSummary ? "" : "active"}>
            <input
              type="radio"
              name="package_kind"
              checked={!isSummary}
              disabled={!!item}
              onChange={() => setIsSummary(false)}
            />
            <span>
              <strong>Etapa executável</strong>
              <small>Possui peso, orçamento e medição física</small>
            </span>
          </label>
          <label className={isSummary ? "active" : ""}>
            <input
              type="radio"
              name="package_kind"
              checked={isSummary}
              disabled={!!item}
              onChange={() => setIsSummary(true)}
            />
            <span>
              <strong>Grupo consolidador</strong>
              <small>Organiza subetapas sem duplicar percentuais</small>
            </span>
          </label>
        </div>

        <div className="form-grid three eap-editor-grid">
          <label>
            Código EAP
            <input name="wbs_code" defaultValue={defaultWbs} required />
          </label>
          <label className="span-2">
            Nome da etapa
            <input name="name" defaultValue={item?.name || ""} required />
          </label>
          <label className="span-3">
            Descrição
            <textarea
              name="description"
              rows={2}
              defaultValue={item?.description || ""}
            />
          </label>
          <label>
            Grupo superior
            <select
              name="parent_id"
              defaultValue={item?.parent_id || initialParentId || ""}
            >
              <option value="">Nível principal</option>
              {parentOptions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.wbs_code || candidate.code} · {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Disciplina
            <select
              name="discipline"
              defaultValue={item?.discipline || parent?.discipline || "geral"}
            >
              {disciplineOptions.map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fase
            <select
              name="phase"
              defaultValue={item?.phase || parent?.phase || "planejamento"}
            >
              {phaseOptions.map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select name="status" defaultValue={item?.status || "planejado"}>
              {statusOptions.map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prioridade
            <select
              name="priority"
              defaultValue={item?.priority || "normal"}
            >
              {priorityOptions.map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ordem
            <input
              name="sort_order"
              type="number"
              min="0"
              step="1"
              defaultValue={defaultSort}
              required
            />
          </label>
          <label>
            Início previsto
            <input
              name="planned_start"
              type="date"
              defaultValue={
                item?.planned_start ||
                parent?.planned_start ||
                project.start_date ||
                ""
              }
            />
          </label>
          <label>
            Término previsto
            <input
              name="planned_end"
              type="date"
              defaultValue={
                item?.planned_end ||
                parent?.planned_end ||
                project.end_date ||
                ""
              }
            />
          </label>
          <label>
            Responsável
            <select
              name="responsible_user_id"
              defaultValue={item?.responsible_user_id || ""}
            >
              <option value="">Não definido</option>
              {data.members.map((member) => {
                const profile = data.profiles.find(
                  (candidate) => candidate.id === member.user_id,
                );
                return (
                  <option value={member.user_id} key={member.id}>
                    {profile?.full_name || member.user_id}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            Centro de custo
            <select
              name="cost_center_id"
              defaultValue={item?.cost_center_id || ""}
            >
              <option value="">Não definido</option>
              {availableCenters.map((center) => (
                <option value={center.id} key={center.id}>
                  {center.code} · {center.name}
                  {!center.active ? " · inativo" : ""}
                </option>
              ))}
            </select>
          </label>
          {!isSummary && (
            <>
              <label>
                Peso na obra (%)
                <input
                  name="weight_pct"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  defaultValue={Number(item?.weight_pct || 0)}
                  required
                />
              </label>
              <label>
                Previsto atual (%)
                <input
                  name="planned_progress"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  defaultValue={Number(item?.planned_progress || 0)}
                  required
                />
              </label>
              <label>
                Orçamento da etapa
                <input
                  name="budget_amount"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={Number(item?.budget_amount || 0)}
                  required
                />
              </label>
              <label>
                Previsão de custo
                <input
                  name="forecast_amount"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={Number(
                    item?.forecast_amount || item?.budget_amount || 0,
                  )}
                  required
                />
              </label>
            </>
          )}
          <label className="span-3">
            Observações
            <textarea name="notes" rows={3} defaultValue={item?.notes || ""} />
          </label>
        </div>

        {item?.template_code && (
          <div className="info-box">
            Esta etapa nasceu do modelo{" "}
            <strong>
              {data.constructionEapTemplates.find(
                (template) =>
                  template.template_code === item.template_code,
              )?.name || item.template_code}
            </strong>
            . As alterações ficam restritas a este empreendimento e não
            modificam o modelo original.
          </div>
        )}

        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={submitting}>
            {submitting
              ? "Salvando..."
              : item
                ? "Salvar alterações"
                : "Adicionar à EAP"}
          </button>
        </footer>
      </form>
    </div>
  );
}
