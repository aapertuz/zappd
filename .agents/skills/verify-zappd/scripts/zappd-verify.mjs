#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  capturePageSnapshot,
  getProcessCommand,
  isExpectedChromeProcess,
  isProcessAlive,
  launchChromeSession,
  performBrowserAction,
  terminateProcessGroup,
  waitForBrowserState,
} from './cdp-browser.mjs';

const BASE_DIR = '/tmp/zappd-verify';
const RUNS_DIR = path.join(BASE_DIR, 'runs');
const EVIDENCE_DIR = path.join(BASE_DIR, 'evidence');
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_PORT_START = 18081;
const DEFAULT_PORT_END = 18999;
const DEFAULT_CDP_PORT_START = 19222;
const DEFAULT_CDP_PORT_END = 19999;
const DEFAULT_TIMEOUT_MS = 60000;
const BOOLEAN_FLAGS = new Set(['clear']);

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message, extra = {}) {
  printJson({ ok: false, error: message, ...extra });
  process.exit(1);
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printJson({
      ok: true,
      usage:
        'zappd-verify.mjs <launch|doctor|save-evidence|browser-open|browser-act|browser-wait|browser-snapshot|browser-close|cleanup|list> [flags]',
    });
    process.exit(0);
  }

  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      fail(`Unexpected positional argument: ${token}`);
    }
    const equalIndex = token.indexOf('=');
    if (equalIndex !== -1) {
      const key = token.slice(2, equalIndex);
      const value = token.slice(equalIndex + 1);
      if (!key) {
        fail(`Invalid flag syntax: ${token}`);
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = value !== 'false';
      } else {
        flags[key] = value;
      }
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const nextToken = rest[index + 1];
    if (nextToken === undefined || nextToken.startsWith('--')) {
      fail(`Missing value for flag --${key}`);
    }
    flags[key] = nextToken;
    index += 1;
  }

  return { command, flags };
}

function assertValidId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(`Invalid ${label}: must match ${ID_PATTERN.source}`);
  }
  return value;
}

function resolveRepoRoot() {
  const cwdRoot = fs.realpathSync(process.cwd());
  const packageJsonPath = path.join(cwdRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fail(`Missing package.json in ${cwdRoot}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (pkg.name !== 'zappd') {
    fail(`Expected package.json name "zappd" in ${cwdRoot}, found "${pkg.name}"`);
  }
  return cwdRoot;
}

function getGitHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function isExpectedExpoProcess(pid, port) {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const command = getProcessCommand(pid);
  if (!command) {
    return false;
  }
  const portPattern = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`);
  return command.includes('expo') && portPattern.test(command);
}

function getListeningPids(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number.parseInt(line.slice(1), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function canBindLocalhostPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function isPortFree(port) {
  if (getListeningPids(port).length > 0) {
    return false;
  }
  return canBindLocalhostPort(port);
}

function readExistingRuns() {
  if (!fs.existsSync(RUNS_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statePath = path.join(RUNS_DIR, entry.name, 'state.json');
    if (!fs.existsSync(statePath)) {
      continue;
    }
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      runs.push(state);
    } catch {
      runs.push({ runId: entry.name, corrupt: true, statePath });
    }
  }
  return runs;
}

function readRunState(runId) {
  const runDir = path.join(RUNS_DIR, runId);
  const statePath = path.join(runDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    fail(`No run state found for run-id "${runId}" at ${statePath}`);
  }
  return { runDir, statePath, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
}

function writeRunState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readLogTail(logPath, lineCount = 40) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(-lineCount);
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

function extractBundlePath(html) {
  const match = /(?:href|src)="([^"]*entry\.bundle[^"]*)"/i.exec(html);
  if (!match) {
    return null;
  }
  const unescaped = match[1].replaceAll('&amp;', '&');
  return unescaped.startsWith('/') ? unescaped : `/${unescaped}`;
}

function listFilesRecursive(dirPath, rootDir = dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath, rootDir));
    } else if (entry.isFile()) {
      results.push(path.relative(rootDir, fullPath));
    }
  }
  return results.sort();
}

async function terminateAndVerifyPortClosed(pid, port, sigtermWaitMs) {
  await terminateProcessGroup(pid, sigtermWaitMs);
  const portDeadline = Date.now() + 3000;
  while (getListeningPids(port).includes(pid) && Date.now() < portDeadline) {
    await delay(100);
  }
}

