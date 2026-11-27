import assert from 'node:assert/strict';

import {
  DEFAULT_AI_PROVIDER,
  OPEN_QUADRUPED_ARCHETYPE,
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  POPPY_ARCHETYPE,
  QUADCOPTER_ARCHETYPE,
  REACHY_MINI_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  ROVER_ARCHETYPE,
} from '@/shared/domain';

import { classifyCanvasPromptWithConfidence } from '@/features/learning/model/promptRouter';
import { resolveCanvasPromptRoute } from '@/features/learning/services/promptRoutingService';

import {
  listConfiguredAiProviders,
  resolveDefaultConfiguredProvider,
} from '@/backend/orchestrator/aiProviders';
import { classifyPromptWithCloudProvider } from '@/backend/orchestrator/promptRouteResponder';

function withCustomParams(archetype, values) {
  return {
    ...archetype,
    parameters: archetype.parameters.map((param) => ({
      ...param,
      value: values[param.name] ?? param.value,
    })),
  };
}

const CUSTOM_PARAM_DRONE_VALUES = {
  rotor_count: 6,
  wheelbase_mm: 320,
  deck_gap_mm: 26,
  arm_thickness_mm: 4,
};

const CONTEXTS = {
  empty: null,
  fixed_drone: {
    assembly: QUADCOPTER_ARCHETYPE,
    focusedComponentId: null,
  },
  fixed_drone_focus: {
    assembly: QUADCOPTER_ARCHETYPE,
    focusedComponentId: 'comp_motor_rr',
  },
  param_drone_custom: {
    assembly: withCustomParams(PARAMETRIC_MULTIROTOR_ARCHETYPE, CUSTOM_PARAM_DRONE_VALUES),
    focusedComponentId: null,
  },
  param_drone_focus: {
    assembly: withCustomParams(PARAMETRIC_MULTIROTOR_ARCHETYPE, CUSTOM_PARAM_DRONE_VALUES),
    focusedComponentId: 'comp_multi_lower',
  },
  reachy_mini: {
    assembly: REACHY_MINI_ARCHETYPE,
    focusedComponentId: null,
  },
  rover: {
    assembly: ROVER_ARCHETYPE,
    focusedComponentId: null,
  },
  arm_focus: {
    assembly: ROBOTIC_ARM_ARCHETYPE,
    focusedComponentId: 'comp_upper_arm_link',
  },
};

