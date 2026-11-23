import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const SPECIAL_KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export function findChromeBinary() {
  const candidates = process.env.ZAPPD_CHROME_BIN
    ? [process.env.ZAPPD_CHROME_BIN, ...CHROME_CANDIDATES]
    : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function getProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const output = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

export function isExpectedChromeProcess(pid, profileDir) {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const command = getProcessCommand(pid);
  if (!command) {
    return false;
  }
  return command.includes(`--user-data-dir=${profileDir}`);
}

export function sendSignalToProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function terminateProcessGroup(pid, sigtermWaitMs = 5000) {
  if (!isProcessAlive(pid)) {
    return;
  }
  sendSignalToProcessGroup(pid, 'SIGTERM');
  const sigtermDeadline = Date.now() + sigtermWaitMs;
  while (isProcessAlive(pid) && Date.now() < sigtermDeadline) {
    await delay(100);
  }
  if (isProcessAlive(pid)) {
    sendSignalToProcessGroup(pid, 'SIGKILL');
    const sigkillDeadline = Date.now() + 2000;
    while (isProcessAlive(pid) && Date.now() < sigkillDeadline) {
      await delay(100);
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 10000) {
    await new Promise((resolve, reject) => {
      const socket = new globalThis.WebSocket(this.wsUrl);
      this.socket = socket;
      const timer = globalThis.setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to CDP socket ${this.wsUrl}`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        globalThis.clearTimeout(timer);
        resolve();
      });

      socket.addEventListener('error', () => {
        globalThis.clearTimeout(timer);
        reject(new Error(`CDP socket error connecting to ${this.wsUrl}`));
      });

      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id === undefined) {
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
          return;
        }
        this.pending.delete(message.id);
        globalThis.clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(`${entry.method}: ${message.error.message}`));
          return;
        }
        entry.resolve(message.result ?? {});
      });

      socket.addEventListener('close', () => {
        for (const [id, entry] of this.pending.entries()) {
          this.pending.delete(id);
          globalThis.clearTimeout(entry.timer);
          entry.reject(new Error(`CDP socket closed while waiting for ${entry.method}`));
        }
      });
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (!this.socket || this.socket.readyState !== globalThis.WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket not open for ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      globalThis.clearTimeout(entry.timer);
      entry.reject(new Error(`CDP client closed during ${entry.method}`));
    }
    if (this.socket && this.socket.readyState === globalThis.WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
  }
}

async function withCdpPage(pageWsUrl, task) {
  const client = new CdpClient(pageWsUrl);
  await client.connect();
  try {
    return await task(client);
  } finally {
    client.close();
  }
}

async function applyViewport(cdp, viewport) {
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) {
    return;
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: viewport.width < 600,
  });
}

async function readPageDiagnostics(cdp) {
  const response = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const textarea = document.querySelector('textarea[aria-label="Prompt input"]');
      const sendButton = document.querySelector('button[aria-label="Send"]');
      const form = document.querySelector('form');
      const textareaStyle = textarea ? getComputedStyle(textarea) : null;
      const hasExplorer = document.querySelector('section[aria-label="3D Assembly Explorer"]') !== null;
      const rawAssembly = hasExplorer ? window.__zappdAssemblyDiagnostics : null;
      const assembly = rawAssembly
        ? {
            projectId: rawAssembly.projectId ?? null,
            archetypeId: rawAssembly.archetypeId ?? null,
            title: rawAssembly.title ?? null,
            provider: rawAssembly.provider ?? null,
            apiFormat: rawAssembly.apiFormat ?? null,
            verificationStatus: rawAssembly.verificationStatus ?? null,
            validationPassed: Boolean(rawAssembly.validationPassed),
            interferenceCount: rawAssembly.interferenceCount ?? null,
            nodeCount: rawAssembly.nodeCount ?? 0,
            glbNodeCount: Array.isArray(rawAssembly.glbNodeIds) ? rawAssembly.glbNodeIds.length : 0,
            selectedComponentId: rawAssembly.selectedComponentId ?? null,
            isolatedComponentId: rawAssembly.isolatedComponentId ?? null,
            viewMode: rawAssembly.viewMode ?? null,
            focusedPartCallout: rawAssembly.focusedPartCallout ?? null,
            nodeScreenPositions: rawAssembly.nodeScreenPositions ?? {},
            explodeFactor: rawAssembly.explodeFactor ?? null,
            animatedExplodeFactor: rawAssembly.animatedExplodeFactor ?? null,
            assemblyStatus: rawAssembly.assemblyStatus ?? null,
            assemblyProgress: rawAssembly.assemblyProgress ?? null,
            activeExplodeStage: rawAssembly.activeExplodeStage ?? null,
            camera: rawAssembly.camera ?? null,
            separatedOffsets: rawAssembly.separatedOffsets ?? {},
            selectedNodePositionMeters:
              rawAssembly.selectedComponentId && rawAssembly.nodePositionsMeters
                ? (rawAssembly.nodePositionsMeters[rawAssembly.selectedComponentId] ?? null)
                : null,
            webglActive: Boolean(rawAssembly.webglActive),
          }
        : null;
      const bodyText = document.body ? document.body.innerText : '';
      const isLoadingAssembly = bodyText.includes('Loading verified CAD assembly');
      const hasProviderToolbar = document.querySelector('[role="toolbar"]') !== null;
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        promptValue: textarea ? textarea.value : null,
        promptHeight: textarea ? textarea.getBoundingClientRect().height : null,
        promptScrollHeight: textarea ? textarea.scrollHeight : null,
        promptMaxHeight: textareaStyle ? textareaStyle.maxHeight : null,
        promptOverflowY: textareaStyle ? textareaStyle.overflowY : null,
        sendDisabled: sendButton ? sendButton.disabled : null,
        formWidth: form ? form.getBoundingClientRect().width : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        isLoadingAssembly,
        hasProviderToolbar,
        assembly,
        errors: Array.isArray(window.__zappdVerifyErrors) ? window.__zappdVerifyErrors : [],
      };
    })()`,
  });
  return response.result?.value ?? null;
}

function formatAxTree(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }

  const lines = [];
  function visit(nodeId, depth) {
    const node = byId.get(nodeId);
    if (!node) {
      return;
    }
    const role = node.role?.value ?? '';
    const name = node.name?.value ?? '';
    const skipSelf =
      node.ignored ||
      role === 'InlineTextBox' ||
      ((role === 'generic' || role === 'none') && name === '');

    const nextDepth = skipSelf ? depth : depth + 1;
    if (!skipSelf) {
      const attrs = [];
      const propMap = new Map();
      for (const prop of node.properties ?? []) {
        propMap.set(prop.name, prop.value?.value);
      }
      if (propMap.get('disabled') === true) {
        attrs.push('disabled');
      }
      if (propMap.get('focused') === true) {
        attrs.push('focused');
      }
      if (node.value?.value !== undefined && node.value.value !== '') {
        attrs.push(`value=${JSON.stringify(node.value.value)}`);
      }
      const indent = '  '.repeat(depth);
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      const suffix = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
      lines.push(`${indent}- ${label}${suffix}`);
    }

    for (const childId of node.childIds ?? []) {
      visit(childId, nextDepth);
    }
  }

  if (nodes.length > 0) {
    visit(nodes[0].nodeId, 0);
  }
  return lines;
}

function findAxNode(nodes, role, name) {
  const targetRole = role.toLowerCase();
  for (const node of nodes) {
    if (node.ignored) {
      continue;
    }
    const nodeRole = node.role?.value?.toLowerCase() ?? '';
    const nodeName = node.name?.value ?? '';
    if (nodeRole === targetRole && nodeName === name && typeof node.backendDOMNodeId === 'number') {
      return node;
    }
  }
  return null;
}

async function clickBackendNode(cdp, backendDOMNodeId) {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId });
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: backendDOMNodeId });
  const content = model?.content;
  if (!Array.isArray(content) || content.length < 8) {
    throw new Error(`Missing box model for backendDOMNodeId=${backendDOMNodeId}`);
  }
  const x = (content[0] + content[2] + content[4] + content[6]) / 4;
  const y = (content[1] + content[3] + content[5] + content[7]) / 4;
  await clickPoint(cdp, x, y);
}

