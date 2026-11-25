import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = json.loads((root / "backend/data/poppy-catalog.json").read_text())
fields = ["id", "parentId", "name", "level", "depth", "category", "colorHex", "dimensionsMm", "restPositionMeters", "explodeDirection", "explodeDistanceMeters", "materialHint", "spdxLicense", "sourceUrl", "sourceName", "stepFixtureName", "specifications"]
entries = ["    makeNode(" + ", ".join(json.dumps(node[key]) for key in fields) + ")," for node in spec["nodes"]]
p = root / "src/shared/domain/catalog.ts"
s = p.read_text()
start = s.index('export const CATALOG_ARCHETYPES:')
if 'export const POPPY_ARCHETYPE' in s:
    s = s[:s.index('export const POPPY_ARCHETYPE')] + s[start:]
start = s.index('export const CATALOG_ARCHETYPES:')
block = '''export const POPPY_ARCHETYPE: CatalogArchetypeDefinition = {
  semantics: 'source_inspection',
  archetypeId: aid('poppy_humanoid_v1'),
  title: 'Poppy Humanoid source CAD inspection',
  summary: 'Official Poppy Humanoid 1.0.2 source assembly. Front shell uses an official visual-only mesh; head_face CAD remains rejected. Engineering validation is not established. CC-BY-SA-4.0, Poppy project and authors.',
  keywords: ['poppy', 'humanoid', 'biped'],
  rootNodeId: cid(''' + json.dumps(spec['nodes'][0]['id']) + '''),
  nodes: [
''' + '\n'.join(entries) + '''
  ],
  relationships: [],
  assemblySteps: [],
};

'''
s=s[:start]+block+s[start:]
s=s.replace('  ROVER_ARCHETYPE,\n];','  ROVER_ARCHETYPE,\n  POPPY_ARCHETYPE,\n];')
p.write_text(s)
