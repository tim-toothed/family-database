import { asArray, asTrimmedString, normalizeText } from './normalize.js';

const PERSON_ID_RE = /^P(\d+)$/i;
const PERSON_LOOKUP_ID_RE = /\[(P\d+)\]$/i;

export function normalizePersonId(value) {
  const text = asTrimmedString(value);
  const match = text.match(PERSON_ID_RE);
  return match ? `P${match[1]}`.toUpperCase() : text;
}

export function resolvePersonLookupTarget(rawValue, { peopleById, optionValueToId } = {}) {
  const normalized = asTrimmedString(rawValue);
  if (!normalized) return '';
  if (peopleById?.has(normalized)) return normalized;
  if (optionValueToId?.has(normalized)) return optionValueToId.get(normalized);

  const match = normalized.match(PERSON_LOOKUP_ID_RE) || normalized.match(PERSON_ID_RE);
  if (!match) return null;

  const normalizedId = normalizePersonId(match[1] || normalized);
  return peopleById?.has(normalizedId) ? normalizedId : null;
}

export function computeNextPersonId(ids, extraIds = []) {
  const numericIds = [...asArray(ids), ...asArray(extraIds)]
    .map((id) => asTrimmedString(id).match(PERSON_ID_RE))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  if (!numericIds.length) return 'P001';

  const nextNumber = Math.max(...numericIds) + 1;
  const width = Math.max(3, String(nextNumber).length);
  return `P${String(nextNumber).padStart(width, '0')}`;
}

export function buildChildRelationTypeFromParent(relationType) {
  const normalized = normalizeText(relationType);
  if (!normalized) return '';
  if (normalized.includes('приемн')) return 'приемный';
  if (normalized.includes('мачех') || normalized.includes('отчим')) return 'сводный';
  if (normalized.includes('мать') || normalized.includes('отец')) return 'биологический';
  return '';
}

export function buildParentRelationTypeFromChild(childRelationType, personSex) {
  const normalizedRelation = normalizeText(childRelationType);
  const normalizedSex = normalizeText(personSex);
  const isMale = normalizedSex === 'м';
  const isFemale = normalizedSex === 'ж';

  if (!isMale && !isFemale) return '';
  if (normalizedRelation.includes('приемн')) return isMale ? 'приемный отец' : 'приемная мать';
  if (normalizedRelation.includes('сводн')) return isMale ? 'отчим' : 'мачеха';
  return isMale ? 'отец' : 'мать';
}

export function canonicalSiblingRelationType(relationType) {
  const normalized = normalizeText(relationType);
  if (!normalized) return '';
  if (normalized === 'биологический') return 'биологический';
  if (normalized === 'приемный') return 'приемный';
  if (normalized === 'сводный по отцу') return 'сводный по отцу';
  if (normalized === 'сводный по матери') return 'сводный по матери';
  return asTrimmedString(relationType);
}

export function inferSiblingRelationType(leftRelationType, rightRelationType) {
  const left = canonicalSiblingRelationType(leftRelationType);
  const right = canonicalSiblingRelationType(rightRelationType);

  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;

  const pair = new Set([left, right]);
  if (pair.has('биологический') && pair.has('сводный по отцу')) return 'сводный по отцу';
  if (pair.has('биологический') && pair.has('сводный по матери')) return 'сводный по матери';
  if (pair.has('биологический') && pair.has('приемный')) return 'приемный';
  if (pair.has('приемный')) return 'приемный';

  return '';
}
