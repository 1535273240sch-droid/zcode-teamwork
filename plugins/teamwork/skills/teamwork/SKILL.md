---
name: teamwork
description: Run a collaborative multi-agent campaign for repo-scale work - migrations, refactors across many files, simulations, and deep research. Use when a task spans many files or hours, needs independent verification of its own claims, or has repeatedly failed because a single agent kept agreeing with its own early mistakes. Not for small edits, single-file fixes, or work with a predictable cost per task.
when_to_use: The user invokes /teamwork, asks for a multi-agent team, asks for a task to be attacked and verified independently, or describes multi-day work spanning a repository. Also use when a previous single-agent attempt produced a confident result that could not be reproduced.
license: MIT
metadata:
  author: Teamwork for ZCode
  version: 0.2.0
---

# Teamwork — Phase 1: Specify What, Not How

You are opening a campaign. This phase is a scoping interview run by **you**, the primary agent. Do not start implementing. Do not delegate yet. A campaign that begins on a vague charter burns its whole budget discovering the goal was never defined.

The output of this phase is a **reviewable charter** the human approves. Only then does execution start.

## Step 1 — Interview

**Use the interactive question panel, not a wall of text.** Ask through the platform's multiple-choice question UI, batched by topic, with concrete options the human can pick from and an open field for anything the options miss. Do not dump five paragraphs of prose questions into the transcript: it is slower to answer, easier to skim past, and it is the single biggest difference between this and the original Teamwork interview.

One batch per topic below, in order. After each answer, push back on anything vague instead of filling the gap with an assumption.

**Scope & Objectives.** What outcome, not what activity. Push until it is checkable: "reduce p95 latency under 200ms on the replay dataset", not "improve performance". If the user's phrasing is an activity, ask what changes in the world when it succeeds.

**Requirements.** Constraints that bound the work: languages, dependencies, interfaces that must not change, performance floors, licensing. Then explicitly: **what is out of scope.** Unowned scope is how a campaign grows without limit.

**Independent Verification.** How would someone who did not do the work confirm it? This is the section people answer lazily — "we'll run the tests". Push: which command, on what state, compared against what, run by whom. If the only verification is the implementer running their own check, say so plainly as a weakness rather than letting it pass.

**Acceptance Criteria.** A numbered list, each independently checkable and each tied to evidence. Reject any criterion satisfiable by a plan, a description, or a confident summary. For each one, name the command or artifact that proves it.

**Project Working Directory.** An absolute path. Default to the current workspace and confirm it.

## Step 2 — Integrity mode

Pick one and record it. Default `development` unless the user says otherwise.

- **development** — rapid iteration. Shortcuts allowed but must be recorded in the report.
- **demo** — someone else must reproduce the result from a clean state, unaided.
- **benchmark** — maximum strictness. Language standard library only. No generated fixtures, no expected values written after seeing the result, no test that merely asserts current behaviour.

In `benchmark` mode, say out loud that you will expect the Success Auditor to look for metric gaming, and that a partially-achieved honest result beats a gamed complete one.

## Step 3 — Select the pattern

Choose the orchestration shape that fits. Do not default to the most elaborate one.

| Pattern | Use when | Pipeline |
|---|---|---|
| **Iterative Coding** | Work that cannot be cleanly split — tightly coupled through a fast feedback loop, like one algorithm or one simulation | Implement → Critic → refine → Auditor |
| **Distributed Coding** | Work that fans out into genuinely independent workstreams | Orchestrator → parallel Workers → Critic → Auditor |
| **Long Proof** | An open question with dead ends — a conjecture, a search over strategies, a novel design | Explorer → Challenger (falsify) → Worker → Auditor |
| **Self-Verification** | A claim that must be checked at every step rather than only at the end | Worker → Auditor loop per milestone |
| **Document Review** | Analysis of a body of material rather than code | Explorer → Critic → synthesis → Auditor |

Be honest about the decomposition. If the parts are coupled, choosing Distributed Coding buys conflicts, not speed.

**If you pick Distributed Coding, say so explicitly.** It is the only pattern that runs Workers concurrently, it is the only pattern where ownership attribution actually matters, and the ownership hooks report loudly when they cannot attribute a claim to a specific Worker.

## Step 4 — Write the charter

Write it to `.teamwork/campaign.json` in the working directory. This file activates the ownership hooks, so it must be well formed:

```json
{
  "objective": "<one sentence, checkable>",
  "integrity_mode": "development | demo | benchmark",
  "pattern": "iterative-coding | distributed-coding | long-proof | self-verification | document-review",
  "working_directory": "<absolute path>",
  "requirements": ["<constraint>"],
  "out_of_scope": ["<explicitly excluded>"],
  "verification_method": "<command or artifact that proves the result, and who runs it>",
  "acceptance_criteria": ["<numbered, independently checkable>"],
  "ownership_lease_minutes": 10,
  "approved": false,
  "phase": "scoping"
}
```

The charter is the **only** place these two values are set. There is no plugin-level setting that feeds them: `integrity_mode` and `ownership_lease_minutes` are decided in this interview and read straight out of the charter by the runtime. Do not tell the user to look for a switch in the plugin settings page — there isn't one, on purpose.

The hooks read three fields, and nothing happens until the first two line up:

