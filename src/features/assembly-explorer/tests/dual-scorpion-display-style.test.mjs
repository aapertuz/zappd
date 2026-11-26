import assert from 'node:assert/strict';
import { it } from 'node:test';

import { getCatalogArchetypeById } from '@/shared/domain';

import { resolveDualScorpionDisplayStyles } from '../model/dualScorpionDisplayStyle.ts';

it('applies the approved palette to Dual Scorpion assembly roles', () => {
  const catalog = getCatalogArchetypeById('dual_scorpion_v1');
  const styles = resolveDualScorpionDisplayStyles(catalog);

  assert.equal(styles.get('dual_scorpion_base_link')?.colorHex, '#64748B');
  assert.equal(styles.get('dual_scorpion_part_base')?.colorHex, '#64748B');
  assert.equal(styles.get('dual_scorpion_part_body')?.colorHex, '#64748B');
  assert.equal(styles.get('dual_scorpion_part_joint1_l')?.colorHex, '#60A5FA');
  assert.equal(styles.get('dual_scorpion_part_joint1_r')?.colorHex, '#2DD4BF');
  assert.equal(styles.get('dual_scorpion_part_joint2_holder_l')?.colorHex, '#475569');
  assert.equal(styles.get('dual_scorpion_part_joint3_motor_case_r')?.colorHex, '#475569');
  assert.equal(styles.get('dual_scorpion_part_joint8_ee_l')?.colorHex, '#FBBF24');
  assert.equal(styles.get('dual_scorpion_part_joint8_ee_r')?.colorHex, '#FBBF24');
  assert.equal(styles.get('dual_scorpion_part_joint1_l')?.roughness, 0.88);
  assert.equal(styles.get('dual_scorpion_part_joint1_l')?.clearcoat, 0);
  assert.equal(styles.get('dual_scorpion_part_joint1_l')?.envMapIntensity, 0.08);
});

it('does not change display styles for other archetypes', () => {
  const catalog = getCatalogArchetypeById('quadcopter_drone_v1');

  assert.equal(resolveDualScorpionDisplayStyles(catalog).size, 0);
});
