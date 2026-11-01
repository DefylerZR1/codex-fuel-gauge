# Codex Fuel Gauge Roadmap

Fuel Gauge will grow from a usage monitor into a local operations console for planning and directing useful Codex work. The gauge remains the home view; larger capabilities live in separate modules so telemetry stays readable.

## 1. Project Roadmap

- Register local projects and their repository, deployment, and documentation locations.
- Convert objectives into milestones, actionable tasks, dependencies, and completion criteria.
- Track last audit, last deployment, open risks, pending commits, and next useful action.
- Rank work by operational value, urgency, project health, and estimated usage cost.
- Preserve a human-readable roadmap file in each project so objectives remain portable.

## 2. Automation and Usage Burner

- Schedule useful work windows, including the daily 10–12% usage target and pre-reset burn window.
- Select work from approved roadmap objectives instead of inventing token-consuming tasks.
- Prioritize audits, tests, accessibility, performance, schema, documentation, dependency health, and conversion improvements.
- Keep a configurable emergency reserve and stop automatically when the reserve is reached.
- Support dry-run, approval-required, and autonomous policies per project and action type.
- Record every selected objective, action, verification result, commit, deployment, and usage change.
- Never consume earned reset credits automatically.

## 3. FYI Integrations

- Google Search Console: indexing, sitemap, query, position, coverage, and page-experience changes.
- GitHub: pending commits, failed checks, releases, dependency alerts, and issue activity.
- Hosting and deployment: current production revision, deployment state, and domain health.
- Codex: active plan, refill timing, usage pace, work-session history, and automation outcomes.
- Surface concise FYI cards with source, severity, observed time, and recommended next action.

## Platform Work

- Tabbed 16:9 shell: Gauge, Roadmap, Automation, and FYI.
- Local encrypted settings and per-project permissions.
- Connector adapters with read-only defaults and explicit write capabilities.
- Windows startup option, notifications, update checks, and signed distribution when available.
- Import/export for configuration, roadmaps, and activity logs.

## Delivery Order

1. Project registry and roadmap schema.
2. Roadmap editor and objective/task assembler.
3. Read-only FYI cards for GitHub, deployments, and Search Console.
4. Automation queue with dry-run execution and audit logs.
5. Usage-aware scheduling, reserve enforcement, and incremental burn targets.
6. Carefully scoped autonomous execution policies per project.
