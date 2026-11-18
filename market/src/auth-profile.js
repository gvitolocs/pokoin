// users/{uid} document → the profile the header, menu and desks read
// (role, Silver, avatar, handle). No React: the Solid UI shapes the same
// document from a REST read.

import { safeAvatarUrl } from './avatar.js';

function readDate(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function profileFrom(data = {}, uid = '') {
  const role = String(data.role || '').trim().toLowerCase();
  const roles = Array.isArray(data.roles) ? data.roles.map((row) => String(row).toLowerCase()) : [];
  const admin = data.admin === true || data.isAdmin === true || role === 'admin' || roles.includes('admin');
  const silverUntil = readDate(data.silverUntil);
  // Silver = admin or an unexpired silverUntil; a legacy `role: 'silver'`
  // grants nothing (paid Silver expires after a year).
  const silver = admin || (silverUntil && silverUntil.getTime() > Date.now());
  return {
    uid,
    username: data.username || '',
    displayName: String(data.displayName || '').trim(),
    role: data.role || '',
    admin,
    silver,
    silverUntil,
    photoUrl: safeAvatarUrl(data.photoUrl),
  };
}
