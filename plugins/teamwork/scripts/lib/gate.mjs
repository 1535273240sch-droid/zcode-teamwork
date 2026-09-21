// Teamwork - gate completion evaluation.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {
  findTeamworkDir,
  charterHash,
  getGitInfo,
} from './utils.mjs';
import {verifyEvidenceChain, findEvidenceById} from './evidence.mjs';
import {PASSING_VERDICTS} from './verify.mjs';
import {lockKey, statePaths} from '../../hooks/_lib.mjs';

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const out = {};
  for (const rawLine of text.slice(3, end).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      out[key] = items;
    } else {
      if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' || first === "'") && last === first) {
          value = value.slice(1, -1);
        }
      }
      out[key] = value;
    }
  }
  return out;
}

export function gateCommand(args) {
  const jsonOutput = args.includes('--json');
  const teamworkDir = findTeamworkDir(process.cwd());
  const projectDir = dirname(teamworkDir);
  const paths = statePaths(projectDir);

  const gaps = [];
  const warnings = [];

  // G1: campaign.json exists; approval.json exists and charter_sha256 matches
  let campaign = null;
  if (!existsSync(paths.campaign)) {
    gaps.push({id: 'G1', message: 'campaign.json does not exist'});
  } else {
    try {
      campaign = JSON.parse(readFileSync(paths.campaign, 'utf8'));
    } catch (err) {
      gaps.push({id: 'G1', message: `campaign.json is malformed: ${err.message}`});
    }
  }

  let approval = null;
  if (!existsSync(paths.approval)) {
    gaps.push({id: 'G1', message: 'approval.json does not exist'});
  } else {
    try {
      approval = JSON.parse(readFileSync(paths.approval, 'utf8'));
    } catch (err) {
      gaps.push({id: 'G1', message: `approval.json is malformed: ${err.message}`});
    }
  }

  const integrityMode = campaign?.integrity_mode || 'development';

  if (campaign && approval) {
    const currentHash = charterHash(campaign);
    if (approval.charter_sha256 !== currentHash) {
      gaps.push({
        id: 'G1',
        message: `charter has been modified since approval (approved: ${approval.charter_sha256}, current: ${currentHash})`,
      });
    }
    if (approval.source === 'manual_fallback') {
      if (integrityMode === 'development') {
        warnings.push({
          id: 'G1',
          message: 'approval was granted via manual fallback (unverified by user prompt hook)',
        });
      } else {
        gaps.push({
          id: 'G1',
          message: `manual fallback approval is disallowed in ${integrityMode} mode`,
        });
      }
    }
  }

  // G2: plan.json exists, sentinel: "CLEARED", each milestone status is "done"
  let plan = null;
  if (!existsSync(paths.plan)) {
    gaps.push({id: 'G2', message: 'plan.json does not exist'});
  } else {
    try {
      plan = JSON.parse(readFileSync(paths.plan, 'utf8'));
    } catch (err) {
      gaps.push({id: 'G2', message: `plan.json is malformed: ${err.message}`});
    }
  }

  if (plan) {
    if (plan.sentinel !== 'CLEARED') {
      gaps.push({
        id: 'G2',
        message: `plan sentinel verdict is not CLEARED (got: ${plan.sentinel})`,
      });
    }
    const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
    if (milestones.length === 0) {
      gaps.push({id: 'G2', message: 'plan.json has no milestones'});
    }
    for (const m of milestones) {
      if (m.status !== 'done') {
        gaps.push({
          id: 'G2',
          message: `milestone ${m.id} is not done (status: ${m.status})`,
        });
      }
    }
  }

  // G5: Evidence hash chain is intact across all evidence files
  const evidenceDir = paths.evidenceDir;
  const chainResult = verifyEvidenceChain(evidenceDir);
  if (!chainResult.valid) {
    gaps.push({
      id: 'G5',
      message: `evidence hash chain broken: ${JSON.stringify(chainResult.errors)}`,
    });
  }

  // G3, G4, G6, G7, G10: Milestones verification records
  const verificationsDir = join(paths.stateDir, 'verifications');
  if (plan && Array.isArray(plan.milestones)) {
    for (const m of plan.milestones) {
      const roles = Array.isArray(m.verified_by)
        ? m.verified_by
        : typeof m.verified_by === 'string'
          ? [m.verified_by]
          : [];

      if (roles.length === 0) {
        gaps.push({
          id: 'G3',
          message: `milestone ${m.id} has no verified_by roles assigned in plan.json`,
        });
      }

      // G10: Risk check if present
      if (m.risk) {
        const r = String(m.risk).toLowerCase();
        if (r === 'low') {
          if (!roles.includes('critic')) {
            gaps.push({
              id: 'G10',
              message: `milestone ${m.id} risk is low but verified_by does not include critic`,
            });
          }
        } else if (r === 'medium') {
          if (!roles.includes('critic') || !roles.includes('auditor')) {
            gaps.push({
              id: 'G10',
              message: `milestone ${m.id} risk is medium but verified_by does not include critic and auditor`,
            });
          }
        } else if (r === 'high') {
          if (
            !roles.includes('critic') ||
            !roles.includes('auditor') ||
            !roles.includes('challenger')
          ) {
            gaps.push({
              id: 'G10',
              message: `milestone ${m.id} risk is high but verified_by does not include critic, auditor, and challenger`,
            });
          }
        }
      }

      for (const role of roles) {
        const vFileName = `${m.id}--${role}.md`;
        const vFilePath = join(verificationsDir, vFileName);
        if (!existsSync(vFilePath)) {
          gaps.push({
            id: 'G3',
            message: `missing verification record for milestone ${m.id} role ${role} (.teamwork/verifications/${vFileName})`,
          });
          continue;
        }

        let content = '';
        try {
          content = readFileSync(vFilePath, 'utf8');
        } catch (err) {
          gaps.push({
            id: 'G4',
            message: `cannot read verification file ${vFileName}: ${err.message}`,
          });
          continue;
        }

        const fm = parseFrontmatter(content);
        if (!fm || !fm.verdict) {
          gaps.push({
            id: 'G4',
            message: `verification file ${vFileName} has invalid frontmatter or missing verdict`,
          });
          continue;
        }

        if (!PASSING_VERDICTS.has(fm.verdict)) {
          gaps.push({
            id: 'G4',
            message: `verification file ${vFileName} verdict is not passing: ${fm.verdict}`,
          });
        }

        const evidenceIds = Array.isArray(fm.evidence)
          ? fm.evidence
          : typeof fm.evidence === 'string' && fm.evidence.length > 0
            ? [fm.evidence]
            : [];

        if (evidenceIds.length === 0 && fm.verdict !== 'BLOCKED' && fm.verdict !== 'UNFALSIFIABLE') {
          gaps.push({
            id: 'G5',
            message: `verification file ${vFileName} contains no evidence IDs`,
          });
        }

        // Check each evidence ID exists and check G6 (mtime)
        const mFiles = Array.isArray(m.files) ? m.files : [];
        let maxFileMtime = 0;
        for (const f of mFiles) {
          try {
            const fPath = join(projectDir, f);
            if (existsSync(fPath)) {
              const mt = statSync(fPath).mtimeMs;
              if (mt > maxFileMtime) maxFileMtime = mt;
            }
          } catch {}
        }

        for (const evId of evidenceIds) {
          const evEntry = findEvidenceById(evidenceDir, evId);
          if (!evEntry) {
            gaps.push({
              id: 'G5',
              message: `verification file ${vFileName} references non-existent evidence ID ${evId}`,
            });
          } else {
            // G6: evidence timestamp >= maxFileMtime
            const evTs = evEntry.ts || evEntry.timestamp;
            if (maxFileMtime > 0 && evTs) {
              const evTime = new Date(evTs).getTime();
              // Allow small 1-second tolerance for file-system clock skew
              if (evTime < maxFileMtime - 1000) {
                gaps.push({
                  id: 'G6',
                  message: `evidence ${evId} in ${vFileName} is stale (evidence at ${evTs}, file modified later)`,
                });
              }
            }
          }
        }
      }
    }
  }

  // G8: final-audit.md exists, verdict is ACHIEVED, contains at least 1 valid evidence id
  const finalAuditPath = join(paths.stateDir, 'final-audit.md');
  if (!existsSync(finalAuditPath)) {
    gaps.push({id: 'G8', message: 'final-audit.md does not exist'});
  } else {
    try {
      const content = readFileSync(finalAuditPath, 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm || !fm.verdict) {
        gaps.push({id: 'G8', message: 'final-audit.md has invalid frontmatter'});
      } else if (fm.verdict !== 'ACHIEVED') {
        gaps.push({
          id: 'G8',
          message: `final-audit.md verdict is not ACHIEVED (got: ${fm.verdict})`,
        });
      } else {
        const evidenceIds = Array.isArray(fm.evidence)
          ? fm.evidence
          : typeof fm.evidence === 'string' && fm.evidence.length > 0
            ? [fm.evidence]
            : [];
        if (evidenceIds.length === 0) {
          gaps.push({
            id: 'G8',
            message: 'final-audit.md has no evidence IDs',
          });
        } else {
          for (const evId of evidenceIds) {
            const evEntry = findEvidenceById(evidenceDir, evId);
            if (!evEntry) {
              gaps.push({
                id: 'G8',
                message: `final-audit.md references non-existent evidence ID ${evId}`,
              });
            }
          }
        }
      }
    } catch (err) {
      gaps.push({id: 'G8', message: `cannot read final-audit.md: ${err.message}`});
    }
  }

  // G9: ownership-audit.json exists and result is PASS
  if (!existsSync(paths.ownershipAudit)) {
    gaps.push({
      id: 'G9',
      message: 'ownership-audit.json does not exist. Run teamwork.mjs audit-ownership first.',
    });
  } else {
    try {
      const ownReport = JSON.parse(readFileSync(paths.ownershipAudit, 'utf8'));
      if (ownReport.result === 'SKIPPED_NO_GIT') {
        if (integrityMode === 'development') {
          warnings.push({
            id: 'G9',
            message: 'ownership audit skipped because workspace is not a git repository',
          });
        } else {
          gaps.push({
            id: 'G9',
            message: `git repository is required in ${integrityMode} mode, ownership audit cannot be skipped`,
          });
        }
      } else if (ownReport.result !== 'PASS') {
        gaps.push({
          id: 'G9',
          message: `ownership audit failed with ${ownReport.violations?.length || 0} violations`,
        });
      }
    } catch (err) {
      gaps.push({
        id: 'G9',
        message: `ownership-audit.json is malformed: ${err.message}`,
      });
    }
  }

  // G11: progress.json stale check (T7)
  const progressPath = join(paths.stateDir, 'progress.json');
  if (existsSync(progressPath)) {
    try {
      const prog = JSON.parse(readFileSync(progressPath, 'utf8'));
      const stallMinutes = Number(campaign?.stall_minutes) || 30;
      const stallMs = Math.max(5, Math.min(1440, stallMinutes)) * 60 * 1000;
      const now = Date.now();
      for (const [mId, mData] of Object.entries(prog.milestones || {})) {
        if (mData.status === 'in-progress' && mData.last_heartbeat) {
          const hb = new Date(mData.last_heartbeat).getTime();
          if (now - hb > stallMs) {
            gaps.push({
              id: 'G11',
              message: `milestone ${mId} is stale (no heartbeat for ${Math.round((now - hb) / 60000)} minutes, threshold: ${stallMinutes}m)`,
            });
          }
        }
      }
    } catch {}
  }

  const passed = gaps.length === 0;

  if (jsonOutput) {
    const out = {
      passed,
      gaps,
      warnings,
      checked_at: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    if (warnings.length > 0) {
      console.log('TEAMWORK-GATE WARNINGS:');
      for (const w of warnings) {
        console.log(`  - [${w.id}] ${w.message}`);
      }
    }
    if (gaps.length > 0) {
      console.log('TEAMWORK-GATE GAPS:');
      for (const g of gaps) {
        console.log(`  - [${g.id}] ${g.message}`);
      }
      console.log(`TEAMWORK-GATE: FAIL (${gaps.length} gaps)`);
    } else {
      console.log('TEAMWORK-GATE: PASS');
    }
  }

  process.exit(passed ? 0 : 1);
}