async function checkInstanceUsable(baseUrl, repoRoot, remainingMs) {
  const statusTimeout = Math.min(3000, Math.max(500, remainingMs));
  const statusRes = await fetchText(`${baseUrl}/status`, statusTimeout);
  if (statusRes.status !== 200 || statusRes.body.trim() !== 'packager-status:running') {
    return {
      ready: false,
      reason: `Unexpected /status response: status=${statusRes.status} body=${JSON.stringify(statusRes.body.trim())}`,
    };
  }

  const headerRoot = statusRes.headers.get('x-react-native-project-root');
  if (!headerRoot) {
    return { ready: false, reason: 'Missing X-React-Native-Project-Root header on /status' };
  }
  const realHeaderRoot = fs.realpathSync(headerRoot);
  if (realHeaderRoot !== repoRoot) {
    return {
      ready: false,
      reason: `Port project root mismatch: expected ${repoRoot}, got ${realHeaderRoot}`,
    };
  }

  const rootRes = await fetchText(`${baseUrl}/`, Math.min(10000, Math.max(1000, remainingMs)));
  const contentType = rootRes.headers.get('content-type') ?? '';
  if (rootRes.status !== 200 || !contentType.includes('text/html')) {
    return {
      ready: false,
      reason: `Unexpected / response: status=${rootRes.status} content-type=${contentType}`,
    };
  }
  if (
    !rootRes.body.includes('aria-label="Prompt input"') ||
    !rootRes.body.includes('aria-label="Send"')
  ) {
    return {
      ready: false,
      reason: 'Root HTML missing expected Prompt input or Send controls',
    };
  }

  const bundlePath = extractBundlePath(rootRes.body);
  if (!bundlePath) {
    return { ready: false, reason: 'Root HTML missing entry.bundle URL' };
  }

  const bundleRes = await fetchText(
    `${baseUrl}${bundlePath}`,
    Math.min(20000, Math.max(2000, remainingMs)),
  );
  if (bundleRes.status !== 200 || bundleRes.body.length === 0) {
    return {
      ready: false,
      reason: `Client web bundle failed: status=${bundleRes.status} path=${bundlePath}`,
    };
  }

  const settleRes = await fetchText(`${baseUrl}/`, Math.min(10000, Math.max(1000, remainingMs)));
  if (
    settleRes.status !== 200 ||
    !settleRes.body.includes('aria-label="Prompt input"') ||
    !settleRes.body.includes('aria-label="Send"')
  ) {
    return {
      ready: false,
      reason: `Post-bundle SSR check not ready: status=${settleRes.status}`,
    };
  }

  return { ready: true, bundlePath };
}

function writeFeatureEvidence({
  runId,
  feature,
  step,
  state,
  screenshotPath,
  screenshotBuffer,
  snapshotPath,
  snapshotLines,
  entryPoint,
  note,
}) {
  const featureDir = path.join(EVIDENCE_DIR, runId, feature);
  fs.mkdirSync(featureDir, { recursive: true });

  const files = [];
  if (screenshotBuffer !== undefined) {
    if (!Buffer.isBuffer(screenshotBuffer) || screenshotBuffer.length === 0) {
      fail('Captured screenshot buffer is empty');
    }
    const targetPath = path.join(featureDir, `${step}.png`);
    fs.writeFileSync(targetPath, screenshotBuffer);
    files.push(targetPath);
  } else if (screenshotPath !== undefined) {
    const sourcePath = path.resolve(screenshotPath);
    if (!fs.existsSync(sourcePath)) {
      fail(`Screenshot source file not found: ${sourcePath}`);
    }
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size === 0) {
      fail(`Screenshot source file is empty or not a regular file: ${sourcePath}`);
    }
    const targetPath = path.join(featureDir, `${step}.png`);
    fs.copyFileSync(sourcePath, targetPath);
    files.push(targetPath);
  }

  if (Array.isArray(snapshotLines)) {
    const targetPath = path.join(featureDir, `${step}.aria.txt`);
    fs.writeFileSync(targetPath, `${snapshotLines.join('\n')}\n`);
    files.push(targetPath);
  } else if (snapshotPath !== undefined) {
    const sourcePath = path.resolve(snapshotPath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      fail(`Snapshot source file not found: ${sourcePath}`);
    }
    const targetPath = path.join(featureDir, `${step}.aria.txt`);
    fs.copyFileSync(sourcePath, targetPath);
    files.push(targetPath);
  }

  const metaPath = path.join(featureDir, `${step}.meta.json`);
  const metadata = {
    runId,
    feature,
    step,
    entryPoint: entryPoint ?? null,
    note: note ?? null,
    timestamp: new Date().toISOString(),
    url: state?.url ?? null,
    gitHead: state?.gitHead ?? null,
    files: [...files, metaPath],
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
  files.push(metaPath);

  return { featureDir, files };
}