const EVAL_DATASET = [
  {
    id: 'empty_explain',
    category: 'empty_canvas',
    contextKey: 'empty',
    prompt: 'Explain the arms',
    expectedIntent: 'load_assembly',
  },
  {
    id: 'empty_drone',
    category: 'empty_canvas',
    contextKey: 'empty',
    prompt: 'build a quadcopter drone',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: QUADCOPTER_ARCHETYPE.archetypeId,
  },

  {
    id: 'switch_exact_user_repro_overview',
    category: 'load_switch_direct',
    contextKey: 'fixed_drone',
    prompt: 'i want to build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_exact_user_repro_focus',
    category: 'load_switch_focus',
    contextKey: 'fixed_drone_focus',
    prompt: 'i want to build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_missing_to',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: 'i want build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_wanna',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: 'i wanna build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_leading_now',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: 'now i want to build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_polite_can_you',
    category: 'load_switch_polite',
    contextKey: 'fixed_drone',
    prompt: 'can you load reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_polite_can_we_qmark',
    category: 'load_switch_polite',
    contextKey: 'fixed_drone',
    prompt: 'can we build a reachy mini?',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_polite_could_you',
    category: 'load_switch_polite',
    contextKey: 'fixed_drone_focus',
    prompt: 'could you switch to reachy mini?',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_bare_name',
    category: 'load_switch_bare',
    contextKey: 'fixed_drone',
    prompt: 'reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_minor_typo',
    category: 'load_switch_typo',
    contextKey: 'fixed_drone',
    prompt: 'i want to build a rechy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_try_rover',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: "let's try the planetary rover instead",
    expectedIntent: 'load_assembly',
    expectedArchetypeId: ROVER_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_make_arm',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: 'make me a robotic arm',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: ROBOTIC_ARM_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_generate_quadruped',
    category: 'load_switch_casual',
    contextKey: 'fixed_drone',
    prompt: 'generate a quadruped robot dog',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: OPEN_QUADRUPED_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_source_and_target',
    category: 'load_switch_source_target',
    contextKey: 'fixed_drone',
    prompt: 'switch from quadcopter drone to poppy',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: POPPY_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_open_in_focus',
    category: 'load_switch_focus',
    contextKey: 'fixed_drone_focus',
    prompt: 'open reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_show_in_focus',
    category: 'load_switch_focus',
    contextKey: 'fixed_drone_focus',
    prompt: 'show me the rover',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: ROVER_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_custom_drone_from_rover',
    category: 'load_switch_direct',
    contextKey: 'rover',
    prompt: 'build a custom 6-rotor drone with 300mm wheelbase',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_hexacopter_from_reachy',
    category: 'load_switch_direct',
    contextKey: 'reachy_mini',
    prompt: 'i want to build a hexacopter',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_spanish_reachy',
    category: 'load_switch_multilingual',
    contextKey: 'fixed_drone',
    prompt: 'quiero construir un reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'switch_from_param_drone_to_reachy',
    category: 'load_switch_direct',
    contextKey: 'param_drone_custom',
    prompt: 'i want to build a reachy mini',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },

  {
    id: 'mod_fixed_6rotor',
    category: 'modify_absolute',
    contextKey: 'fixed_drone',
    prompt: 'make it a 6-rotor drone',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_wheelbase',
    category: 'modify_absolute',
    contextKey: 'fixed_drone',
    prompt: 'change wheelbase to 320mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 4, wheelbase_mm: 320, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_turn_hexacopter',
    category: 'modify_absolute',
    contextKey: 'fixed_drone',
    prompt: 'turn this drone into a hexacopter',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_arm_thickness',
    category: 'modify_absolute',
    contextKey: 'fixed_drone',
    prompt: 'modify the drone to have 5mm thick arms',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 4, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 5 },
  },
  {
    id: 'mod_fixed_build_this_with_6',
    category: 'modify_absolute',
    contextKey: 'fixed_drone_focus',
    prompt: 'build this drone with 6 rotors',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_polite_wheelbase',
    category: 'modify_polite',
    contextKey: 'fixed_drone',
    prompt: 'can you make the wheelbase 300mm?',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 4, wheelbase_mm: 300, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_relative_thicker_arms',
    category: 'modify_relative',
    contextKey: 'fixed_drone',
    prompt: 'make the arms thicker',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 4,
      wheelbase_mm: (v) => v === 260,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v > 4 && v <= 6,
    },
  },
  {
    id: 'mod_fixed_relative_wider_wheelbase',
    category: 'modify_relative',
    contextKey: 'fixed_drone',
    prompt: 'give it a wider wheelbase',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 4,
      wheelbase_mm: (v) => v > 260 && v <= 360,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v === 4,
    },
  },
  {
    id: 'mod_fixed_add_2_rotors',
    category: 'modify_relative',
    contextKey: 'fixed_drone',
    prompt: 'add 2 more rotors',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_focus_hexacopter',
    category: 'modify_focus',
    contextKey: 'fixed_drone_focus',
    prompt: 'make this drone a hexacopter',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_fixed_focus_arm_thickness',
    category: 'modify_focus',
    contextKey: 'fixed_drone_focus',
    prompt: 'increase arm thickness to 5mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 4, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 5 },
  },

  {
    id: 'mod_param_deck_gap_preserve',
    category: 'modify_preserve',
    contextKey: 'param_drone_custom',
    prompt: 'now change deck gap to 32mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 320, deck_gap_mm: 32, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_param_deck_gap_delta',
    category: 'modify_relative',
    contextKey: 'param_drone_custom',
    prompt: 'increase deck gap by 4mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 320, deck_gap_mm: 30, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_param_wheelbase_delta',
    category: 'modify_relative',
    contextKey: 'param_drone_custom',
    prompt: 'reduce wheelbase by 20mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 300, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_param_thicker_arms_preserve',
    category: 'modify_relative',
    contextKey: 'param_drone_custom',
    prompt: 'make the arms thicker',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v === 320,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v > 4 && v <= 6,
    },
  },
  {
    id: 'mod_param_narrower_deck_gap',
    category: 'modify_relative',
    contextKey: 'param_drone_custom',
    prompt: 'make the deck gap narrower',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v === 320,
      deck_gap_mm: (v) => v >= 20 && v < 26,
      arm_thickness_mm: (v) => v === 4,
    },
  },
  {
    id: 'mod_param_back_to_4_rotors',
    category: 'modify_preserve',
    contextKey: 'param_drone_custom',
    prompt: 'switch back to 4 rotors',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 4, wheelbase_mm: 320, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'mod_param_compound_two_params',
    category: 'modify_preserve',
    contextKey: 'param_drone_custom',
    prompt: 'set wheelbase to 280 and arm thickness to 5.5mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 280, deck_gap_mm: 26, arm_thickness_mm: 5.5 },
  },
  {
    id: 'mod_param_focus_thicken',
    category: 'modify_focus',
    contextKey: 'param_drone_focus',
    prompt: 'thicken the arms to 5mm',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 320, deck_gap_mm: 26, arm_thickness_mm: 5 },
  },
  {
    id: 'mod_param_qualitative_heavier_duty',
    category: 'modify_relative_subtle',
    contextKey: 'param_drone_custom',
    prompt: 'beef up the arms and give the electronics a bit more vertical room between decks',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v === 320,
      deck_gap_mm: (v) => v > 26 && v <= 36,
      arm_thickness_mm: (v) => v > 4 && v <= 6,
    },
  },

  {
    id: 'q_motor_how',
    category: 'question_direct',
    contextKey: 'fixed_drone',
    prompt: 'How does the Rear Right Brushless Motor work?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_motor_explain',
    category: 'question_direct',
    contextKey: 'fixed_drone',
    prompt: 'Explain the Rear Right Brushless Motor',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_current_wheelbase',
    category: 'question_direct',
    contextKey: 'param_drone_custom',
    prompt: 'What is the wheelbase right now?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_tell_me',
    category: 'question_direct',
    contextKey: 'fixed_drone',
    prompt: 'Tell me what this does',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_arm_base_joint',
    category: 'question_direct',
    contextKey: 'arm_focus',
    prompt: 'Explain the base joint',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_arm_inspect_servo',
    category: 'question_direct',
    contextKey: 'arm_focus',
    prompt: 'Inspect the elbow servo',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_compare_reachy',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'compare this drone with reachy mini',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_how_reachy_different',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'how is reachy mini different from this drone?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_wheelbase_stability',
    category: 'question_lookalike',
    contextKey: 'param_drone_custom',
    prompt: 'how does wheelbase affect stability?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_can_carry_camera',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'can this drone carry a camera?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_can_fly_6_rotors',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'can this drone fly with 6 rotors?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_how_modify_mount',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'how do I modify the motor mount?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_why_arm_thickness',
    category: 'question_lookalike',
    contextKey: 'param_drone_custom',
    prompt: 'why is arm thickness 4mm?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_what_happens_increase_deck_gap',
    category: 'question_lookalike',
    contextKey: 'param_drone_custom',
    prompt: 'what happens if you increase the deck gap?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_could_build_reachy_motors',
    category: 'question_lookalike',
    contextKey: 'fixed_drone_focus',
    prompt: 'could I build a reachy mini with these motors?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_show_how_motor_works',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'Show me how the quadcopter motor works',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_why_hexacopter_vs_quad',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'why would someone use a hexacopter instead of a quadcopter?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_inspect_motor_on_rover',
    category: 'question_lookalike',
    contextKey: 'arm_focus',
    prompt: 'Inspect the motor on a rover',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_inspect_rover_qmark',
    category: 'question_lookalike',
    contextKey: 'fixed_drone',
    prompt: 'Inspect the rover?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'q_how_build_this_arm',
    category: 'question_lookalike',
    contextKey: 'arm_focus',
    prompt: 'Build this robotic arm',
    expectedIntent: 'ask_question',
  },

  {
    id: 'unsup_drone_lidar',
    category: 'unsupported_modify',
    contextKey: 'fixed_drone',
    prompt: 'add a lidar to this drone',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_drone_camera',
    category: 'unsupported_modify',
    contextKey: 'param_drone_custom',
    prompt: 'add a thermal camera to the drone',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_drone_color',
    category: 'unsupported_modify',
    contextKey: 'fixed_drone',
    prompt: 'change the frame color to red',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_drone_replace_fc',
    category: 'unsupported_modify',
    contextKey: 'fixed_drone',
    prompt: 'replace the flight controller with a Raspberry Pi',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_reachy_taller',
    category: 'unsupported_modify',
    contextKey: 'reachy_mini',
    prompt: 'make reachy mini taller',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_reachy_antennas',
    category: 'unsupported_modify',
    contextKey: 'reachy_mini',
    prompt: 'change the antenna length to 120mm',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_reachy_wheels',
    category: 'unsupported_modify',
    contextKey: 'reachy_mini',
    prompt: 'add wheels to reachy mini',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_rover_wheelbase',
    category: 'unsupported_modify',
    contextKey: 'rover',
    prompt: 'increase the rover wheelbase to 500mm',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'unsup_rover_add_arm',
    category: 'unsupported_modify',
    contextKey: 'rover',
    prompt: 'add a robotic arm on top of the rover',
    expectedIntent: 'unsupported_modify',
  },
];

