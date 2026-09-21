# Changelog

All notable changes to this project are documented here.

The version lives in **two** places and they must stay in sync: `plugins/teamwork/.zcode-plugin/plugin.json`
is the installed version, and `marketplace.json` is the version the client compares against to decide whether
to offer an update. Bump both, or installed users will never be told there is a new one.

## [0.3.0] — 2026-09-21

The engine release. Through 0.2.0 the rules lived in prose and were checked by hooks; this release
gives them a place to live that can be called, tested and refused. Roughly 3200 lines of library code
and 3100 lines of tests were added, and four real defects were found by those tests rather than by
reading the code.

### Added — the engine (`lib/`)

- **`state.mjs`** — versioned, typed, validated campaign state. Writes are atomic (write-then-rename),
  so a hook killed mid-write leaves the previous state intact instead of a file that parses but lies.
  `loadCampaign` returns null on bad input and never throws, because every caller is a live session.
  Unknown fields survive a round trip, so a newer plugin version's fields are not deleted by an older
  hook that happens to run afterwards.
- **`ownership.mjs`** — exclusive file ownership, split into two concepts that the earlier code had
  conflated: a *declared assignment* (a plan statement, no expiry) and a *lease* (a liveness claim,
  time-bounded and renewable).
- **`verification.mjs`** — sizing by blast radius rather than by milestone size, scoped prompts per
  role, and gate judgement. One objection fails a gate; adversarial review is not a vote. A
  self-review counts as zero voices.
- **`journal.mjs`** — append-only JSON Lines trail. A summary written by a confused process reads as
  authoritative, so nothing here rewrites history. Torn tail lines are skipped.
- **`handoff.mjs`** — staleness assessment and cross-session handoff. Reports journal silence,
  expired leases and a missing trail as separate signals, because they fail differently and the
  remedy differs.
- **`isolation.mjs`** — three tiers for Worker scratch space (git worktree, private directory, shared
  workspace). Falls back rather than failing, and records when it does; a silent downgrade would leave
  a reader believing in isolation that is not there. Every git call uses an argument vector rather
  than an interpolated shell string, so a branch name cannot become a command. Carries per-role write
  permissions, so a verifier editing the thing it judges is refused where a gate can see it.
- **`patterns.mjs`** — six execution shapes (distributed-coding, iterative-coding, document-review,
  math-proof, self-verification, research), each declaring its roles, flow, gate and constraints. A
  pattern is validated on load, so a campaign cannot start in a shape with no gate — which is exactly
  what produces confident, unverified output.
- **`engine.mjs` / `teamwork-cli.mjs`** — the control surface and its command-line exposure. On this
  platform a library without a CLI is a library nothing can call.

### Added — enforcement

- **Verification gate (`Stop`)**. A milestone the state file calls done, with no verification record on
  disk, now blocks the end of the turn and names the gaps. The rule went from a written promise to an
  enforced one. Stands down on the second pass so a model that cannot satisfy it is not trapped.
- **Audit trail (`PostToolUse`)**. Every tool call is recorded to `events.jsonl` without the model's
  cooperation. It records shape and target, never tool output.
- **Spawn budget (`PreToolUse` on Task)**. A hard ceiling on Worker dispatches, counted from the
  trail. A campaign that has lost its way keeps dispatching because each individual Worker looks
  locally justified; this is the number that makes the total visible.
- **Progress watch (`UserPromptSubmit`)**. Reports staleness and verification coverage at the user's
  next turn.

### Fixed — four defects found by the tests

- **Every planned file appeared to have lapsed.** Ownership declared by a plan was compared against
  lease expiry, so the first Worker to run would be told its own file was held by another milestone.
  The exclusive-ownership invariant — the reason the plugin exists — was defeated at the first step.
  Declared assignments no longer expire.
- **A campaign could reach execution without approval.** `setPhase` blocked backwards moves but not
  the skip past approval, which is the one decision the two-phase flow exists to protect. Spending
  phases now require `approved: true`.
- **`initProject` overwrote any existing state**, discarding a scoping interview as a side effect of
  running one command. Replacing now requires an explicit `force`.
- **A plan could give one file two owners.** `patterns.mjs` normalised paths more weakly than
  `ownership.mjs`, so `./X.TS` and `x.ts` were two files. The check passed, and the failure would have
  arrived as a runtime refusal with both Workers already dispatched.

### Changed

- Pattern is locked once a campaign is approved: its milestones were shaped for the current one.
- Plans are validated against their pattern before being accepted, not at a gate afterwards.

### Notes

- **No dead-man timer.** A process hook cannot hold a clock and this plugin has no resident process.
  `progress-watch` reports at the user's next turn, which is strictly weaker than a timer that
  interrupts. Documented as such in the code rather than presented as equivalent.
- The engine does not drive the session. Only the model can dispatch a Subagent, so rules are enforced
  when the engine is called and observed by the hooks — not continuously.