async function clickPoint(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

function resolveKeyDescriptor(key) {
  if (SPECIAL_KEY_MAP[key]) {
    return SPECIAL_KEY_MAP[key];
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isAlpha = upper >= 'A' && upper <= 'Z';
    const isDigit = upper >= '0' && upper <= '9';
    return {
      key,
      code: isAlpha ? `Key${upper}` : isDigit ? `Digit${upper}` : '',
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  throw new Error(`Unsupported key "${key}"`);
}

function computeModifierMask(modifiers) {
  let mask = 0;
  for (const name of modifiers) {
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }
    const bit = MODIFIER_BITS[trimmed];
    if (!bit) {
      throw new Error(`Unsupported modifier "${trimmed}"`);
    }
    mask |= bit;
  }
  return mask;
}

export async function launchChromeSession({
  url,
  profileDir,
  cdpPort,
  logPath,
  width = 1280,
  height = 800,
}) {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    throw new Error('No Chrome or Chromium binary found');
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(
    chromeBin,
    [
      '--headless=new',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error('Failed to spawn headless Chrome process');
  }
  child.unref();

  try {
    const deadline = Date.now() + 15000;
    let pageTarget = null;

    while (Date.now() < deadline) {
      if (!isProcessAlive(child.pid)) {
        throw new Error(`Headless Chrome process ${child.pid} exited prematurely`);
      }
      try {
        const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        if (listRes.ok) {
          const targets = await listRes.json();
          pageTarget = targets.find(
            (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
          );
          if (pageTarget) {
            break;
          }
        }
      } catch {
        pageTarget = null;
      }
      await delay(200);
    }

    if (!pageTarget) {
      throw new Error(`Timed out waiting for Chrome CDP target on port ${cdpPort}`);
    }

    await withCdpPage(pageTarget.webSocketDebuggerUrl, async (cdp) => {
      await cdp.send('Page.enable');
      await cdp.send('DOM.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Accessibility.enable');
      await applyViewport(cdp, { width, height });
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const errors = [];
          window.__zappdVerifyErrors = errors;
          const origError = console.error.bind(console);
          console.error = (...args) => {
            errors.push({ type: 'console.error', message: args.map((item) => String(item)).join(' ') });
            origError(...args);
          };
          window.addEventListener('error', (event) => {
            errors.push({ type: 'pageerror', message: event.message || 'Uncaught page error' });
          });
          window.addEventListener('unhandledrejection', (event) => {
            errors.push({ type: 'unhandledrejection', message: String(event.reason) });
          });
        })();`,
      });
      await cdp.send('Page.navigate', { url });

      const hydrationDeadline = Date.now() + 15000;
      let hydrated = false;
      while (Date.now() < hydrationDeadline) {
        const evalRes = await cdp.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            const textarea = document.querySelector('textarea[aria-label="Prompt input"]');
            const sendButton = document.querySelector('button[aria-label="Send"]');
            if (document.readyState !== 'complete' || !textarea || !sendButton) {
              return false;
            }
            return Object.keys(textarea).some((key) => key.startsWith('__reactProps$'));
          })()`,
        });
        if (evalRes.result?.value === true) {
          hydrated = true;
          break;
        }
        await delay(200);
      }

      if (!hydrated) {
        throw new Error(`Timed out waiting for React hydration at ${url}`);
      }
    });

    return {
      pid: child.pid,
      pgid: child.pid,
      cdpPort,
      profileDir,
      pageWsUrl: pageTarget.webSocketDebuggerUrl,
      targetId: pageTarget.id,
      width,
      height,
    };
  } catch (error) {
    await terminateProcessGroup(child.pid, 3000);
    throw error;
  }
}

