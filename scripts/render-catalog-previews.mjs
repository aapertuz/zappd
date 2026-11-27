import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  findChromeBinary,
  terminateProcessGroup,
  withCdpPage,
} from '../.agents/skills/verify-zappd/scripts/cdp-browser.mjs';
import './tests/resolve-src-alias.mjs';

const { fetchCloudCatalogPayload, resolveFirebaseCloudConfig } =
  await import('../backend/orchestrator/firebaseCloudStore.ts');
const { buildFirebaseStorageMediaUrl } = await import('../src/shared/firebase/firebaseProject.ts');
const { listCatalogArchetypes } = await import('../src/shared/domain/catalog.ts');

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.join(repoRoot, 'assets/images/assembly-previews');
const cachedGlbDir = process.env.ZAPPD_PREVIEW_GLB_DIR ?? '/tmp/zappd-proto-glbs';
const require = createRequire(import.meta.url);
const threeDir = path.dirname(path.dirname(require.resolve('three')));

const html = `<!doctype html><script type="importmap">
{"imports":{"three":"/three/build/three.module.js"}}
</script>`;

const previewSource = `
import * as THREE from 'three';
import { GLTFLoader } from '/three/examples/jsm/loaders/GLTFLoader.js';
import { CAD_PREVIEW_INITIAL_ANGLE, createCadStudioTurntable } from '/studio.mjs';

const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
});
renderer.setSize(640, 400);
const studio = createCadStudioTurntable(renderer);
const loader = new GLTFLoader();

export async function renderPreview(archetypeId) {
  const model = await loader.loadAsync('/glb/' + encodeURIComponent(archetypeId));
  try {
    studio.setModel(model.scene);
    studio.render(CAD_PREVIEW_INITIAL_ANGLE, 640 / 400);
    return canvas.toDataURL('image/png').split(',')[1];
  } finally {
    studio.clearModel();
  }
}
`;

async function resolveGlb(archetypeId, scratch) {
  const localCandidates = [
    path.join(cachedGlbDir, `${archetypeId}.glb`),
    path.join(repoRoot, 'backend/data/exports', archetypeId, 'model.glb'),
  ];
  for (const candidate of localCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  const config = resolveFirebaseCloudConfig();
  const catalog = config.enabled && (await fetchCloudCatalogPayload(archetypeId, config));
  if (!catalog) throw new Error(`No real catalog GLB available for ${archetypeId}`);
  const { storagePath, sha256, sizeBytes } = catalog.pointer.files.glb;
  const response = await fetch(buildFirebaseStorageMediaUrl(config.storageBucket, storagePath), {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download ${archetypeId} GLB: HTTP ${response.status}`);
  }
  const destination = path.join(scratch, `${archetypeId}.glb`);
  const checksum = createHash('sha256');
  let bytes = 0;
  const digestStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      checksum.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response.body, digestStream, createWriteStream(destination));
  if (bytes !== sizeBytes || checksum.digest('hex') !== sha256) {
    throw new Error(`Firebase GLB failed integrity checks for ${archetypeId}`);
  }
  return destination;
}

async function getPageTarget(profileDir) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split(
        '\n',
      );
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(({ type }) => type === 'page');
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome did not expose a preview page');
}

async function renderCatalogPreviews() {
  const chrome = findChromeBinary();
  if (!chrome)
    throw new Error('Install Chrome or set ZAPPD_CHROME_BIN to render the catalog previews.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'zappd-catalog-previews-'));
  let browser;
  let server;
  try {
    const catalog = listCatalogArchetypes();
    const glbs = new Map(
      await Promise.all(
        catalog.map(async ({ archetypeId }) => [
          `/glb/${archetypeId}`,
          await resolveGlb(archetypeId, scratch),
        ]),
      ),
    );
    const studioTs = await readFile(path.join(repoRoot, 'src/shared/ui/cadStudio.web.ts'), 'utf8');
    const { outputText: studioSource } = ts.transpileModule(studioTs, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    });
    const modules = new Map([
      ['/render.mjs', previewSource],
      ['/studio.mjs', studioSource],
    ]);
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(html);
        return;
      }
      const source = modules.get(url.pathname);
      const glb = glbs.get(url.pathname);
      const threeModule =
        url.pathname.startsWith('/three/') &&
        path.join(threeDir, url.pathname.slice('/three/'.length));
      if (source !== undefined) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(source);
      } else if (glb !== undefined || threeModule) {
        response.setHeader('Content-Type', glb ? 'model/gltf-binary' : 'text/javascript');
        const stream = createReadStream(glb ?? threeModule);
        stream.once('error', () => response.destroy());
        stream.pipe(response);
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const profileDir = path.join(scratch, 'chrome');
    browser = spawn(
      chrome,
      [
        '--headless=new',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { detached: true, stdio: 'ignore' },
    );
    browser.unref();
    const target = await getPageTarget(profileDir);
    await mkdir(outputDir, { recursive: true });
    await withCdpPage(target, async (cdp) => {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      for (const { archetypeId } of catalog) {
        const { result, exceptionDetails } = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `import('/render.mjs').then(({ renderPreview }) => renderPreview(${JSON.stringify(archetypeId)}))`,
            awaitPromise: true,
            returnByValue: true,
          },
          60000,
        );
        if (exceptionDetails !== undefined || typeof result?.value !== 'string') {
          throw new Error(
            `Could not render ${archetypeId}: ${exceptionDetails?.exception?.description ?? exceptionDetails?.text}`,
          );
        }
        const png = Buffer.from(result.value, 'base64');
        await writeFile(path.join(outputDir, `${archetypeId}.png`), png);
        console.log(`Rendered ${archetypeId} at 640×400 (${png.byteLength} bytes)`);
      }
    });
  } finally {
    if (browser?.pid !== undefined) await terminateProcessGroup(browser.pid);
    server?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await renderCatalogPreviews();
