'use strict';

const { listGuides, readGuide } = require('./agent-guides');
const { createPerson, getPerson, listPeopleIndex, updatePerson } = require('./family-db');
const {
  cloneJson,
  collectChangedPaths,
  computeNextPersonId,
  getPersonDisplayName,
  parsePayloadJson,
} = require('./person-utils');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeLimit(value, fallback = 20) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), 50);
}

function normalizeChangedPaths(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((path) => String(path || '').trim())
    .filter(Boolean);
}

function isPathCoveredByExpected(actualPath, expectedPath) {
  const actual = String(actualPath || '').trim();
  const expected = String(expectedPath || '').trim();
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  if (actual.startsWith(`${expected}.`)) return true;
  if (expected.startsWith(`${actual}.`)) return true;
  return actual.split('.')[0] === expected.split('.')[0];
}

function assertOnlyExpectedChanges(changedPaths, expectedChangedPaths) {
  if (!expectedChangedPaths.length) {
    throw new Error('expected_changed_paths must list the fields that are intentionally changed.');
  }

  const unexpectedPaths = changedPaths.filter((actualPath) => (
    !expectedChangedPaths.some((expectedPath) => isPathCoveredByExpected(actualPath, expectedPath))
  ));

  if (unexpectedPaths.length) {
    throw new Error(
      `Refusing to save unexpected changes outside expected_changed_paths: ${unexpectedPaths.join(', ')}. `
      + `Expected only: ${expectedChangedPaths.join(', ')}. Re-read the card and retry with unrelated fields unchanged.`
    );
  }
}

const TEXT_LIST_FIELD_KEY = {
  education: 'education_info',
  jobs: 'job',
  military_service: 'service_info',
  war_participation: 'war',
  achievements: 'achievement',
  residences: 'residence_info',
  sources: 'source',
};

const SCALAR_TEXT_FIELDS = new Set([
  'class_title',
  'religion',
  'nationality',
  'hobbies',
  'character',
  'appearance',
  'health',
]);

function getTopLevelPaths(paths) {
  return [...new Set(paths.map((path) => String(path || '').split('.')[0]).filter(Boolean))];
}

function looksLikeJsonMarkup(value) {
  const text = String(value || '').trim();
  if (!text || !['{', '['].includes(text[0])) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function assertTextValue(value, path) {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a plain string, not nested JSON/object markup.`);
  }
  if (looksLikeJsonMarkup(value)) {
    throw new Error(`${path} must be plain text, not a JSON string.`);
  }
}

function assertPlainObjectArray(value, section) {
  if (!Array.isArray(value)) {
    throw new Error(`${section} must be an array.`);
  }
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${section}[${index}] must be an object.`);
    }
  });
}

function assertTextListSection(payload, section, key) {
  if (payload[section] === undefined) return;
  assertPlainObjectArray(payload[section], section);
  payload[section].forEach((item, index) => {
    const keys = Object.keys(item);
    if (!keys.includes(key)) {
      throw new Error(`${section}[${index}] must use ${key}, not ${keys.join(', ') || 'empty object'}.`);
    }
    for (const itemKey of keys) {
      if (itemKey !== key) throw new Error(`${section}[${index}] has unsupported field ${itemKey}; expected only ${key}.`);
    }
    assertTextValue(item[key], `${section}[${index}].${key}`);
  });
}

function assertOtherInfoSection(payload) {
  if (payload.other_info === undefined) return;
  assertPlainObjectArray(payload.other_info, 'other_info');
  payload.other_info.forEach((item, index) => {
    const keys = Object.keys(item);
    for (const key of keys) {
      if (!['label', 'text'].includes(key)) {
        throw new Error(`other_info[${index}] has unsupported field ${key}; expected label/text.`);
      }
    }
    if (!keys.includes('text')) throw new Error(`other_info[${index}] must include text.`);
    if (item.label !== undefined) assertTextValue(item.label, `other_info[${index}].label`);
    assertTextValue(item.text, `other_info[${index}].text`);
  });
}

function assertMediaSection(payload) {
  if (payload.media === undefined) return;
  assertPlainObjectArray(payload.media, 'media');
  payload.media.forEach((item, index) => {
    const keys = Object.keys(item);
    for (const key of keys) {
      if (!['description', 'link'].includes(key)) {
        throw new Error(`media[${index}] has unsupported field ${key}; expected description/link.`);
      }
      assertTextValue(item[key], `media[${index}].${key}`);
    }
  });
}

function assertScalarTextSection(payload, section) {
  if (payload[section] === undefined || payload[section] === null || payload[section] === '') return;
  assertTextValue(payload[section], section);
}

function validatePersonPayloadShape(payload, sections = Object.keys(payload || {})) {
  const sectionSet = new Set(sections);
  for (const [section, key] of Object.entries(TEXT_LIST_FIELD_KEY)) {
    if (sectionSet.has(section)) assertTextListSection(payload, section, key);
  }
  for (const section of SCALAR_TEXT_FIELDS) {
    if (sectionSet.has(section)) assertScalarTextSection(payload, section);
  }
  if (sectionSet.has('other_info')) assertOtherInfoSection(payload);
  if (sectionSet.has('media')) assertMediaSection(payload);
}

