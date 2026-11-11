# Guided broker proposals — release checkpoint, 2026-11-11

## Status

Prepared locally; NOT published. Production remains a553202.
The pending PDF/material-sharing work from 2026-11-06 is preserved with this change.
Migration 20261106171730 is already applied remotely. Migration 20261111190153 is a draft, not applied.

## Implemented

- Guided lead/lot, percentage entry, term/amortization, annual balloons and dates sections.
- Price and SACOC/gradient radio choices; policy-derived, non-editable monthly interest.
- Entry percentage stays fixed when price changes; entry installments and their separate rate are visible.
- Annual balloon amounts/dates, first/last monthly amount, monthly principal, total cash flow and full schedule.
- Split-entry default starts next month; monthly series starts after the final entry.
- PDF conference and share actions remain separate from submission/reservation.
- Client submission identity follows the exact payload; server still checks broker access, lot availability and approval.
- Draft server migration derives rates from policy parameters, enforces entry/term/balloon limits and exposes only whitelisted commercial parameters.
- New balloon dates coincide with the 12th, 24th, etc. monthly payment (including grace); deploy client/server together.

## Verification

- 20 unit tests passed: policy tier boundaries, entry rates, Price/SACOC, cents, calendar dates, balloons and existing broker funnel.
- TypeScript and lint passed (172 existing repository warnings, zero errors).
- Production build stopped at mandatory audit: Next.js 16.3.8 has a critical advisory; audit recommends 16.4.6. No audit bypass or dependency change performed. Awaiting authorization for the previously requested security upgrade.
- Browser regression was expanded with synthetic API fixtures, but Chromium could not launch: socket() failed, Operation not permitted. Do not report browser/UI verification as passed.
- Draft database migration has not been applied or integration-tested. Existing financial records were not changed.

## Before publication

1. Obtain authorization for the security dependency update, update pinned Next.js and matching eslint-config-next, rerun the full build/audit.
2. Run tests/broker-workspace-browser.mjs in an allowed browser test environment with synthetic fixtures; inspect desktop/mobile screenshots.
3. Test the draft migration on a disposable/staging database, including rate tampering, broker ownership, sold/reserved units, repeat submissions, entry options and decimal/date parity.
4. Deploy the draft migration and matching frontend together; verify the exact ready commit and broker flow.

## Commercial policy activation is separate and still pending

The UI/helpers support the requested 180-month policy, but no policy values were activated in this turn. Current production default still has max 150 / flat 0.33%.
Requested parameters: max 180; entry >=10%, <=6 installments; monthly interest tiers <=96:0.0033, <=120:0.005, <=180:0.006; annual balloons <=40% total and <=4. Retain existing entry options (<=3 interest-free; <=6 at 0.33%) and IPCA unless explicitly changed.

Before activating those values, update ALL flat-rate consumers: corporate use-proposal-builder, negotiation-view, ProposalModalV52 rate display, bia_manager_simulate, calculate_public_agent_payment_simulation_v4 and public-agent simulation copy. Otherwise longer plans can quote the wrong rate. Keep historic proposal/contract snapshots immutable. Do not activate 180 months with a single flat 0.33% rate.

Already completed separately: all 164 available active lots were repriced to R$1,200/m², with per-lot audits. Sold/reserved/blocked/unavailable inventory was preserved.
