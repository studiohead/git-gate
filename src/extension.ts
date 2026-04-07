"use strict";

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync, spawn } from 'child_process';

// ── constants ────────────────────────────────────────────────────────────────
const CONFIG_FILE  = 'git-gate-config.json';
const LOG_FILE     = '.git-gate-activity.log';   // written by the Python loader
const MAX_LOG_ENTRIES = 200;

// ── state ────────────────────────────────────────────────────────────────────
let originalGitPath: string | undefined;
let dashboardPanel: vscode.WebviewPanel | undefined;
let logWatcher: fs.FSWatcher | undefined;

interface LogEntry {
    ts:      string;   // HH:MM
    outcome: 'blocked' | 'safe' | 'system';
    files:   string;
    rule?:   string;
}

// ── activate ─────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
    const wrapperScript = path.join(context.extensionPath, 'git-wrapper.sh');

    if (!fs.existsSync(wrapperScript)) {
        vscode.window.showErrorMessage('Git Gate: wrapper script missing — reinstall the extension.');
        return;
    }
    fs.chmodSync(wrapperScript, 0o755);

    // Redirect VS Code's internal git to our wrapper
    originalGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
    vscode.workspace.getConfiguration('git').update(
        'path', wrapperScript, vscode.ConfigurationTarget.Workspace
    );

    // Inject wrapper into every terminal's PATH and pass log file path
    const wrapperDir = context.extensionPath;
    const currentPath = process.env.PATH || '';
    if (!currentPath.startsWith(wrapperDir)) {
        process.env.PATH = `${wrapperDir}:${currentPath}`;
    }
    ensureLogDir(context);
    const logFp = logFilePath(context);
    if (!fs.existsSync(logFp)) fs.writeFileSync(logFp, '');
    process.env.GIT_GATE_LOG_FILE = logFp;

    const pathExport = `export PATH="${wrapperDir}:$PATH"; export GIT_GATE_LOG_FILE="${logFp}"`;
    vscode.window.terminals.forEach(t => t.sendText(pathExport, true));
    context.subscriptions.push(
        vscode.window.onDidOpenTerminal(t => t.sendText(pathExport, true))
    );

    // Ensure Docker container is running (non-blocking)
    ensureDockerContainer(context);

    // Append a system-start entry to the activity log
    appendLogEntry(context, { outcome: 'system', files: 'Git Gate activated', ts: nowHHMM() });

    // Register: open dashboard panel
    context.subscriptions.push(
        vscode.commands.registerCommand('git-gate.openDashboard', () => {
            openDashboard(context);
        })
    );

    // Register: legacy command alias (still works from command palette)
    context.subscriptions.push(
        vscode.commands.registerCommand('git-gate.manageSensitiveFiles', () => {
            openDashboard(context);
        })
    );

    vscode.window.showInformationMessage('Git Gate is armed.', 'Open Dashboard').then(sel => {
        if (sel === 'Open Dashboard') openDashboard(context);
    });
}

// ── deactivate ───────────────────────────────────────────────────────────────
export function deactivate() {
    logWatcher?.close();
    if (originalGitPath !== undefined) {
        vscode.workspace.getConfiguration('git').update(
            'path', originalGitPath, vscode.ConfigurationTarget.Workspace
        );
    } else {
        vscode.workspace.getConfiguration('git').update(
            'path', undefined, vscode.ConfigurationTarget.Workspace
        );
    }
}

// ── docker helpers ───────────────────────────────────────────────────────────
function ensureDockerContainer(context: vscode.ExtensionContext) {
    const check = spawnSync('docker', ['ps', '--format', '{{.Names}}']);
    const running = check.stdout?.toString() || '';
    if (running.includes('git-gate')) return;

    vscode.window.showInformationMessage('Git Gate: starting Docker container…');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) return;

    // Build + run asynchronously so we don't block activation
    const build = spawn('docker', ['build', '-t', 'git-gate', context.extensionPath]);
    build.on('close', code => {
        if (code !== 0) {
            vscode.window.showWarningMessage('Git Gate: Docker build failed — local enforcement only.');
            return;
        }
        spawn('docker', [
            'run', '-d', '--name', 'git-gate',
            '-v', `${workspaceRoot}:/workspace`,
            'git-gate'
        ]);
    });
}

// ── activity log helpers ─────────────────────────────────────────────────────
function nowHHMM(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function logFilePath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, LOG_FILE);
}

function ensureLogDir(context: vscode.ExtensionContext) {
    const dir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendLogEntry(context: vscode.ExtensionContext, entry: LogEntry) {
    ensureLogDir(context);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logFilePath(context), line);
}