async function handleLaunch(flags) {
  const repoRoot = resolveRepoRoot();
  const runId = flags['run-id']
    ? assertValidId(flags['run-id'], 'run-id')
    : `zappd-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const timeoutMs = flags['timeout-ms']
    ? Number.parseInt(flags['timeout-ms'], 10)
    : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    fail(`Invalid --timeout-ms value: ${flags['timeout-ms']}`);
  }

  const runDir = path.join(RUNS_DIR, runId);
  if (fs.existsSync(runDir)) {
    fail(`Run ID already exists: ${runId}`);
  }

  const existingRuns = readExistingRuns();
  for (const existing of existingRuns) {
    if (
      !existing.corrupt &&
      existing.repoRoot === repoRoot &&
      isExpectedExpoProcess(existing.pid, existing.port)
    ) {
      fail(
        `Another active verification run already exists for ${repoRoot} (${existing.runId}, pid ${existing.pid}, port ${existing.port}). Run: ./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id ${existing.runId}`,
        { activeRunId: existing.runId, activePid: existing.pid, activePort: existing.port },
      );
    }
  }

  const reservedPorts = new Set(
    existingRuns
      .filter((existing) => !existing.corrupt && isExpectedExpoProcess(existing.pid, existing.port))
      .map((existing) => existing.port),
  );

  let port = null;
  if (flags.port !== undefined) {
    const parsedPort = Number.parseInt(flags.port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      fail(`Invalid --port value: ${flags.port}`);
    }
    if (reservedPorts.has(parsedPort) || !(await isPortFree(parsedPort))) {
      fail(`Requested port ${parsedPort} is already in use`);
    }
    port = parsedPort;
  } else {
    for (let candidate = DEFAULT_PORT_START; candidate <= DEFAULT_PORT_END; candidate += 1) {
      if (!reservedPorts.has(candidate) && (await isPortFree(candidate))) {
        port = candidate;
        break;
      }
    }
    if (port === null) {
      fail(`No free port available in range ${DEFAULT_PORT_START}..${DEFAULT_PORT_END}`);
    }
  }

  const require = createRequire(path.join(repoRoot, 'package.json'));
  const expoCliPath = require.resolve('expo/bin/cli');
  const gitHead = getGitHead(repoRoot);
  const evidenceDir = path.join(EVIDENCE_DIR, runId);

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const logPath = path.join(runDir, 'metro.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    [expoCliPath, 'start', '--localhost', '--port', String(port)],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        EXPO_NO_TELEMETRY: '1',
        BROWSER: 'none',
      },
    },
  );
  fs.closeSync(logFd);

  if (!child.pid) {
    fs.rmSync(runDir, { recursive: true, force: true });
    fail('Failed to spawn Expo Metro process');
  }

  const statePath = path.join(runDir, 'state.json');
  const state = {
    runId,
    pid: child.pid,
    pgid: child.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    repoRoot,
    gitHead,
    startedAt: new Date().toISOString(),
    logPath,
    evidenceDir,
  };
  writeRunState(statePath, state);
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let lastReason = 'Timed out waiting for Metro readiness';

  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid)) {
      lastReason = `Expo Metro process ${child.pid} exited prematurely`;
      break;
    }

    try {
      const readiness = await checkInstanceUsable(state.url, repoRoot, deadline - Date.now());
      if (readiness.ready) {
        printJson({
          ok: true,
          runId,
          pid: child.pid,
          port,
          url: state.url,
          repoRoot,
          gitHead,
          logPath,
          evidenceDir,
          bundlePath: readiness.bundlePath,
        });
        return;
      }
      lastReason = readiness.reason;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    await delay(500);
  }

  const logTail = readLogTail(logPath, 40);
  await terminateAndVerifyPortClosed(child.pid, port, 3000);
  fs.rmSync(runDir, { recursive: true, force: true });
  fail(lastReason, { runId, port, logTail });
}

async function handleDoctor(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { state } = readRunState(runId);
  const currentRepoRoot = resolveRepoRoot();
  const checks = [];

  const command = getProcessCommand(state.pid);
  const processAliveOk = isExpectedExpoProcess(state.pid, state.port);
  checks.push({
    name: 'processAlive',
    ok: processAliveOk,
    detail: processAliveOk
      ? `pid ${state.pid} running (${command})`
      : `pid ${state.pid} missing or unexpected command (${command ?? 'not running'})`,
  });

  const listeningPids = getListeningPids(state.port);
  const portOwnerOk = listeningPids.includes(state.pid);
  checks.push({
    name: 'portOwner',
    ok: portOwnerOk,
    detail: portOwnerOk
      ? `port ${state.port} owned by pid ${state.pid}`
      : `port ${state.port} listeners: [${listeningPids.join(', ')}] (expected ${state.pid})`,
  });

  let statusOk = false;
  let statusDetail = 'not checked';
  try {
    const statusRes = await fetchText(`${state.url}/status`, 3000);
    const headerRoot = statusRes.headers.get('x-react-native-project-root');
    const realHeaderRoot = headerRoot ? fs.realpathSync(headerRoot) : null;
    statusOk =
      statusRes.status === 200 &&
      statusRes.body.trim() === 'packager-status:running' &&
      realHeaderRoot === state.repoRoot &&
      realHeaderRoot === currentRepoRoot;
    statusDetail = `status=${statusRes.status} body=${statusRes.body.trim()} projectRoot=${realHeaderRoot}`;
  } catch (error) {
    statusDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: 'statusEndpoint', ok: statusOk, detail: statusDetail });

  let routeOk = false;
  let routeDetail = 'not checked';
  try {
    const rootRes = await fetchText(`${state.url}/`, 8000);
    const contentType = rootRes.headers.get('content-type') ?? '';
    const hasControls =
      rootRes.body.includes('aria-label="Prompt input"') &&
      rootRes.body.includes('aria-label="Send"');
    routeOk = rootRes.status === 200 && contentType.includes('text/html') && hasControls;
    routeDetail = `status=${rootRes.status} content-type=${contentType} hasControls=${hasControls}`;
  } catch (error) {
    routeDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: 'rootRouteRender', ok: routeOk, detail: routeDetail });

  let orchestrateOk = false;
  let orchestrateDetail = 'not checked';
  try {
    const apiRes = await fetchText(`${state.url}/api/orchestrate`, 5000);
    const parsed = apiRes.status === 200 ? JSON.parse(apiRes.body) : null;
    const configured = Array.isArray(parsed?.configuredProviders)
      ? parsed.configuredProviders
      : null;
    orchestrateOk = apiRes.status === 200 && configured !== null;
    orchestrateDetail = orchestrateOk
      ? `status=200 configuredProviders=[${configured.join(', ')}] defaultProvider=${String(parsed.defaultProvider ?? '')}`
      : `status=${apiRes.status} body=${apiRes.body.slice(0, 120)}`;
  } catch (error) {
    orchestrateDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: 'orchestrateEndpoint', ok: orchestrateOk, detail: orchestrateDetail });

  const currentGitHead = getGitHead(state.repoRoot);
  const gitOk = currentGitHead === state.gitHead;
  checks.push({
    name: 'gitRevisionMatch',
    ok: gitOk,
    detail: `recorded=${state.gitHead} current=${currentGitHead}`,
  });

  const evidenceOk =
    typeof state.evidenceDir === 'string' &&
    fs.existsSync(state.evidenceDir) &&
    fs.statSync(state.evidenceDir).isDirectory();
  checks.push({
    name: 'evidenceDirExists',
    ok: evidenceOk,
    detail: state.evidenceDir,
  });

  if (state.browser) {
    let browserOk = isExpectedChromeProcess(state.browser.pid, state.browser.profileDir);
    let browserDetail = browserOk
      ? `pid ${state.browser.pid} CDP port ${state.browser.cdpPort}`
      : `browser pid ${state.browser.pid} missing or profile mismatch`;
    if (browserOk) {
      try {
        const versionRes = await fetchText(
          `http://127.0.0.1:${state.browser.cdpPort}/json/version`,
          2000,
        );
        browserOk = versionRes.status === 200;
        browserDetail = `${browserDetail} cdpStatus=${versionRes.status}`;
      } catch (error) {
        browserOk = false;
        browserDetail = error instanceof Error ? error.message : String(error);
      }
    }
    checks.push({
      name: 'browserAlive',
      ok: browserOk,
      detail: browserDetail,
    });
  }

  const ok = checks.every((check) => check.ok);
  printJson({
    ok,
    runId,
    pid: state.pid,
    port: state.port,
    url: state.url,
    evidenceDir: state.evidenceDir,
    checks,
  });
  if (!ok) {
    process.exit(1);
  }
}

