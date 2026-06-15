const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'out', 'cli.js');

function makeLogFixture(lines = ['boot ok', 'panic: foo', 'watchdog reset']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-serial-monitor-test-'));
  const logDir = path.join(root, 'logs');
  const { LogStore } = require(path.join(repoRoot, 'out', 'logStore'));
  const store = new LogStore(logDir);
  const session = store.startSession('COM7', 115200);
  store.appendSerialData(`${lines.join('\n')}\n`);
  store.closeSession('done');
  return { root, logDir, session };
}

async function makeFlushedLogFixture(lines) {
  const fixture = makeLogFixture(lines);
  await waitFor(() => {
    if (!fs.existsSync(fixture.session.filePath)) {
      return false;
    }
    return fs.readFileSync(fixture.session.filePath, 'utf-8').includes('disconnected done');
  });
  return fixture;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for log fixture to flush');
}

function runCli(args, cwd = repoRoot) {
  return execFileSync(process.execPath, [cliPath, 'logs', ...args], {
    cwd,
    encoding: 'utf-8'
  });
}

test('lists persisted log sessions newest first', async () => {
  const fixture = await makeFlushedLogFixture();

  const output = runCli(['sessions', '--log-dir', fixture.logDir]);

  assert.match(output, /COM7/);
  assert.match(output, /115200/);
  assert.match(output, new RegExp(fixture.session.sessionId));
});

test('search returns structured JSON matches', async () => {
  const fixture = await makeFlushedLogFixture();

  const output = runCli([
    'search',
    '--log-dir',
    fixture.logDir,
    '--session',
    'latest',
    '--query',
    'panic|watchdog',
    '--regex',
    '--json'
  ]);
  const matches = JSON.parse(output);

  assert.equal(matches.length, 2);
  assert.equal(matches[0].event.text, 'panic: foo');
  assert.equal(matches[1].event.text, 'watchdog reset');
});

test('context includes before and after lines around a match', async () => {
  const fixture = await makeFlushedLogFixture();

  const output = runCli([
    'context',
    '--log-dir',
    fixture.logDir,
    '--session',
    'latest',
    '--query',
    'panic',
    '--before',
    '1',
    '--after',
    '1',
    '--json'
  ]);
  const matches = JSON.parse(output);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].event.text, 'panic: foo');
  assert.deepEqual(matches[0].events.map((event) => event.text), [
    'boot ok',
    'panic: foo',
    'watchdog reset'
  ]);
});

test('tail returns the requested number of recent events', async () => {
  const fixture = await makeFlushedLogFixture();

  const output = runCli([
    'tail',
    '--log-dir',
    fixture.logDir,
    '--session',
    'latest',
    '--lines',
    '2',
    '--json'
  ]);
  const events = JSON.parse(output);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.text), ['watchdog reset', 'disconnected done']);
});