async function toolSearchPeople(args) {
  const query = String(args.query || '').trim().toLowerCase();
  const limit = normalizeLimit(args.limit);
  const rows = await listPeopleIndex();
  const matches = rows
    .filter((row) => {
      const id = String(row.id || '').toLowerCase();
      const name = String(row.display_name || '').toLowerCase();
      return !query || id.includes(query) || name.includes(query);
    })
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      display_name: row.display_name || row.id,
    }));

  return { rows: matches, total: matches.length };
}

async function toolGetPerson(args) {
  const personId = String(args.person_id || '').trim();
  if (!personId) throw new Error('person_id is required.');

  const row = await getPerson(personId);
  return {
    id: row.id,
    display_name: getPersonDisplayName(row.payload, row.id),
    payload: row.payload,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function toolCreatePersonPayload(args) {
  const rows = await listPeopleIndex();
  const requestedId = String(args.person_id || '').trim();
  const personId = requestedId || computeNextPersonId(rows);
  if (rows.some((row) => String(row.id || '').trim() === personId)) {
    throw new Error(`Person ${personId} already exists.`);
  }

  const payload = parsePayloadJson(args.payload_json);
  if (payload.id && String(payload.id).trim() !== personId) {
    throw new Error(`payload.id must match ${personId}.`);
  }
  payload.id = personId;
  validatePersonPayloadShape(payload);

  const row = await createPerson(personId, payload);
  const afterPayload = cloneJson(row.payload || payload);
  return {
    result: {
      id: row.id || personId,
      display_name: getPersonDisplayName(afterPayload, personId),
      synchronizedIds: row.synchronizedIds || [],
      skippedIds: row.skippedIds || [],
    },
    change: {
      personId,
      displayName: getPersonDisplayName(afterPayload, personId),
      changedPaths: ['created'],
      beforePayload: null,
      afterPayload,
    },
  };
}

async function toolUpdatePersonPayload(args) {
  const personId = String(args.person_id || '').trim();
  if (!personId) throw new Error('person_id is required.');

  const beforeRow = await getPerson(personId);
  const beforePayload = cloneJson(beforeRow.payload);
  const afterPayloadInput = parsePayloadJson(args.payload_json);
  if (afterPayloadInput.id && String(afterPayloadInput.id).trim() !== personId) {
    throw new Error(`payload.id must match ${personId}.`);
  }
  afterPayloadInput.id = afterPayloadInput.id || personId;

  const expectedChangedPaths = normalizeChangedPaths(args.expected_changed_paths);
  const requestedChangedPaths = collectChangedPaths(beforePayload, afterPayloadInput);
  assertOnlyExpectedChanges(requestedChangedPaths, expectedChangedPaths);
  validatePersonPayloadShape(afterPayloadInput, getTopLevelPaths(requestedChangedPaths));

  const row = await updatePerson(personId, afterPayloadInput);
  const afterPayload = cloneJson(row.payload || afterPayloadInput);
  const changedPaths = collectChangedPaths(beforePayload, afterPayload);

  return {
    result: {
      id: row.id || personId,
      display_name: getPersonDisplayName(afterPayload, personId),
      changedPaths,
      synchronizedIds: row.synchronizedIds || [],
      skippedIds: row.skippedIds || [],
    },
    change: {
      personId,
      displayName: getPersonDisplayName(afterPayload, personId),
      changedPaths,
      beforePayload,
      afterPayload,
    },
  };
}

function assertPublicUrl(rawUrl) {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only public http/https URLs are allowed.');
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.local')
    || hostname === '127.0.0.1'
    || hostname.startsWith('127.')
    || hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) {
    throw new Error('Private network URLs are not allowed.');
  }
  return url;
}

function decodeHtmlEntity(entity) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  if (named[entity]) return named[entity];
  if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  return `&${entity};`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+|#\d+|#x[a-fA-F0-9]+);/g, (_, entity) => {
      try {
        return decodeHtmlEntity(entity);
      } catch {
        return ' ';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function toolFetchPublicUrl(args) {
  const url = assertPublicUrl(args.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'family-ai-agent/1.0',
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (!response.ok) throw new Error(`URL returned ${response.status}.`);
    const text = contentType.includes('html') ? htmlToText(rawText) : rawText.replace(/\s+/g, ' ').trim();
    return {
      url: url.toString(),
      status: response.status,
      content_type: contentType,
      text: text.slice(0, 16000),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const TOOL_HANDLERS = {
  search_people: toolSearchPeople,
  get_person: toolGetPerson,
  create_person_payload: toolCreatePersonPayload,
  update_person_payload: toolUpdatePersonPayload,
  list_agent_guides: async () => ({ guides: listGuides() }),
  read_agent_guide: async (args) => readGuide(String(args.guide_id || '').trim()),
  fetch_public_url: toolFetchPublicUrl,
};

async function executeToolCall(call) {
  const name = String(call?.name || '').trim();
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}.`);

  let args;
  try {
    args = call?.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    throw new Error(`Tool ${name} arguments must be valid JSON.`);
  }

  return handler(asObject(args));
}

module.exports = {
  executeToolCall,
};