const HELDOUT_DATASET = [
  {
    id: 'ho_load_done_with_drone',
    category: 'heldout_load',
    contextKey: 'fixed_drone',
    prompt: "I'm done with the drone, let's check out reachy",
    expectedIntent: 'load_assembly',
    expectedArchetypeId: REACHY_MINI_ARCHETYPE.archetypeId,
  },
  {
    id: 'ho_load_pull_up_dog',
    category: 'heldout_load',
    contextKey: 'fixed_drone',
    prompt: 'forget the drone, pull up the walking dog robot',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: OPEN_QUADRUPED_ARCHETYPE.archetypeId,
  },
  {
    id: 'ho_load_humanoid_polite',
    category: 'heldout_load',
    contextKey: 'fixed_drone',
    prompt: 'can we check out the humanoid instead?',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: POPPY_ARCHETYPE.archetypeId,
  },
  {
    id: 'ho_load_spanish_rover',
    category: 'heldout_load',
    contextKey: 'fixed_drone',
    prompt: 'quiero ver el rover',
    expectedIntent: 'load_assembly',
    expectedArchetypeId: ROVER_ARCHETYPE.archetypeId,
  },
  {
    id: 'ho_mod_spanish_6rotors',
    category: 'heldout_modify',
    contextKey: 'fixed_drone',
    prompt: 'cambia el dron a 6 rotores',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'ho_mod_clearance_stack',
    category: 'heldout_modify',
    contextKey: 'param_drone_custom',
    prompt: 'I need more clearance inside the frame for a bigger flight stack',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v === 320,
      deck_gap_mm: (v) => v > 26 && v <= 36,
      arm_thickness_mm: (v) => v === 4,
    },
  },
  {
    id: 'ho_mod_upgrade_6prop',
    category: 'heldout_modify',
    contextKey: 'fixed_drone',
    prompt: 'can we upgrade this to a 6 prop setup?',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParams: { rotor_count: 6, wheelbase_mm: 260, deck_gap_mm: 26, arm_thickness_mm: 4 },
  },
  {
    id: 'ho_mod_reinforce_arms',
    category: 'heldout_modify',
    contextKey: 'param_drone_custom',
    prompt: 'the arms look fragile, reinforce them a little',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v === 320,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v > 4 && v <= 6,
    },
  },
  {
    id: 'ho_mod_stretch_frame',
    category: 'heldout_modify',
    contextKey: 'param_drone_custom',
    prompt: "stretch out the frame so it's more stable",
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v > 320 && v <= 360,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v === 4,
    },
  },
  {
    id: 'ho_mod_more_compact',
    category: 'heldout_modify',
    contextKey: 'param_drone_custom',
    prompt: 'make it more compact',
    expectedIntent: 'modify_assembly',
    expectedArchetypeId: PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId,
    expectedParamChecks: {
      rotor_count: (v) => v === 6,
      wheelbase_mm: (v) => v >= 220 && v < 320,
      deck_gap_mm: (v) => v === 26,
      arm_thickness_mm: (v) => v === 4,
    },
  },
  {
    id: 'ho_q_wider_wb_wind',
    category: 'heldout_question',
    contextKey: 'param_drone_custom',
    prompt: 'would a wider wheelbase help with wind?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'ho_q_reachy_harder',
    category: 'heldout_question',
    contextKey: 'fixed_drone',
    prompt: 'is reachy mini harder to assemble than this?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'ho_q_6rotors_battery',
    category: 'heldout_question',
    contextKey: 'fixed_drone',
    prompt: 'do you think 6 rotors would drain the battery faster?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'ho_q_rover_similar_motors',
    category: 'heldout_question',
    contextKey: 'fixed_drone',
    prompt: 'if I wanted to build a rover later, does it use similar motors?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'ho_q_why_4mm_arm',
    category: 'heldout_question',
    contextKey: 'param_drone_custom',
    prompt: 'why did they pick a 4mm arm on this design?',
    expectedIntent: 'ask_question',
  },
  {
    id: 'ho_unsup_gopro',
    category: 'heldout_unsupported',
    contextKey: 'fixed_drone',
    prompt: 'stick a GoPro gimbal under the belly',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'ho_unsup_foldable',
    category: 'heldout_unsupported',
    contextKey: 'param_drone_custom',
    prompt: 'give it foldable arms so it fits in a backpack',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'ho_unsup_3blade',
    category: 'heldout_unsupported',
    contextKey: 'fixed_drone',
    prompt: 'swap the propellers to 3-blade props',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'ho_unsup_paint_reachy',
    category: 'heldout_unsupported',
    contextKey: 'reachy_mini',
    prompt: 'paint the shell matte black',
    expectedIntent: 'unsupported_modify',
  },
  {
    id: 'ho_unsup_rover_6wheels',
    category: 'heldout_unsupported',
    contextKey: 'rover',
    prompt: 'give the rover six wheels instead of four',
    expectedIntent: 'unsupported_modify',
  },
];

