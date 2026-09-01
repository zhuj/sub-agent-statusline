# English documentation

This folder explains how `opencode-subagent-statusline` works: what problem it solves, how it integrates with OpenCode, how it processes subagent events, and how the project is maintained.

The documentation is written for two audiences:

- **Plugin users**, who want to install, configure, and understand the TUI surface.
- **Contributors**, who need to understand the architecture, tests, and internal rules before changing code.

## Recommended reading order

If this is your first time in the repository, read in this order:

1. [Overview](./01-overview.md)
2. [Installation and usage](./02-installation-and-usage.md)
3. [Architecture](./03-architecture.md)
4. [Event flow](./04-event-flow.md)
5. [State model and counters](./05-state-model-and-counters.md)
6. [Rendering and deduplication](./06-rendering-and-deduplication.md)
7. [TUI interface](./07-tui-interface.md)
8. [Advanced configuration](./08-advanced-configuration.md)
9. [Development and testing](./09-development-and-testing.md)
10. [Troubleshooting](./10-troubleshooting.md)

## Quick map

| Document                                                                 | Purpose                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [01-overview.md](./01-overview.md)                                       | Understand what the plugin does and its main pieces.                                |
| [02-installation-and-usage.md](./02-installation-and-usage.md)           | Install the plugin in OpenCode and use the sidebar.                                 |
| [03-architecture.md](./03-architecture.md)                               | Understand the code modules and how they connect.                                   |
| [04-event-flow.md](./04-event-flow.md)                                   | Follow the path from an OpenCode event to a visible row.                            |
| [05-state-model-and-counters.md](./05-state-model-and-counters.md)       | Explain `StatuslineState`, `ChildSessionState`, sources, and `totalExecuted`.       |
| [06-rendering-and-deduplication.md](./06-rendering-and-deduplication.md) | Explain row collapse, visibility, and the difference between internal state and UI. |
| [07-tui-interface.md](./07-tui-interface.md)                             | Document the sidebar, footer, navigation, and commands.                             |
| [08-advanced-configuration.md](./08-advanced-configuration.md)           | Environment variables, state files, debug logs, and paths.                          |
| [09-development-and-testing.md](./09-development-and-testing.md)         | Commands, test strategy, coverage boundaries, and smoke tests.                      |
| [10-troubleshooting.md](./10-troubleshooting.md)                         | Common cases: plugin not visible, stale cache, missing tokens, and debugging.       |

## Documentation status

Created documents:

- `00-index.md`
- `01-overview.md`
- `02-installation-and-usage.md`
- `03-architecture.md`
- `04-event-flow.md`
- `05-state-model-and-counters.md`
- `06-rendering-and-deduplication.md`
- `07-tui-interface.md`
- `08-advanced-configuration.md`
- `09-development-and-testing.md`
- `10-troubleshooting.md`

Not part of the current numbered set:

- publication and release documentation, which remains intentionally pending for a future pass if needed.

## Related companion documents

These live at the repo root (not under `docs/en/`/`docs/es/`) and complement the
numbered guides above:

| Document                                  | Purpose                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| [`../releasing.md`](../releasing.md)      | Tag-gated release process, recovery gates, and publish commands.                       |
| [`../testing.md`](../testing.md)          | Testing strategy, file map, and current TUI / e2e coverage boundaries.                 |
| [`../openspec/specs/`](../openspec/specs) | Authored change proposals and per-change specs (the source of truth for change flow).  |
| [`../openspec/changes/`](../openspec/changes) | Active and archived openspec changes — start here when proposing a behavioural change. |
