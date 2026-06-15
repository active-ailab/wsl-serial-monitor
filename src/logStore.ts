import * as fs from 'fs';
import * as path from 'path';

export type LogEventSource = 'serial' | 'system';

export interface SerialLogEvent {
    ts: string;
    sessionId: string;
    port: string;
    baudRate: number;
    source: LogEventSource;
    text: string;
    raw?: string;
}

export interface LogSession {
    sessionId: string;
    port: string;
    baudRate: number;
    filePath: string;
    startTime?: string;
    mtimeMs: number;
    size: number;
}

export interface ContextMatch {
    matchIndex: number;
    event: SerialLogEvent;
    before: SerialLogEvent[];
    after: SerialLogEvent[];
    events: SerialLogEvent[];
}

export interface LogRotationConfig {
    maxAgeDays?: number;
    maxFiles?: number;
    maxTotalSizeMB?: number;
}

export class LogStore {
    private readonly logDir: string;
    private stream: fs.WriteStream | undefined;
    private currentSession: { sessionId: string; port: string; baudRate: number; filePath: string } | undefined;
    private lineBuffer = '';

    constructor(logDir: string) {
        this.logDir = logDir;
    }

    cleanupOldSessions(config: LogRotationConfig = {}): { deleted: number; kept: number } {
        const { maxAgeDays = 30, maxFiles = 100, maxTotalSizeMB = 500 } = config;

        if (!fs.existsSync(this.logDir)) {
            return { deleted: 0, kept: 0 };
        }

        const now = Date.now();
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const maxTotalSizeBytes = maxTotalSizeMB * 1024 * 1024;

        const files = fs.readdirSync(this.logDir)
            .filter((name) => name.endsWith('.ndjson'))
            .map((name) => {
                const filePath = path.join(this.logDir, name);
                const stat = fs.statSync(filePath);
                return { name, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        let totalSize = 0;
        let deleted = 0;
        const toDelete: string[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ageMs = now - file.mtimeMs;
            const isExpired = ageMs > maxAgeMs;
            const exceedsFileLimit = i >= maxFiles;
            const wouldExceedSize = totalSize + file.size > maxTotalSizeBytes;

            if (isExpired || exceedsFileLimit || wouldExceedSize) {
                toDelete.push(file.filePath);
            } else {
                totalSize += file.size;
            }
        }

        for (const filePath of toDelete) {
            try {
                fs.unlinkSync(filePath);
                deleted++;
            } catch {
                // Ignore errors (file may be in use)
            }
        }

        return { deleted, kept: files.length - deleted };
    }

    startSession(port: string, baudRate: number): { sessionId: string; filePath: string } {
        this.closeSession();
        ensureDirectory(this.logDir);

        const baseSessionId = createSessionId(port);
        let sessionId = baseSessionId;
        let filePath = path.join(this.logDir, `${sessionId}.ndjson`);
        let suffix = 2;
        while (fs.existsSync(filePath)) {
            sessionId = `${baseSessionId}_${suffix}`;
            filePath = path.join(this.logDir, `${sessionId}.ndjson`);
            suffix++;
        }

        // Create empty file immediately so it exists for callers
        fs.writeFileSync(filePath, '', { flag: 'a' });
        this.stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
        this.currentSession = { sessionId, port, baudRate, filePath };
        this.lineBuffer = '';
        this.appendSystemEvent(`connected ${port} @ ${baudRate} baud`);

        return { sessionId, filePath };
    }

    appendSerialData(data: string): void {
        if (!this.currentSession || !this.stream) {
            return;
        }

        this.lineBuffer += data;

        let nlIdx: number;
        while ((nlIdx = this.lineBuffer.indexOf('\n')) !== -1) {
            const line = this.lineBuffer.substring(0, nlIdx).replace(/\r$/, '');
            this.lineBuffer = this.lineBuffer.substring(nlIdx + 1);
            this.appendEvent({
                source: 'serial',
                text: line,
                raw: Buffer.from(line, 'utf-8').toString('hex')
            });
        }
    }

    appendSystemEvent(text: string): void {
        this.appendEvent({ source: 'system', text });
    }

    closeSession(reason?: string): void {
        if (!this.currentSession || !this.stream) {
            return;
        }

        if (this.lineBuffer.length > 0) {
            const line = this.lineBuffer.replace(/\r$/, '');
            this.lineBuffer = '';
            this.appendEvent({
                source: 'serial',
                text: line,
                raw: Buffer.from(line, 'utf-8').toString('hex')
            });
        }

        if (reason) {
            this.appendSystemEvent(`disconnected ${reason}`);
        }

        this.stream.end();
        this.stream = undefined;
        this.currentSession = undefined;
    }

    getCurrentSession(): { sessionId: string; filePath: string } | undefined {
        if (!this.currentSession) {
            return undefined;
        }
        return {
            sessionId: this.currentSession.sessionId,
            filePath: this.currentSession.filePath
        };
    }

    private appendEvent(event: Pick<SerialLogEvent, 'source' | 'text' | 'raw'>): void {
        if (!this.currentSession || !this.stream) {
            return;
        }

        const row: SerialLogEvent = {
            ts: new Date().toISOString(),
            sessionId: this.currentSession.sessionId,
            port: this.currentSession.port,
            baudRate: this.currentSession.baudRate,
            source: event.source,
            text: event.text,
            ...(event.raw ? { raw: event.raw } : {})
        };

        this.stream.write(`${JSON.stringify(row)}\n`);
    }
}

export function ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function createSessionId(port: string, date = new Date()): string {
    const timestamp = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
        '_',
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
        String(date.getSeconds()).padStart(2, '0')
    ].join('');

    return `${timestamp}_${sanitizeSessionPart(port)}`;
}

export function listSessions(logDir: string): LogSession[] {
    if (!fs.existsSync(logDir)) {
        return [];
    }

    const files = fs.readdirSync(logDir).filter((name) => name.endsWith('.ndjson'));
    
    // Process files - readFirstEvent is already optimized to read only first 8KB
    const sessions = files.map((name) => {
        const filePath = path.join(logDir, name);
        const stat = fs.statSync(filePath);
        const firstEvent = readFirstEvent(filePath);
        const sessionId = firstEvent?.sessionId ?? path.basename(name, '.ndjson');
        const parsed = parseSessionId(sessionId);
        return {
            sessionId,
            port: firstEvent?.port ?? parsed.port,
            baudRate: firstEvent?.baudRate ?? 0,
            filePath,
            startTime: firstEvent?.ts,
            mtimeMs: stat.mtimeMs,
            size: stat.size
        };
    });
    
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
}

export function resolveSession(logDir: string, selector = 'latest'): LogSession {
    const sessions = listSessions(logDir);
    if (sessions.length === 0) {
        throw new Error(`No log sessions found in ${logDir}`);
    }

    if (selector === 'latest') {
        return sessions[0];
    }

    const exact = sessions.find((session) => session.sessionId === selector);
    if (exact) {
        return exact;
    }

    const byFilename = sessions.find((session) => path.basename(session.filePath) === selector);
    if (byFilename) {
        return byFilename;
    }

    throw new Error(`Session not found: ${selector}`);
}

export function readEvents(filePath: string): SerialLogEvent[] {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Log file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const events: SerialLogEvent[] = [];
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as SerialLogEvent);
        } catch {
            // Ignore torn writes or manually edited invalid lines.
        }
    }
    return events;
}

