// Teamwork - approve subcommand logic.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {
  findTeamworkDir,
  charterHash,
  getGitInfo,
} from './utils.mjs';
import {writeAtomic, appendEvent, statePaths} from '../../hooks/_lib.mjs';

export function approveCommand(args) {
  const isCheck = args.includes('--check');
  const isManual = args.includes('--manual-fallback');

  if (!isCheck && !isManual) {
    console.error('Usage: teamwork.mjs approve [--check] [--manual-fallback]');
    process.exit(2);
  }

  const teamworkDir = findTeamworkDir(process.cwd());
  const campaignPath = join(teamworkDir, 'campaign.json');
  const approvalPath = join(teamworkDir, 'approval.json');
  const projectDir = dirname(teamworkDir);
  const paths = statePaths(projectDir);

  if (!existsSync(campaignPath)) {
    console.error('Error: campaign.json not found in ' + teamworkDir);
    process.exit(1);
  }

  let campaign;
  try {
    campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));
  } catch (err) {
    console.error('Error: failed to parse campaign.json: ' + err.message);
    process.exit(1);
  }

  const currentHash = charterHash(campaign);

  if (isCheck) {
    if (campaign.approved !== true || campaign.phase !== 'execution') {
      console.error('Error: campaign is not approved or not in execution phase');
      process.exit(1);
    }
    if (!existsSync(approvalPath)) {
      console.error('Error: approval.json not found');
      process.exit(1);
    }
    let approval;
    try {
      approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
    } catch (err) {
      console.error('Error: failed to parse approval.json: ' + err.message);
      process.exit(1);
    }
    if (approval.charter_sha256 !== currentHash) {
      console.error(
        `Error: charter has changed since approval (approved: ${approval.charter_sha256}, current: ${currentHash})`
      );
      process.exit(1);
    }
    console.log(
      `APPROVED: charter_sha256=${approval.charter_sha256} source=${approval.source} approved_at=${approval.approved_at}`
    );
    process.exit(0);
  }

  if (isManual) {
    const git = getGitInfo(projectDir);
    const baseSha = git.isGit ? git.head : null;
    const now = new Date().toISOString();

    const approval = {
      charter_sha256: currentHash,
      approved_at: now,
      base_sha: baseSha,
      source: 'manual_fallback',
    };

    writeAtomic(approvalPath, JSON.stringify(approval, null, 2) + '\n');

    campaign.approved = true;
    campaign.phase = 'execution';
    writeAtomic(campaignPath, JSON.stringify(campaign, null, 2) + '\n');

    appendEvent(paths, {
      event: 'approved',
      charter_sha256: currentHash,
      source: 'manual_fallback',
      base_sha: baseSha,
    });

    console.log(`APPROVED (manual_fallback): charter_sha256=${currentHash}`);
    process.exit(0);
  }
}
