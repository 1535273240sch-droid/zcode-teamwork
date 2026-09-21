---
description: Approve the Teamwork campaign charter and arm the execution phase.
skills: teamwork
---

[[TEAMWORK-APPROVE-v1]]

The human user has approved the campaign charter.

Do NOT modify `campaign.json` yourself. Run `teamwork.mjs approve --check` to verify approval status. Once confirmed:
1. Run Sentinel to review the charter (CLEARED or BLOCKED).
2. If cleared, run Orchestrator to decompose milestones and write `.teamwork/plan.json`.
3. Set the goal using `/goal` and proceed with Phase 2 execution.