function matchesExpected(testCase, decision) {
  return (
    decision.kind === testCase.expectedIntent &&
    (testCase.contextKey === 'empty' ||
      testCase.expectedArchetypeId === undefined ||
      testCase.expectedArchetypeId === decision.targetArchetypeId) &&
    Object.entries(testCase.expectedParams ?? {}).every(
      ([key, value]) => decision.parameterValues?.[key] === value,
    ) &&
    Object.entries(testCase.expectedParamChecks ?? {}).every(([key, check]) =>
      check(decision.parameterValues?.[key]),
    )
  );
}

const INTENTS = ['load_assembly', 'modify_assembly', 'ask_question', 'unsupported_modify'];

function createMatrix() {
  return Object.fromEntries(
    INTENTS.map((expected) => [expected, Object.fromEntries(INTENTS.map((got) => [got, 0]))]),
  );
}

function percentile(values, rank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index];
}

const cases = [...EVAL_DATASET, ...HELDOUT_DATASET];
const offlineOnly = process.argv.includes('--offline-only');
const requireLive = process.argv.includes('--live');
const configuredProviders = offlineOnly ? [] : listConfiguredAiProviders();
const provider =
  configuredProviders.length > 0
    ? resolveDefaultConfiguredProvider(DEFAULT_AI_PROVIDER)
    : DEFAULT_AI_PROVIDER;
