# Guided broker proposals — release checkpoint, 2026-11-11

## Status

Release candidate validated and authorized for publication. Production commit and policy activation must be verified after the main branch deployment is READY.
The pending PDF/material-sharing work from 2026-11-06 is preserved with this change.
Migrations for proposal documents, guided proposal policy, and term-based commercial rates are applied remotely. The two new migrations ran integration assertions in their deployment transactions, with business fixtures rolled back.
Edge Functions are active: enterprise-bia-agent-gateway v20, enterprise-vitoria-agent v8, enterprise-vitoria-agent-gateway v4. Unrelated deployed dependencies and authentication settings were preserved.

## Implemented

- Guided lead/lot, percentage entry, term/amortization, annual balloons and dates sections.
- Price and SACOC/gradient radio choices; policy-derived, non-editable monthly interest.
- Entry percentage stays fixed when price changes; entry installments and their separate rate are visible.
- Annual balloon amounts/dates, first/last monthly amount, monthly principal, total cash flow and full schedule.
- Split-entry default starts next month; monthly series starts after the final entry.
- PDF conference and share actions remain separate from submission/reservation.
- Client submission identity follows the exact payload; server still checks broker access, lot availability and approval.
- Server derives rates from policy parameters, enforces entry/term/balloon limits and exposes only whitelisted commercial parameters.
- New balloon dates coincide with the 12th, 24th, etc. monthly payment (including grace); deploy client/server together.

## Verification

- 40 unit tests passed: policy tier boundaries, entry rates, Price/SACOC, cents, calendar dates, balloons, broker funnel, Bia runtime/presentation and tier presentation.
- TypeScript and lint passed (172 existing repository warnings, zero errors).
- Next.js and eslint-config-next upgraded to 16.4.6 with authorization. Full production build passed, including mandatory dependency audit (zero vulnerabilities).
- Real React server-render test passed for the initial proposal form, policy controls, automatic rate, entry amount and amortization choices.
- Broker PDF tests passed for short and multi-page schedules; PDF rendering inspected. Bia scenario PDF test and rendering passed for three different term rates.
- Browser regression was expanded with synthetic API fixtures, but Chromium could not launch: socket() failed, Operation not permitted. Do not report browser/UI verification as passed.
- Database integration tests passed for broker ownership, rate/term/entry/balloon/date tampering, approval-pending submission, reservation linkage, repeat-submission idempotency, schedule/PDF parity and all rate boundaries. No test proposals/reservations remain. Existing financial records were not changed.

## Before publication

1. Publish the validated source with a compare-and-swap main branch update; confirm the exact commit is READY on the production domain.
2. Activate the requested commercial policy in one audited transaction, preserving historical proposal/contract snapshots.
3. Recheck live policy/rate boundaries, available lot prices, deployment health and security advisors.
4. Browser interaction/desktop/mobile regression remains unverified due the environment permission boundary; run the prepared synthetic fixture suite in an allowed browser environment.

## Commercial policy activation is separate and still pending

The UI/helpers support the requested 180-month policy, but no policy values were activated in this turn. Current production default still has max 150 / flat 0.33%.
Requested parameters: max 180; entry >=10%, <=6 installments; monthly interest tiers <=96:0.0033, <=120:0.005, <=180:0.006; annual balloons <=40% total and <=4. Retain existing entry options (<=3 interest-free; <=6 at 0.33%) and IPCA unless explicitly changed.

All identified flat-rate consumers are now updated: corporate use-proposal-builder, negotiation-view, ProposalModalV52 rate display, bia_manager_simulate, calculate_public_agent_payment_simulation_v4, public-agent simulation copy and Bia gateways/PDF. Each scenario carries its actual monthly rate. Keep historic proposal/contract snapshots immutable. Do not activate 180 months with a single flat 0.33% rate.

Already completed separately: all 164 available active lots were repriced to R$1,200/m², with per-lot audits. Sold/reserved/blocked/unavailable inventory was preserved.
