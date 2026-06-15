const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const { LogStore, createSessionId, listSessions, resolveSession, readEvents, tailEvents, searchEvents, contextEvents, ensureDirectory, computeStats, exportEvents } = require(path.join(repoRoot, 'out', 'logStore'));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-serial-monitor-test-'));
}

test('LogStore.startSession creates log directory and file', async () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  const store = new LogStore(logDir);

  const { sessionId, filePath } = store.startSession('COM7', 115200);

  assert.ok(sessionId.includes('COM7'));
  // The directory should exist
  assert.ok(fs.existsSync(logDir));

  // Close session to flush the stream
  store.closeSession();

  // Wait for stream to flush
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Now the file should exist and contain the connected event
  assert.ok(fs.existsSync(filePath));
  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(content.includes('connected COM7 @ 115200 baud'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.appendSerialData writes NDJSON lines', async () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  const store = new LogStore(logDir);
  const { sessionId, filePath } = store.startSession('COM3', 9600);

  store.appendSerialData('line1\nline2\n');
  store.closeSession();

  // Wait for stream to flush
  await new Promise((resolve) => setTimeout(resolve, 50));

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  assert.ok(lines.length >= 3); // connected + line1 + line2
  const events = lines.map((l) => JSON.parse(l));
  assert.equal(events[1].text, 'line1');
  assert.equal(events[1].source, 'serial');
  assert.equal(events[2].text, 'line2');
  assert.ok(events[1].raw);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.closeSession flushes partial line buffer', async () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  const store = new LogStore(logDir);
  const { filePath } = store.startSession('COM1', 115200);

  store.appendSerialData('partial');
  store.closeSession('done');

  // Wait for stream to flush
  await new Promise((resolve) => setTimeout(resolve, 50));

  const content = fs.readFileSync(filePath, 'utf-8');
  const events = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const texts = events.map((e) => e.text);

  assert.ok(texts.includes('partial'));
  assert.ok(texts.includes('disconnected done'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.getCurrentSession returns undefined before start', () => {
  const dir = makeTmpDir();
  const store = new LogStore(path.join(dir, 'logs'));

  assert.equal(store.getCurrentSession(), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSessionId formats timestamp and port', () => {
  const date = new Date(2026, 0, 15, 10, 30, 45);
  const id = createSessionId('COM7', date);

  assert.equal(id, '20260115_103045_COM7');
});

test('createSessionId sanitizes special characters in port', () => {
  const date = new Date(2026, 0, 15, 10, 30, 45);
  const id = createSessionId('/dev/ttyUSB0', date);

  assert.ok(!id.includes('/'));
  assert.ok(id.includes('ttyUSB0'));
});

test('listSessions returns sessions sorted by mtime descending', async () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  ensureDirectory(logDir);

  const file1 = path.join(logDir, '20260101_000000_COM1.ndjson');
  const file2 = path.join(logDir, '20260102_000000_COM2.ndjson');
  fs.writeFileSync(file1, JSON.stringify({ ts: '2026-01-01', sessionId: 's1', port: 'COM1', baudRate: 9600, source: 'system', text: 'connected' }) + '\n');
  fs.writeFileSync(file2, JSON.stringify({ ts: '2026-01-02', sessionId: 's2', port: 'COM2', baudRate: 115200, source: 'system', text: 'connected' }) + '\n');

  // Ensure different mtimes
  const time1 = new Date('2026-01-01');
  const time2 = new Date('2026-01-02');
  fs.utimesSync(file1, time1, time1);
  fs.utimesSync(file2, time2, time2);

  const sessions = listSessions(logDir);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 's2');
  assert.equal(sessions[1].sessionId, 's1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions returns empty array for missing directory', () => {
  const sessions = listSessions('/nonexistent/path');
  assert.deepEqual(sessions, []);
});

test('resolveSession returns latest session', () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  ensureDirectory(logDir);

  const file = path.join(logDir, '20260101_000000_COM1.ndjson');
  fs.writeFileSync(file, JSON.stringify({ ts: '2026-01-01', sessionId: 's1', port: 'COM1', baudRate: 9600, source: 'system', text: 'connected' }) + '\n');

  const session = resolveSession(logDir, 'latest');
  assert.equal(session.sessionId, 's1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveSession throws for missing session', () => {
  const dir = makeTmpDir();
  assert.throws(() => resolveSession(dir), /No log sessions found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readEvents parses NDJSON file', () => {
  const dir = makeTmpDir();
  const file = path.join(dir, 'test.ndjson');
  const events = [
    { ts: '2026-01-01', sessionId: 's1', port: 'COM1', baudRate: 9600, source: 'system', text: 'connected' },
    { ts: '2026-01-01', sessionId: 's1', port: 'COM1', baudRate: 9600, source: 'serial', text: 'hello' }
  ];
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const result = readEvents(file);
  assert.equal(result.length, 2);
  assert.equal(result[1].text, 'hello');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readEvents throws for missing file', () => {
  assert.throws(() => readEvents('/nonexistent/file.ndjson'), /Log file not found/);
});

test('tailEvents returns last N events', () => {
  const events = [
    { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }
  ];
  const result = tailEvents(events, 3);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((e) => e.text), ['c', 'd', 'e']);
});

test('tailEvents returns all if lines > length', () => {
  const events = [{ text: 'a' }, { text: 'b' }];
  const result = tailEvents(events, 10);
  assert.equal(result.length, 2);
});

test('searchEvents finds matches with plain text', () => {
  const events = [
    { text: 'boot ok' },
    { text: 'error: failed' },
    { text: 'watchdog reset' },
    { text: 'recovered' }
  ];
  const matches = searchEvents(events, 'error');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].index, 1);
  assert.equal(matches[0].event.text, 'error: failed');
});

test('searchEvents finds matches with regex', () => {
  const events = [
    { text: 'boot ok' },
    { text: 'panic: crash' },
    { text: 'watchdog reset' }
  ];
  const matches = searchEvents(events, 'panic|watchdog', true);
  assert.equal(matches.length, 2);
});

test('searchEvents respects limit', () => {
  const events = [
    { text: 'error 1' },
    { text: 'error 2' },
    { text: 'error 3' }
  ];
  const matches = searchEvents(events, 'error', false, 2);
  assert.equal(matches.length, 2);
});

test('contextEvents returns surrounding events', () => {
  const events = [
    { text: 'a' }, { text: 'b' }, { text: 'target' }, { text: 'd' }, { text: 'e' }
  ];
  const matches = contextEvents(events, 'target', false, 1, 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchIndex, 2);
  assert.equal(matches[0].event.text, 'target');
  assert.equal(matches[0].before.length, 1);
  assert.equal(matches[0].after.length, 1);
  assert.equal(matches[0].before[0].text, 'b');
  assert.equal(matches[0].after[0].text, 'd');
});

test('contextEvents handles boundaries correctly', () => {
  const events = [
    { text: 'target' }, { text: 'b' }, { text: 'c' }
  ];
  const matches = contextEvents(events, 'target', false, 5, 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].before.length, 0);
  assert.equal(matches[0].after.length, 2);
});

test('ensureDirectory creates nested directories', () => {
  const dir = makeTmpDir();
  const nested = path.join(dir, 'a', 'b', 'c');
  ensureDirectory(nested);
  assert.ok(fs.existsSync(nested));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureDirectory does not throw for existing directory', () => {
  const dir = makeTmpDir();
  assert.doesNotThrow(() => ensureDirectory(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.cleanupOldSessions deletes files older than maxAgeDays', () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  ensureDirectory(logDir);

  const oldFile = path.join(logDir, 'old.ndjson');
  const newFile = path.join(logDir, 'new.ndjson');

  fs.writeFileSync(oldFile, 'test\n');
  fs.writeFileSync(newFile, 'test\n');

  const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

  const store = new LogStore(logDir);
  const result = store.cleanupOldSessions({ maxAgeDays: 30 });

  assert.equal(result.deleted, 1);
  assert.equal(result.kept, 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.cleanupOldSessions respects maxFiles limit', () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  ensureDirectory(logDir);

  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(logDir, `file${i}.ndjson`), 'test\n');
  }

  const store = new LogStore(logDir);
  const result = store.cleanupOldSessions({ maxFiles: 3 });

  assert.equal(result.deleted, 2);
  assert.equal(result.kept, 3);

  const remaining = fs.readdirSync(logDir).filter((f) => f.endsWith('.ndjson'));
  assert.equal(remaining.length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('LogStore.cleanupOldSessions returns zero for empty directory', () => {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'logs');
  ensureDirectory(logDir);

  const store = new LogStore(logDir);
  const result = store.cleanupOldSessions();

  assert.equal(result.deleted, 0);
  assert.equal(result.kept, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeStats returns correct statistics', () => {
  const events = [
    { ts: '2026-01-01T10:00:00Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'system', text: 'connected' },
    { ts: '2026-01-01T10:00:01Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'boot ok' },
    { ts: '2026-01-01T10:00:02Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'error: failed' },
    { ts: '2026-01-01T10:00:03Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'SBEngine init' },
    { ts: '2026-01-01T10:00:04Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'warning: timeout' },
    { ts: '2026-01-01T10:00:05Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'SBEngine start' }
  ];

  const stats = computeStats(events, 's1', 'COM1', 115200);

  assert.equal(stats.sessionId, 's1');
  assert.equal(stats.port, 'COM1');
  assert.equal(stats.totalEvents, 6);
  assert.equal(stats.serialEvents, 5);
  assert.equal(stats.systemEvents, 1);
  assert.equal(stats.errorCount, 1);
  assert.equal(stats.warningCount, 1);
  assert.equal(stats.topPatterns.length, 1);
  assert.equal(stats.topPatterns[0].pattern, 'SBEngine');
  assert.equal(stats.topPatterns[0].count, 2);
});

test('computeStats handles empty events', () => {
  const stats = computeStats([], 's1', 'COM1', 115200);

  assert.equal(stats.totalEvents, 0);
  assert.equal(stats.errorCount, 0);
  assert.equal(stats.warningCount, 0);
  assert.equal(stats.topPatterns.length, 0);
  assert.equal(stats.timeDistribution.length, 0);
});

test('exportEvents exports to CSV format', () => {
  const events = [
    { ts: '2026-01-01T10:00:00Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'hello' },
    { ts: '2026-01-01T10:00:01Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'world' }
  ];

  const csv = exportEvents(events, 'csv');
  const lines = csv.split('\n');

  assert.equal(lines[0], 'timestamp,source,port,baudRate,text');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('hello'));
  assert.ok(lines[2].includes('world'));
});

test('exportEvents exports to JSON format', () => {
  const events = [
    { ts: '2026-01-01T10:00:00Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'hello' }
  ];

  const json = exportEvents(events, 'json', true);
  const parsed = JSON.parse(json);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, 'hello');
});

test('exportEvents exports to JSONL format', () => {
  const events = [
    { ts: '2026-01-01T10:00:00Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'hello' },
    { ts: '2026-01-01T10:00:01Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'world' }
  ];

  const jsonl = exportEvents(events, 'jsonl');
  const lines = jsonl.split('\n');

  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, 'hello');
  assert.equal(JSON.parse(lines[1]).text, 'world');
});

test('exportEvents escapes quotes in CSV', () => {
  const events = [
    { ts: '2026-01-01T10:00:00Z', sessionId: 's1', port: 'COM1', baudRate: 115200, source: 'serial', text: 'say "hello"' }
  ];

  const csv = exportEvents(events, 'csv');
  assert.ok(csv.includes('say ""hello""'));
});

test('exportEvents throws for invalid format', () => {
  const events = [];
  assert.throws(() => exportEvents(events, 'xml'), /Unsupported export format/);
});
