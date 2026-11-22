import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
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

const { FirebaseEmulatorRepository } = await import('../../../src/shared/firebase/index.ts');
const { orchestrateProjectAssemblyCreation } = await import('../genkitOrchestrator.ts');

describe('Genkit multi-provider orchestrator with OpenCascade and Firebase emulator persistence', () => {
  it('orchestrates a quadcopter request end-to-end and persists hierarchy and binaries', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'I want to learn how to build a quadcopter',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'quadcopter_drone_v1');
    assert.equal(assembly.verificationStatus, 'sourced_verified');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.brepValid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.ok(assembly.validation.maxDimensionalErrorMm <= 0.1);
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

  it('orchestrates a second robotics archetype (3-DOF robotic arm)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build a 3-DOF robotic arm with parallel gripper',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 12);
    assert.equal(assembly.assemblySteps.length, 3);
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
                        ? 'DeepSeek Planned 3-DOF Arm'
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
        prompt: 'Plan a 3-DOF robotic arm',
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
      assert.equal(deepseekRun.title, 'DeepSeek Planned 3-DOF Arm');

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
});
