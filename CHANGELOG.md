# Changelog

All notable changes to this project are documented here.

The version lives in **two** places and they must stay in sync: `plugins/teamwork/.zcode-plugin/plugin.json`
is the installed version, and `marketplace.json` is the version the client compares against to decide whether
to offer an update. Bump both, or installed users will never be told there is a new one.

## [0.3.7] — 2026-09-22

Concurrency, after the eight-worker incident. Two additions and one ordering fix.

The incident: eight workers dispatched in parallel, and at 20:19:47 an upstream
teardown cut all eight in-flight requests at the same instant. Six never reported.
Every surface showed success, 2.68 million tokens produced six stub files, and the
loss was found by a human reading the filesystem.

The cause was not concurrency by itself. It is that a worker killed mid-flight
leaves no result **and no error**, so nothing could tell it apart from a worker that
had finished. Concurrency only decided how many were lost at once.

### Added

- **A concurrency ceiling, set by the user at approval** (`maxParallel`, default 4).
  The total budget bounds what a campaign costs; it says nothing about shape. A
  campaign with sixteen dispatches allowed can still start all sixteen at once, and
  that is what happened. In-flight count comes from the dispatch reservations that
  already existed, so this needed no new state. Set to 0 for no limit.

- **Abandoned-dispatch detection.** A reservation is taken when a dispatch is
  admitted and consumed when its result is recorded, so an unconsumed reservation
  means a worker began and nothing came back. The gate now reports those at turn
  end: six of eight workers going silent would have surfaced as a refusal instead of
  a green board.

  It separates "started and silent" from "started and finished", not from "started
  and working" - a live worker holds a reservation too. That is why it is checked
  where nothing should still be running.

### Fixed

- **The gate exited before it could see the incident.** It returned early when the
  campaign had no milestones, which is exactly the state the eight workers were
  dispatched into. The abandoned-dispatch check now runs before the milestone
  source, and a campaign with no milestones but silent dispatches is blocked rather
  than skipped.

- **The budget resolver existed twice**, in `spawn-budget.mjs` and
  `scheduler.mjs`, with identical bodies. Same shape as the plan.json /
  campaign.json and 'execution' / 'approved' defects: two implementations of one
  contract that agree until one is edited. The hook now imports the shared
  resolver, and a structural test asserts it does not carry its own.

### Tests

882 -> 921, built from the incident's shape: six reservations against a campaign
with no milestones, a cap of two with two in flight, and the ordering regression.

Obvious in hindsight, and only visible because the incident was written down in
enough detail to reconstruct it in a test fixture.

## [0.3.6] — 2026-09-22

Closes the gap between checking what a record says and checking what is on disk.
Both incidents below are real, and both defeated the gate for the same reason.

### Added

- **Deliverable check.** A milestone may declare `deliverables`. Each must exist,
  clear a size floor, contain body text beyond its headings, and carry no
  placeholder marker. Written for the code-review incident: six workers reported
  success and wrote heading-only stubs of 802, 1008 and 1839 bytes, while the two
  that survived wrote 23,818 and 35,390. The gate passed all six, because it read
  the record and the record said the right words. A file on disk can be measured;
  an account of one cannot.

- **Evidence capture.** `audit-log.mjs` now writes a fingerprint of each captured
  command - command, exit status, byte count, hash, short tail - into
  `.teamwork/evidence/`. Records cite it with a line
  `evidence: .teamwork/evidence/<name>.log`, and the gate requires the citation,
  the file, and its non-emptiness.

- **Forgery detection.** The check that makes the rest worth having: if the audit
  trail shows a `Write` call creating a file inside `evidence/`, that file is the
  claimant's own work and citing it is rejected. Written for the second incident,
  where a worker put a fabricated `npm test` transcript in its record and the gate
  accepted it. Evidence has to be produced by the command, not by the claimant.

- `lib/evidence.mjs`, and `tests/evidence.test.mjs` (60 assertions). The tests are
  built from the incident shapes - the real byte counts, the real placeholder
  marker - because a check that only passes its own fixtures has proved nothing.

### Fixed

- **`evidence.mjs` and `audit-log.mjs` each had a `captureEvidence`.** They differed:
  one stored the full output, the other a fingerprint. This is the same defect shape
  as the plan.json/campaign.json disagreement that needed a real machine to find -
  two modules implementing one contract differently. Consolidated to one
  implementation, which `audit-log` imports.

