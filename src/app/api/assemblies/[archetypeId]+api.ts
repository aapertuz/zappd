import { getCatalogArchetypeById } from '@/shared/domain';

import { formatApiError } from '@/backend/orchestrator/errorFormatting';
import { loadCatalogProjectAssembly } from '@/backend/orchestrator/genkitOrchestrator';

export async function GET(
  _request: Request,
  { archetypeId }: { readonly archetypeId: string },
): Promise<Response> {
  if (getCatalogArchetypeById(archetypeId) === undefined) {
    return Response.json({ error: `Unknown CAD archetype "${archetypeId}"` }, { status: 404 });
  }
  try {
    return Response.json(await loadCatalogProjectAssembly({ archetypeId, allowUnverified: true }));
  } catch (error: unknown) {
    return Response.json(
      { error: formatApiError(error, 'Catalog assembly load failed') },
      { status: 400 },
    );
  }
}
