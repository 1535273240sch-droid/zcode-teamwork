---
name: teamwork-execute
description: Phase 2 of a Teamwork campaign - run the approved pattern, dispatch Workers against the ownership table, route every milestone through an independent verifier, and write the verification records that make the campaign's completion checkable. Use after the charter is approved and the Sentinel has returned CLEARED. Not for scoping a new campaign, and not for small edits.
when_to_use: The Teamwork charter has been approved and the campaign is entering execution, or a campaign is resuming mid-flight and the next milestone needs dispatching. Also use when a milestone has been rejected and needs routing back through implementation and verification.
license: MIT
metadata:
  author: Teamwork for ZCode
  version: 0.2.0
---

# Teamwork — Phase 2: Execute the Pattern

Phase 1 produced a charter and the human approved it. Phase 2 is the loop that turns the plan into a finished campaign. **This skill fixes the scheduling decisions**, because leaving them to improvisation makes two runs of the same campaign behave differently.

## Before the first dispatch

Confirm all four, and stop if any is missing:

1. `.teamwork/campaign.json` has `approved: true` and `phase: "execution"`, and `.teamwork/approval.json` exists matching the charter hash. Check with `teamwork.mjs approve --check`. Until this holds, the ownership hooks are inert and parallel Workers have no protection at all.
2. Sentinel returned `CLEARED`, not `BLOCKED`.
3. `.teamwork/plan.json` exists with milestones, a dependency graph, risk ratings, and an ownership table. If it does not, the Orchestrator has not run.
4. The `/goal` text requires `teamwork.mjs gate` to output `TEAMWORK-GATE: PASS`.

## The loop

Run one milestone through these five steps, then take the next one the dependency graph has unblocked.

**1. Dispatch.** Check `.teamwork/mode.json` before dispatching. If `max_parallel` is set (e.g., degraded to 1 due to weak attribution), never exceed that concurrency limit. Send the milestone to a Worker with its file scope and its acceptance criteria. Dispatch Workers in parallel **only** where the ownership table gives them disjoint files and `mode.json` permits. A milestone whose `blocked_by` is not yet done does not start.

**2. Implement.** The Worker changes only its own files, using the `Edit` and `Write` tools, and reports what changed, the exact verification command, and its raw output. A Worker that needs a file outside its scope stops and reports a conflict instead of taking it. Workers are strictly prohibited from writing to `.teamwork/evidence/**`, `.teamwork/approval.json`, `.teamwork/verifications/**`, and `.teamwork/final-audit.md`.

**3. Verify.** Route the milestone to the role that matches what is actually in doubt — Critic for implementation defects, Challenger for a load-bearing premise, Auditor to reproduce the evidence. **Never the Worker that built it.** The verifier runs proof commands via `teamwork.mjs run -- <cmd>` to record hash-chained evidence, then calls `teamwork.mjs verify --milestone <id> --role <role> --verdict <verdict> --evidence <ids> [--body "text"]` to record the verification. **Never write verification files by hand.**

**4. Route the verdict.**

| Verdict | What happens |
|---|---|
| Critic `SOUND`, Auditor `REPRODUCED`, Challenger `SURVIVED` | Mark `verified: true` and `status: "done"` in `plan.json`, then move on. |
| Critic finds defects | Send it back to the **same Worker** if the fix stays inside its file scope, otherwise reassign the file to the milestone's owner. This is rework round 1. |
| Auditor `DIVERGED` | Treat it as a verification failure, not a bug report: the claimed evidence does not exist as claimed. Back to implementation, and tell the Worker the specific discrepancy. |
| Challenger `FALSIFIED` | The premise is dead. **Do not rework the milestone** — send it to the Orchestrator to replan. |
| Challenger `UNFALSIFIABLE` | The claim cannot be tested. Report it to the human; do not silently proceed. |
| Auditor `BLOCKED` | The verification command is missing or unreproducible. That is itself a milestone failure: fix the acceptance criterion or the evidence, then re-verify. |

**5. Record.** Update `plan.json`. A milestone is done only when `verified: true` and a verification file exists.

## Rework ceiling

**Two rework rounds per milestone.** Count them. Rework round 1 is a normal iteration; round 2 means the original split was probably wrong.

At the ceiling, stop reworking and climb the escalation ladder:

1. **Retry the role once, unchanged.** Most failures are transient.
2. **Send it back to the Orchestrator** to replan — re-split the milestone, reassign the file, or change which role verifies it. Update `plan.json`.
3. **Stop and escalate.** Run `/goal pause` and report to the human: which milestone is stuck, what was tried, what the blocker actually is, which milestones are done, and what has been spent.

**Never let a failing milestone loop.** The per-round verifier will open another round indefinitely, so an unresolved failure turns into a burn-the-budget loop that produces nothing. Two rework rounds and a replan is the ceiling; past that it is a human decision, not an agent decision.

## What you must not do

- **Do not verify your own work.** Dispatching a Worker and then reading its diff yourself is not verification; it is the same judgement twice.
- **Do not skip a verifier because the tests are green.** Green tests are what the verifier is supposed to check the teeth of, not a reason to skip it.
- **Do not let a milestone be called done without a verification file.** That file is the only part of this protocol the runtime can check, so it is the only part that cannot be quietly skipped.
- **Do not widen a Worker's file scope to unblock it.** Serialise the milestones instead. Two Workers in one file is the failure mode this whole framework exists to prevent.

## Closing the campaign

When every milestone is `done` and `verified`, run the **Success Auditor** against the **charter**, not the milestone list. The Success Auditor executes final proof commands via `teamwork.mjs run -- <cmd>` and records the audit using `teamwork.mjs final-audit --verdict <ACHIEVED|PARTIALLY ACHIEVED|NOT ACHIEVED> --evidence <ids> [--body "text"]`.

Then run `teamwork.mjs gate` to verify all campaign invariants (G1-G12). A campaign honestly reported as `PARTIALLY ACHIEVED` is worth more than one confidently reported as complete — and the `/goal` will not pass without `TEAMWORK-GATE: PASS`.
