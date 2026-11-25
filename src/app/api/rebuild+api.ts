import { z } from 'zod';

import { parseOrchestrationMetadata } from '@/shared/domain';

import { rebuildAssemblyWithParameters } from '@/backend/orchestrator/genkitOrchestrator';

const rebuildRequestSchema = z.object({
  archetypeId: z.string().trim().min(1),
  parameterValues: z.record(z.string(), z.number()),
  title: z.string().trim().min(1),
  userPrompt: z.string().trim().min(1),
  orchestration: z.unknown().transform(parseOrchestrationMetadata),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const input = rebuildRequestSchema.parse(await request.json());
    const assembly = await rebuildAssemblyWithParameters({ ...input, allowUnverified: true });
    return Response.json(assembly);
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Parameter rebuild failed' },
      { status: 400 },
    );
  }
}
