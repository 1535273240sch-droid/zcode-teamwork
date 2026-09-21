# Changelog

All notable changes to this project are documented here.

The version lives in **two** places and they must stay in sync: `plugins/teamwork/.zcode-plugin/plugin.json`
is the installed version, and `marketplace.json` is the version the client compares against to decide whether
to offer an update. Bump both, or installed users will never be told there is a new one.

## [0.3.0] — 2026-09-21

A hardening and mechanical enforcement release. Moves Teamwork from "convention-based" promises to "mechanism-based" enforcement across evidence, approval, attribution, completion gating, and workspace isolation.

### Breaking Changes
- **Approval Gate & Charter Hash Invalidation (T3):** Setting `approved: true` by Agent editing `campaign.json` is no longer sufficient to arm ownership hooks. Approval must be triggered by the user via `/teamwork-approve` (or sentinel token) through the `UserPromptSubmit` hook, writing `.teamwork/approval.json` with the canonical `charter_sha256`. Any modification to the charter after approval invalidates execution and disarms hooks until re-approved.

### Added — Enforcement & Verification
- **Tool-produced Evidence & SHA-256 Hash Chaining (T2):** Proof commands must be executed via `teamwork.mjs run -- <cmd>` generating structured, hash-chained entries in `.teamwork/evidence/<UTC-date>.jsonl`. Verifiers record verdicts via `teamwork.mjs verify` and `teamwork.mjs final-audit` referencing verified evidence IDs.
- **Protected Paths (T2):** Direct edits and shell writes/redirects to `.teamwork/evidence/**` and `.teamwork/approval.json` are denied at hook level. Workers are forbidden from writing verification records.
- **Deterministic Ownership Audit & Degradation (T4):** Weak attribution under `distributed-coding` writes `.teamwork/mode.json` (`max_parallel: 1`) to degrade to serial execution. `teamwork.mjs audit-ownership` checks Git diff against `base_sha` for unauthorized file edits (R1-R3).
- **Deterministic Completion Gate (T5):** `teamwork.mjs gate [--json]` unifies completion evaluation into 12 checkable invariants (G1-G12).
- **Progress Heartbeat & Milestone Handoff (T7):** `teamwork.mjs progress <beat|set>` tracks heartbeat, start/end snapshots, and stall detection; `.teamwork/handoff.md` stores handoff notes.
- **External Archive Isolation & Defense (T8):** Campaigns archive to `~/.teamwork-archive/` outside the project. In `benchmark` mode, Bash commands attempting to read archives are denied.
- **Cross-Round Knowledge Base (T9):** `teamwork.mjs knowledge <add|list>` maintains `pitfalls.md`, `failed-approaches.md`, and `proved.md`, automatically injected into new sessions.
- **Risk-Adaptive Verification (T10):** Milestones support `risk: low|medium|high`, requiring corresponding verifier role coverage in Gate G10.
- **Path Security Suite (T11):** Hardened defense against `..` traversal, symlink escape, Windows 8.3 short paths, and case/prefix path variants.
- **Seed Defect Eval Fixtures (T12):** `tests/evals/` adds `eval-leak`, `eval-premise`, and `eval-diverge` benchmarks with mock/live runner.

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
