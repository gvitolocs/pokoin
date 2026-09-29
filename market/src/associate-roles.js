/**
 * Associate roster roles → what badges say. Roles are lowercase slugs in
 * public.marketplace_associates.role; the Founder Ambassador is a one-off
 * ambassador title (scripts/sql/097_founder_ambassador.sql).
 */
const LABELS = {
  founder_ambassador: 'Founder Ambassador',
  ambassador: 'Ambassador',
  distributor: 'Distributor',
  associate: 'Associate',
};

export function associateRoleLabel(role) {
  const key = String(role || '').trim().toLowerCase();
  if (LABELS[key]) return LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isAmbassadorRole(role) {
  const key = String(role || '').trim().toLowerCase();
  return key === 'ambassador' || key === 'founder_ambassador';
}

export function isFounderRole(role) {
  return String(role || '').trim().toLowerCase() === 'founder_ambassador';
}
