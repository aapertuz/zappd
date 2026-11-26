import { z } from 'zod';

import {
  GEOMETRY_ORIGIN_POLICY,
  type AssemblyNode,
  type AssetChecksum,
  type ConnectorPort,
  type ElectricalBusKind,
  type GeometryOrigin,
  type MountingInterfaceKind,
  assemblyNodeFieldsSchema,
  connectorPortSchema,
  isAssetChecksum,
  isGeometryOrigin,
} from './assembly';
import cotsCatalog from './catalog/cots/index.json' with { type: 'json' };

export type CotsPartSpec = Pick<
  AssemblyNode,
  'name' | 'dimensionsMm' | 'materialHint' | 'colorHex' | 'specifications' | 'mountingInterfaces'
> & {
  readonly cotsId: string;
  readonly origin: GeometryOrigin;
  readonly spdxLicense: string;
  readonly sourceUrl: string;
  readonly sourceName: string;
  readonly stepFixtureName: string;
  readonly expectedStepSha256: AssetChecksum;
  readonly ports: readonly ConnectorPort[];
  readonly category?: string;
  readonly tags?: readonly string[];
};

export type CotsPartQuery = {
  readonly busKind?: ElectricalBusKind;
  readonly mountingKind?: MountingInterfaceKind;
  readonly origin?: GeometryOrigin;
  readonly maxDimensionMm?: number;
  readonly text?: string;
};

const catalogText = z.string().trim().min(1);
const positiveDimension = z.number().positive();
const nodeFields = assemblyNodeFieldsSchema.shape;

export const cotsPartSpecSchema = z
  .strictObject({
    cotsId: catalogText,
    name: catalogText,
    origin: z.custom<GeometryOrigin>(isGeometryOrigin),
    spdxLicense: catalogText,
    sourceUrl: z.url(),
    sourceName: catalogText,
    stepFixtureName: catalogText,
    expectedStepSha256: z.custom<AssetChecksum>(isAssetChecksum),
    dimensionsMm: z.tuple([positiveDimension, positiveDimension, positiveDimension]),
    materialHint: nodeFields.materialHint,
    colorHex: z.string().regex(/^#[a-f0-9]{6}$/i),
    specifications: nodeFields.specifications,
    ports: z.array(connectorPortSchema),
    mountingInterfaces: nodeFields.mountingInterfaces,
    category: catalogText.optional(),
    tags: z.array(catalogText).optional(),
  })
  .refine(
    ({ origin, sourceUrl }) =>
      GEOMETRY_ORIGIN_POLICY[origin].allowedUriPrefixes.some((prefix) =>
        sourceUrl.startsWith(prefix),
      ),
    { path: ['sourceUrl'], message: 'Expected a provenance URI allowed for the geometry origin' },
  );

export const COTS_CATALOG_PARTS: readonly CotsPartSpec[] = z
  .array(cotsPartSpecSchema)
  .parse(cotsCatalog);

export function getCotsPartById(cotsId: string): CotsPartSpec | undefined {
  return COTS_CATALOG_PARTS.find((part) => part.cotsId === cotsId);
}

export function searchCotsParts({
  busKind,
  mountingKind,
  origin,
  maxDimensionMm,
  text,
}: CotsPartQuery): readonly CotsPartSpec[] {
  const searchText = text?.trim().toLowerCase() ?? '';

  return COTS_CATALOG_PARTS.filter(
    (part) =>
      (origin === undefined || part.origin === origin) &&
      (maxDimensionMm === undefined || Math.max(...part.dimensionsMm) <= maxDimensionMm) &&
      (busKind === undefined ||
        part.ports.some(
          (port) => port.busKind === busKind || port.compatibleBusKinds?.includes(busKind),
        )) &&
      (mountingKind === undefined ||
        part.mountingInterfaces?.some((mounting) => mounting.kind === mountingKind)) &&
      (searchText === '' ||
        [part.cotsId, part.name, part.category ?? '', ...(part.tags ?? [])].some((field) =>
          field.toLowerCase().includes(searchText),
        )),
  );
}
