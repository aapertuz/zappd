import {
  type CatalogArchetypeId,
  OPEN_QUADRUPED_ARCHETYPE,
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  POPPY_ARCHETYPE,
  QUADCOPTER_ARCHETYPE,
  REACHY_MINI_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  ROVER_ARCHETYPE,
} from '@/shared/domain';

import quadruped from '@/assets/images/assembly-previews/open_quadruped_v1.png';
import rover from '@/assets/images/assembly-previews/open_source_rover_v1.png';
import multirotor from '@/assets/images/assembly-previews/parametric_multirotor_v1.png';
import poppy from '@/assets/images/assembly-previews/poppy_humanoid_v1.png';
import drone from '@/assets/images/assembly-previews/quadcopter_drone_v1.png';
import reachy from '@/assets/images/assembly-previews/reachy_mini_v1.png';
import arm from '@/assets/images/assembly-previews/robotic_arm_3dof_v1.png';

export const previewImages: Readonly<Record<CatalogArchetypeId, number>> = {
  [OPEN_QUADRUPED_ARCHETYPE.archetypeId]: quadruped,
  [ROVER_ARCHETYPE.archetypeId]: rover,
  [PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId]: multirotor,
  [POPPY_ARCHETYPE.archetypeId]: poppy,
  [QUADCOPTER_ARCHETYPE.archetypeId]: drone,
  [REACHY_MINI_ARCHETYPE.archetypeId]: reachy,
  [ROBOTIC_ARM_ARCHETYPE.archetypeId]: arm,
};