| Field | Read by | Effect |
|---|---|---|
| `approved` | both ownership hooks | must be `true` before the hooks arm at all |
| `phase` | both ownership hooks | must be `"execution"` before the hooks arm at all |
| `ownership_lease_minutes` | ownership hooks | how long a write claim survives without activity |
| `pattern` | `ownership-lock.mjs` | `distributed-coding` turns on the attribution warning |
| `integrity_mode` | `session-context.mjs` | injects the mode constraints at session start |
| `objective` / `acceptance_criteria` | `session-context.mjs` | injected at session start so a resumed session does not drift |

Also ensure `.teamwork/` is gitignored — it holds runtime campaign state, not source.

## Step 5 — Get approval

Present the charter to the human and wait. Switch to Plan mode if you want a structured review before execution. **Do not set `approved: true` yourself**, and do not start Phase 2 on an assumption of consent. Tell the user to approve by typing `/teamwork-approve`.

**Warn the user about the countdown.** The platform's question panel auto-continues after five minutes by default, picking a direction on its own if nobody answers. That would let the approval gate pass itself. Tell the user to turn off **Settings → General → Ask-questions auto-continue** before running a campaign, or to keep the countdown paused by hovering over the panel while they read the charter.

## Step 6 — Hand off

After the user approves via `/teamwork-approve` (or confirms in the question panel for manual fallback), verify the approval with `teamwork.mjs approve --check`, then:

1. **Sentinel** reviews the charter and returns CLEARED or BLOCKED. Do not proceed past BLOCKED — resolve it with the human instead.
2. **Orchestrator** decomposes into milestones with a dependency graph, risk levels (`low|medium|high`), and a file-ownership table (including optional `shared_files`), and **writes the result to `.teamwork/plan.json`**. This is not optional: the plan is the only thing that keeps parallel Workers off each other, and a plan that lives only in the conversation dies with the conversation.
3. Set the goal with `/goal` so the platform's per-round verification keeps the campaign converging without you typing "continue":

   ```
   /goal <objective> — all acceptance criteria satisfied,
   and running `teamwork.mjs gate` outputs TEAMWORK-GATE: PASS
   ```

   The goal relies on the gate command to deterministically verify all evidence hash chains, role signatures, file modifications, ownership audit, and final audit. Without `TEAMWORK-GATE: PASS`, the goal simply does not pass.

4. Run the pattern following the **`teamwork-execute`** skill, which fixes the dispatch loop and the escalation rules. Dispatch Workers in parallel only where the ownership table allows and `mode.json` permits.

### `.teamwork/plan.json`

```json
{
  "sentinel": "CLEARED",
  "milestones": [
    {
      "id": "m1",
      "deliverable": "<checkable artifact>",
      "files": ["src/a.ts"],
      "blocked_by": [],
      "verified_by": ["critic"],
      "risk": "low",
      "status": "pending | in-progress | done",
      "verified": false
    }
  ],
  "ownership": {"src/a.ts": "m1"},
  "shared_files": []
}
```

`ownership` maps every in-scope file to exactly one milestone. `status` and `verified` are updated as the campaign runs, so a session that restarts can see where it left off.

### When something fails

Do not improvise the recovery. Follow this ladder, and stop climbing at the first rung that works:

1. **Retry the role once, unchanged.** Most failures are transient.
2. **Still failing: send it back to the Orchestrator** to replan — re-split the milestone, reassign the file, or change which role verifies it. Update `plan.json`.
3. **Still failing: stop and escalate to the human.** Run `/goal pause`, then report: which milestone is stuck, what was tried, what the blocker actually is, which milestones are already done, and what has been spent so far.

**Never let a failing role loop.** The per-round verifier will happily open another round, so an unresolved failure becomes a burn-the-budget loop with no progress. Two retries and a replan is the ceiling; after that it is a human decision.

## Verification artifacts

The rule "a milestone is not complete until an agent that did not implement it has verified it" is only as strong as the evidence left behind. So the evidence is a file:

- **`.teamwork/verifications/<milestone>.md`** — written by the verifier, **never by the Worker that implemented the milestone**. It records the milestone id, the role that verified it, the exact command or check that was run, the raw output, and the verdict (`SOUND` / `FALSIFIED` / `SURVIVED` / `REPRODUCED` / `DIVERGED` / `BLOCKED`).
- **`.teamwork/final-audit.md`** — written by the Success Auditor, judging the charter rather than the milestone list, concluding `ACHIEVED`, `PARTIALLY ACHIEVED`, or `NOT ACHIEVED`.

A milestone with no verification file counts as unverified no matter how green its tests are. That is the whole point: a campaign that skips verification used to look exactly like one that did it properly, and now it does not.

Run `/teamwork status` at any time to see which milestones still lack a verification record.

## The invariant

**A milestone is not complete until an agent that did not implement it has verified it.** The verifier differs by what is in doubt:

- **Critic** — is the implementation wrong? Defects, edge cases, error paths, silent wrongness.
- **Challenger** — is the premise wrong? Falsify the measurement, the baseline, the causal story.
- **Auditor** — does the evidence exist and say what it claims? Reproduce it independently.
- **Success Auditor** — was the thing that was asked for actually done? Guards against goal displacement.

Running the same agent that built a thing to check the thing is not verification. It is a second opinion from the same source.

## Cost warning

This is expensive and it is slow. It is worth it when the work is large, the verification genuinely independent, and a wrong answer is costly. It is not worth it for a small edit — say so and do the work directly instead.