function readLogEntries(context: vscode.ExtensionContext): LogEntry[] {
    const fp = logFilePath(context);
    if (!fs.existsSync(fp)) return [];
    try {
        const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
        return lines
            .slice(-MAX_LOG_ENTRIES)
            .map(l => JSON.parse(l) as LogEntry)
            .reverse();   // newest first
    } catch {
        return [];
    }
}

// ── config helpers ───────────────────────────────────────────────────────────
function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
}

function getSensitiveFiles(): string[] {
    const root = getWorkspaceRoot();
    if (!root) return [];
    const cfgPath = path.join(root, CONFIG_FILE);
    if (!fs.existsSync(cfgPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).sensitiveFiles ?? [];
    } catch { return []; }
}

function saveSensitiveFiles(files: string[]) {
    const root = getWorkspaceRoot();
    if (!root) return;
    fs.writeFileSync(
        path.join(root, CONFIG_FILE),
        JSON.stringify({ sensitiveFiles: files }, null, 2)
    );
}

function countsByOutcome(entries: LogEntry[]) {
    let blocked = 0, safe = 0;
    for (const e of entries) {
        if (e.outcome === 'blocked') blocked++;
        else if (e.outcome === 'safe') safe++;
    }
    return { blocked, safe };
}

// ── dashboard panel ──────────────────────────────────────────────────────────
function openDashboard(context: vscode.ExtensionContext) {
    if (dashboardPanel) {
        dashboardPanel.reveal(vscode.ViewColumn.One);
        refreshDashboard(context);
        return;
    }

    dashboardPanel = vscode.window.createWebviewPanel(
        'gitGateDashboard',
        'Git Gate',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    dashboardPanel.onDidDispose(() => {
        logWatcher?.close();
        logWatcher = undefined;
        dashboardPanel = undefined;
    });

    refreshDashboard(context);

    // Watch the log file and push updates to the webview
    ensureLogDir(context);
    const fp = logFilePath(context);
    // Touch file so watcher has something to watch
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, '');
    logWatcher = fs.watch(fp, () => refreshDashboard(context));

    // Handle messages from the webview
    dashboardPanel.webview.onDidReceiveMessage(msg => {
        switch (msg.command) {
            case 'updateRules':
                saveSensitiveFiles(msg.files);
                break;
            case 'clearLog':
                ensureLogDir(context);
                fs.writeFileSync(logFilePath(context), '');
                refreshDashboard(context);
                break;
        }
    });
}

function refreshDashboard(context: vscode.ExtensionContext) {
    if (!dashboardPanel) return;
    const files   = getSensitiveFiles();
    const entries = readLogEntries(context);
    const counts  = countsByOutcome(entries);
    const root    = getWorkspaceRoot() ?? '(no workspace)';
    dashboardPanel.webview.html = getDashboardHtml(files, entries, counts, root);
}

// ── webview HTML ─────────────────────────────────────────────────────────────
function inferRuleType(rule: string): [string, string] {
    if (rule.endsWith('/'))                             return ['rt-dir',  'dir'];
    if (rule.includes('*'))                             return ['rt-glob', 'glob'];
    if (!rule.includes('.') || rule.startsWith('.') && !rule.slice(1).includes('.'))
                                                        return ['rt-dir',  'dir'];
    return ['rt-file', 'file'];
}

