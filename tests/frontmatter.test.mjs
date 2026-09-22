// Structural validation for the Teamwork ZCode plugin.
//
// ZCode silently ignores unrecognised frontmatter keys, so a typo in an agent file
// fails quietly instead of erroring. This asserts every key is one ZCode actually
// reads, that required keys are present, that every file the manifests reference
// really exists, and that protocol files stay pure ASCII.
//
//   node tests/frontmatter.test.mjs

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(REPO, 'plugins', 'teamwork');

// Keys ZCode documents for each component type.
const AGENT_KEYS = new Set([
	'name',
	'description',
	'model',
	'thoughtLevel',
	'color',
	'tools',
	'disallowedTools',
	'maxTurns',
	'injectAgentsMd',
	'mcpServers',
]);
const SKILL_KEYS = new Set(['name', 'description', 'when_to_use', 'license', 'metadata', 'allowed-tools']);
const COMMAND_KEYS = new Set(['description', 'argument-hint', 'allowed-tools', 'model', 'skills', 'disable-noninteractive']);

// ZCode tool names. A Command Code name (read_file, shell_command, ...) would
// grant nothing at all here, silently.
const ZCODE_TOOLS = new Set([
	'Read',
	'Grep',
	'Glob',
	'Bash',
	'Edit',
	'Write',
	'WebFetch',
	'WebSearch',
	'TodoWrite',
	'Agent',
	'Task',
]);

// The roster is discovered from the directory rather than listed here. A hardcoded
// list would silently skip any agent file added later, and the checks below are the
// ones that keep a new role from inheriting dispatch capability.
const AGENTS = readdirSync(join(PLUGIN, 'agents'))
	.filter((f) => f.endsWith('.md'))
	.map((f) => f.slice(0, -3))
	.sort();

// The roles that judge work must not be able to change it.
const VERIFIER_ROLES = ['critic', 'challenger', 'auditor', 'success-auditor'];

// The plugin's core invariant is enforced by these two hooks sharing one store.
const REQUIRED_PRETOOLUSE_MATCHERS = ['Write|Edit', 'Bash'];

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
	}
}

// Minimal frontmatter reader: flat `key: value` pairs plus one nested block
// (used by the skill's `metadata:`). Values keep everything after the first colon,
// which is what YAML does too, so a colon inside a description is safe. Matching
// surrounding quotes are stripped, because a value written as "a: b" would
// otherwise compare unequal to the same value written unquoted.
function frontmatter(text) {
	if (!text.startsWith('---')) return undefined;
	const end = text.indexOf('\n---', 3);
	if (end === -1) return undefined;
	const out = {};
	let nested = null;
	for (const rawLine of text.slice(3, end).split('\n')) {
		if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
		const indented = /^\s/.test(rawLine);
		const line = rawLine.trim();
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' || first === "'") && last === first) value = value.slice(1, -1);
		}
		if (indented && nested) {
			out[nested][key] = value;
			continue;
		}
		if (value === '') {
			nested = key;
			out[key] = {};
			continue;
		}
		nested = null;
		out[key] = value;
	}
	return out;
}

function validate(label, path, allowed, required) {
	console.log(`\n${label}`);
	const text = readFileSync(path, 'utf8');
	const fm = frontmatter(text);
	if (!fm) {
		check(`${label}: has frontmatter`, false, 'no --- block');
		return {};
	}
	check(`${label}: has frontmatter`, true);
	for (const key of required) {
		check(`${label}: required "${key}" present`, typeof fm[key] === 'string' && fm[key].length > 0);
	}
	const unknown = Object.keys(fm).filter((k) => !allowed.has(k));
	check(`${label}: no unknown keys`, unknown.length === 0, unknown.join(', '));

	for (const field of ['tools', 'disallowedTools']) {
		if (!fm[field]) continue;
		const bad = fm[field]
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
			.filter((t) => !ZCODE_TOOLS.has(t));
		check(`${label}: ${field} are ZCode tool names`, bad.length === 0, bad.join(', '));
	}

	// ZCode ignores thoughtLevel unless the agent also pins a model.
	if (fm.thoughtLevel && !fm.model) {
		check(`${label}: thoughtLevel not set without model`, false, 'would be silently ignored');
	} else {
		check(`${label}: model/thoughtLevel pairing valid`, true);
	}

	if (fm.maxTurns !== undefined) {
		check(`${label}: maxTurns is a positive integer`, /^\d+$/.test(fm.maxTurns) && Number(fm.maxTurns) > 0, fm.maxTurns);
	}
	return fm;
}