function handleSaveEvidence(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const feature = assertValidId(flags.feature, 'feature');
  const step = assertValidId(flags.step, 'step');

  const statePath = path.join(RUNS_DIR, runId, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;

  const { featureDir, files } = writeFeatureEvidence({
    runId,
    feature,
    step,
    state,
    screenshotPath: flags.screenshot,
    snapshotPath: flags['snapshot-file'],
    entryPoint: flags['entry-point'],
    note: flags.note,
  });

  printJson({
    ok: true,
    runId,
    feature,
    step,
    evidencePath: featureDir,
    files,
  });
}

async function handleBrowserOpen(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { runDir, statePath, state } = readRunState(runId);

  if (state.browser && isExpectedChromeProcess(state.browser.pid, state.browser.profileDir)) {
    fail(`Browser session already open for run "${runId}" (pid ${state.browser.pid})`, {
      runId,
      cdpPort: state.browser.cdpPort,
    });
  }

  const targetPath = flags.path ?? '/';
  const width = flags.width ? Number.parseInt(flags.width, 10) : 1280;
  const height = flags.height ? Number.parseInt(flags.height, 10) : 800;
  if (!Number.isInteger(width) || width < 240 || !Number.isInteger(height) || height < 240) {
    fail('Invalid --width or --height');
  }

  const claimedCdpPorts = new Set(
    readExistingRuns()
      .filter(
        (run) =>
          !run.corrupt &&
          run.browser?.cdpPort &&
          isExpectedChromeProcess(run.browser.pid, run.browser.profileDir),
      )
      .map((run) => run.browser.cdpPort),
  );

  let cdpPort = null;
  for (let candidate = DEFAULT_CDP_PORT_START; candidate <= DEFAULT_CDP_PORT_END; candidate += 1) {
    if (!claimedCdpPorts.has(candidate) && (await isPortFree(candidate))) {
      cdpPort = candidate;
      break;
    }
  }
  if (cdpPort === null) {
    fail(`No free CDP port in ${DEFAULT_CDP_PORT_START}..${DEFAULT_CDP_PORT_END}`);
  }

  const profileDir = path.join(runDir, 'chrome-profile');
  const chromeLogPath = path.join(runDir, 'chrome.log');
  const targetUrl = new URL(targetPath, state.url).toString();

  try {
    const browser = await launchChromeSession({
      url: targetUrl,
      profileDir,
      cdpPort,
      logPath: chromeLogPath,
      width,
      height,
    });
    state.browser = browser;
    writeRunState(statePath, state);
    printJson({
      ok: true,
      runId,
      pid: browser.pid,
      cdpPort: browser.cdpPort,
      url: targetUrl,
      width,
      height,
      targetId: browser.targetId,
    });
  } catch (error) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fail(error instanceof Error ? error.message : String(error), {
      runId,
      logTail: readLogTail(chromeLogPath, 30),
    });
  }
}

