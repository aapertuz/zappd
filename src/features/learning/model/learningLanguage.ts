const MATERIAL_NAMES = new Map([
  ['carbon_fiber', 'carbon fiber'],
  ['carbon_fiber_composite', 'carbon fiber composite'],
  ['anodized_aluminum', 'anodized aluminum'],
  ['machined_aluminum', 'machined aluminum'],
  ['pla_3d_printed', '3D-printed PLA plastic'],
  ['abs_3d_printed', '3D-printed ABS plastic'],
  ['fr4_pcb', 'fiberglass circuit board material'],
  ['servo_housing', 'servo motor housing material'],
  ['polycarbonate', 'polycarbonate plastic'],
  ['brass', 'brass'],
]);

const EVERYDAY_TERMS: readonly (readonly [RegExp, string])[] = [
  [/\bmulti-rotor UAV airframe\b/gi, 'frame for an aircraft with several propellers'],
  [/\bautonomous planetary ground rover\b/gi, 'vehicle designed to explore terrain on its own'],
  [/\bfollower manipulator\b/gi, 'robot arm that follows another arm’s movements'],
  [/\brobotic manipulator\b/gi, 'robotic arm'],
  [/\bbrushless propulsion\b/gi, 'motors and propellers'],
  [/\bstereo perception\b/gi, 'depth sensing'],
  [/\bcompute bay\b/gi, 'computer compartment'],
  [
    /\bcoaxial cylindrical motor stator seat\b/gi,
    'round mount lined up with the motor’s center line',
  ],
  [/\bcantilevered arm cup\b/gi, 'socket at the end of the arm'],
  [/\bcantilevered (\w+)\b/gi, '$1 supported at one end'],
  [/\bcoaxially\b/gi, 'along the same center line'],
  [/\bcoaxial\b/gi, 'sharing a center line'],
  [/\boutrunner rotation axis\b/gi, 'line the motor spins around'],
  [/\brotation axis\b/gi, 'line it spins around'],
  [/\bperpendicular to the airframe plane\b/gi, 'at a right angle to the drone frame'],
  [/\boutrunner (?:brushless )?motors\b/gi, 'motors with spinning outer shells'],
  [/\boutrunner motor shaft\b/gi, 'shaft of the motor with a spinning outer shell'],
  [/\boutrunner\b/gi, 'motor with a spinning outer shell'],
  [/\brevolute joint\b/gi, 'pivot joint'],
  [/\bstandoff(?= pins?\b)/gi, 'spacer'],
  [/\bstandoff(s?)\b/gi, 'spacer$1'],
  [/\bairframe chassis\b/gi, 'drone frame'],
  [/\bchassis\b/gi, 'frame'],
  [/\byaw drive\b/gi, 'side-to-side turning mechanism'],
  [/\byaw\b/gi, 'side-to-side rotation'],
  [/\bwrist differential\b/gi, 'wrist gearing'],
  [/\bactuator(s?)\b/gi, 'movement mechanism$1'],
  [/\bsteering and axle drivetrain\b/gi, 'steering and wheel drive'],
  [/\baxle flange(s?)\b/gi, 'axle mounting rim$1'],
  [/\bAckermann\/swerve steering angle\b/gi, 'steering angle'],
  [/\bB-rep\b/gi, '3D shape data'],
  [/\bDOF\b/g, 'directions of movement'],
  [/(\d)(mm)\b/g, '$1 $2'],
];

const SPEC_NAMES = new Map([
  ['degrees of freedom', 'number of ways it can move'],
  ['link length', 'length of the connecting piece'],
  ['wheel stations', 'number of wheel positions'],
  ['wrist axes', 'number of ways the wrist can turn'],
  ['yaw range', 'side-to-side turning range'],
]);

export function humanizeMaterial(materialHint: string): string | null {
  const hint = materialHint.trim();
  if (hint === '' || hint === 'assembly_root') return null;
  return MATERIAL_NAMES.get(hint) ?? (hint.replace(/[_\s]+/g, ' ').trim() || null);
}

export function humanizeTechnicalText(text: string): string {
  return EVERYDAY_TERMS.reduce(
    (plain, [pattern, replacement]) => plain.replace(pattern, replacement),
    text,
  ).trim();
}

export function humanizeName(name: string): string {
  const plain = name
    .replace(/\b\d+[- ]DOF\s+/gi, '')
    .replace(/\s+(?:(?:CAD )?Assembly|Subsystem)$/i, '');
  return humanizeTechnicalText(plain) || name.trim();
}

export function humanizeSpecKey(key: string): string {
  const words = key
    .replace(/(?:Mm|Deg|Nm|KgCm)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .toLowerCase();
  return SPEC_NAMES.get(words) ?? humanizeTechnicalText(words);
}

export function formatDimensions(dimensionsMm: readonly number[]): string {
  return `${dimensionsMm.map((value) => String(Number(value.toFixed(1)))).join(' × ')} mm`;
}

export function finishSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function describePurpose(text: string, subject = 'It'): string {
  return finishSentence(
    humanizeTechnicalText(text).replace(
      /^(Aligns|Actuates|Closes|Converts|Couples|Drives|Elevates|Houses|Isolates|Keeps|Maintains|Moves|Places|Provides|Retains|Supports|Transmits|Transfers)\b/i,
      (verb) => `${subject} ${verb.toLowerCase()}`,
    ),
  );
}

export function formatSpecification(key: string, value: string | number | boolean): string {
  const unit = /Mm$/.test(key)
    ? ' mm'
    : /Deg$/.test(key)
      ? ' degrees'
      : /Nm$/.test(key)
        ? ' N·m'
        : /KgCm$/.test(key)
          ? ' kg·cm'
          : '';
  const label = humanizeSpecKey(key);
  if (typeof value === 'boolean')
    return `The saved details mark “${label}” as ${value ? 'yes' : 'no'}.`;
  const detail = typeof value === 'number' ? `${value}${unit}` : humanizeTechnicalText(value);
  return finishSentence(`Its ${label} is ${detail}`);
}

export function formatConnection(
  counterpartName: string | undefined,
  howConnected: string,
): string {
  const detail = humanizeTechnicalText(howConnected).replace(/[.!?]+$/, '');
  if (counterpartName === undefined) return finishSentence(detail);
  return `It connects to the ${humanizeName(counterpartName)} (${detail}).`;
}