console.log('=== frontmatter reader ===');
// The reader itself is asserted, because a reader that mis-parses makes every
// check below it meaningless.
{
	const fm = frontmatter('---\nname: x\ndescription: "quoted: with a colon"\nmetadata:\n  author: a: b\n---\nbody');
	check('reader: colon inside a value is preserved', fm.description === 'quoted: with a colon', fm.description);
	check('reader: quotes are stripped for comparison', !fm.description.startsWith('"'), fm.description);
	check('reader: nested block parsed', fm.metadata?.author === 'a: b', JSON.stringify(fm.metadata));
	check('reader: missing frontmatter returns undefined', frontmatter('no frontmatter here') === undefined);
	check('reader: unclosed frontmatter returns undefined', frontmatter('---\nname: x\n') === undefined);
}

console.log('\n=== agents ===');
const seen = new Set();
for (const name of AGENTS) {
	const fm = validate(`agents/${name}.md`, join(PLUGIN, 'agents', `${name}.md`), AGENT_KEYS, ['name', 'description']);
	check(`agents/${name}.md: name matches filename`, fm.name === name, `frontmatter="${fm.name}" file="${name}"`);
	check(`agents/${name}.md: name is unique`, !seen.has(fm.name));
	seen.add(fm.name);
	// ZCode's built-in roles cannot have their names reused.
	check(`agents/${name}.md: not a reserved ZCode name`, !['general-purpose', 'explore'].includes(fm.name));
	// The roster ships to a public marketplace, so every description carries an
	// English half alongside the Chinese one.
	check(
		`agents/${name}.md: description has an English half`,
		/[A-Za-z]{4,}/.test(fm.description ?? ''),
		String(fm.description).slice(0, 80),
	);

	// Every role must declare an explicit tool list. ZCode only applies a profile's
	// tool restrictions when `tools` is present; an agent that omits it inherits the
	// parent's full set, which would silently hand it dispatch capability and break
	// both the spawn budget and exclusive file ownership.
	check(
		`agents/${name}.md: declares an explicit tool list`,
		typeof fm.tools === 'string' && fm.tools.trim().length > 0,
		`tools=${JSON.stringify(fm.tools)}`,
	);

	// Task starts a Subagent. A nested dispatcher is invisible to the hooks that
	// enforce the campaign's budget and ownership: a parent hook cannot see a
	// grandchild's tool calls, so the ceiling and the file table would both be
	// defeated without any error being raised.
	const declaredTools = String(fm.tools ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	check(
		`agents/${name}.md: cannot dispatch a nested subagent`,
		!declaredTools.includes('Task'),
		`tools=${declaredTools.join(', ')}`,
	);

	// The verifier roles must not be able to edit: a verifier that changes the code
	// makes the evidence describe a revision that no longer exists. Enforced in
	// isolation.mjs at runtime, and asserted here so the frontmatter cannot drift.
	if (VERIFIER_ROLES.includes(name)) {
		const disallowed = String(fm.disallowedTools ?? '')
			.split(',')
			.map((t) => t.trim());
		check(
			`agents/${name}.md: a verifier cannot edit`,
			disallowed.includes('Edit') && disallowed.includes('Write'),
			`disallowedTools=${JSON.stringify(fm.disallowedTools)}`,
		);
	}
}

console.log('\n=== skills ===');
{
	const skillsDir = join(PLUGIN, 'skills');
	const names = readdirSync(skillsDir, {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	check('skills/: both phase skills present', names.join(',') === 'teamwork,teamwork-execute', names.join(','));
	for (const name of names) {
		const fm = validate(`skills/${name}/SKILL.md`, join(skillsDir, name, 'SKILL.md'), SKILL_KEYS, ['name', 'description']);
		check(`skills/${name}/SKILL.md: name matches directory`, fm.name === name, `frontmatter="${fm.name}" dir="${name}"`);
		check(`skills/${name}/SKILL.md: metadata has a version`, typeof fm.metadata?.version === 'string', JSON.stringify(fm.metadata));
	}
}

console.log('\n=== commands ===');
{
	const commandsDir = join(PLUGIN, 'commands');
	const files = readdirSync(commandsDir).filter((f) => f.endsWith('.md')).sort();
	check('commands/: three commands present', files.join(',') === 'teamwork-end.md,teamwork-status.md,teamwork.md', files.join(','));
	for (const file of files) {
		const label = `commands/${file}`;
		const fm = validate(label, join(commandsDir, file), COMMAND_KEYS, ['description']);
		const stem = file.replace(/\.md$/, '');
		// ZCode derives the command name from the filename and requires it to match
		// this pattern; a stray capital or space would silently not register.
		check(`${label}: filename is a valid command name`, /^[a-z0-9][a-z0-9_:-]{0,63}$/.test(stem), stem);
	}
	const entry = readFileSync(join(commandsDir, 'teamwork.md'), 'utf8');
	check('commands/teamwork.md: body uses $ARGUMENTS', entry.includes('$ARGUMENTS'));
	check('commands/teamwork.md: mounts the teamwork skill', frontmatter(entry)?.skills === 'teamwork', frontmatter(entry)?.skills);
}

console.log('\n=== manifest ===');
const plugin = JSON.parse(readFileSync(join(PLUGIN, '.zcode-plugin', 'plugin.json'), 'utf8'));
{
	check('plugin.json: name is valid', /^[a-z0-9][a-z0-9._-]{0,127}$/.test(plugin.name), plugin.name);
	// hooks/hooks.json is the standard location and is auto-discovered; declaring it
	// again makes ZCode emit a duplicate-component diagnostic.
	check('plugin.json: does not re-declare the standard hooks path', plugin.hooks === undefined);
	// ZCode only substitutes ${user_config.*} inside .mcp.json. A userConfig entry
	// here would render as a switch in the plugin settings page that no code path
	// ever reads, so the plugin must not ship one.
	check('plugin.json: ships no userConfig (ZCode cannot deliver it to hooks or skills)', plugin.userConfig === undefined);

	for (const field of ['commands', 'skills', 'agents']) {
		const rel = plugin[field];
		check(`plugin.json: ${field} points at an existing directory`, typeof rel === 'string' && existsSync(join(PLUGIN, rel)), String(rel));
	}

	const market = JSON.parse(readFileSync(join(REPO, 'marketplace.json'), 'utf8'));
	check('marketplace.json: name is valid', /^[a-z0-9][a-z0-9._-]{0,127}$/.test(market.name), market.name);
	const entryPlugin = (market.plugins ?? []).find((p) => p.name === plugin.name);
	check('marketplace.json: lists the teamwork plugin', Boolean(entryPlugin));
	check('marketplace.json: entry has a source', typeof entryPlugin?.source === 'string' && entryPlugin.source.length > 0);
	// ZCode resolves a plugin source against the MARKETPLACE ROOT and ignores
	// `pluginRoot`. The previous assertion joined REPO + pluginRoot + source, so it
	// built a path that always exists and stayed green while the real installer
	// rejected the manifest with "Unsupported or missing plugin source". Assert the
	// resolution the installer actually performs, and forbid the field that let the
	// two disagree.
	check('marketplace.json: does not declare pluginRoot (ZCode ignores it)', market.pluginRoot === undefined, String(market.pluginRoot));
	const sourceRel = String(entryPlugin?.source ?? '').replace(/^\.\//, '');
	check('marketplace.json: source is relative to the marketplace root', sourceRel.length > 0 && !sourceRel.startsWith('/') && !/^[a-zA-Z]:/.test(sourceRel), String(entryPlugin?.source));
	check('marketplace.json: source resolves as ZCode resolves it (against the marketplace root)', existsSync(join(REPO, sourceRel)), join(REPO, sourceRel));
	// The marketplace `version` drives update checks; it must be bumped when the
	// plugin changes or installs will not be offered an update.
	check('marketplace.json: entry version matches plugin.json', entryPlugin?.version === plugin.version, `${entryPlugin?.version} vs ${plugin.version}`);

	const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
	check('package.json: version matches plugin.json', pkg.version === plugin.version, `${pkg.version} vs ${plugin.version}`);

	const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
	check('CHANGELOG.md: documents the current version', changelog.includes(`## [${plugin.version}]`), plugin.version);
}

console.log('\n=== hooks ===');
const hooksConfig = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
{
	const pre = hooksConfig.hooks?.PreToolUse ?? [];
	const matchers = pre.map((group) => group.matcher);
	for (const required of REQUIRED_PRETOOLUSE_MATCHERS) {
		check(`hooks.json: PreToolUse covers "${required}"`, matchers.includes(required), matchers.join(' | '));
	}

	// An enumerated source list silently stops covering sources the runtime adds
	// later, and a resumed session is the most drift-prone case there is.
	const sessionMatchers = (hooksConfig.hooks?.SessionStart ?? []).map((group) => group.matcher);
	const permissive = sessionMatchers.some((m) => m === undefined || m === '' || m === '*');
	check('hooks.json: SessionStart matcher is source-agnostic', permissive, sessionMatchers.join(' | '));

	// Every script the config names must exist, or the hook fails silently at run time.
	const referenced = [];
	for (const groups of Object.values(hooksConfig.hooks ?? {})) {
		for (const group of groups) {
			for (const hook of group.hooks ?? []) {
				for (const arg of hook.args ?? []) {
					const match = /\$\{(?:ZCODE|CLAUDE)_PLUGIN_ROOT\}\/(.+)$/.exec(arg);
					if (match) referenced.push(match[1]);
				}
			}
		}
	}
	check('hooks.json: references at least three scripts', referenced.length >= 3, referenced.join(', '));
	for (const rel of referenced) {
		check(`hooks.json: referenced script exists (${rel})`, existsSync(join(PLUGIN, rel)));
	}
}

console.log('\n=== protocol files are pure ASCII ===');
// Config and hook payloads cross an encoding boundary into ZCode's runtime. An em
// dash in a GBK environment eats the following quote and breaks the JSON outright.
// Markdown is read as UTF-8 by the model and is fine; these are not.
{
	const hooksDir = join(PLUGIN, 'hooks');
	const protocolFiles = [join('hooks', 'hooks.json'), ...readdirSync(hooksDir).filter((f) => f.endsWith('.mjs')).map((f) => join('hooks', f))];
	check('protocol files: hooks directory was scanned', protocolFiles.length >= 5, protocolFiles.join(', '));
	for (const rel of protocolFiles) {
		const text = readFileSync(join(PLUGIN, rel), 'utf8');
		const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
		check(`${rel.replace(/\\/g, '/')}: ASCII only`, bad.length === 0, `found: ${[...new Set(bad)].join('')}`);
	}
	for (const rel of ['marketplace.json', join('plugins', 'teamwork', '.zcode-plugin', 'plugin.json'), 'package.json']) {
		const text = readFileSync(join(REPO, rel), 'utf8');
		const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
		check(`${rel.replace(/\\/g, '/')}: ASCII only`, bad.length === 0, `found: ${[...new Set(bad)].join('')}`);
	}
}

// --- hook cwd contract -----------------------------------------------------
//
// Every hook must resolve its project directory through the shared helper. A hook
// that reads input.cwd directly breaks whenever the payload omits that field, and
// the failure is silent: it looks for .teamwork/ under the wrong directory, finds
// nothing, and reports nothing. ZCode exports ZCODE_PROJECT_DIR for exactly this
// reason, so resolveProjectDir() is the only accepted form.

console.log('\n=== hook cwd contract ===');

{
	const hooksDir = join(PLUGIN, 'hooks');
	const hookFiles = readdirSync(hooksDir).filter((f) => f.endsWith('.mjs') && f !== '_lib.mjs');
	check('hooks: there are hooks to check', hookFiles.length >= 7, hookFiles.join(', '));

	for (const file of hookFiles) {
		const source = readFileSync(join(hooksDir, file), 'utf8');
		if (!source.includes('const cwd')) continue;
		check(
			`hooks/${file}: uses the shared project-dir helper`,
			source.includes('resolveProjectDir(input)'),
			'resolves cwd some other way',
		);
	}

	const lib = readFileSync(join(hooksDir, '_lib.mjs'), 'utf8');
	check('hooks/_lib.mjs: helper is exported', /export function resolveProjectDir/.test(lib));
	check('hooks/_lib.mjs: helper consults ZCODE_PROJECT_DIR', /ZCODE_PROJECT_DIR/.test(lib));
	check('hooks/_lib.mjs: helper consults CLAUDE_PROJECT_DIR', /CLAUDE_PROJECT_DIR/.test(lib));
}

// --- Stop hook channel -----------------------------------------------------
//
// A Stop hook that returns only `stopReason` is a silent no-op: ZCode records the
// reason, sets blockRequested, and then ends the turn, because the continuation
// check requires additionalContexts to be non-empty and only reason/systemMessage
// are pushed into it. This shipped once and made the whole verification gate inert
// on a real machine, so it is asserted structurally now.

console.log('\n=== Stop hook channel ===');

{
	const gate = readFileSync(join(PLUGIN, 'hooks', 'verification-gate.mjs'), 'utf8');
	check('gate: returns reason on block', /decision:\s*'block',\s*\n\s*reason:/.test(gate), 'block must carry reason');
	check('gate: does not send the display-only stopReason', !/stopReason:/.test(gate), 'stopReason does not reach additionalContexts');

	const probe = readFileSync(join(REPO, 'plugins', 'hook-probe', 'hooks', 'probe.mjs'), 'utf8');
	check('probe: block mode returns reason', /reason:\s*'hook-probe: verifying/.test(probe), 'probe must exercise the working channel');
	check('probe: does not send stopReason', !/stopReason:/.test(probe), 'a probe testing the wrong field reports a false negative');
}

// --- dispatch tool name ----------------------------------------------------
//
// ZCode 3.14 ships the tool as `Agent`; `Task` is its documented alias, and the
// matcher is a case-sensitive regex that knows nothing about aliases. A matcher of
// "Task" therefore never fires on a real machine, which made the spawn budget a
// no-op and stopped audit-log from ever recording a dispatch. Both are asserted
// here so the two names cannot drift apart again.

console.log('\n=== dispatch tool name ===');

{
	const hooksJson = readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8');
	check('hooks.json: the dispatch matcher covers both names', /"matcher":\s*"Task\|Agent"/.test(hooksJson), 'matcher must be Task|Agent');

	const budget = readFileSync(join(PLUGIN, 'hooks', 'spawn-budget.mjs'), 'utf8');
	check('spawn-budget: accepts Agent', /['"]Agent['"]/.test(budget), 'must accept the real tool name');
	check('spawn-budget: accepts Task', /['"]Task['"]/.test(budget), 'must still accept the alias');

	const audit = readFileSync(join(PLUGIN, 'hooks', 'audit-log.mjs'), 'utf8');
	check('audit-log: records Agent as a dispatch', /toolName === 'Task' \|\| toolName === 'Agent'/.test(audit), 'dispatch detection must cover both');
	check('audit-log: detects failure through the status field', /toolResponse\.status === 'failed'/.test(audit), 'PostToolUseFailure never fires on a real machine');

	// The other matchers were confirmed correct against a live install.
	check('hooks.json: edit matcher is unchanged', /"matcher":\s*"Write\|Edit"/.test(hooksJson), 'confirmed correct');
	check('hooks.json: bash matcher is unchanged', /"matcher":\s*"Bash"/.test(hooksJson), 'confirmed correct');
}

// --- cross-module contract -------------------------------------------------
//
// Bug #8 was two implementations of isCampaignActive disagreeing: the hooks waited
// for phase 'execution' while the engine's approve() writes 'approved'. Every hook
// treated an approved campaign as non-existent and exited silently. The unit tests
// missed it because their fixture used 'execution' - the value that matched the
// bug, not the engine. Tests can agree with a bug indefinitely; only comparing the
// two implementations catches it.

console.log('\n=== cross-module contract ===');

{
	const hooksLib = readFileSync(join(PLUGIN, 'hooks', '_lib.mjs'), 'utf8');
	const stateLib = readFileSync(join(PLUGIN, 'lib', 'state.mjs'), 'utf8');

	const phasesIn = (src) => {
		const m = src.match(/ACTIVE_PHASES\s*=\s*\[([^\]]*)\]/) || src.match(/return \[([^\]]*)\]\.includes\(state\.phase\)/);
		if (!m) return null;
		return m[1]
			.split(',')
			.map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
			.filter((x) => x.length > 0)
			.sort();
	};

	const hooksPhases = phasesIn(hooksLib);
	const statePhases = phasesIn(stateLib);

	check('contract: both modules define the active phases', hooksPhases !== null && statePhases !== null, `${hooksPhases} vs ${statePhases}`);
	check(
		'contract: hooks and engine agree on what makes a campaign active',
		JSON.stringify(hooksPhases) === JSON.stringify(statePhases),
		`hooks=${JSON.stringify(hooksPhases)} engine=${JSON.stringify(statePhases)}`,
	);

	// The engine's own approve() must land on a phase the hooks accept. This is the
	// exact mismatch that shipped: approve() writes 'approved', which the old hooks
	// did not list. Only the approve path is checked - 'aborted' and 'complete' are
	// terminal phases where the hooks are deliberately inert.
	const engine = readFileSync(join(PLUGIN, 'lib', 'engine.mjs'), 'utf8');
	const approveBody = engine.slice(engine.indexOf('approve()'), engine.indexOf('advance('));
	const entered = (approveBody.match(/setPhase\(state,\s*'([a-z]+)'\)/g) || [])
		.map((m) => m.match(/'([a-z]+)'/)[1]);
	check('contract: approve() is locatable', entered.length > 0, 'no setPhase calls found in approve()');
	for (const phase of entered) {
		check(
			`contract: approve() may enter "${phase}" and the hooks accept it`,
			statePhases.includes(phase) && hooksPhases.includes(phase),
			`engine enters ${phase}, hooks accept ${JSON.stringify(hooksPhases)}`,
		);
	}
}

// --- the dispatch ceiling is one contract, not two --------------------------
//
// Same shape as the phase mismatch above, found the same way: by running a real
// campaign. The hook read the ceiling from campaign.json while the engine used its own
// constructor default, so a campaign with `spawnBudget: 6` was enforced at 6 and
// reported as 16 by `status` and `succession`. Every number a human could read was
// wrong in the permissive direction. The count had the same problem - the engine
// counted its own journal, which no hook writes dispatches to, so it reported 0 while
// the trail held 2.
//
// These assertions read both implementations and compare them, so the two cannot drift
// apart again without failing here.
{
	const engineSrc = readFileSync(join(PLUGIN, 'lib', 'engine.mjs'), 'utf8');
	const sbSrc = readFileSync(join(PLUGIN, 'hooks', 'spawn-budget.mjs'), 'utf8');
	const schedSrc = readFileSync(join(PLUGIN, 'lib', 'scheduler.mjs'), 'utf8');
	const stateSrc = readFileSync(join(PLUGIN, 'lib', 'state.mjs'), 'utf8');
	const hooksLibSrc = readFileSync(join(PLUGIN, 'hooks', '_lib.mjs'), 'utf8');

	// The default ceiling must be the same number in both constants.
	const defaultIn = (src) => {
		const m = src.match(/DEFAULT_SPAWN_BUDGET\s*=\s*(\d+)/);
		return m ? Number(m[1]) : null;
	};
	const libDefault = defaultIn(schedSrc);
	const hookDefault = defaultIn(hooksLibSrc);
	check('contract: both modules define the default spawn budget', libDefault !== null && hookDefault !== null, `${libDefault} vs ${hookDefault}`);
	check('contract: the default spawn budget agrees', libDefault === hookDefault, `lib=${libDefault} hook=${hookDefault}`);

	// Both sides must consult campaign.json's spawnBudget, not a hardcoded value, and
	// they must do it through one implementation. The hook used to carry its own copy
	// of the resolver; two copies that agree until one is edited is the defect shape
	// behind the plan.json/campaign.json and 'execution'/'approved' bugs.
	check(
		'contract: the hook resolves the budget through the shared helper',
		/resolveSpawnBudget\(/.test(sbSrc),
		'hook must not carry its own copy',
	);
	check(
		'contract: the hook does not define its own budget resolver',
		!/function readBudget\(/.test(sbSrc),
		'found a second implementation',
	);
	check(
		'contract: the hook resolves concurrency through the shared helper',
		/resolveMaxParallel\(/.test(sbSrc),
		'the cap is a charter field too',
	);
	check('contract: the engine resolves spawnBudget via the shared helper', /resolveSpawnBudget\(/.test(engineSrc), 'engine must not use its own default');
	check('contract: the shared resolver reads campaign.json', /campaign\?\.spawnBudget/.test(schedSrc), 'resolver must read the charter field');

	// The engine must not report the raw constructor default as the ceiling again.
	check(
		'contract: the engine no longer exposes a fixed budget field',
		!/this\.budget\s*=/.test(engineSrc),
		'this.budget was the field that ignored campaign.json',
	);

	// The dispatch count must come from the event trail, the same source the hook uses.
	check('contract: the engine counts dispatches from the event trail', /countDispatches\(this\.paths\.events\)/.test(engineSrc), 'engine must read events.jsonl');
	check('contract: the hook counts dispatches from the event trail', /countDispatches\(paths\.events\)/.test(sbSrc), 'hook must read events.jsonl');
	check('contract: the trail counter is exported from the lib side', /export function countDispatches/.test(stateSrc), 'state.mjs owns file reads');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