async function handleBrowserAct(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { statePath, state } = readRunState(runId);

  if (!state.browser || !isExpectedChromeProcess(state.browser.pid, state.browser.profileDir)) {
    fail(`No active headless browser session for run "${runId}". Run browser-open first.`);
  }

  const action = flags.action;
  if (!action) {
    fail('Missing --action');
  }

  const options = {
    action,
    role: flags.role,
    name: flags.name,
    x: flags.x === undefined ? undefined : Number(flags.x.trim() || NaN),
    y: flags.y === undefined ? undefined : Number(flags.y.trim() || NaN),
    text: flags.text,
    clear: Boolean(flags.clear),
    key: flags.key,
    modifiers: flags.modifiers ? flags.modifiers.split(',') : [],
    width: flags.width ? Number.parseInt(flags.width, 10) : undefined,
    height: flags.height ? Number.parseInt(flags.height, 10) : undefined,
    viewport: {
      width: state.browser.width,
      height: state.browser.height,
    },
  };

  if (action === 'click') {
    const hasCoordinates = options.x !== undefined || options.y !== undefined;
    if (hasCoordinates && (!Number.isFinite(options.x) || !Number.isFinite(options.y))) {
      fail('Coordinate click requires finite --x and --y');
    }
    if (hasCoordinates && (options.role !== undefined || options.name !== undefined)) {
      fail('Choose --x and --y or --role and --name for a click');
    }
    if (!hasCoordinates && (!options.role || !options.name)) {
      fail('click action requires --role and --name or --x and --y');
    }
  }
  if (action === 'type' && (!options.role || !options.name)) {
    fail('type action requires --role and --name');
  }
  if (action === 'press' && !options.key) {
    fail('press action requires --key');
  }
  if (
    action === 'resize' &&
    (!Number.isInteger(options.width) || !Number.isInteger(options.height))
  ) {
    fail('resize action requires integer --width and --height');
  }

  try {
    const result = await performBrowserAction(state.browser.pageWsUrl, options);
    if (action === 'resize') {
      state.browser.width = options.width;
      state.browser.height = options.height;
      writeRunState(statePath, state);
    }
    printJson({
      ok: true,
      runId,
      action,
      diagnostics: result.diagnostics,
      errors: result.errors,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), { runId, action });
  }
}

