import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const targetBase = path.join(repoRoot, 'src', specifier.slice(2));
      for (const candidate of [`${targetBase}.ts`, path.join(targetBase, 'index.ts')]) {
        if (fs.existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.startsWith('file://')
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const targetBase = path.resolve(parentDir, specifier);
      if (!path.extname(targetBase) && fs.existsSync(`${targetBase}.ts`)) {
        return { url: pathToFileURL(`${targetBase}.ts`).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { getCatalogArchetypeById } = await import('../../../src/shared/domain/index.ts');
const { FirebaseEmulatorRepository } = await import('../../../src/shared/firebase/index.ts');
const { matchesCatalogPlacements, orchestrateProjectAssemblyCreation } =
  await import('../genkitOrchestrator.ts');

function assertReusesAvailableExports(assembly) {
  const manifestFile = path.join(
    repoRoot,
    'backend',
    'data',
    'exports',
    assembly.archetypeId,
    'manifest.json',
  );
  if (fs.existsSync(manifestFile)) {
    assert.deepEqual(assembly.manifest, JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  }
}

describe('Genkit multi-provider orchestrator with OpenCascade and Firebase emulator persistence', () => {
  it('orchestrates a quadcopter request end-to-end and persists hierarchy and binaries', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'I want to learn how to build a quadcopter',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'quadcopter_drone_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.brepValid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.ok(assembly.validation.maxDimensionalErrorMm <= 0.1);
    assert.equal(assembly.nodes.length, 42);
    assert.equal(assembly.assemblySteps.length, 6);
    assertReusesAvailableExports(assembly);
    assert.equal(assembly.orchestration.provider, 'gemini');
    assert.equal(assembly.orchestration.apiFormat, 'google_genai');

    const persistedProject = repository.getProjectAssembly(assembly.projectId);
    assert.ok(persistedProject);
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/nodes`).length,
      assembly.nodes.length,
    );
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/relationships`).length,
      assembly.relationships.length,
    );
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/steps`).length,
      assembly.assemblySteps.length,
    );

    const stepObj = repository.readStorageObject(assembly.manifest.files.step.storagePath);
    const glbObj = repository.readStorageObject(assembly.manifest.files.glb.storagePath);
    const usdzObj = repository.readStorageObject(assembly.manifest.files.usdz.storagePath);
    assert.ok(stepObj && stepObj.sizeBytes > 0);
    assert.ok(glbObj && glbObj.sizeBytes > 0);
    assert.ok(usdzObj && usdzObj.sizeBytes > 0);
    assert.equal(Buffer.from(glbObj.bytes.slice(0, 4)).toString('utf8'), 'glTF');
  });

  it('orchestrates a second robotics archetype (SO-ARM100 manipulator)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build a 5-DOF SO-100 robotic arm with parallel gripper',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 31);
    assert.equal(assembly.assemblySteps.length, 5);
    assertReusesAvailableExports(assembly);
  });

  it('orchestrates a third robotics archetype (NOVA2 open-source rover)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Explore an autonomous ground rover chassis with stereo camera',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'open_source_rover_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 21);
    assert.equal(assembly.assemblySteps.length, 4);
    const computeBay = assembly.nodes.find(({ id }) => id === 'comp_rover_compute_bay');
    assert.equal(computeBay.enclosureRole, 'shell');
    assert.equal(computeBay.explodeDistanceMeters, 0.075);
    assertReusesAvailableExports(assembly);
  });

  it('orchestrates a fourth robotics archetype (HeyPCB Reachy Mini desktop robot)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build Reachy Mini desktop companion robot',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'reachy_mini_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 98);
    assert.equal(assembly.assemblySteps.length, 51);
    const topShell = assembly.nodes.find(({ id }) => id === 'comp_reachy_top_shell');
    assert.equal(topShell.enclosureRole, 'shell');
    assert.deepEqual(topShell.explodeDirection, [0.921954, 0.140297, -0.360765]);
    assert.equal(topShell.explodeDistanceMeters, 0.165);
    const mainPlate = assembly.nodes.find(({ id }) => id === 'comp_reachy_main_plate');
    assert.equal(Object.hasOwn(mainPlate, 'enclosureRole'), false);
    assertReusesAvailableExports(assembly);
  });

  it('drives both OpenAI and DeepSeek through the shared OpenAI-compatible API integration', async () => {
    const receivedRequests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        receivedRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
          model: body.model,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    archetypeId:
                      body.model === 'deepseek-chat'
                        ? 'robotic_arm_3dof_v1'
                        : 'quadcopter_drone_v1',
                    projectTitle:
                      body.model === 'deepseek-chat'
                        ? 'DeepSeek Planned SO-ARM100'
                        : 'OpenAI Planned Quadcopter',
                    plannedSubsystems: ['Subsystem A', 'Subsystem B'],
                    rationale: 'Planned over OpenAI-compatible endpoint',
                  }),
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const repo = new FirebaseEmulatorRepository();
      const openaiRun = await orchestrateProjectAssemblyCreation({
        prompt: 'Plan a quadcopter drone',
        provider: 'openai',
        apiKey: 'sk-test-openai',
        baseUrl,
        repository: repo,
      });
      const deepseekRun = await orchestrateProjectAssemblyCreation({
        prompt: 'Plan a 5-DOF robotic arm',
        provider: 'deepseek',
        apiKey: 'sk-test-deepseek',
        baseUrl,
        repository: repo,
      });

      assert.equal(openaiRun.orchestration.provider, 'openai');
      assert.equal(openaiRun.orchestration.apiFormat, 'openai_compatible');
      assert.equal(openaiRun.orchestration.executionMode, 'live_api');
      assert.equal(openaiRun.title, 'OpenAI Planned Quadcopter');

      assert.equal(deepseekRun.orchestration.provider, 'deepseek');
      assert.equal(deepseekRun.orchestration.apiFormat, 'openai_compatible');
      assert.equal(deepseekRun.orchestration.executionMode, 'live_api');
      assert.equal(deepseekRun.title, 'DeepSeek Planned SO-ARM100');

      assert.deepEqual(receivedRequests, [
        {
          url: '/v1/chat/completions',
          authorization: 'Bearer sk-test-openai',
          model: 'gpt-4o',
        },
        {
          url: '/v1/chat/completions',
          authorization: 'Bearer sk-test-deepseek',
          model: 'deepseek-chat',
        },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects colliding CAD geometry before persisting to Firestore or Storage', async () => {
    const repository = new FirebaseEmulatorRepository();
    await assert.rejects(
      () =>
        orchestrateProjectAssemblyCreation({
          prompt: 'I want to build a quadcopter',
          provider: 'gemini',
          injectCollisionTest: true,
          repository,
        }),
      /OpenCascade validation rejected assembly/,
    );
    assert.equal(repository.listCollection('projects').length, 0);
  });

  it('requires a live provider key instead of falling back to keyword matching', async () => {
    const repository = new FirebaseEmulatorRepository();
    const originalCwd = process.cwd();
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-no-env-'));
    delete process.env.OPENAI_API_KEY;
    process.chdir(isolatedCwd);
    try {
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'I want to build a quadcopter',
            provider: 'openai',
            requireLiveApiKey: true,
            repository,
          }),
        /Missing OPENAI_API_KEY in \.env\.local for OpenAI/,
      );
      assert.equal(repository.listCollection('projects').length, 0);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
      if (originalOpenAiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it('rejects shifted or collision-injected Poppy outputs through the orchestrator before saving or publishing', async () => {
    const poppy = getCatalogArchetypeById('poppy_humanoid_v1');
    assert.ok(poppy);
    const originalCwd = process.cwd();
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-poppy-orch-'));

    const stepBytes = Buffer.from('ISO-10303-21;POPPY-STUB;');
    const glbBytes = Buffer.from('glTF\x02\x00\x00\x00');
    const usdzBytes = Buffer.from('PK\x03\x04usdz');
    const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
    const stepSha = sha256Hex(stepBytes);
    const glbSha = sha256Hex(glbBytes);
    const usdzSha = sha256Hex(usdzBytes);
    const manifestHash = sha256Hex(
      Buffer.from(`poppy_humanoid_v1:${stepSha}:${glbSha}:${usdzSha}`),
    );

    const buildPoppyPayload = (shiftLastNode) => {
      const nodes = poppy.nodes.map((node, index) => ({
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        level: node.level,
        depth: node.depth,
        category: node.category,
        colorHex: node.colorHex,
        dimensionsMm: node.dimensionsMm,
        restPositionMeters:
          shiftLastNode && index === poppy.nodes.length - 1
            ? [
                node.restPositionMeters[0] + 0.01,
                node.restPositionMeters[1],
                node.restPositionMeters[2],
              ]
            : node.restPositionMeters,
        explodeDirection: node.explodeDirection,
        explodeDistanceMeters: node.explodeDistanceMeters,
        materialHint: node.materialHint,
        specifications: node.specifications,
        geometry: node.geometry,
        provenance: {
          origin: node.origin,
          verificationStatus: 'unverified',
          spdxLicense: node.spdxLicense,
          sourceUrl: node.sourceUrl,
          sourceName: node.sourceName,
          stepSha256: node.expectedStepSha256 ?? stepSha,
        },
        glbNodeName: node.id,
        usdzPrimPath: `/World/${node.id}`,
      }));
      const mappedLeaves = nodes.filter(
        (node) =>
          (node.level === 'component' || node.level === 'subcomponent') &&
          node.geometry?.kind !== 'unavailable',
      );
      return {
        archetypeId: 'poppy_humanoid_v1',
        verificationStatus: 'unverified',
        nodes,
        glbNodeIds: mappedLeaves.map((node) => node.glbNodeName),
        usdzPrimPaths: mappedLeaves.map((node) => node.usdzPrimPath),
        manifest: {
          manifestHash,
          archetypeId: 'poppy_humanoid_v1',
          generatedAtIso: '2026-11-25T00:00:00.000Z',
          files: {
            step: {
              format: 'step',
              storagePath: `assemblies/${manifestHash}/model.step`,
              publicUrl: '/assemblies/poppy_humanoid_v1/model.step',
              sha256: stepSha,
              sizeBytes: stepBytes.length,
            },
            glb: {
              format: 'glb',
              storagePath: `assemblies/${manifestHash}/model.glb`,
              publicUrl: '/assemblies/poppy_humanoid_v1/model.glb',
              sha256: glbSha,
              sizeBytes: glbBytes.length,
            },
            usdz: {
              format: 'usdz',
              storagePath: `assemblies/${manifestHash}/model.usdz`,
              publicUrl: '/assemblies/poppy_humanoid_v1/model.usdz',
              sha256: usdzSha,
              sizeBytes: usdzBytes.length,
            },
          },
        },
        validation: {
          valid: false,
          brepValid: true,
          interferenceCount: 0,
          maxDimensionalErrorMm: 0.05,
          nodeMappingComplete: true,
          unitSystem: 'meters_y_up',
          checkedAtIso: '2026-11-25T00:00:00.000Z',
          failures: ['Partial source inspection'],
          sourceInterferenceReport: {
            status: 'partial',
            solidCount: 199,
            possiblePairCount: 19701,
            candidatePairCount: 0,
            intersectionCount: 0,
            unresolvedPairCount: 0,
            volumeThresholdMm3: 0.001,
            aabbToleranceMm: 1e-7,
            excludedComponents: [],
            pairs: [],
            limitations: [],
          },
          engineeringReport: {
            status: 'unverified',
            manufacturingReadiness: 'not_established',
            materials: 'unknown',
            manufacturingTolerances: 'unknown',
            loadsAndConstraints: 'not_verified',
            renderDimensionComparison: {
              maximumErrorMm: 0.05,
              thresholdMm: 0.1,
              meaning: 'CAD to render bounds comparison',
            },
            nodeMappingComplete: true,
            rejectedCadComponentIds: [],
            surfaceComponentIds: [],
          },
        },
      };
    };

    const writeExportFixture = (dir, payload) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'model.step'), stepBytes);
      fs.writeFileSync(path.join(dir, 'model.glb'), glbBytes);
      fs.writeFileSync(path.join(dir, 'model.usdz'), usdzBytes);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(payload.manifest));
      fs.writeFileSync(path.join(dir, 'pipeline_result.json'), JSON.stringify(payload));
    };

    const canonicalPayload = buildPoppyPayload(false);
    const shiftedPayload = buildPoppyPayload(true);
    assert.equal(matchesCatalogPlacements(poppy.nodes, canonicalPayload.nodes), true);
    assert.equal(matchesCatalogPlacements(poppy.nodes, shiftedPayload.nodes), false);

    const pythonStubPath = path.join(isolatedCwd, 'backend', '.venv', 'bin', 'python');
    const stubPayloadPath = path.join(isolatedCwd, 'stub-payload.json');
    fs.mkdirSync(path.dirname(pythonStubPath), { recursive: true });
    fs.writeFileSync(
      pythonStubPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        "const outDir = args[args.indexOf('--output-dir') + 1];",
        "const jsonOut = args[args.indexOf('--json-out') + 1];",
        `const payload = JSON.parse(fs.readFileSync(${JSON.stringify(stubPayloadPath)}, 'utf8'));`,
        'fs.mkdirSync(outDir, { recursive: true });',
        `fs.writeFileSync(path.join(outDir, 'model.step'), Buffer.from(${JSON.stringify(stepBytes.toString('base64'))}, 'base64'));`,
        `fs.writeFileSync(path.join(outDir, 'model.glb'), Buffer.from(${JSON.stringify(glbBytes.toString('base64'))}, 'base64'));`,
        `fs.writeFileSync(path.join(outDir, 'model.usdz'), Buffer.from(${JSON.stringify(usdzBytes.toString('base64'))}, 'base64'));`,
        "fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(payload.manifest));",
        'fs.writeFileSync(jsonOut, JSON.stringify(payload));',
      ].join('\n'),
      { mode: 0o755 },
    );

    const precomputedDir = path.join(
      isolatedCwd,
      'backend',
      'data',
      'exports',
      'poppy_humanoid_v1',
    );
    const publicDir = path.join(isolatedCwd, 'public', 'assemblies', 'poppy_humanoid_v1');

    process.chdir(isolatedCwd);
    try {
      writeExportFixture(precomputedDir, shiftedPayload);
      fs.writeFileSync(stubPayloadPath, JSON.stringify(shiftedPayload));
      const shiftedRepo = new FirebaseEmulatorRepository();
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'Inspect Poppy humanoid',
            provider: 'gemini',
            repository: shiftedRepo,
          }),
        /OpenCascade validation rejected assembly "poppy_humanoid_v1"/,
      );
      assert.equal(shiftedRepo.listCollection('projects').length, 0);
      assert.equal(fs.existsSync(publicDir), false);

      fs.writeFileSync(stubPayloadPath, JSON.stringify(canonicalPayload));
      const injectedRepo = new FirebaseEmulatorRepository();
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'Inspect Poppy humanoid',
            provider: 'gemini',
            injectCollisionTest: true,
            repository: injectedRepo,
          }),
        /OpenCascade validation rejected assembly "poppy_humanoid_v1"/,
      );
      assert.equal(injectedRepo.listCollection('projects').length, 0);
      assert.equal(fs.existsSync(publicDir), false);

      writeExportFixture(precomputedDir, canonicalPayload);
      const canonicalRepo = new FirebaseEmulatorRepository();
      const persisted = await orchestrateProjectAssemblyCreation({
        prompt: 'Inspect Poppy humanoid',
        provider: 'gemini',
        repository: canonicalRepo,
      });
      assert.equal(persisted.archetypeId, 'poppy_humanoid_v1');
      assert.equal(canonicalRepo.listCollection('projects').length, 1);
      assert.equal(fs.existsSync(path.join(publicDir, 'pipeline_result.json')), true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });
});
