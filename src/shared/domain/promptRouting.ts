import { z } from 'zod';

import { isAiProviderId, type AiProviderId } from './aiProvider';
import {
  assemblyParameterSchema,
  isCatalogArchetypeId,
  isComponentId,
  isParameterName,
  type CatalogArchetypeId,
  type ComponentId,
} from './assembly';
import {
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  QUADCOPTER_ARCHETYPE,
  getCatalogArchetypeById,
} from './catalog';

export const DRONE_PARAMETRIC_ARCHETYPE_ID = PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId;

export function supportsDroneParameterPromotion(archetypeId: CatalogArchetypeId): boolean {
  return archetypeId === QUADCOPTER_ARCHETYPE.archetypeId;
}

const catalogArchetypeIdSchema = z
  .custom<CatalogArchetypeId>(isCatalogArchetypeId)
  .refine((id) => getCatalogArchetypeById(id) !== undefined, 'Unknown catalog archetype');
const componentIdSchema = z.custom<ComponentId>(isComponentId);
const parameterValuesSchema = z.record(z.string().refine(isParameterName), z.number());
const nonemptyText = z.string().trim().min(1);
const providerSchema = z.custom<AiProviderId>(isAiProviderId);

const promptRouteActiveContextSchema = z.strictObject({
  archetypeId: catalogArchetypeIdSchema,
  title: nonemptyText,
  rootNodeId: componentIdSchema,
  focusedComponentId: componentIdSchema.nullable(),
  focusedComponentName: nonemptyText.nullable(),
  parameters: z.array(assemblyParameterSchema).readonly().optional(),
});

const promptRouteDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('load_assembly'),
    targetArchetypeId: catalogArchetypeIdSchema.optional(),
    parameterValues: parameterValuesSchema.readonly().optional(),
  }),
  z.strictObject({
    kind: z.literal('modify_assembly'),
    targetArchetypeId: catalogArchetypeIdSchema,
    parameterValues: parameterValuesSchema.readonly(),
  }),
  z.strictObject({
    kind: z.literal('ask_question'),
    targetComponentId: componentIdSchema,
  }),
  z.strictObject({
    kind: z.literal('unsupported_modify'),
    reason: nonemptyText,
  }),
]);

const promptRouteCloudRequestSchema = z.strictObject({
  prompt: nonemptyText,
  activeContext: promptRouteActiveContextSchema,
  provider: providerSchema,
  providerExplicitlySelected: z.boolean(),
});
const promptRouteCloudResponseSchema = z.strictObject({
  provider: providerSchema,
  decision: promptRouteDecisionSchema,
});

export type CanvasPromptRouteDecision = Readonly<z.infer<typeof promptRouteDecisionSchema>>;
export type PromptRouteConfidence = 'high' | 'low';
export type PromptRouteActiveContext = Readonly<z.infer<typeof promptRouteActiveContextSchema>>;
export type PromptRouteCloudRequest = Readonly<
  Omit<z.infer<typeof promptRouteCloudRequestSchema>, 'activeContext'> & {
    readonly activeContext: PromptRouteActiveContext;
  }
>;
export type PromptRouteCloudResponse = Readonly<
  Omit<z.infer<typeof promptRouteCloudResponseSchema>, 'decision'> & {
    readonly decision: CanvasPromptRouteDecision;
  }
>;

export function parsePromptRouteCloudRequest(raw: unknown): PromptRouteCloudRequest {
  return promptRouteCloudRequestSchema.parse(raw);
}

export function parsePromptRouteCloudResponse(raw: unknown): PromptRouteCloudResponse {
  return promptRouteCloudResponseSchema.parse(raw);
}

export function formatUnsupportedModifyNotice({
  archetypeId,
  title,
  parameters,
}: Pick<PromptRouteActiveContext, 'archetypeId' | 'title' | 'parameters'>): string {
  const editableParameters = parameters?.length
    ? parameters
    : supportsDroneParameterPromotion(archetypeId)
      ? PARAMETRIC_MULTIROTOR_ARCHETYPE.parameters
      : undefined;
  if (!editableParameters?.length) {
    return `${title} is a fixed reference assembly and does not support parameter edits.`;
  }
  const ranges = editableParameters.map(({ label, min, max, unit }) => {
    const suffix = unit === 'mm' ? ' mm' : unit === 'deg' ? '°' : '';
    return `${label} (${min}–${max}${suffix})`;
  });
  return `You can edit ${ranges.join(', ')} on ${title}.`;
}
