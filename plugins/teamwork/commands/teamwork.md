---
description: Open a Teamwork campaign — scope the objective, pick an integrity mode and pattern, then run a multi-agent team with independent verification.
argument-hint: "<objective>"
skills: teamwork
---

Open a Teamwork campaign for this objective:

$ARGUMENTS

If no objective was given, ask for one before doing anything else.

Now run **Phase 1 — Specify What, Not How**, following the `teamwork` skill:

1. Check if a tier is specified (`--tier agile|standard|adversarial`) or run `node ${ZCODE_PLUGIN_ROOT}/lib/teamwork-cli.mjs tier --task "$ARGUMENTS"` to recommend one:
   - **L1 Agile (Duo)**: For single-file fixes, small features, or rapid test additions. Skips Sentinel & heavy scoping interview, launches Worker + Critic directly to save 80%+ tokens!
   - **L2 Standard (Squad)**: Orchestrator + Worker + Auditor + Critic for multi-file features and clean milestone breakdown.
   - **L3 Adversarial (Full Team)**: All 8 roles for quantitative models, math proofs, and high-risk migrations.
2. If L1 Agile is selected, create `.teamwork/campaign.json` directly with `tier: "agile"`, `approved: true`, `phase: "execution"`, and immediately begin implementation.
3. If L2 Standard or L3 Adversarial is selected:
   - Interview me on the key topics (Scope, Requirements, Verification, Acceptance Criteria). **Use the interactive question panel** — one batch per topic.
   - Write the charter to `.teamwork/campaign.json` and await approval.
   - **Warn me about the question countdown** before approval.

Do not dispatch any subagents, and do not start implementing, until approved (auto-approved in L1 Agile). The ownership hooks stay inert until `approved: true` and `phase: "execution"` are both written.

Once approved, follow the `teamwork-execute` skill for Phase 2. Commands available while running:
- `/teamwork-status` — OLED & Mermaid visual dashboard and progress ledger
- `/teamwork-end` — archive campaign state and disarm hooks