export async function capturePageSnapshot(pageWsUrl, viewport) {
  return withCdpPage(pageWsUrl, async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Accessibility.enable');
    await applyViewport(cdp, viewport);

    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const ariaLines = formatAxTree(nodes);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pngBuffer = Buffer.from(data, 'base64');
    const diagnostics = await readPageDiagnostics(cdp);

    return {
      ariaLines,
      pngBuffer,
      diagnostics,
      errors: diagnostics?.errors ?? [],
    };
  });
}

export async function performBrowserAction(pageWsUrl, options) {
  return withCdpPage(pageWsUrl, async (cdp) => {
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Accessibility.enable');
    await applyViewport(cdp, options.viewport);

    switch (options.action) {
      case 'resize': {
        await applyViewport(cdp, { width: options.width, height: options.height });
        break;
      }
      case 'click': {
        if (options.x !== undefined && options.y !== undefined) {
          await clickPoint(cdp, options.x, options.y);
          break;
        }
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const targetNode = findAxNode(nodes, options.role, options.name);
        if (!targetNode) {
          throw new Error(
            `Control not found: role=${options.role} name=${JSON.stringify(options.name)}`,
          );
        }
        await clickBackendNode(cdp, targetNode.backendDOMNodeId);
        break;
      }
      case 'type': {
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const targetNode = findAxNode(nodes, options.role, options.name);
        if (!targetNode) {
          throw new Error(
            `Control not found: role=${options.role} name=${JSON.stringify(options.name)}`,
          );
        }
        const alreadyFocused =
          targetNode.properties?.some(
            (prop) => prop.name === 'focused' && prop.value?.value === true,
          ) === true;
        if (!alreadyFocused || options.clear) {
          await clickBackendNode(cdp, targetNode.backendDOMNodeId);
          await cdp.send('DOM.focus', { backendNodeId: targetNode.backendDOMNodeId });
        }
        if (options.clear) {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: 4,
            commands: ['selectAll'],
          });
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: 4,
          });
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          });
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          });
        }
        if (options.text !== undefined && options.text.length > 0) {
          await cdp.send('Input.insertText', { text: options.text });
        }
        break;
      }
      case 'press': {
        const descriptor = resolveKeyDescriptor(options.key);
        const modifiers = computeModifierMask(options.modifiers ?? []);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: descriptor.key,
          code: descriptor.code,
          windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
          nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
          modifiers,
        });
        if (descriptor.text && (modifiers & 6) === 0) {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'char',
            text: descriptor.text,
            unmodifiedText: descriptor.text,
            key: descriptor.key,
            code: descriptor.code,
            windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
            modifiers,
          });
        }
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: descriptor.key,
          code: descriptor.code,
          windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
          nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
          modifiers,
        });
        break;
      }
      default:
        throw new Error(`Unsupported browser action: ${options.action}`);
    }

    await delay(120);
    const diagnostics = await readPageDiagnostics(cdp);
    return {
      diagnostics,
      errors: diagnostics?.errors ?? [],
    };
  });
}