const runLive = !offlineOnly && configuredProviders.length > 0;
const deterministicMisses = [];
const liveMisses = [];
const deterministicMatrix = createMatrix();
const liveMatrix = createMatrix();
const deterministicLatencies = [];
const liveLatencies = [];
const cloudLatencies = [];
let offlineVerified = 0;
let fallbacksVerified = 0;
let liveRoutes = 0;
let liveFallbacks = 0;

for (const testCase of cases) {
  const input = {
    prompt: testCase.prompt,
    activeContext: CONTEXTS[testCase.contextKey],
    provider,
    providerExplicitlySelected: false,
  };
  const detStart = performance.now();
  const deterministic = classifyCanvasPromptWithConfidence(input.prompt, input.activeContext);
  deterministicLatencies.push(performance.now() - detStart);
  deterministicMatrix[testCase.expectedIntent][deterministic.decision.kind] += 1;
  if (!matchesExpected(testCase, deterministic.decision)) {
    assert.equal(
      deterministic.confidence,
      'low',
      `Incorrect fast-path decision for ${testCase.id}`,
    );
    deterministicMisses.push(testCase.id);
  }

  const offline = await resolveCanvasPromptRoute({
    ...input,
    isOnline: () => false,
    routeCloud: async () => assert.fail('Offline routing reached the cloud transport'),
  });
  assert.deepEqual(offline, { decision: deterministic.decision, source: 'deterministic' });
  offlineVerified += 1;

  const unavailable = await resolveCanvasPromptRoute({
    ...input,
    isOnline: () => true,
    routeCloud: async () => {
      throw new Error('Cloud routing is unavailable');
    },
  });
  const fallbackExpected = input.activeContext !== null && deterministic.confidence === 'low';
  assert.deepEqual(unavailable, {
    decision: deterministic.decision,
    source: fallbackExpected ? 'deterministic_fallback' : 'deterministic',
  });
  if (fallbackExpected) fallbacksVerified += 1;

  if (runLive) {
    const liveStart = performance.now();
    const resolved = await resolveCanvasPromptRoute({
      ...input,
      isOnline: () => true,
      routeCloud: (request, signal) => classifyPromptWithCloudProvider(request, { signal }),
    });
    const elapsedMs = performance.now() - liveStart;
    liveLatencies.push(elapsedMs);
    liveMatrix[testCase.expectedIntent][resolved.decision.kind] += 1;
    if (resolved.source === 'cloud') {
      liveRoutes += 1;
      cloudLatencies.push(elapsedMs);
    }
    if (resolved.source === 'deterministic_fallback') liveFallbacks += 1;
    if (!matchesExpected(testCase, resolved.decision)) liveMisses.push(testCase.id);
  }
}