export function tailEvents(events: SerialLogEvent[], lines: number): SerialLogEvent[] {
    return events.slice(Math.max(0, events.length - lines));
}

/**
 * Read last N lines directly from file without loading entire file.
 * Reads backwards from end in chunks for efficiency.
 */
export function tailEventsFromFile(filePath: string, lines: number): SerialLogEvent[] {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Log file not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const fd = fs.openSync(filePath, 'r');
    
    try {
        const results: SerialLogEvent[] = [];
        let position = stat.size;
        let remainder = '';
        let newlineCount = 0;

        while (position > 0 && newlineCount < lines + 1) {
            const readSize = Math.min(CHUNK_SIZE, position);
            position -= readSize;
            
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, position);
            
            const chunk = buffer.toString('utf-8') + remainder;
            const lineEndIdx = chunk.lastIndexOf('\n');
            
            if (lineEndIdx === -1) {
                remainder = chunk;
                continue;
            }
            
            const completePart = chunk.substring(0, lineEndIdx);
            remainder = chunk.substring(lineEndIdx + 1);
            
            const linesInChunk = completePart.split('\n');
            newlineCount += linesInChunk.length;
            
            // Parse lines in reverse to get last N
            for (let i = linesInChunk.length - 1; i >= 0 && results.length < lines; i--) {
                const line = linesInChunk[i].replace(/\r$/, '');
                if (!line.trim()) continue;
                try {
                    results.unshift(JSON.parse(line) as SerialLogEvent);
                } catch {
                    // Ignore invalid lines
                }
            }
        }
        
        // Handle remainder if we haven't read enough lines
        if (results.length < lines && remainder.trim()) {
            try {
                results.unshift(JSON.parse(remainder.replace(/\r$/, '')) as SerialLogEvent);
            } catch {
                // Ignore
            }
        }
        
        return results.slice(-lines); // Ensure exactly N lines
    } finally {
        fs.closeSync(fd);
    }
}