function renderRuleItem(f: string): string {
    const [cls, label] = inferRuleType(f);
    const safe = f.replace(/"/g, '&quot;');
    return `
    <div class="rule-item" data-file="${safe}">
      <div class="rule-left">
        <span class="rule-type-badge ${cls}">${label}</span>
        <span class="rule-name">${safe}</span>
      </div>
      <button class="rule-del" title="remove">×</button>
    </div>`;
}

function renderLogItem(e: LogEntry): string {
    const badge =
        e.outcome === 'blocked' ? '<span class="badge badge-blocked">blocked</span>' :
        e.outcome === 'safe'    ? '<span class="badge badge-safe">safe</span>' :
                                  '<span class="badge badge-sys">system</span>';
    const ruleSpan = e.rule
        ? `<br><span class="log-sub">matched rule <span class="log-rule">${e.rule}</span></span>`
        : '';
    const filesDisplay = e.outcome !== 'system'
        ? ` git add <span class="log-path">${e.files}</span>`
        : ` <span class="log-sys-msg">${e.files}</span>`;
    return `
    <div class="log-item">
      <span class="log-time">${e.ts}</span>
      <div class="log-msg">${badge}${filesDisplay}${ruleSpan}</div>
    </div>`;
}

function getDashboardHtml(
    files: string[],
    entries: LogEntry[],
    counts: { blocked: number; safe: number },
    workspaceRoot: string
): string {
    const ruleItems = files.map(renderRuleItem).join('');
    const logItems  = entries.length
        ? entries.map(renderLogItem).join('')
        : '<div class="log-empty">No activity yet this session.</div>';
    const repoLabel = workspaceRoot.length > 48
        ? '…' + workspaceRoot.slice(-46)
        : workspaceRoot;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Git Gate</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    line-height: 1.5;
  }

  /* ── layout ── */
  .shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px;
    background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .topbar-left { display: flex; align-items: center; gap: 8px; }
  .topbar-title { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }

  .status-pill {
    display: flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 20px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    background: rgba(64,185,64,0.15); color: #4caf50;
    border: 1px solid rgba(64,185,64,0.35);
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #4caf50; }

  .repo-bar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 16px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px; color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .repo-path {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .repo-sep { opacity: 0.35; }

  .stats-row {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    padding: 10px 16px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .stat-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 8px 12px;
  }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .stat-value { font-size: 22px; font-weight: 600; }
  .stat-value.blocked { color: #e05c5c; }
  .stat-value.safe    { color: #4caf50; }
  .stat-value.rules   { color: var(--vscode-textLink-foreground, #4da6ff); }

  .cols {
    display: flex; gap: 0; flex: 1; overflow: hidden;
    border-top: 1px solid var(--vscode-panel-border);
  }

  /* ── left panel: rules ── */
  .rules-panel {
    width: 240px; flex-shrink: 0;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    overflow: hidden;
  }
  .panel-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--vscode-descriptionForeground);
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .panel-sub { font-size: 10px; letter-spacing: 0; text-transform: none; font-weight: 400; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.7; }

  .rule-list { flex: 1; overflow-y: auto; }
  .rule-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: default;
  }
  .rule-item:hover { background: var(--vscode-list-hoverBackground); }
  .rule-left { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .rule-type-badge {
    font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 20px;
    flex-shrink: 0; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .rt-file { background: rgba(77,166,255,0.15); color: #4da6ff; border: 1px solid rgba(77,166,255,0.3); }
  .rt-dir  { background: rgba(255,167,38,0.15); color: #ffab29; border: 1px solid rgba(255,167,38,0.3); }
  .rt-glob { background: rgba(167,100,255,0.15); color: #b57dff; border: 1px solid rgba(167,100,255,0.3); }
  .rule-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rule-del {
    background: none; border: none; cursor: pointer; padding: 2px 5px;
    color: var(--vscode-descriptionForeground); font-size: 15px; border-radius: 3px;
    flex-shrink: 0; line-height: 1; opacity: 0.6;
  }
  .rule-del:hover { background: rgba(224,92,92,0.2); color: #e05c5c; opacity: 1; }

  .add-row {
    display: flex; gap: 6px; padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .add-row input {
    flex: 1; font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px; padding: 4px 8px; outline: none;
  }
  .add-row input:focus { border-color: var(--vscode-focusBorder); }
  .add-row input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .add-btn {
    padding: 4px 10px; font-size: 11px; font-weight: 600;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer; flex-shrink: 0;
  }
  .add-btn:hover { background: var(--vscode-button-hoverBackground); }

  /* ── right panel: log ── */
  .log-panel {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .log-list { flex: 1; overflow-y: auto; }
  .log-empty { padding: 24px 16px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .clear-btn {
    font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0;
    background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 3px;
    color: var(--vscode-descriptionForeground);
  }
  .clear-btn:hover { background: var(--vscode-list-hoverBackground); }

  .log-item {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 7px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
  }
  .log-item:hover { background: var(--vscode-list-hoverBackground); }
  .log-time {
    color: var(--vscode-descriptionForeground); min-width: 38px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; padding-top: 1px;
  }
  .log-msg { flex: 1; line-height: 1.5; }
  .log-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: 0.8; }
  .log-rule { font-family: var(--vscode-editor-font-family, monospace); color: #e05c5c; font-size: 11px; }
  .log-sub  { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .log-sys-msg { color: var(--vscode-descriptionForeground); font-size: 11px; }

  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 20px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; margin-right: 5px; vertical-align: middle;
  }
  .badge-blocked { background: rgba(224,92,92,0.18); color: #e05c5c; border: 1px solid rgba(224,92,92,0.35); }
  .badge-safe    { background: rgba(76,175,80,0.15); color: #4caf50; border: 1px solid rgba(76,175,80,0.3); }
  .badge-sys     { background: rgba(77,166,255,0.15); color: #4da6ff; border: 1px solid rgba(77,166,255,0.3); }
</style>
</head>
<body>
<div class="shell">

  <div class="topbar">
    <div class="topbar-left">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="16" rx="3" fill="currentColor" opacity="0.1"/>
        <path d="M4 9 L7.5 12.5 L14 5.5" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9 1 L9 3.5 M9 14.5 L9 17 M1 9 L3.5 9 M14.5 9 L17 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.3"/>
      </svg>
      <span class="topbar-title">Git Gate</span>
    </div>
    <div class="status-pill">
      <span class="dot"></span>
      armed
    </div>
  </div>

  <div class="repo-bar">
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <circle cx="5.5" cy="2.5" r="2" stroke="currentColor" stroke-width="1.1"/>
      <path d="M5.5 4.5 L5.5 8.5 M3.5 6.5 L5.5 8.5 L7.5 6.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>workspace</span>
    <span class="repo-sep">›</span>
    <span class="repo-path">${repoLabel}</span>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Blocked</div>
      <div class="stat-value blocked" id="stat-blocked">${counts.blocked}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Allowed</div>
      <div class="stat-value safe" id="stat-safe">${counts.safe}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Rules</div>
      <div class="stat-value rules" id="stat-rules">${files.length}</div>
    </div>
  </div>

  <div class="cols">
    <div class="rules-panel">
      <div class="panel-header">
        Rules
        <span class="panel-sub">${CONFIG_FILE}</span>
      </div>
      <div class="rule-list" id="rule-list">${ruleItems}</div>
      <div class="add-row">
        <input id="rule-input" type="text" placeholder=".env, secrets/, *.key" />
        <button class="add-btn" id="add-btn">Add</button>
      </div>
    </div>

    <div class="log-panel">
      <div class="panel-header">
        Activity log
        <button class="clear-btn" id="clear-btn">clear</button>
      </div>
      <div class="log-list" id="log-list">${logItems}</div>
    </div>
  </div>

</div>
<script>
  const vscode = acquireVsCodeApi();

  // ── rule type inference ──────────────────────────────────────────────
  function inferType(rule) {
    if (rule.endsWith('/')) return ['rt-dir', 'dir'];
    if (rule.includes('*')) return ['rt-glob', 'glob'];
    const hasDot = rule.includes('.');
    if (!hasDot) return ['rt-dir', 'dir'];
    if (rule.startsWith('.') && rule.slice(1).indexOf('.') === -1) return ['rt-dir', 'dir'];
    return ['rt-file', 'file'];
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function getAllRules() {
    return Array.from(document.querySelectorAll('#rule-list .rule-item'))
                .map(el => el.dataset.file);
  }

  function syncRules() {
    vscode.postMessage({ command: 'updateRules', files: getAllRules() });
    document.getElementById('stat-rules').textContent = getAllRules().length;
  }

  function attachDeleteHandlers() {
    document.querySelectorAll('.rule-del').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.rule-item').remove();
        syncRules();
      });
    });
  }
  attachDeleteHandlers();

  // ── add rule ─────────────────────────────────────────────────────────
  document.getElementById('add-btn').addEventListener('click', () => {
    const input = document.getElementById('rule-input');
    const val = input.value.trim();
    if (!val) return;

    const existing = getAllRules();
    if (existing.includes(val)) {
      input.style.borderColor = '#e05c5c';
      setTimeout(() => input.style.borderColor = '', 800);
      return;
    }

    const [cls, label] = inferType(val);
    const safeVal = val.replace(/"/g, '&quot;');
    const item = document.createElement('div');
    item.className = 'rule-item';
    item.dataset.file = val;
    item.innerHTML =
      '<div class="rule-left">' +
        '<span class="rule-type-badge ' + cls + '">' + label + '</span>' +
        '<span class="rule-name">' + safeVal + '</span>' +
      '</div>' +
      '<button class="rule-del" title="remove">\u00d7</button>';
    item.querySelector('.rule-del').addEventListener('click', () => {
      item.remove(); syncRules();
    });
    document.getElementById('rule-list').appendChild(item);
    input.value = '';
    syncRules();
  });

  document.getElementById('rule-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('add-btn').click();
  });

  // ── clear log ────────────────────────────────────────────────────────
  document.getElementById('clear-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clearLog' });
  });
</script>
</body>
</html>`;
}