async function handleBrowserWait(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { state } = readRunState(runId);

  if (!state.browser || !isExpectedChromeProcess(state.browser.pid, state.browser.profileDir)) {
    fail(`No active headless browser session for run "${runId}". Run browser-open first.`);
  }

  const timeoutMs = flags['timeout-ms'] ? Number.parseInt(flags['timeout-ms'], 10) : 25000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500) {
    fail(`Invalid --timeout-ms value: ${flags['timeout-ms']}`);
  }

  try {
    const result = await waitForBrowserState(state.browser.pageWsUrl, {
      archetype: flags.archetype,
      provider: flags.provider,
      text: flags.text,
      timeoutMs,
      viewport: {
        width: state.browser.width,
        height: state.browser.height,
      },
    });
    printJson({
      ok: true,
      runId,
      diagnostics: result.diagnostics,
      errors: result.errors,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), { runId });
  }
}

async function handleBrowserSnapshot(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { state } = readRunState(runId);

  if (!state.browser || !isExpectedChromeProcess(state.browser.pid, state.browser.profileDir)) {
    fail(`No active headless browser session for run "${runId}". Run browser-open first.`);
  }

  try {
    const snapshot = await capturePageSnapshot(state.browser.pageWsUrl, {
      width: state.browser.width,
      height: state.browser.height,
    });
    let saved = null;
    if (flags.feature !== undefined || flags.step !== undefined) {
      const feature = assertValidId(flags.feature, 'feature');
      const step = assertValidId(flags.step, 'step');
      saved = writeFeatureEvidence({
        runId,
        feature,
        step,
        state,
        screenshotBuffer: snapshot.pngBuffer,
        snapshotLines: snapshot.ariaLines,
        entryPoint: flags['entry-point'],
        note: flags.note,
      });
    }

    printJson({
      ok: true,
      runId,
      diagnostics: snapshot.diagnostics,
      errors: snapshot.errors,
      ariaLines: snapshot.ariaLines,
      evidencePath: saved?.featureDir ?? null,
      files: saved?.files ?? [],
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), { runId });
  }
}

