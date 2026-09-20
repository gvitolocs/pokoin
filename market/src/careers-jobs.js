/**
 * Open roles for /careers.
 *
 * Leave OPEN_ROLES empty until a real posting exists. Shape matches the
 * Phantom/Ashby board dump in candyext/dumps/phantom (department accordion +
 * title / location / employmentType / applyUrl). Do not invent openings here.
 */

/** @typedef {{
 *   id: string,
 *   title: string,
 *   department: string,
 *   team?: string,
 *   location: string,
 *   employmentType?: string,
 *   isRemote?: boolean,
 *   applyUrl?: string,
 *   jobUrl?: string,
 * }} CareersRole */

/** @type {CareersRole[]} */
export const OPEN_ROLES = [];

export const CAREERS_CONTACT = 'mailto:contact@pokoin.com?subject=Careers';

/**
 * Group roles by department, preserving first-seen department order.
 * @param {CareersRole[]} roles
 * @returns {{ department: string, roles: CareersRole[] }[]}
 */
export function groupRolesByDepartment(roles = OPEN_ROLES) {
  const list = Array.isArray(roles) ? roles : [];
  const order = [];
  const buckets = new Map();
  for (const role of list) {
    if (!role || typeof role !== 'object') continue;
    const department = String(role.department || 'General').trim() || 'General';
    if (!buckets.has(department)) {
      buckets.set(department, []);
      order.push(department);
    }
    buckets.get(department).push(role);
  }
  return order.map((department) => ({
    department,
    roles: buckets.get(department),
  }));
}

export function roleHref(role) {
  if (!role || typeof role !== 'object') return CAREERS_CONTACT;
  const href = String(role.applyUrl || role.jobUrl || '').trim();
  return href || CAREERS_CONTACT;
}

export function roleMeta(role) {
  if (!role || typeof role !== 'object') return '';
  const bits = [];
  const location = String(role.location || '').trim();
  if (location) bits.push(location);
  const type = String(role.employmentType || '').trim();
  if (type) {
    bits.push(type === 'FullTime' ? 'Full-time' : type === 'PartTime' ? 'Part-time' : type);
  }
  return bits.join(' · ');
}
