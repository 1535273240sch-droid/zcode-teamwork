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

1. `.teamwork/campaign.json` has `approved: true` and `phase: "execution"`. Until both hold, the ownership hooks are inert and parallel Workers have no protection at all.
2. Sentinel returned `CLEARED`, not `BLOCKED`.
3. `.teamwork/plan.json` exists with milestones, a dependency graph, and an ownership table. If it does not, the Orchestrator has not run.
4. The `/goal` text names the verification files, not just the objective.

## The loop

Run one milestone through these five steps, then take the next one the dependency graph has unblocked.

**1. Dispatch.** Send the milestone to a Worker with its file scope and its acceptance criteria. Dispatch Workers in parallel **only** where the ownership table gives them disjoint files. A milestone whose `blocked_by` is not yet done does not start. Name the dispatch after the person, not the ID: the card title is `owner名片：title` (e.g. "约翰·卡马克 · 实现攻坚：把 desc 接口接进采集器"), and in conversation a milestone is referred to as `title（id）`. Verification filenames keep using the bare `id` — the persona lives in prose, never in file paths.

**2. Implement.** The Worker changes only its own files, using the `Edit` and `Write` tools, and reports what changed, the exact verification command, and its raw output. A Worker that needs a file outside its scope stops and reports a conflict instead of taking it.

**3. Verify.** Route the milestone to the role that matches what is actually in doubt — Critic for implementation defects, Challenger for a load-bearing premise, Auditor to reproduce the evidence. **Never the Worker that built it.** The verifier writes `.teamwork/verifications/<milestone>.md` containing the milestone id, the verifying role, the exact command or check, the raw output, and the verdict.

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

When every milestone is `done` and `verified`, run the **Success Auditor** against the **charter**, not the milestone list, and have it write `.teamwork/final-audit.md` with a verdict of `ACHIEVED`, `PARTIALLY ACHIEVED`, or `NOT ACHIEVED`.

Then report to the human. A campaign honestly reported as `PARTIALLY ACHIEVED` is worth more than one confidently reported as complete — and the `/goal` will not pass without the final audit file anyway.
