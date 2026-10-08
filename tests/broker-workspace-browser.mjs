// UI regression with synthetic API fixtures: never authenticates or writes production data.
// Build first, then run with QA_NODE_MODULES and optional QA_CHROMIUM / TEST_BASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.QA_NODE_MODULES ? pathToFileURL(path.join(process.env.QA_NODE_MODULES, "playwright/index.mjs")).href : "playwright");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3101";
const server = process.env.TEST_BASE_URL ? null : spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"], { stdio: "pipe" });
const serverErrors = [];
server?.stderr.on("data", data => serverErrors.push(data.toString()));
process.on("exit", () => server?.kill());
const output = await mkdtemp(path.join(tmpdir(), "broker-workspace-"));
const actor = "00000000-0000-4000-a000-000000000001";
const org = "00000000-0000-4000-a000-000000000002";
const project = "00000000-0000-4000-a000-000000000003";
const now = new Date().toISOString();
const membership = { organization_id: org, user_id: actor, role: "corretor", active: true };
const stages = [["novo", "Novo lead"], ["contato", "Tentativa de contato"], ["qualificacao", "Qualificação SDR"], ["visita", "Visita agendada"], ["proposta", "Proposta enviada"], ["ganho", "Venda concluída"]].map(([code, name], position) => ({ id: code, name, code, position, pipeline_id: "pipeline", active: true, is_won: code === "ganho", is_lost: false }));
const records = [["lead-sdr", "João Sintético", "qualificacao"], ["lead-approved", "Márcia Sintética", "proposta"], ["lead-pending", "Pedro Sintético", "proposta"], ["lead-agency", "Lead da imobiliária", "novo"]].map(([id, person_name, stage]) => ({ id, person_name, organization_id: org, project_id: project, pipeline_id: "pipeline", stage, stage_id: stage, record_status: "aberta", broker_user_id: id === "lead-agency" ? "another-broker" : actor, created_at: now, updated_at: now, temperature: "morno", lead_score: 10, tags: [], phone: "00000000000", notes: null }));
const proposals = [
  { id: "proposal-approved", crm_record_id: "lead-approved", approval_status: "aprovada", status: "aprovada", proposal_number: "TEST-APPROVED", unit_code: "TEST-A01" },
  { id: "proposal-pending", crm_record_id: "lead-pending", approval_status: "pendente", status: "submetida", proposal_number: "TEST-PENDING", unit_code: "TEST-A02" },
];
const activities = [
  { id: "appointment", title: "Visita sintética", status: "pendente", starts_at: now, due_at: now, related_type: "crm_record", related_id: "lead-sdr", owner_user_id: actor },
  { id: "personal", title: "Planejamento pessoal", status: "pendente", starts_at: now, due_at: now, related_type: null, related_id: null, owner_user_id: actor },
];
const commerce = {
  pipelines: [{ id: "pipeline", name: "Funil comercial", is_default: true }], stages,
  responsibles: [{ id: actor, full_name: "Corretor sintético" }], lead_policies: [], proposals,
  policies: [{ id: "policy", project_id: project, name: "Política sintética", min_down_payment_pct: 0.2, max_installments: 120, monthly_interest_rate: 0.0033, reservation_validity_hours: 24, grace_months: 0, balloon_frequency_months: 12 }],
};
const units = [{ id: "unit", project_id: project, unit_code: "TEST-A03", lot_number: "03", block_code: "A", area: 300, list_price: 300000 }];
const payloads = [];
const unexpected = [];
let browser;
let inspectedPage;
try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, `Server did not start: ${serverErrors.join("")}`);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.QA_CHROMIUM ? { executablePath: process.env.QA_CHROMIUM } : {}), args: ["--no-sandbox", "--single-process", "--no-zygote", "--disable-gpu"], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {}) });
  const context = await browser.newContext({ viewport: { width: 1536, height: 960 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
  await context.addInitScript(({ actor, now }) => {
    const session = { access_token: "synthetic-test-token", refresh_token: "synthetic-test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user: { id: actor, email: "synthetic@example.invalid", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now } };
    localStorage.setItem("sb-qsdffayasuzsmngteika-auth-token", JSON.stringify(session));
  }, { actor, now });
  await context.route("**/*.supabase.co/**", async route => {
    const request = route.request(), url = new URL(request.url()), resource = url.pathname.split("/").at(-1);
    const rpc = url.pathname.includes("/rpc/");
    let result;
    if (rpc) {
      const body = request.postDataJSON();
      if (resource === "get_broker_attendance_context") result = { projects: [{ id: project, name: "Empreendimento sintético" }], units, agencies: [{ id: "agency", name: "Imobiliária sintética" }] };
      else if (resource === "get_broker_commercial_context") result = commerce;
      else if (resource === "get_broker_lead_insights") result = { last_message: "Mensagem sintética para revisão", updated_at: now };
      else if (resource === "submit_broker_proposal") {
        payloads.push({ resource, body });
        result = { id: body.p_request_id, number: "TEST-SUBMITTED" };
      } else if (resource === "save_broker_appointment") {
        payloads.push({ resource, body });
        activities.push({ id: "new-appointment", title: body.p_title, status: body.p_status, related_type: body.p_record_id ? "crm_record" : null, related_id: body.p_record_id, starts_at: body.p_starts_at, due_at: body.p_due_at, owner_user_id: actor });
        result = "new-appointment";
      } else if (resource === "move_broker_lead_stage") {
        payloads.push({ resource, body });
        const lead = records.find(row => row.id === body.p_record_id);
        lead.stage_id = body.p_stage_id; lead.stage = body.p_stage_id;
        result = null;
      } else unexpected.push(resource);
    } else if (request.method() === "GET") {
      const emptyTables = ["crm_actions", "crm_lead_assignments", "crm_marketing_assets", "crm_asset_folders", "document_attachments", "communication_links", "marketing_assets"];
      if (resource === "organization_members") result = membership;
      else if (resource === "organizations") result = { id: org, name: "Organização sintética" };
      else if (resource === "profiles") result = { id: actor, full_name: "Corretor sintético" };
      else if (resource === "crm_records") result = records;
      else if (resource === "user_activities") result = activities;
      else if (emptyTables.includes(resource)) result = [];
      else unexpected.push(resource);
    } else unexpected.push(`${request.method()} ${resource}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result ?? null) });
  });
  await context.route("**/api/**", route => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const page = await context.newPage(), errors = [];
  inspectedPage = page;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/crm`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Leads e clientes potenciais", exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 4);
  const search = page.getByRole("searchbox", { name: "Buscar por nome", exact: true });
  await search.fill("  joao  ");
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Insights IA", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Encaminhar proposta", exact: true }).click();
  const proposalDialog = page.getByRole("dialog", { name: "Proposta e reserva de lote" });
  assert.equal(await proposalDialog.getByRole("combobox", { name: "Lead vinculado", exact: true }).inputValue(), "lead-sdr");
  await proposalDialog.getByRole("searchbox", { name: "Buscar lead por nome" }).fill("marcia");
  await proposalDialog.getByRole("combobox", { name: "Lead vinculado", exact: true }).selectOption("lead-approved");
  await proposalDialog.getByLabel("Lote disponível").selectOption("unit");
  await proposalDialog.getByRole("button", { name: "Encaminhar proposta", exact: true }).click();
  await proposalDialog.waitFor({ state: "hidden" });
  assert.equal(payloads.at(-1).resource, "submit_broker_proposal");
  assert.equal(payloads.at(-1).body.p_record_id, "lead-approved");
  assert.equal(payloads.at(-1).body.p_unit_id, "unit");
  assert.ok(!("approval_status" in payloads.at(-1).body.p_terms));
  await search.fill("");
  await page.screenshot({ path: path.join(output, "leads-desktop.png") });

  await page.getByRole("button", { name: "Meu funil", exact: true }).click();
  await page.getByRole("heading", { name: "Meu funil de vendas" }).waitFor();
  assert.equal(await page.getByText("3 oportunidades sob sua responsabilidade.").count(), 1);
  assert.ok(!(await page.locator("main").innerText()).includes("Qualificação SDR"));
  assert.equal(await page.locator("option").filter({ hasText: "Qualificação SDR" }).count(), 0);
  const approved = page.getByRole("region", { name: "Propostas aprovadas", exact: true });
  assert.equal(await approved.locator("article").count(), 1);
  assert.equal(await approved.getByRole("button", { name: "Márcia Sintética", exact: true }).count(), 1);
  assert.equal(await approved.locator("select").count(), 0);
  const service = page.getByRole("region", { name: "Em atendimento", exact: true });
  await service.getByRole("button", { name: "Gerar proposta", exact: true }).click();
  assert.equal(await proposalDialog.getByRole("combobox", { name: "Lead vinculado", exact: true }).inputValue(), "lead-sdr");
  await proposalDialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("combobox", { name: "Etapa de João Sintético", exact: true }).selectOption("visita");
  await page.getByRole("region", { name: "Visita agendada", exact: true }).getByRole("button", { name: "João Sintético", exact: true }).waitFor();
  assert.equal(payloads.at(-1).resource, "move_broker_lead_stage");
  assert.equal(payloads.at(-1).body.p_stage_id, "visita");
  await page.screenshot({ path: path.join(output, "funnel-desktop.png") });

  await page.getByRole("button", { name: "Minha agenda", exact: true }).click();
  await page.getByRole("heading", { name: "Minha agenda", exact: true }).waitFor();
  assert.equal(await page.getByRole("columnheader", { name: "Lead vinculado", exact: true }).count(), 1);
  const agendaSearch = page.getByRole("searchbox", { name: "Buscar na agenda", exact: true });
  await agendaSearch.fill("joao");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await agendaSearch.fill("Planejamento");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await agendaSearch.fill("");
  await page.getByRole("button", { name: "+ Novo compromisso", exact: true }).click();
  const appointment = page.getByRole("dialog", { name: "Gerenciar compromisso", exact: true });
  await appointment.getByRole("searchbox", { name: "Buscar lead por nome" }).fill("marcia");
  const linked = appointment.getByRole("combobox", { name: "Lead vinculado", exact: true });
  assert.equal(await linked.locator("option").count(), 2);
  await linked.selectOption("lead-approved");
  await appointment.getByRole("searchbox", { name: "Buscar lead por nome" }).fill("does-not-exist");
  assert.equal(await linked.inputValue(), "lead-approved");
  assert.match(await appointment.getByRole("status").innerText(), /selecionado foi mantido/);
  await appointment.getByLabel("Título", { exact: true }).fill("Visita agendada sintética");
  await appointment.getByRole("button", { name: "Salvar compromisso", exact: true }).click();
  await appointment.waitFor({ state: "hidden" });
  assert.equal(payloads.at(-1).resource, "save_broker_appointment");
  assert.equal(payloads.at(-1).body.p_record_id, "lead-approved");
  await agendaSearch.fill("marcia");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByRole("button", { name: "Gerenciar", exact: true }).click();
  assert.equal(await appointment.getByRole("combobox", { name: "Lead vinculado", exact: true }).isDisabled(), true);
  await appointment.getByRole("button", { name: "Voltar", exact: true }).click();
  await page.screenshot({ path: path.join(output, "agenda-desktop.png") });

  for (const tab of ["Meus atendimentos", "Meu funil", "Minha agenda"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Mobile overflow: ${tab}`);
    await page.screenshot({ path: path.join(output, `mobile-${tab.replaceAll(" ", "-")}.png`) });
  }
  assert.deepEqual(unexpected, [], "Every backend request must be explicitly mocked; no production writes allowed");
  assert.deepEqual(errors, []);
  assert.deepEqual(serverErrors, []);
  console.log(JSON.stringify({ result: "passed", source: "synthetic API fixtures", browserErrors: errors, testedMutations: payloads.map(item => item.resource), screenshots: output }));
} catch (error) {
  if (inspectedPage) {
    console.error(await inspectedPage.locator("body").ariaSnapshot());
    await inspectedPage.screenshot({ path: path.join(output, "failure.png") });
    console.error(`Screenshot: ${output}/failure.png`);
  }
  throw error;
} finally {
  await browser?.close();
  server?.kill();
}
