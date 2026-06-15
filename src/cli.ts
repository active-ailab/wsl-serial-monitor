#!/usr/bin/env node

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SerialLogEvent,
    contextEvents,
    listSessions,
    readEvents,
    resolveSession,
    searchEvents,
    searchEventsStreaming,
    tailEvents,
    tailEventsFromFile,
    computeStats,
    exportEvents,
    ExportFormat
} from './logStore';

interface ParsedArgs {
    positionals: string[];
    options: Record<string, string | boolean>;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const [namespace, command] = args.positionals;

    if (namespace !== 'logs' || !command || getBoolean(args, 'help')) {
        printHelp();
        process.exit(namespace === 'logs' || getBoolean(args, 'help') ? 0 : 1);
    }

    const logDir = getLogDir(args);

    switch (command) {
        case 'sessions':
            handleSessions(logDir, args);
            break;
        case 'tail':
            await handleTail(logDir, args);
            break;
        case 'search':
            handleSearch(logDir, args);
            break;
        case 'context':
            handleContext(logDir, args);
            break;
        case 'stats':
            handleStats(logDir, args);
            break;
        case 'export':
            handleExport(logDir, args);
            break;
        case 'watch':
            await handleWatch(logDir, args);
            break;
        default:
            throw new Error(`Unknown logs command: ${command}`);
    }
}

function handleSessions(logDir: string, args: ParsedArgs): void {
    const sessions = listSessions(logDir);
    if (getBoolean(args, 'json')) {
        printJson(sessions);
        return;
    }

    if (sessions.length === 0) {
        console.log(`No log sessions found in ${logDir}`);
        return;
    }

    for (const session of sessions) {
        const startTime = session.startTime ?? '-';
        const baudRate = session.baudRate || '-';
        console.log(`${startTime}\t${session.sessionId}\t${session.port}\t${baudRate}\t${session.filePath}`);
    }
}

async function handleTail(logDir: string, args: ParsedArgs): Promise<void> {
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const lines = getNumber(args, 'lines', getNumber(args, 'limit', 100));
    
    // Use optimized tail from file (reads only last N lines)
    const events = tailEventsFromFile(session.filePath, lines);

    if (getBoolean(args, 'json') && !getBoolean(args, 'follow')) {
        printJson(events);
    } else {
        printEvents(events, getBoolean(args, 'json'));
    }

    if (getBoolean(args, 'follow')) {
        await followSessionFile(session.filePath, getBoolean(args, 'json'));
    }
}

function handleSearch(logDir: string, args: ParsedArgs): void {
    const query = requireQuery(args);
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const limit = getNumber(args, 'limit', 50);
    
    // Use streaming search with early termination
    const matches = searchEventsStreaming(
        session.filePath,
        query,
        getBoolean(args, 'regex'),
        limit
    );

    if (getBoolean(args, 'json')) {
        printJson(matches);
        return;
    }

    printEvents(matches.map((match) => match.event), false);
}

function handleContext(logDir: string, args: ParsedArgs): void {
    const query = requireQuery(args);
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const matches = contextEvents(
        readEvents(session.filePath),
        query,
        getBoolean(args, 'regex'),
        getNumber(args, 'before', 10),
        getNumber(args, 'after', 10),
        getNumber(args, 'limit', 1)
    );

    if (getBoolean(args, 'json')) {
        printJson(matches);
        return;
    }

    for (const match of matches) {
        console.log(`--- match at line ${match.matchIndex + 1}: ${match.event.text} ---`);
        for (const event of match.events) {
            const marker = event === match.event ? '>' : ' ';
            console.log(formatEvent(event, marker));
        }
    }
}

