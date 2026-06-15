# WSL Serial Monitor

This is a VS Code extension for monitoring COM serial ports from WSL or native Windows.

## Agent Log CLI

When the user asks to inspect, debug, or analyze serial port logs, use the Agent Log CLI. Do NOT try to open the COM port directly — the VS Code extension owns the serial port.

### Source development (from repo root)

```bash
npm run compile
npm run logs -- sessions
npm run logs -- tail --session latest --lines 100
npm run logs -- search --session latest --query "panic|error|assert|watchdog|reset|fail" --regex --json
npm run logs -- context --session latest --query "watchdog" --before 30 --after 80 --json
```

### Installed extension

Ask the user to run `Serial: Copy Agent CLI Command` from the VS Code command palette, or check the `WSL Serial Monitor` Output channel for the `[CLI] Agent CLI:` line. Use the copied path as the executable.

```bash
<cli-path> sessions
<cli-path> tail --session latest --lines 100
<cli-path> search --session latest --query "panic|error" --regex --json
<cli-path> context --session latest --query watchdog --before 30 --after 80 --json
```

### Diagnosis workflow

1. `sessions` — list available log sessions
2. `search --regex --json` — find abnormal patterns (`panic|error|assert|watchdog|reset|fail|disconnect`)
3. `context --json` — for each important match, read surrounding lines to understand state transitions
4. Summarize findings with timestamps and evidence lines

### Notes

- Logs are NDJSON files in the `logs/` directory (configurable via `wsl-serial-monitor.agentLogDirectory`)
- `--log-dir /path/to/logs` overrides the default log directory
- `--json` returns structured output for programmatic consumption
- The `raw` field is UTF-8 text re-encoded as hex, not original serial bytes
