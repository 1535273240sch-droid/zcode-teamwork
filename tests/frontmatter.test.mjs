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

const AGENTS = [
	'sentinel',
	'orchestrator',
	'explorer',
	'worker',
	'critic',
	'challenger',
	'auditor',
	'success-auditor',
];

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
	check('marketplace.json: source resolves to an existing directory', existsSync(join(REPO, market.pluginRoot ?? '', entryPlugin?.source ?? '')), String(entryPlugin?.source));
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

	// Also scan scripts/ directory recursively
	const scriptsDir = join(PLUGIN, 'scripts');
	function findMjs(dir, relPrefix = 'scripts') {
		const result = [];
		if (!existsSync(dir)) return result;
		for (const ent of readdirSync(dir, {withFileTypes: true})) {
			const sub = join(dir, ent.name);
			const rel = join(relPrefix, ent.name);
			if (ent.isDirectory()) {
				result.push(...findMjs(sub, rel));
			} else if (ent.isFile() && ent.name.endsWith('.mjs')) {
				result.push(rel);
			}
		}
		return result;
	}
	const scriptFiles = findMjs(scriptsDir);
	if (scriptFiles.length > 0) {
		check('protocol files: scripts directory was scanned', scriptFiles.length >= 1, scriptFiles.join(', '));
		protocolFiles.push(...scriptFiles);
	}

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