console.info(
  `Deterministic: ${cases.length - deterministicMisses.length}/${cases.length} matched (p50=${percentile(deterministicLatencies, 50).toFixed(2)}ms, p95=${percentile(deterministicLatencies, 95).toFixed(2)}ms).`,
);
console.info('Deterministic confusion matrix:', JSON.stringify(deterministicMatrix));
console.info(
  `Offline: ${offlineVerified}/${cases.length} matched deterministic routing. Cloud failure: ${fallbacksVerified}/${fallbacksVerified} ambiguous cases fell back.`,
);
if (runLive) {
  console.info(
    `Live (${provider}): ${cases.length - liveMisses.length}/${cases.length} matched. Cloud decisions: ${liveRoutes}/${cases.length}. Cloud fallbacks: ${liveFallbacks}. Overall p50=${percentile(liveLatencies, 50).toFixed(2)}ms, p95=${percentile(liveLatencies, 95).toFixed(1)}ms. Cloud p50=${percentile(cloudLatencies, 50).toFixed(1)}ms, p95=${percentile(cloudLatencies, 95).toFixed(1)}ms.`,
  );
  console.info('Live confusion matrix:', JSON.stringify(liveMatrix));
} else if (requireLive && !offlineOnly) {
  console.error('Live evaluation requires a configured AI provider key.');
  process.exitCode = 1;
} else {
  console.info('Live provider evaluation skipped.');
}
if (process.argv.includes('--details')) {
  console.info('Deterministic misses:', deterministicMisses.join(', ') || 'none');
  if (runLive) console.info('Live misses:', liveMisses.join(', ') || 'none');
}
