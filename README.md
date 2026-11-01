# Codex Fuel Gauge

Codex Fuel Gauge is a local, read-only desktop monitor for ChatGPT-backed Codex usage. It reads supported telemetry from Codex App Server and displays the remaining allowance, quota-window reset time, and a daily utilization target.

## Privacy and security

- Runs locally on your computer.
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
