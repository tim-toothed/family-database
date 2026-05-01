'use strict';

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePayloadJson(value, label = 'payload_json') {
  try {
    const parsed = JSON.parse(String(value || ''));
    assertPlainObject(parsed, label);
    return parsed;
  } catch (error) {
    if (error?.message?.includes('must be an object')) throw error;
    throw new Error(`${label} must be a valid JSON object string.`);
  }
}

function getPersonDisplayName(payload, fallbackId) {
  const birthName = payload?.birth_name;
  if (typeof birthName === 'string' && birthName.trim()) return birthName.trim();
  if (birthName && typeof birthName === 'object' && !Array.isArray(birthName)) {
    const name = [birthName.surname, birthName.first_name, birthName.patronymic]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' ');
    if (name) return name;
  }
  return String(fallbackId || '').trim();
}

function collectChangedPaths(beforeValue, afterValue, path = []) {
  if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return [];
  if (!isPlainObject(beforeValue) || !isPlainObject(afterValue)) {
    return [path.join('.') || 'payload'];
  }
  const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
  const changed = [];
  for (const key of keys) changed.push(...collectChangedPaths(beforeValue[key], afterValue[key], [...path, key]));
  return changed;
}

function computeNextPersonId(rows) {
  const numericIds = rows
    .map((row) => String(row.id || '').trim().match(/^P(\d+)$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const maxId = numericIds.length ? Math.max(...numericIds) : 0;
  const width = Math.max(3, String(maxId + 1).length);
  return `P${String(maxId + 1).padStart(width, '0')}`;
}

module.exports = {
  cloneJson,
  collectChangedPaths,
  computeNextPersonId,
  getPersonDisplayName,
  parsePayloadJson,
};
