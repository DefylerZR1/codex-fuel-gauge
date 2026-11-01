# Codex Fuel Gauge

See [ROADMAP.md](ROADMAP.md) for the planned project-roadmap, automation, usage-budgeting, and FYI integration modules.

Codex Fuel Gauge is a local desktop operations console for ChatGPT-backed Codex usage. It displays allowance telemetry, quota-window reset time, and daily utilization targets; reads Codex's native managed-project registry; and can launch controlled roadmap, SEO-audit, and GSC-focused project tasks.

## Project workspace

- Queries Codex's native `project/list` registry and supplements it with genuine Git repository roots from Codex thread history.
- Builds or updates a repository-specific `ROADMAP.md` through a controlled Codex task.
- Runs a read-only SEO analysis that records evidence and recommendations in `SEO_AUDIT.md`.
- Applies high-confidence GSC-focused repository improvements without claiming live Search Console access.
- Keeps non-Git Codex projects visible and provides an in-app setup walkthrough for Codex desktop, the VS Code Codex extension, Git, and GitHub.

## Privacy and security

- Runs locally on your computer. Project actions occur only after you press their button.
- Uses the authentication already managed by Codex App Server.
- Does not read, store, or transmit authentication tokens.
- Does not send analytics.
- Exposes telemetry only on `127.0.0.1:47831`.
- Does not consume rate-limit reset credits or change account settings.

## Requirements

- Windows 10 or Windows 11.
- A current Codex installation with `codex app-server` support.
- A ChatGPT-backed Codex login. API-key-only authentication does not expose ChatGPT usage telemetry.

## Development

```powershell
npm install
npm run check:telemetry
npm start
```

Build a portable executable:

```powershell
npm run pack:win
```

## Local automation endpoint

While the app is running:

- `GET http://127.0.0.1:47831/api/usage`
- `GET http://127.0.0.1:47831/health`

## Project status

Codex App Server is currently an experimental interface. Codex Fuel Gauge isolates protocol access in `src/app-server-client.js` so compatibility updates remain small and reviewable.

## Disclaimer

Codex Fuel Gauge is an independent open-source project and is not affiliated with or endorsed by OpenAI. Codex and ChatGPT are trademarks of OpenAI.
