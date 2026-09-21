---
description: Show the current Teamwork campaign state — milestone progress, active file leases, verification gaps, and recent hook events. Read-only.
allowed-tools: Read, Grep, Glob, Bash
---

Report the current state of the Teamwork campaign in this workspace. **This is a read-only report — change nothing.**

Read whatever exists, and say plainly when something is missing rather than guessing:

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
3. **Verification gaps** — run `node <path-to-cli>/scripts/teamwork.mjs gate --json` to get the authoritative verification gaps (G1-G12) and report them directly, rather than computing them by hand. If there are none and gate passes, say so explicitly.
4. **Recent events** — anything from `events.jsonl` worth acting on, especially `denied` entries, which mean two Workers actually collided, and repeated `expired` entries on the same file, which mean a Worker keeps dying.

If `.teamwork/campaign.json` does not exist, say that no campaign is running in this workspace and stop — do not create anything.

If `phase` is not `execution` or `approved` is not `true`, say so and note that the ownership hooks are currently **inert**, so parallel Workers are unprotected.