function handleStats(logDir: string, args: ParsedArgs): void {
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const events = readEvents(session.filePath);
    const stats = computeStats(events, session.sessionId, session.port, session.baudRate);

    if (getBoolean(args, 'json')) {
        printJson(stats);
        return;
    }

    // Human-readable output
    const durationSec = stats.durationMs / 1000;
    const durationMin = durationSec / 60;

    console.log('=== Session Statistics ===');
    console.log(`Session:    ${stats.sessionId}`);
    console.log(`Port:       ${stats.port} @ ${stats.baudRate} baud`);
    console.log(`Time:       ${stats.startTime || '-'} → ${stats.endTime || '-'}`);
    console.log(`Duration:   ${durationMin.toFixed(1)} min (${durationSec.toFixed(1)} sec)`);
    console.log('');
    console.log('--- Event Counts ---');
    console.log(`Total:      ${stats.totalEvents}`);
    console.log(`Serial:     ${stats.serialEvents}`);
    console.log(`System:     ${stats.systemEvents}`);
    console.log(`Errors:     ${stats.errorCount}`);
    console.log(`Warnings:   ${stats.warningCount}`);
    console.log('');

    if (stats.topPatterns.length > 0) {
        console.log('--- Top Patterns ---');
        for (const { pattern, count } of stats.topPatterns) {
            const bar = '█'.repeat(Math.min(20, Math.round(count / stats.totalEvents * 100)));
            console.log(`${pattern.padEnd(12)} ${String(count).padStart(6)} ${bar}`);
        }
        console.log('');
    }

    if (stats.timeDistribution.length > 0) {
        console.log('--- Time Distribution ---');
        const maxCount = Math.max(...stats.timeDistribution.map(t => t.count));
        for (const { hour, count } of stats.timeDistribution) {
            const bar = '█'.repeat(Math.round(count / maxCount * 30));
            console.log(`${hour} ${String(count).padStart(6)} ${bar}`);
        }
    }
}

function handleExport(logDir: string, args: ParsedArgs): void {
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const events = readEvents(session.filePath);
    const format = getString(args, 'format', 'json') as ExportFormat;
    const pretty = getBoolean(args, 'pretty');
    const outputFile = getString(args, 'output', '');

    if (!['csv', 'json', 'jsonl'].includes(format)) {
        throw new Error(`Invalid format: ${format}. Use csv, json, or jsonl.`);
    }

    const content = exportEvents(events, format, pretty);

    if (outputFile) {
        fs.writeFileSync(outputFile, content, 'utf-8');
        console.log(`Exported ${events.length} events to ${outputFile} (${format})`);
    } else {
        console.log(content);
    }
}

interface WatchPattern {
    query: string;
    regex: boolean;
    color: string;
}