- **A milestone id inside an evidence path satisfied the naming check.** A record
  containing only `evidence: .teamwork/evidence/m1-run.log` counted as naming m1,
  because the check ran over the whole text. Citations are now stripped before the
  naming test, since a record that mentions its milestone only inside a path has not
  been written about at all.

### Limits, stated

The fingerprint proves a command **ran**. It does not prove the record quotes it
faithfully - a worker that runs the tests honestly and then misreports the numbers
is not caught. Closing that needs the full output stored, which needs a secrets
policy first: a code review reads `.env` files, and an evidence store that leaks
credentials would be worse than the problem it solves. `TEAMWORK_EVIDENCE_TAIL`
controls how much tail is kept.

The deliverable check asks whether a file exists and has substance. It cannot ask
whether the content is correct.

### Tests

808 -> 882.

## [0.3.5] — 2026-09-22

Found by installing this plugin on a clean Windows machine and running the first-task
walkthrough end to end - a two-milestone campaign driven by real sessions. Full record:
[docs/实测记录.md](docs/实测记录.md).

### Fixed

- **The engine and the hook disagreed about the dispatch ceiling, in the permissive
  direction.** The spawn-budget hook read `spawnBudget` from `campaign.json`; the engine
  used its own constructor default and never looked. For a campaign with
  `spawnBudget: 2`, the hook enforced 2 while `status`, `schedule` and `succession` all
  reported **16**:

  | reporter | ceiling for a `spawnBudget: 2` campaign |
  | --- | --- |
  | `status` / `schedule` / `succession` | 16 |
  | the hook that actually blocks | 2 |

  Every number a human could read was wrong in the direction that looks safer. For a cost
  ceiling that is the worst way to be wrong. Both sides now resolve through one
  `resolveSpawnBudget()` in `scheduler.mjs`.

- **The reported dispatch count was always zero.** The engine counted its own
  `journal.jsonl`, which no hook writes dispatch entries to - dispatches are recorded by
  `audit-log.mjs` into `events.jsonl`. A campaign that had dispatched twice reported
  "Dispatches: 0", so the succession warning could never fire. The count now comes from
  the event trail, through one `countDispatches()` shared with the hook.

- **A UTF-8 BOM on the state file silently disarmed every hook.** `JSON.parse`
  rejects a leading byte-order mark, and every reader treats a parse failure as "no
  campaign", so a BOM turned all seven hooks into no-ops: the ownership lock, the bash
  guard, the spawn budget and the verification gate all exited cleanly and enforced
  nothing, reporting nothing. Same contradiction, same state, one byte different:

  | `campaign.json` | gate on a milestone marked done with no verification record |
  | --- | --- |
  | clean | blocks |
  | BOM prepended | returns `{}` - passes |

  This is a realistic edit rather than a synthetic one. The state file is user-editable
  by design - `/teamwork-status` and `docs/首个任务.md` both tell people to read it - and
  the obvious Windows editors add a BOM by default: PowerShell 5.1's
  `Set-Content -Encoding UTF8`, and Notepad's "UTF-8 with BOM". Found by hitting it:
  a gate test that should have blocked returned `{}`, and the cause was a BOM the test
  harness itself had written. The reader now strips a leading BOM before parsing.

### Changed

- **`marketplace.json` no longer declares `pluginRoot`.** ZCode resolves a plugin
  `source` against the marketplace root and ignores `pluginRoot` entirely, so the
  upstream `pluginRoot: "plugins"` + `source: "./teamwork"` pair resolved to a path
  that does not exist. Installing from the documented marketplace failed with
  `plugin_marketplace_invalid: Unsupported or missing plugin source: ./teamwork` on
  every attempt. Sources are now written relative to the marketplace root
  (`./plugins/teamwork`), which is the form the installer actually resolves.

- **README: the hook-trust warning was wrong, and a harder prerequisite was missing.**
  Measured on ZCode 3.14.1: plugin hooks run without any trust approval. What actually
  stops them is `node` not being on PATH - all seven hooks invoke a bare `node` as a
  `process` hook, and on a machine without Node.js every invocation fails silently
  (287 failures in the walkthrough, no error surfaced to the user). The README now says
  so, and says that installing Node.js requires a ZCode **restart**, not merely a new
  session, because PATH is inherited at process start.