export function searchEvents(
    events: SerialLogEvent[],
    query: string,
    regex = false,
    limit = Number.POSITIVE_INFINITY
): Array<{ index: number; event: SerialLogEvent }> {
    const matcher = createMatcher(query, regex);
    const matches: Array<{ index: number; event: SerialLogEvent }> = [];

    for (let index = 0; index < events.length; index++) {
        if (matcher(events[index].text)) {
            matches.push({ index, event: events[index] });
            if (matches.length >= limit) {
                break;
            }
        }
    }

    return matches;
}

/**
 * Stream search: reads file line by line, stops early when limit reached.
 * Much more memory-efficient for large files with early matches.
 */
export function searchEventsStreaming(
    filePath: string,
    query: string,
    regex = false,
    limit = 50
): Array<{ index: number; event: SerialLogEvent }> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Log file not found: ${filePath}`);
    }

    const matcher = createMatcher(query, regex);
    const matches: Array<{ index: number; event: SerialLogEvent }> = [];
    
    const content = fs.readFileSync(filePath, 'utf-8');
    let index = 0;
    
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        
        try {
            const event = JSON.parse(line) as SerialLogEvent;
            if (matcher(event.text)) {
                matches.push({ index, event });
                if (matches.length >= limit) {
                    break; // Early termination
                }
            }
            index++;
        } catch {
            // Ignore invalid lines
            index++;
        }
    }
    
    return matches;
}

export function contextEvents(
    events: SerialLogEvent[],
    query: string,
    regex = false,
    before = 10,
    after = 10,
    limit = 1
): ContextMatch[] {
    return searchEvents(events, query, regex, limit).map(({ index, event }) => {
        const start = Math.max(0, index - before);
        const end = Math.min(events.length, index + after + 1);
        return {
            matchIndex: index,
            event,
            before: events.slice(start, index),
            after: events.slice(index + 1, end),
            events: events.slice(start, end)
        };
    });
}

function createMatcher(query: string, regex: boolean): (text: string) => boolean {
    if (regex) {
        const expression = new RegExp(query);
        return (text: string) => expression.test(text);
    }

    return (text: string) => text.includes(query);
}

function sanitizeSessionPart(value: string): string {
    const sanitized = value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
    return sanitized || 'serial';
}

function parseSessionId(sessionId: string): { port: string } {
    const match = sessionId.match(/^\d{8}_\d{6}_(.+)$/);
    return { port: match?.[1] ?? 'unknown' };
}

function readFirstEvent(filePath: string): SerialLogEvent | undefined {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/, 1)[0];
        if (!firstLine.trim()) {
            return undefined;
        }
        return JSON.parse(firstLine) as SerialLogEvent;
    } catch {
        return undefined;
    } finally {
        fs.closeSync(fd);
    }
}

// ---- Stats ----

export interface SessionStats {
    sessionId: string;
    port: string;
    baudRate: number;
    startTime?: string;
    endTime?: string;
    durationMs: number;
    totalEvents: number;
    serialEvents: number;
    systemEvents: number;
    sourceBreakdown: Record<string, number>;
    errorCount: number;
    warningCount: number;
    topPatterns: Array<{ pattern: string; count: number }>;
    timeDistribution: Array<{ hour: string; count: number }>;
}

// Combined regex for single-pass matching
const COMBINED_ERROR_REGEX = /\b(?:panic|error|fail(?:ed|ure)?|assert(?:ion)?|crash|abort|fatal|exception)\b/i;
const COMBINED_WARNING_REGEX = /\bwarn(?:ing)?|timeout|retry|reset|watchdog|OOM|out of memory\b/i;

const COMMON_PATTERNS = [
    { name: 'SBEngine', regex: /\bSBEngine\b/ },
    { name: 'hm_power', regex: /\bhm_power\b/ },
    { name: 'GNSS', regex: /\bGNSS\b/ },
    { name: 'HealthSe', regex: /\bHealthSe\b/ },
    { name: 'chargeSe', regex: /\bchargeSe\b/ },
    { name: 'PM_LOCKS', regex: /\bPM_LOCKS\b/ },
    { name: 'ALG_GPS', regex: /\bALG_GPS\b/ },
    { name: 'ALG_ALT', regex: /\bALG_ALT\b/ }
];

// Pre-compile combined pattern for COMMON_PATTERNS single-pass check
const COMMON_PATTERNS_COMBINED = COMMON_PATTERNS.map(p => ({
    name: p.name,
    regex: p.regex
}));

export function computeStats(events: SerialLogEvent[], sessionId: string, port: string, baudRate: number): SessionStats {
    const sourceBreakdown: Record<string, number> = {};
    let errorCount = 0;
    let warningCount = 0;
    const patternCounts: Record<string, number> = {};
    const hourCounts: Record<string, number> = {};

    for (const event of events) {
        // Source breakdown
        sourceBreakdown[event.source] = (sourceBreakdown[event.source] || 0) + 1;

        // Error/warning counts - single regex pass each
        if (COMBINED_ERROR_REGEX.test(event.text)) errorCount++;
        if (COMBINED_WARNING_REGEX.test(event.text)) warningCount++;

        // Common patterns - check each individually (they're distinct keywords)
        for (const pattern of COMMON_PATTERNS_COMBINED) {
            if (pattern.regex.test(event.text)) {
                patternCounts[pattern.name] = (patternCounts[pattern.name] || 0) + 1;
            }
        }

        // Time distribution
        if (event.ts) {
            try {
                const date = new Date(event.ts);
                const hour = String(date.getHours()).padStart(2, '0') + ':00';
                hourCounts[hour] = (hourCounts[hour] || 0) + 1;
            } catch {
                // Ignore invalid timestamps
            }
        }
    }

    // Sort patterns by count
    const topPatterns = Object.entries(patternCounts)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    // Sort time distribution
    const timeDistribution = Object.entries(hourCounts)
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => a.hour.localeCompare(b.hour));

    // Calculate duration
    let durationMs = 0;
    let startTime: string | undefined;
    let endTime: string | undefined;
    if (events.length > 0) {
        startTime = events[0].ts;
        endTime = events[events.length - 1].ts;
        try {
            const start = new Date(startTime);
            const end = new Date(endTime);
            durationMs = end.getTime() - start.getTime();
        } catch {
            // Ignore invalid timestamps
        }
    }

    return {
        sessionId,
        port,
        baudRate,
        startTime,
        endTime,
        durationMs,
        totalEvents: events.length,
        serialEvents: sourceBreakdown['serial'] || 0,
        systemEvents: sourceBreakdown['system'] || 0,
        sourceBreakdown,
        errorCount,
        warningCount,
        topPatterns,
        timeDistribution
    };
}

// ---- Export ----

export type ExportFormat = 'csv' | 'json' | 'jsonl';

export function exportToCsv(events: SerialLogEvent[]): string {
    const header = 'timestamp,source,port,baudRate,text';
    const rows = events.map(event => {
        const text = event.text.replace(/"/g, '""');
        return `"${event.ts}","${event.source}","${event.port}",${event.baudRate},"${text}"`;
    });
    return [header, ...rows].join('\n');
}

export function exportToJson(events: SerialLogEvent[], pretty = false): string {
    return JSON.stringify(events, null, pretty ? 2 : undefined);
}

export function exportToJsonl(events: SerialLogEvent[]): string {
    return events.map(event => JSON.stringify(event)).join('\n');
}

export function exportEvents(events: SerialLogEvent[], format: ExportFormat, pretty = false): string {
    switch (format) {
        case 'csv':
            return exportToCsv(events);
        case 'json':
            return exportToJson(events, pretty);
        case 'jsonl':
            return exportToJsonl(events);
        default:
            throw new Error(`Unsupported export format: ${format}`);
    }
}