async function handleBrowserClose(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const { statePath, state } = readRunState(runId);
  if (!state.browser) {
    printJson({ ok: true, runId, alreadyClosed: true });
    return;
  }

  const browserPid = state.browser.pid;
  const profileDir = state.browser.profileDir;
  if (isProcessAlive(browserPid)) {
    if (!isExpectedChromeProcess(browserPid, profileDir)) {
      fail(`Refusing to kill browser pid ${browserPid}: command does not match ${profileDir}`);
    }
    await terminateAndVerifyPortClosed(browserPid, state.browser.cdpPort, 4000);
  }

  fs.rmSync(profileDir, { recursive: true, force: true });
  delete state.browser;
  writeRunState(statePath, state);
  printJson({ ok: true, runId, closedChromePid: browserPid });
}

async function handleCleanup(flags) {
  const runId = assertValidId(flags['run-id'], 'run-id');
  const runDir = path.join(RUNS_DIR, runId);
  const statePath = path.join(runDir, 'state.json');
  const evidenceDir = path.join(EVIDENCE_DIR, runId);

  if (!fs.existsSync(statePath)) {
    const evidenceFiles = listFilesRecursive(evidenceDir);
    printJson({
      ok: true,
      runId,
      alreadyCleaned: true,
      evidenceDir,
      evidenceFiles,
      evidenceFileCount: evidenceFiles.length,
    });
    return;
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  let stoppedBrowserPid = null;
  if (state.browser && isProcessAlive(state.browser.pid)) {
    if (!isExpectedChromeProcess(state.browser.pid, state.browser.profileDir)) {
      fail(
        `Refusing to kill browser pid ${state.browser.pid}: command does not match ${state.browser.profileDir}`,
        { runId },
      );
    }
    await terminateAndVerifyPortClosed(state.browser.pid, state.browser.cdpPort, 4000);
    stoppedBrowserPid = state.browser.pid;
  }

  let stoppedPid = null;
  if (isProcessAlive(state.pid)) {
    if (!isExpectedExpoProcess(state.pid, state.port)) {
      fail(
        `Refusing to kill pid ${state.pid}: process command does not match Expo on port ${state.port}`,
        { runId, pid: state.pid, port: state.port, command: getProcessCommand(state.pid) },
      );
    }
    await terminateAndVerifyPortClosed(state.pid, state.port, 5000);
    if (isProcessAlive(state.pid)) {
      fail(`Failed to terminate Expo Metro pid ${state.pid}`, { runId, pid: state.pid });
    }
    stoppedPid = state.pid;
  }

  const remainingPids = getListeningPids(state.port);
  const portClosed = !remainingPids.includes(state.pid);
  if (!portClosed) {
    fail(`Port ${state.port} still held by pid ${state.pid}`, { runId, port: state.port });
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  const evidenceFiles = listFilesRecursive(evidenceDir);

  printJson({
    ok: true,
    runId,
    stoppedPid,
    stoppedBrowserPid,
    portClosed,
    removedRunDir: runDir,
    evidenceDir,
    evidenceFileCount: evidenceFiles.length,
  });
}

function handleList() {
  const runs = readExistingRuns().map((run) => {
    if (run.corrupt) {
      return run;
    }
    return {
      runId: run.runId,
      pid: run.pid,
      alive: isExpectedExpoProcess(run.pid, run.port),
      port: run.port,
      url: run.url,
      repoRoot: run.repoRoot,
      browserAlive: run.browser
        ? isExpectedChromeProcess(run.browser.pid, run.browser.profileDir)
        : false,
      evidenceDir: run.evidenceDir,
      startedAt: run.startedAt,
    };
  });
  printJson({ ok: true, runs });
}

async function main() {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  switch (command) {
    case 'launch':
      await handleLaunch(flags);
      break;
    case 'doctor':
      await handleDoctor(flags);
      break;
    case 'save-evidence':
      handleSaveEvidence(flags);
      break;
    case 'browser-open':
      await handleBrowserOpen(flags);
      break;
    case 'browser-act':
      await handleBrowserAct(flags);
      break;
    case 'browser-wait':
      await handleBrowserWait(flags);
      break;
    case 'browser-snapshot':
      await handleBrowserSnapshot(flags);
      break;
    case 'browser-close':
      await handleBrowserClose(flags);
      break;
    case 'cleanup':
      await handleCleanup(flags);
      break;
    case 'list':
      handleList();
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

void main();