## [0.2.0] — 2026-09-18

A correctness and closed-loop release. The concept layer was already sound; this release fixes the runtime
layer, where the exclusive-ownership invariant quietly failed in exactly the scenario the plugin exists for —
parallel Workers — and closes the loop where the role protocol was a promise rather than a check.

### Fixed — correctness

- **Lease store had a read-decide-write race (TOCTOU).** Two Workers claiming different files could each read
  the old store and write it back, and the later write erased the earlier claim. Measured before the fix:
  3 of 5 rounds lost leases, worst round kept 9 of 12. The critical section now runs inside a `mkdir`-based
  mutex, with stale-lock stealing so a killed process cannot deadlock a campaign.
- **Ownership attribution could fail open, silently.** When no per-subagent signal reaches the hook, every
  Worker resolves to the same owner and the conflict check cannot fire. The hook now records which signal it
  used and warns loudly on the first claim under `distributed-coding`, instead of implying protection it does
  not have.
- **Bash could bypass the lock entirely.** `echo x > file`, `sed -i`, `tee`, `dd of=`, `rm`, `mv` and `cp`
  never reached the `Write|Edit` hook. A second `PreToolUse` hook now polices shell writes against the same
  lease store, denies writes to a file another Worker holds, and warns when an in-place edit cannot be
  attributed to a file at all.
- **macOS case-insensitive filesystems were unhandled.** `lockKey()` lowercased only on Windows, so
  `/src/Core.ts` and `/src/core.ts` produced two different keys on APFS and HFS+. Case folding now covers
  `darwin` too, filenames are normalised to NFC (macOS stores them in NFD), and symlinked paths are resolved.
- **The hook armed itself before approval.** It fired whenever `campaign.json` existed, including during the
  scoping interview. It now requires `approved: true` **and** `phase: "execution"`.
- **`SessionStart` was matched against an enumerated source list** (`startup|clear|compact`). A resumed
  session is the longest and most drift-prone case there is, so the matcher is now source-agnostic and covers
  any source the runtime adds later.

### Added — closed loop

- **Verification records are now files.** `.teamwork/verifications/<milestone>.md`, written by the verifier and
  never by the implementer, plus `.teamwork/final-audit.md` from the Success Auditor. A milestone without a
  verification file counts as unverified no matter how green its tests are.
- **`/goal` text names those files**, so the platform's per-round verification checks that the role protocol was
  executed rather than only that tests pass. This is the change that turns "the team verified it" from a claim
  into something the runtime can check.
- **Explicit escalation protocol.** Retry the role once, then replan via the Orchestrator, then pause and
  escalate to the human. Two rework rounds per milestone is the ceiling.
- **`.teamwork/plan.json`.** The Orchestrator writes milestones, dependency graph and the ownership table to
  disk, and the session hook injects them back on restart. The ownership table no longer dies with the session.
- **New `teamwork-execute` skill** fixing the Phase 2 dispatch loop: dispatch, implement, verify, route the
  verdict, record.
- **New commands:** `/teamwork-status` (read-only progress, leases and verification gaps) and `/teamwork-end`
  (archive state, disarm the hooks).

### Added — engineering

- **CI** across Node 18/20/22 on Linux, macOS and Windows.
- **`events.jsonl`** recording claims, denials and expiries, so a collision can be diagnosed after the fact.
- **Hardening:** prototype-pollution-resistant lease store, orphaned `.tmp` sweep, lease minutes clamped to
  1–10080.
- **Bilingual agent descriptions** so the roster reads correctly outside a Chinese-only marketplace.

### Changed

- **Removed `userConfig` from `plugin.json`.** It defined `integrity_mode` and `ownership_lease_minutes`, but
  ZCode only substitutes `${user_config.*}` inside `.mcp.json`, so neither the hooks nor the skills could ever
  read them. They were a switch that did nothing. Both values are set in the Phase 1 interview and read
  straight from the charter, which is documented in the skill.
- **`hooks/` internals factored into `_lib.mjs`.** The editor hook and the shell guard must share one mutex,
  one lease store and one path normalisation; divergence between them would reopen the hole they close.
- **Interview now uses the platform's interactive question panel**, batched by topic, instead of a block of
  prose questions.
- **README corrected** where it overstated what the lock guarantees, and the local-install path no longer
  points at a directory name that does not exist.

### Tests

- 105 → 129 structural checks; 26 → 91 behaviour checks. New coverage: the concurrency race (with a start
  barrier, because process startup jitter alone did not reproduce it), the activation gate, Bash guard
  behaviour, lease-length edges, prototype pollution, stale-`.tmp` sweeping, `extractFilePath` variants,
  macOS case folding under a stubbed platform, and plan injection on resume.

## [0.1.0] — 2026-09-18

Initial release. Eight roles, five patterns, three integrity modes, a lease-based exclusive file lock on
`Write|Edit`, and charter injection at session start.
