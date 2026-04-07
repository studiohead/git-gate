# Git Gate

A VS Code extension that enforces Git safety rules by blocking sensitive files and directories from being staged or committed. Built specifically for developers running **agentic workflows** — where an AI agent has shell access and could accidentally commit secrets, orchestration config, or AI context files.

---

## How it works

Git Gate replaces VS Code's internal git binary with a wrapper script (`git-wrapper.sh`). Every `git add` command is intercepted, checked against your rule list in `git-gate-config.json`, and either allowed through or blocked before staging happens. All activity is logged to the dashboard in real time.

Enforcement runs in two modes:

- **Docker** (preferred) — git commands execute inside an isolated container with the compiled C enforcement binary
- **Local fallback** — if Docker isn't running, the Python loader runs directly on the host

---

## Requirements

- VS Code 1.90+
- Node.js 18+ and npm
- Python 3.10+
- GCC (for compiling the C enforcement binary)
- Docker (optional but recommended)

---

## Installation

### 1. Clone the repository

```bash
git clone git@github.com:studiohead/git-gate.git
cd git-gate
```

### 2. Install dependencies

```bash
npm install
```

### 3. Compile the TypeScript extension

```bash
npm run compile
```

### 4. Compile the C enforcement binary

```bash
gcc -O2 -o loader/git_gate loader/git_gate.c
```

### 5. (Optional) Build the Docker container

```bash
docker build -t git-gate .
```

The Dockerfile compiles the C binary automatically at image build time, so this step covers both the container image and binary compilation in one go.

### 6. Package the VS Code extension

```bash
npx @vscode/vsce package
```

This produces `git-gate-1.0.0.vsix` in the project root.

### 7. Install in VS Code

```bash
code --install-extension git-gate-1.0.0.vsix
```

Or install manually: open VS Code → Extensions → `...` menu → **Install from VSIX…**

---

## Usage

Once installed, Git Gate activates automatically when VS Code opens a workspace.

- Open the dashboard via the command palette: **Git Gate: Open Dashboard**
- The dashboard shows blocked/allowed counts, your active rules, and a live activity log
- Add or remove rules directly from the dashboard — changes are saved to `git-gate-config.json` instantly

### What gets blocked

Anything listed in `git-gate-config.json` under `sensitiveFiles`. Rules support three formats:

| Format | Example | Matches |
|--------|---------|---------|
| Plain filename | `.env-example` | Any file named `.env-example` anywhere in the repo |
| Directory name | `.claude` | Any file inside a `.claude/` directory at any depth |
| Trailing slash | `secrets/` | Same as above, explicit directory syntax |
| Glob | `*.key` | Any file matching the glob pattern (basename) |
| Path glob | `**/.env-*` | Full path glob, matched against the whole file path |

### Default rules

```json
{
  "sensitiveFiles": [
    "agent.md",
    "SKILLS",
    ".AI_ORCHESTRATION",
    ".claude",
    ".env-example"
  ]
}
```

Edit this file directly or use the dashboard to add and remove rules.

---

## Development

### Recompile after TypeScript changes

```bash
npm run compile
```

### Recompile after C changes

```bash
gcc -O2 -o loader/git_gate loader/git_gate.c
```

### Rebuild the Docker image after any changes

```bash
docker build -t git-gate .
```

### Repackage the extension

```bash
npx @vscode/vsce package
```

### Watch mode (auto-recompile TypeScript on save)

```bash
npx tsc -p . --watch
```

---

## Project structure

```
git-gate/
├── src/
│   └── extension.ts          # VS Code extension entry point + dashboard UI
├── loader/
│   ├── git_gate.c            # C enforcement engine (rule matching, blocking)
│   └── load_git_gate.py      # Python loader / Docker entrypoint
├── git-wrapper.sh            # Shim that VS Code's git.path is set to
├── git-gate-config.json      # Rule definitions (lives in your workspace root)
├── Dockerfile                # Container image (compiles git_gate.c at build time)
├── tsconfig.json
└── package.json
```

---

## How the enforcement pipeline works

```
VS Code git operation
        │
        ▼
git-wrapper.sh
        │
        ├─── Docker running? ──► docker exec git-gate python3 /loader/load_git_gate.py
        │
        └─── Local fallback ──► python3 loader/load_git_gate.py
                                        │
                                        ├── git add? → expand paths via git ls-files
                                        │              → run ./loader/git_gate <config> <files>
                                        │                      │
                                        │                      ├── BLOCKED → exit 1, log entry
                                        │                      └── SAFE    → pass through, log entry
                                        │
                                        └── other command → exec real git unchanged
```

---

## Uninstalling

To remove Git Gate cleanly:

1. Uninstall the extension in VS Code
2. Delete `git-gate-config.json` from your workspace root if you no longer need it
3. If the Docker container is running: `docker rm -f git-gate`
