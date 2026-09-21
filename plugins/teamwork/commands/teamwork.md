---
description: Open a Teamwork campaign — scope the objective, pick an integrity mode and pattern, then run a multi-agent team with independent verification.
argument-hint: "<objective>"
skills: teamwork
---

Open a Teamwork campaign for this objective:

$ARGUMENTS

If no objective was given, ask for one before doing anything else.

Now run **Phase 1 — Specify What, Not How**, following the `teamwork` skill:

1. Interview me on the five topics: Scope & Objectives, Requirements, Independent Verification, Acceptance Criteria, Project Working Directory. **Use the interactive question panel** — one batch per topic, each with concrete options to pick from and an open field for anything they miss. Do not output a wall of prose questions. Push back on anything vague rather than filling the gap with an assumption.
2. Recommend an integrity mode (`development` / `demo` / `benchmark`) and say why.
3. Recommend a pattern from the five, and be explicit if the work is non-decomposable — parallelism that conflicts is worse than work that converges serially. Say plainly when the pattern you picked runs Workers in parallel.
4. Write the charter to `.teamwork/campaign.json`, with `approved: false` and `phase: "scoping"`.
5. Show me the charter and wait for approval. **Stop here and tell me to type `/teamwork-approve` to approve.**

**Before I approve, warn me about the question countdown.** The question panel auto-continues after five minutes on its own, which would let this approval gate pass itself. Tell me to turn off **Settings → General → Ask-questions auto-continue** (the wording in Chinese is 设置 → 常规 → 提问自动继续), or to keep the countdown paused by hovering over the panel while I read.

Do not dispatch any subagents, do not start implementing, and **do not set `approved: true` yourself**. The ownership hooks stay inert until `/teamwork-approve` creates `.teamwork/approval.json` and arms execution phase, binding to the exact charter hash.

Once I approve via `/teamwork-approve`, verify approval with `teamwork.mjs approve --check`, then follow the `teamwork-execute` skill for Phase 2. Three commands are available while a campaign runs:

- `/teamwork-approve` — approve the campaign charter and arm execution
- `/teamwork-status` — read-only report of milestone progress, active leases, and verification gaps (via `gate --json`)
- `/teamwork-end` — archive the campaign state and disarm the hooks