async function handleWatch(logDir: string, args: ParsedArgs): Promise<void> {
    const session = resolveSession(logDir, getString(args, 'session', 'latest'));
    const filterOnly = getBoolean(args, 'filter-only');
    const execCmd = getString(args, 'exec', '');
    const follow = getBoolean(args, 'follow') !== false; // Default true for watch

    // Parse patterns: --pattern "error:#f44747" or --query "error"
    const patterns: WatchPattern[] = [];
    const patternArgs = args.options['pattern'];
    
    if (Array.isArray(patternArgs)) {
        for (const p of patternArgs) {
            const parts = String(p).split(':');
            patterns.push({
                query: parts[0],
                regex: getBoolean(args, 'regex'),
                color: parts[1] || '#e8b730'
            });
        }
    } else if (typeof patternArgs === 'string') {
        const parts = patternArgs.split(':');
        patterns.push({
            query: parts[0],
            regex: getBoolean(args, 'regex'),
            color: parts[1] || '#e8b730'
        });
    }

    // Also support --query for simple single pattern
    const query = getString(args, 'query', '');
    if (query && patterns.length === 0) {
        patterns.push({
            query,
            regex: getBoolean(args, 'regex'),
            color: getString(args, 'color', '#e8b730')
        });
    }

    if (patterns.length === 0) {
        throw new Error('Missing --query or --pattern. Use --query "error" or --pattern "error:#f44747"');
    }

    // ANSI color codes
    const colorMap: Record<string, string> = {
        '#f44747': '\x1b[31m',    // red
        '#4ec9b0': '\x1b[36m',    // cyan
        '#569cd6': '\x1b[34m',    // blue
        '#ce9178': '\x1b[33m',    // orange
        '#c586c0': '\x1b[35m',    // purple
        '#dcdcaa': '\x1b[93m',    // yellow
        '#d7ba7d': '\x1b[33m',    // dark yellow
        '#9cdcfe': '\x1b[96m',    // light cyan
        '#b5cea8': '\x1b[92m',    // light green
        '#e8b730': '\x1b[93m',    // gold
        '#ffa500': '\x1b[33m',    // orange
    };
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';

    function getColorAnsi(hex: string): string {
        return colorMap[hex.toLowerCase()] || '\x1b[93m';
    }

    function matchPatterns(text: string): WatchPattern | undefined {
        for (const pattern of patterns) {
            if (pattern.regex) {
                try {
                    if (new RegExp(pattern.regex === true ? pattern.query : pattern.query, 'i').test(text)) {
                        return pattern;
                    }
                } catch {
                    // Invalid regex, skip
                }
            } else {
                if (text.toLowerCase().includes(pattern.query.toLowerCase())) {
                    return pattern;
                }
            }
        }
        return undefined;
    }

    function highlightText(text: string, pattern: WatchPattern): string {
        const colorAnsi = getColorAnsi(pattern.color);
        if (pattern.regex) {
            try {
                const re = new RegExp(pattern.query, 'gi');
                return text.replace(re, (match) => `${colorAnsi}${bold}${match}${reset}`);
            } catch {
                return text;
            }
        }
        const idx = text.toLowerCase().indexOf(pattern.query.toLowerCase());
        if (idx === -1) return text;
        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + pattern.query.length);
        const after = text.slice(idx + pattern.query.length);
        return `${before}${colorAnsi}${bold}${match}${reset}${after}`;
    }

    // Read existing events first to get the offset
    const events = readEvents(session.filePath);
    let offset = 0;
    try {
        const stat = fs.statSync(session.filePath);
        offset = stat.size;
    } catch {
        // File might not exist yet
    }

    console.log(`Watching ${session.filePath}`);
    console.log(`Patterns: ${patterns.map(p => p.query).join(', ')}`);
    if (filterOnly) console.log('Mode: filter-only (only matching lines)');
    if (execCmd) console.log(`Exec: ${execCmd}`);
    console.log('---');

    // Process existing events (show last 10 for context)
    const recentEvents = events.slice(-10);
    for (const event of recentEvents) {
        const matched = matchPatterns(event.text);
        if (matched) {
            if (filterOnly) {
                console.log(highlightText(event.text, matched));
            } else {
                console.log(event.text);
            }
        } else if (!filterOnly) {
            console.log(event.text);
        }
    }

    if (!follow) {
        return;
    }

    // Watch for new events
    let pending = '';
    let execDebounce: NodeJS.Timeout | undefined;

    function executeCommand(matchedText: string) {
        if (!execCmd) return;
        if (execDebounce) clearTimeout(execDebounce);
        execDebounce = setTimeout(() => {
            try {
                const { execSync } = require('child_process');
                const cmd = execCmd.replace(/\{\}/g, JSON.stringify(matchedText));
                execSync(cmd, { stdio: 'inherit' });
            } catch (err: any) {
                console.error(`Exec failed: ${err.message}`);
            }
        }, 100);
    }

    // Poll for new content
    setInterval(() => {
        if (!fs.existsSync(session.filePath)) {
            return;
        }

        const stat = fs.statSync(session.filePath);
        if (stat.size <= offset) {
            return;
        }

        const stream = fs.createReadStream(session.filePath, {
            encoding: 'utf-8',
            start: offset,
            end: stat.size - 1
        });
        offset = stat.size;

        stream.on('data', (chunk: string) => {
            pending += chunk;
            const parts = pending.split(/\r?\n/);
            pending = parts.pop() ?? '';

            for (const line of parts) {
                const event = parseEventLine(line);
                if (!event) continue;

                const matched = matchPatterns(event.text);
                if (matched) {
                    console.log(highlightText(event.text, matched));
                    executeCommand(event.text);
                } else if (!filterOnly) {
                    console.log(event.text);
                }
            }
        });
    }, 200);
}