export async function waitForBrowserState(pageWsUrl, options) {
  const timeoutMs = options.timeoutMs ?? 25000;
  const deadline = Date.now() + timeoutMs;

  return withCdpPage(pageWsUrl, async (cdp) => {
    await cdp.send('Runtime.enable');
    await applyViewport(cdp, options.viewport);

    let lastDiagnostics = null;
    while (Date.now() < deadline) {
      const diagnostics = await readPageDiagnostics(cdp);
      lastDiagnostics = diagnostics;

      let textMatched = true;
      if (options.text) {
        const textRes = await cdp.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(options.text)}))`,
        });
        textMatched = textRes.result?.value === true;
      }

      const assembly = diagnostics?.assembly ?? null;
      const glbReady =
        assembly !== null && assembly.nodeCount > 0 && assembly.glbNodeCount === assembly.nodeCount;
      const archetypeMatched = options.archetype
        ? assembly?.archetypeId === options.archetype && glbReady
        : true;
      const providerMatched = options.provider ? assembly?.provider === options.provider : true;
      const defaultSettled =
        !options.text && !options.archetype && !options.provider
          ? !diagnostics?.isLoadingAssembly &&
            (glbReady || diagnostics?.hasProviderToolbar === true)
          : true;

      if (textMatched && archetypeMatched && providerMatched && defaultSettled) {
        return {
          diagnostics,
          errors: diagnostics?.errors ?? [],
        };
      }

      await delay(250);
    }

    throw new Error(
      `Timed out waiting for browser state after ${timeoutMs}ms (archetype=${options.archetype ?? 'any'}, provider=${options.provider ?? 'any'}, text=${options.text ? JSON.stringify(options.text) : 'any'}, lastArchetype=${lastDiagnostics?.assembly?.archetypeId ?? 'none'}, loading=${String(lastDiagnostics?.isLoadingAssembly)})`,
    );
  });
}
