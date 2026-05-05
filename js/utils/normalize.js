export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asObject(value) {
  return isPlainObject(value) ? value : {};
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asTrimmedString(value) {
  return String(value ?? '').trim();
}

export function normalizeText(value) {
  return asTrimmedString(value).toLowerCase();
}

export function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeForMatch(value, locale = 'ru') {
  return normalizeWhitespace(value).toLocaleLowerCase(locale).replaceAll('ё', 'е');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function normalizeIdList(ids) {
  return [...new Set(asArray(ids).map(asTrimmedString).filter(Boolean))];
}

export function ensureLeadingSlash(path) {
  const text = asTrimmedString(path);
  return text.startsWith('/') ? text : `/${text}`;
}

export function stripTrailingSlashes(value) {
  return asTrimmedString(value).replace(/\/+$/, '');
}

export function clonePlainValue(value) {
  if (Array.isArray(value)) return value.map((item) => clonePlainValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clonePlainValue(nested)]));
  }
  return value;
}
