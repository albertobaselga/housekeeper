export const ROLES = [
  'family_admin',
  'family_member',
  'employee_live_in',
  'helper',
  'viewer'
] as const;

export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'access.manage',
  'agreement.read',
  'agreement.write',
  'calendar.read',
  'calendar.write',
  'comment.create',
  'contact.read',
  'contact.write',
  'content.read',
  'content.write',
  'content.publish',
  'emergency.read',
  'expense.create.self',
  'export.employment.self',
  'leave.approve',
  'leave.request.self',
  'menu.read',
  'menu.write',
  'payment.confirm.self',
  'payment.register',
  'routine.read',
  'routine.toggle',
  'search.use',
  'settlement.close',
  'settlement.read',
  'work.confirm',
  'work.register.self'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  family_admin: 'Administrador familiar',
  family_member: 'Miembro de la familia',
  employee_live_in: 'Empleada interna',
  helper: 'Apoyo del hogar',
  viewer: 'Acceso puntual'
};

const EVERYDAY_READ: Capability[] = [
  'contact.read',
  'emergency.read'
];

const HOME_OPERATIONS: Capability[] = [
  'menu.read',
  'content.read',
  'search.use',
  'routine.read'
];

/**
 * The capability matrix is the single authorization vocabulary shared by
 * server guards and presentation. Hiding a link is never considered a guard.
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  family_admin: CAPABILITIES,
  family_member: [
    ...EVERYDAY_READ,
    ...HOME_OPERATIONS,
    'agreement.read',
    'calendar.read',
    'calendar.write',
    'comment.create',
    'contact.write',
    'content.write',
    'content.publish',
    'menu.write',
    'routine.toggle',
    'settlement.read'
  ],
  employee_live_in: [
    ...EVERYDAY_READ,
    ...HOME_OPERATIONS,
    'agreement.read',
    'calendar.read',
    'comment.create',
    'expense.create.self',
    'export.employment.self',
    'leave.request.self',
    'payment.confirm.self',
    'routine.toggle',
    'settlement.read',
    'work.register.self'
  ],
  helper: [
    ...EVERYDAY_READ,
    ...HOME_OPERATIONS,
    'routine.toggle'
  ],
  viewer: [
    ...EVERYDAY_READ,
    'calendar.read'
  ]
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function capabilitiesFor(role: Role | string | null | undefined): readonly Capability[] {
  return isRole(role) ? ROLE_CAPABILITIES[role] : [];
}

export function can(
  role: Role | string | null | undefined,
  capability: Capability | string
): boolean {
  if (!isRole(role) || !(CAPABILITIES as readonly string[]).includes(capability)) return false;
  return ROLE_CAPABILITIES[role].includes(capability as Capability);
}