async function followSessionFile(filePath: string, asJson: boolean): Promise<void> {
    let offset = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    let pending = '';

    await new Promise<void>(() => {
        setInterval(() => {
            if (!fs.existsSync(filePath)) {
                return;
            }

            const size = fs.statSync(filePath).size;
            if (size <= offset) {
                return;
            }

            const stream = fs.createReadStream(filePath, {
                encoding: 'utf-8',
                start: offset,
                end: size - 1
            });
            offset = size;

            stream.on('data', (chunk) => {
                pending += chunk;
                const parts = pending.split(/\r?\n/);
                pending = parts.pop() ?? '';

                for (const line of parts) {
                    const event = parseEventLine(line);
                    if (event) {
                        printEvents([event], asJson);
                    }
                }
            });
        }, 500);
    });
}

function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    const options: Record<string, string | boolean> = {};

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--')) {
            positionals.push(arg);
            continue;
        }

        const withoutPrefix = arg.slice(2);
        const equalsIndex = withoutPrefix.indexOf('=');
        if (equalsIndex !== -1) {
            options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
            continue;
        }

        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            options[withoutPrefix] = next;
            index++;
        } else {
            options[withoutPrefix] = true;
        }
    }

    return { positionals, options };
}

function getLogDir(args: ParsedArgs): string {
    const fromFlag = getString(args, 'log-dir', '');
    if (fromFlag) {
        return path.resolve(process.cwd(), fromFlag);
    }

    if (process.env.WSL_SERIAL_MONITOR_LOG_DIR) {
        return path.resolve(process.cwd(), process.env.WSL_SERIAL_MONITOR_LOG_DIR);
    }

    const candidates = [
        path.resolve(process.cwd(), 'logs'),
        path.join(os.homedir(), '.vscode-server', 'data', 'User', 'globalStorage', 'roger-han.wsl-serial-monitor', 'logs'),
        path.join(os.homedir(), '.vscode', 'data', 'User', 'globalStorage', 'roger-han.wsl-serial-monitor', 'logs')
    ];

    return candidates.find(hasLogSessions) ?? candidates[0];
}

function hasLogSessions(logDir: string): boolean {
    try {
        return fs.existsSync(logDir) && fs.readdirSync(logDir).some((name) => name.endsWith('.ndjson'));
    } catch {
        return false;
    }
}

function getString(args: ParsedArgs, name: string, defaultValue: string): string {
    const value = args.options[name];
    return typeof value === 'string' ? value : defaultValue;
}

function getNumber(args: ParsedArgs, name: string, defaultValue: number): number {
    const value = args.options[name];
    if (typeof value !== 'string') {
        return defaultValue;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getBoolean(args: ParsedArgs, name: string): boolean {
    return args.options[name] === true;
}

function requireQuery(args: ParsedArgs): string {
    const query = getString(args, 'query', '');
    if (!query) {
        throw new Error('Missing required --query value');
    }
    return query;
}

function printEvents(events: SerialLogEvent[], asJsonLines: boolean): void {
    for (const event of events) {
        if (asJsonLines) {
            console.log(JSON.stringify(event));
        } else {
            console.log(formatEvent(event));
        }
    }
}

function formatEvent(event: SerialLogEvent, marker = ' '): string {
    const source = event.source === 'serial' ? '' : `[${event.source}] `;
    return `${marker} ${event.ts} ${event.port} ${source}${event.text}`;
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function parseEventLine(line: string): SerialLogEvent | undefined {
    if (!line.trim()) {
        return undefined;
    }

    try {
        return JSON.parse(line) as SerialLogEvent;
    } catch {
        return undefined;
    }
}

function printHelp(): void {
    console.log(`Usage:
  wsl-serial-monitor logs sessions [--json] [--log-dir logs]
  wsl-serial-monitor logs tail --session latest [--lines 100] [--follow] [--json]
  wsl-serial-monitor logs search --session latest --query panic [--regex] [--limit 50] [--json]
  wsl-serial-monitor logs context --session latest --query watchdog [--before 10] [--after 10] [--limit 1] [--regex] [--json]
  wsl-serial-monitor logs stats --session latest [--json]
  wsl-serial-monitor logs export --session latest [--format json|csv|jsonl] [--pretty] [--output file]
  wsl-serial-monitor logs watch --session latest --query "error|panic" [--regex] [--filter-only] [--exec "cmd {}"] [--color #f44747] [--pattern "error:#f44747" --pattern "warning:#ffa500"]
`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
});
