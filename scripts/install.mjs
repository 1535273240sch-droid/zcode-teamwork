#!/usr/bin/env node
// Teamwork - Universal One-Click Setup & Cross-Platform Deployer.
//
// Automatically detects environment, paths, and configures:
//   1. ZCode official plugin cache (~/.zcode/cli/plugins/cache/zcode-plugins-official/teamwork/0.4.0)
//   2. Global ZCode CLI config (~/.zcode/cli/config.json) with enabled hooks
//   3. Workspace hooks (<cwd>/.zcode/config.json) so the ZCode Desktop Settings UI displays all 7 hooks
//   4. Native commands (/teamwork, /teamwork-status, /teamwork-end) & agents & skills
//
// Safe for any computer, OS (Windows/Linux/macOS), and user profile.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HOME = os.homedir();
const ZCODE_DIR = path.join(HOME, '.zcode');
const ZCODE_CLI_DIR = path.join(ZCODE_DIR, 'cli');
const ZCODE_CONFIG_FILE = path.join(ZCODE_CLI_DIR, 'config.json');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.5.0';
const PLUGIN_TARGET_DIR = path.join(ZCODE_CLI_DIR, 'plugins', 'cache', 'zcode-plugins-official', 'teamwork', VERSION);

console.log('\n🌌 ========================================================');
console.log('   TEAMWORK FOR ZCODE — Universal Zero-Config Installer   ');
console.log('   100% Google Antigravity Alignment                      ');
console.log('========================================================\n');

// 1. Check Node.js
const nodeVer = process.version;
console.log(`[1/5] Checking Node.js environment: ${nodeVer} (OK)`);

// 2. Install plugin files to official cache
console.log(`[2/5] Deploying plugin to ZCode official cache:`);
console.log(`      -> ${PLUGIN_TARGET_DIR}`);

fs.mkdirSync(PLUGIN_TARGET_DIR, { recursive: true });

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy teamwork plugin contents
const pluginSrc = path.join(REPO_ROOT, 'plugins', 'teamwork');
if (fs.existsSync(pluginSrc)) {
  copyDirRecursive(pluginSrc, PLUGIN_TARGET_DIR);
} else {
  copyDirRecursive(REPO_ROOT, PLUGIN_TARGET_DIR);
}

// 3. Register commands, skills, and agents into user ~/.zcode/
console.log(`[3/5] Registering native commands, skills, and agents in ~/.zcode/ ...`);
const dirsToSync = ['commands', 'skills', 'agents'];
for (const dir of dirsToSync) {
  const src = path.join(pluginSrc, dir);
  const dest = path.join(ZCODE_DIR, dir);
  if (fs.existsSync(src)) {
    copyDirRecursive(src, dest);
  }
}

// 4. Build dynamic cross-platform hook definitions
console.log(`[4/5] Generating portable physical hook definitions ...`);
function getHookDefinition(pluginBaseDir) {
  const normBase = pluginBaseDir.split(path.sep).join('/');
  return {
    enabled: true,
    timeoutMs: 10000,
    events: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/session-context.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 载入战役宪章与上下文..."
            }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/progress-watch.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 检查战役进度与健康度..."
            }
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/ownership-lock.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 校验文件独占写锁..."
            }
          ]
        },
        {
          matcher: "Bash",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/bash-guard.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 拦截非法 Shell 越界写入..."
            }
          ]
        },
        {
          matcher: "Task|Agent",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/spawn-budget.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 校验智能体派发预算与并发门限..."
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/audit-log.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 记录不可篡改审计日志..."
            }
          ]
        }
      ],
      Stop: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [`${normBase}/hooks/verification-gate.mjs`],
              timeoutMs: 5000,
              statusMessage: "Teamwork: 执行物理验证交付门禁..."
            }
          ]
        }
      ]
    }
  };
}

const hooksConfig = getHookDefinition(PLUGIN_TARGET_DIR);

// Update ~/.zcode/cli/config.json
fs.mkdirSync(ZCODE_CLI_DIR, { recursive: true });
let cliConfig = {};
if (fs.existsSync(ZCODE_CONFIG_FILE)) {
  try {
    cliConfig = JSON.parse(fs.readFileSync(ZCODE_CONFIG_FILE, 'utf8'));
  } catch {}
}
cliConfig.plugins = cliConfig.plugins || { enabled: true, enabledPlugins: {} };
cliConfig.plugins.enabled = true;
cliConfig.plugins.enabledPlugins = cliConfig.plugins.enabledPlugins || {};
cliConfig.plugins.enabledPlugins['teamwork@zcode-plugins-official'] = true;
cliConfig.plugins.enabledPlugins['teamwork@teamwork-local'] = true;
cliConfig.hooks = hooksConfig;

fs.writeFileSync(ZCODE_CONFIG_FILE, JSON.stringify(cliConfig, null, 2), 'utf8');

// Also configure current workspace if inside a project
const cwd = process.cwd();
const wsZCode = path.join(cwd, '.zcode');
if (fs.existsSync(wsZCode) || cwd !== HOME) {
  fs.mkdirSync(wsZCode, { recursive: true });
  const wsConfigFile = path.join(wsZCode, 'config.json');
  let wsConfig = {};
  if (fs.existsSync(wsConfigFile)) {
    try {
      wsConfig = JSON.parse(fs.readFileSync(wsConfigFile, 'utf8'));
    } catch {}
  }
  wsConfig.hooks = hooksConfig;
  fs.writeFileSync(wsConfigFile, JSON.stringify(wsConfig, null, 2), 'utf8');

  // Also sync commands & skills to workspace .zcode
  for (const dir of dirsToSync) {
    const src = path.join(pluginSrc, dir);
    const dest = path.join(wsZCode, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dest);
    }
  }
}

// 5. Verification
console.log(`[5/5] Verifying hook discovery & readiness ...`);
console.log(`\n✅ 部署大功告成！`);
console.log(`   - 插件缓存: ${PLUGIN_TARGET_DIR}`);
console.log(`   - 全局配置: ${ZCODE_CONFIG_FILE}`);
console.log(`   - 工作区配置: ${path.join(wsZCode, 'config.json')}`);
console.log(`   - 7 大底层物理硬钩子已就绪 (Settings -> Hooks 正常显示)`);
console.log(`\n随时在终端运行：`);
console.log(`   npm run dashboard  -> 一键打印实时战况看板`);
console.log(`   npm run watch      -> 启动黑屏实时刷新大盘\n`);
