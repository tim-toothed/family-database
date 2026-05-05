import { collectDocumentSnippetTokens } from '../documents/deeplinks.js';
import { getPersonFieldLabel } from '../person/labels.js';
import { escapeHtml, isPlainObject } from '../utils/normalize.js';

const DATE_PART_KEYS = new Set(['day', 'month', 'year']);
const LINK_MASK_URL_RE = /(https?:\/\/[^\s<>"']+|doc:\/\/[^\s<>"']+)/giu;

export function parseEditorPath(pathString) {
  return String(pathString || '')
    .split('.')
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function getValueByEditorPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (current === undefined || current === null) return undefined;
    current = current[segment];
  }
  return current;
}

export function ensureEditorPathContainer(target, path) {
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const next = path[index + 1];

    if (typeof segment === 'number') {
      if (current[segment] === undefined || current[segment] === null) {
        current[segment] = typeof next === 'number' ? [] : {};
      }
      current = current[segment];
      continue;
    }

    if (current[segment] === undefined || current[segment] === null) {
      current[segment] = typeof next === 'number' ? [] : {};
    }
    current = current[segment];
  }
  return current;
}

export function formatPersonOption(personId, peopleById) {
  const name = peopleById?.get(personId);
  if (!name || name === personId) return personId;
  return `${name} [${personId}]`;
}

export function resolvePersonInput(value, peopleById, optionValueToId) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (peopleById?.has(normalized)) return normalized;
  if (optionValueToId?.has(normalized)) return optionValueToId.get(normalized);
  const match = normalized.match(/\[(P\d+)\]$/i);
  if (match && peopleById?.has(match[1].toUpperCase())) {
    return match[1].toUpperCase();
  }
  return null;
}

export function buildPersonOptionEntries(dataset) {
  const entries = Array.from(dataset.indexById.entries())
    .map(([personId, name]) => ({
      id: personId,
      label: formatPersonOption(personId, dataset.indexById),
      sortName: String(name || personId),
      hasCustomName: Boolean(name && name !== personId),
    }))
    .sort((left, right) => {
      if (left.hasCustomName !== right.hasCustomName) {
        return left.hasCustomName ? -1 : 1;
      }
      return left.sortName.localeCompare(right.sortName, 'ru');
    });

  const optionValueToId = new Map(entries.map((entry) => [entry.label, entry.id]));
  return { entries, optionValueToId };
}

export function getEditorFieldLabel(key) {
  return getPersonFieldLabel(key, { context: 'editor' });
}

export function isDateSchemaNode(schemaNode) {
  if (!isPlainObject(schemaNode)) return false;
  const keys = Object.keys(schemaNode);
  return keys.length > 0 && keys.every((key) => DATE_PART_KEYS.has(key));
}

export function isDatePartKey(key) {
  return DATE_PART_KEYS.has(key);
}

export function normalizeDatePartValue(key, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric)) return normalized;

  if (key === 'day' && (numeric < 1 || numeric > 31)) return normalized;
  if (key === 'month' && (numeric < 1 || numeric > 12)) return normalized;
  if (key === 'year' && numeric < 0) return normalized;
  return numeric;
}

export function isGenericSchemaHint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'text';
}

export function extractSchemaOptions(schemaNode) {
  if (typeof schemaNode !== 'string') return [];
  const match = schemaNode.match(/\(([^()]+)\)\s*$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createEmptyValue(schemaNode) {
  if (Array.isArray(schemaNode)) return [];
  if (isPlainObject(schemaNode)) {
    return Object.fromEntries(
      Object.keys(schemaNode).map((key) => [key, createEmptyValue(schemaNode[key])])
    );
  }
  return '';
}

export function getSchemaNode(schemaNode, path) {
  let current = schemaNode;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[0];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function collectLinkMaskTokens(value) {
  const source = String(value || '');
  const tokens = collectDocumentSnippetTokens(source).map((token) => ({
    text: token.raw,
    start: token.start,
    end: token.end,
  }));
  let match;

  LINK_MASK_URL_RE.lastIndex = 0;
  while ((match = LINK_MASK_URL_RE.exec(source))) {
    let url = match[0];
    let end = match.index + url.length;

    while (url && /[),.;!?]$/.test(url)) {
      url = url.slice(0, -1);
      end -= 1;
    }

    if (!url) continue;
    tokens.push({
      text: url,
      start: match.index,
      end,
    });
  }

  return tokens.sort((left, right) => left.start - right.start || left.end - right.end);
}

function buildMaskedLinkHtml(value) {
  const source = String(value || '');
  const tokens = collectLinkMaskTokens(source);
  if (!tokens.length) return '';

  let cursor = 0;
  let html = '';

  for (const token of tokens) {
    if (token.start > cursor) {
      html += escapeHtml(source.slice(cursor, token.start));
    }

    html += `<span class="editor-link-token" data-link-start="${token.start}" data-link-end="${token.end}">[link]</span>`;
    cursor = token.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>');
}

function updateLinkMaskedField(shell) {
  const input = shell.querySelector('.editor-link-mask-target');
  const overlay = shell.querySelector('[data-link-mask-overlay]');
  if (!input || !overlay) return;

  const maskedHtml = buildMaskedLinkHtml(input.value);
  const hasLinks = Boolean(maskedHtml);
  const isEditing = document.activeElement === input && !input.disabled;

  shell.classList.toggle('has-links', hasLinks);
  shell.classList.toggle('is-editing', isEditing);
  shell.classList.toggle('is-masked', hasLinks && !isEditing);
  overlay.classList.toggle('hidden', !hasLinks || isEditing);
  overlay.innerHTML = hasLinks ? maskedHtml : '';
}

function focusMaskedLinkTarget(input, token) {
  if (input.disabled) return;
  input.focus();

  if (!token) return;
  const start = Number(token.dataset.linkStart);
  const end = Number(token.dataset.linkEnd);
  if (Number.isFinite(start) && Number.isFinite(end) && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(start, end);
  }
}

export function initializeLinkMaskedFields(root) {
  root.querySelectorAll('[data-link-mask-shell]').forEach((shell) => {
    const input = shell.querySelector('.editor-link-mask-target');
    const overlay = shell.querySelector('[data-link-mask-overlay]');
    if (!input || !overlay) return;

    const refresh = () => updateLinkMaskedField(shell);

    input.addEventListener('focus', refresh);
    input.addEventListener('blur', () => {
      window.requestAnimationFrame(refresh);
    });
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);

    overlay.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    overlay.addEventListener('click', (event) => {
      const token = event.target.closest('.editor-link-token');
      focusMaskedLinkTarget(input, token);
    });

    refresh();
  });
}
