---
description: Show the current Teamwork campaign state — milestone progress, active file leases, verification gaps, and recent hook events. Read-only.
allowed-tools: Read, Grep, Glob, Bash
---

Report the current state of the Teamwork campaign in this workspace. **This is a read-only report — change nothing.**

First, run the visual dashboard renderer:
```bash
node "${ZCODE_PLUGIN_ROOT}/lib/teamwork-cli.mjs" dashboard 2>/dev/null || node "${HOME}/.zcode/cli/plugins/cache/zcode-plugins-official/teamwork/0.4.0/lib/teamwork-cli.mjs" dashboard 2>/dev/null || node "${USERPROFILE}/.zcode/cli/plugins/cache/zcode-plugins-official/teamwork/0.4.0/lib/teamwork-cli.mjs" dashboard
```
Output the rendered visual markdown report (including Mermaid diagram and progress bar) directly into the conversation.

If you prefer inspecting raw files, read whatever exists:

- `.teamwork/campaign.json` — the charter
- `.teamwork/plan.json` — milestones, ownership table
- `.teamwork/ownership.json` — active file leases
- `.teamwork/verifications/*.md` — one per verified milestone
- `.teamwork/final-audit.md` — the final verdict
- the last 20 lines of `.teamwork/events.jsonl` — recent claims, denials and expiries

Then print a compact report in this shape:

```
Campaign   <objective>
Mode       <integrity_mode> / <pattern> / phase <phase> / approved <yes|no>
Progress   <done> of <total> milestones verified
Hooks      <armed | inert — reason>
Leases     <n> files held
```

Followed by:

1. **Milestones** — one line each: id, status, deliverable, files, who verifies it, and whether a verification record exists. Mark any milestone that is `done` without a verification file as **UNVERIFIED** in capitals; that is the gap this command exists to surface.
2. **Ownership** — the ownership table, and which of those files currently hold a lease, with the holder and how long ago it was claimed.
3. **Verification gaps** — the list of milestones with no `.teamwork/verifications/<id>.md`. If there are none, say so explicitly.
4. **Recent events** — anything from `events.jsonl` worth acting on, especially `denied` entries, which mean two Workers actually collided, and repeated `expired` entries on the same file, which mean a Worker keeps dying.

If `.teamwork/campaign.json` does not exist, say that no campaign is running in this workspace and stop — do not create anything.

If `phase` is not `execution` or `approved` is not `true`, say so and note that the ownership hooks are currently **inert**, so parallel Workers are unprotected.