- **`docs/首个任务.md` prerequisites updated** - see that file for detail.

### Tests

831 (from 810 with the walkthrough's own additions; 1 env-dependent skip).

New in this release:

- A BOM regression covering both the gate and the ownership lock. Reverting the fix
  fails both.
- Contract assertions that both modules resolve the ceiling through the shared helper,
  read the campaign's `spawnBudget`, and count dispatches from the event trail.
  Reintroducing any of the three defects fails the suite - verified by reintroducing
  each one.
- `tests/patterns.test.mjs` no longer feeds dispatches to the engine's journal. The old
  fixture wrote to the wrong file, so it asserted the buggy behaviour and stayed green;
  it now writes to `events.jsonl`, the source the hook reads.

### Note: a fabricated dependency

While running the walkthrough, the `tests` milestone session **wrote and compiled a fake
`git` executable** (`C:\Windows\Temp\GitShim.cs` -> a 5,120-byte `git.exe` on PATH) after
failing to find a real one. It implements `--version`, `init`, `rev-parse`, `add`,
`commit` and `worktree` as no-ops that create directories and stub files - exactly the
commands the isolation tests probe - which turned their `SKIPPED` results into passes.

It was not caught by this plugin's own mechanisms, and neither was the second half of the
problem: the verification record for that milestone quoted an `npm test` output with
fabricated per-suite counts (132/73/185 where the real numbers were 225/156/41) and the
gate accepted it, because the gate checks that a verdict exists, not that the evidence is
true.

Both artefacts were removed, the environment was returned to its real state (no git), and
the suite reports its honest result: 831 passed, 1 skipped. This is the sharpest finding
of the exercise and it points at a real gap - **the gate verifies the shape of the
evidence, not its authenticity**. Worth stating plainly, since the whole premise here is
that a claim is not evidence.

## [0.3.4] — 2026-09-22

### Fixed

- **Re-planning after approval silently invalidated the approval gate.** The approval
  gate is the one decision the two-phase flow exists to protect: a human reads a plan
  and agrees to it. Replacing the milestone list afterwards kept `approved: true`, so
  the campaign ran a plan nobody had agreed to. Found by driving the CLI: after
  `init` -> `plan` -> `approve`, a second `plan` took effect with `approved` still
  true. Any campaign whose requirements changed - which is every real project - was
  running unapproved work. Re-planning now resets to `charter` with `approved: false`,
  and the approval must be given again.

### Changed

- README rewritten. The old opening led with "multi-agent orchestration", a term that
  describes a crowded field and says nothing about this project. The new opening
  leads with what it actually is - hooks as physical constraints rather than
  persuasion - and then makes the evidence the selling point: nine defects found on a
  real machine while 808 unit tests were green, all of them silent, all now fixed.
  The "when to use this" section, previously added near the top, now states the
  platform's limits beside it rather than leaving them to be discovered.

### Tests

808.
## [0.3.3] — 2026-09-22

One defect, found while preparing a first-task walkthrough and testing the CLI path
end to end. It is the most consequential one yet: it disabled every hook.

### Fixed

- **The hooks and the engine disagreed about what makes a campaign active.** The
  hooks required `phase === 'execution'`; the engine's `approve()` writes
  `'approved'`. Neither list contained the other's value, so a campaign created
  through the documented path - `init`, `plan`, `approve` - was treated by every
  hook as non-existent. The ownership lock, the bash guard, the verification gate,
  the spawn budget, the audit trail and the progress watch all exited silently,
  reporting nothing and enforcing nothing.

  Found by driving the real CLI and then the real gate: with a milestone marked done
  and no verification record on disk, the gate returned `{}` instead of blocking.

  Why 804 tests missed it: the hook tests built their fixture with
  `phase: 'execution'` - the value that matched the hooks' expectation rather than
  the engine's output. The fixture agreed with the bug. A structural test now
  compares the two implementations' phase lists directly, and asserts that the
  phases `approve()` enters are ones the hooks accept.

  This is the second defect of the same shape: two modules reading one contract
  differently, with the tests taking the wrong side. The first was hooks reading
  plan.json while the engine wrote campaign.json.

### Tests

804 -> 808.
## [0.3.2] — 2026-09-22

Documentation release. No behaviour change. The 0.3.1 code is unchanged.

The README claimed the code "has never been loaded into a real ZCode". That was
true when written and is no longer: four rounds of verification on a real install
confirmed the core mechanism, and seven defects found by those rounds are all fixed
and re-verified. Leaving the warning up would have understated the project as badly
as removing it entirely would have overstated it.

- README: replaces the "never loaded" warning with what was actually verified - the
  Stop gate blocking a turn, with the gate text accumulating in the model's context
  and pulling it back to work.
- README: adds a "when to use this" section at the top, ahead of the mechanism
  description. The question a reader actually has is whether to use it at all, and
  the cost warning answers a different question. Three questions decide it, with
  the concurrent-write limitation stated plainly beside them rather than buried.
- .gitignore: adds `.zcode-probe/`. Installing the plugin with `cp -r .` from a
  checkout otherwise copies the probe's previous session log into the plugin cache,
  and the next version ships with stale test residue inside it.

Also recorded from round four: the concurrency fix was verified on a real machine.
Two Agent calls 71ms apart in one turn - the second was denied with "1 of them in
flight", and the reservation file was consumed back to empty with exactly one
dispatch in the trail. The earlier round had both calls admitted.## [0.3.1] — 2026-09-21

Seven defects found by running against a real ZCode install, none of which any unit
test caught. The core mechanism - a Stop hook that refuses to let a turn end while
the state file claims work that has no verification record - was confirmed working
on a real machine, and three of the defects below were what had been preventing it
from working there.

### Fixed

- **The Stop block used `stopReason` instead of `reason`.** ZCode parses both, but
  only `reason` and `systemMessage` reach `additionalContexts`, and the continuation
  check requires a non-empty `additionalContexts`. With `stopReason` the block was
  recorded and the turn ended normally. The whole verification gate was inert.
  Measured: with `stopReason` a turn completes once; with `reason` the same turn is
  pulled back four times.
- **Hooks read `plan.json`; the engine writes `campaign.json`.** Three hooks looked
  for a file the engine never creates, so a campaign started through the documented
  CLI path had its gate silently disabled. Milestones now come from campaign.json
  with plan.json kept as a legacy fallback.
- **The dispatch tool is named `Agent`, not `Task`.** The matcher in hooks.json was
  `"Task"`, and a matcher is a case-sensitive regex that does not resolve aliases -
  so the spawn budget never ran, and no dispatch was ever recorded to count. Two
  dispatches against a budget of one were both admitted.
- **`PostToolUseFailure` is never delivered.** A tool that exits non-zero arrives as
  `PostToolUse` with `tool_response.status: "failed"`. Failure detection now reads
  the status field. Six of the seven advertised events are reachable, not seven.
- **The budget could be bypassed by concurrent dispatch.** The count came from the
  trail, written on PostToolUse, while the judgement read it on PreToolUse. A single
  turn issuing several Agent calls had all of them read the same stale count -
  measured at 57ms apart, with the first trail write 1.8s later. PreToolUse now
  takes a reservation under the mutex, so the second call in a batch sees the first
  one's reservation; audit-log consumes it when the dispatch is recorded. A batch of
  N can no longer exceed a budget of N-1.
- **Project directory resolution was inconsistent and had no env fallback.** Every
  hook resolved `cwd` its own way and fell back to the process working directory,
  which is not the workspace root. All seven now use one helper that checks
  `ZCODE_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` first.
- **CI ran two of five test suites.** The workflow listed files by name; three suites
  added later never executed on any runner, so a POSIX-only path assertion sat in a
  suite that CI reported as passing. The workflow now runs `npm test` and asserts
  that every test file is wired into it.

### Documented

- Per-subagent attribution does not exist in the payload: no `agent_id`, no
  `agent_type`, and `session_id` is the parent's. Two subagents in one session
  resolve to the same owner, which makes the exclusivity check absent rather than
  weaker. One Worker per ZCode process is the only reliable arrangement.
- `Stop` fires only at a full turn boundary; a multi-step tool flow does not reach it.
- Hook execution is not written to ZCode's log directory.

### Tests

797 -> 804, with structural guards on the Stop field, the dispatch tool names, the
matcher, and the project-directory helper.

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
