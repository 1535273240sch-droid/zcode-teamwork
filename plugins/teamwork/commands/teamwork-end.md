---
description: Close the current Teamwork campaign — archive its state outside the workspace to ~/.teamwork-archive/ and disarm the ownership hooks. Asks for confirmation first.
allowed-tools: Read, Grep, Glob, Bash
---

Close the Teamwork campaign in this workspace.

**Ask the human to confirm first.** Say clearly what will happen: the campaign ends, its runtime state is archived outside the workspace, and the ownership hooks go inert so ordinary editing is unrestricted again. Do not proceed on an assumption of consent.

If they confirm, archive outside the repository rather than pollute the workspace:

1. Read `.teamwork/campaign.json` and report the objective and the final state before touching anything.
2. Determine the archive destination:
   - Base path: `~/.teamwork-archive/<project-path-sha1>/<UTC-timestamp>/`, using format `YYYY-MM-DDTHH-MM-SSZ` (avoid colons in folder names on Windows).
3. If an existing `.teamwork/history/` directory exists inside the project, inform the user and migrate it to `~/.teamwork-archive/<project-path-sha1>/history/`.
4. **Move** all campaign runtime state into the external archive directory:
   `campaign.json`, `approval.json`, `plan.json`, `ownership.json`, `events.jsonl`, `verifications/`, `final-audit.md`, `evidence/`, `mode.json`, `ownership-audit.json`, `progress.json`, `handoff.md`.
5. Remove any leftover `.teamwork/.lock` directory and any `*.tmp` files.
6. Retain `.teamwork/knowledge/` if present, but remove all archived campaign state from `.teamwork/` so future campaigns start from a completely clean state.

Then report:

- where the archive went, and what is in it,
- the final verdict from `final-audit.md` if it exists, and if it does not, say that the campaign was closed **without** a final audit,
- that the ownership hooks are now inert, and that running `/teamwork <objective>` starts a fresh campaign.

If `.teamwork/campaign.json` does not exist, say that no campaign is running and stop.
