'use strict';

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;
const MAX_BODY_BYTES = 1024 * 1024;

let ydbImportsPromise;
let sqlPromise;

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: {
      ...getCorsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

function emptyResponse(statusCode) {
  return {
    statusCode,
    headers: getCorsHeaders(),
    body: '',
    isBase64Encoded: false,
  };
}

function getHeader(event, name) {
  const normalizedName = String(name || '').toLowerCase();
  const headers = event?.headers || {};
  const pair = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return pair ? String(pair[1] || '') : '';
}

function requireApiToken(event) {
  const expectedToken = process.env.FAMILY_DB_API_TOKEN;
  if (!expectedToken) return;

  const authorization = getHeader(event, 'authorization');
  const expected = `Bearer ${expectedToken}`;
  if (authorization !== expected) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

function parseBody(event) {
  if (!event?.body) return null;

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body);

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('Request body is too large.');
    error.statusCode = 413;
    throw error;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function normalizePath(event) {
  const queryRoute = event?.queryStringParameters?.route || event?.queryStringParameters?.path;
  if (queryRoute) {
    const route = String(queryRoute);
    return (route.startsWith('/') ? route : `/${route}`).replace(/\/+$/, '') || '/';
  }

  const rawPath = String(event?.path || event?.requestContext?.path || '/');
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return path.replace(/\/+$/, '') || '/';
}

function getQueryNumber(event, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = event?.queryStringParameters?.[key];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function decodeId(value) {
  return decodeURIComponent(String(value || '').trim());
}

function assertId(id, label = 'id') {
  if (!id) {
    const error = new Error(`${label} is required.`);
    error.statusCode = 400;
    throw error;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error(`${label} must be an object.`);
    error.statusCode = 400;
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getDisplayName(payload, fallbackId) {
  const birthName = payload?.birth_name;
  if (typeof birthName === 'string' && birthName.trim()) {
    return birthName.trim();
  }

  if (birthName && typeof birthName === 'object' && !Array.isArray(birthName)) {
    const name = [
      birthName.surname,
      birthName.first_name,
      birthName.patronymic,
    ].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
    if (name) return name;
  }

  return String(fallbackId || '').trim() || '???';
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePersonPayload(personId, payload) {
  assertPlainObject(payload, `payload for ${personId}`);
  return { ...payload };
}

function getRelationIds(person, key) {
  return Array.isArray(person?.[key])
    ? [...new Set(
      person[key]
        .map((item) => String(item?.person_id || '').trim())
        .filter(Boolean)
    )]
    : [];
}

function collectLinkedPersonIds(person) {
  return [
    ...getRelationIds(person, 'parents'),
    ...getRelationIds(person, 'siblings'),
    ...getRelationIds(person, 'children'),
    ...getRelationIds(person, 'spouses'),
  ];
}

function clonePlainValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, clonePlainValue(nested)])
    );
  }
  return value;
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeComparableValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeComparableValue(value[key])])
    );
  }

  return value;
}

function areEntriesEqual(left, right) {
  return JSON.stringify(normalizeComparableValue(left)) === JSON.stringify(normalizeComparableValue(right));
}

function buildChildRelationTypeFromParent(relationType) {
  const normalized = normalizeText(relationType);
  if (!normalized) return '';
  if (normalized.includes('приемн')) return 'приемный';
  if (normalized.includes('мачех') || normalized.includes('отчим')) return 'сводный';
  if (normalized.includes('мать') || normalized.includes('отец')) return 'биологический';
  return '';
}

function buildParentRelationTypeFromChild(childRelationType, personSex) {
  const normalizedRelation = normalizeText(childRelationType);
  const normalizedSex = normalizeText(personSex);
  const isMale = normalizedSex === 'м';
  const isFemale = normalizedSex === 'ж';

  if (!isMale && !isFemale) return '';

  if (normalizedRelation.includes('приемн')) {
    return isMale ? 'приемный отец' : 'приемная мать';
  }

  if (normalizedRelation.includes('сводн')) {
    return isMale ? 'отчим' : 'мачеха';
  }

  return isMale ? 'отец' : 'мать';
}

function canonicalSiblingRelationType(relationType) {
  const normalized = normalizeText(relationType);
  if (!normalized) return '';
  if (normalized === 'биологический') return 'биологический';
  if (normalized === 'приемный') return 'приемный';
  if (normalized === 'сводный по отцу') return 'сводный по отцу';
  if (normalized === 'сводный по матери') return 'сводный по матери';
  return String(relationType || '').trim();
}

function inferSiblingRelationType(leftRelationType, rightRelationType) {
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

function buildArrayEntry(personId, relationType = '') {
  const normalizedId = String(personId || '').trim();
  const normalizedRelationType = String(relationType || '').trim();
  if (!normalizedId) return null;

  return {
    person_id: normalizedId,
    ...(normalizedRelationType ? { relation_type: normalizedRelationType } : {}),
  };
}

function buildMirroredSpouseEntry(personId, spouseEntry) {
  const normalizedId = String(personId || '').trim();
  const source = spouseEntry && typeof spouseEntry === 'object' && !Array.isArray(spouseEntry)
    ? spouseEntry
    : {};
  if (!normalizedId) return null;

  const entry = { person_id: normalizedId };
  if (Array.isArray(source.marriage) && source.marriage.length) {
    entry.marriage = clonePlainValue(source.marriage);
  }
  if (Array.isArray(source.divorce) && source.divorce.length) {
    entry.divorce = clonePlainValue(source.divorce);
  }
  return entry;
}

function setReciprocalEntry(person, key, relatedPersonId, entry) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) return false;

  const normalizedRelatedId = String(relatedPersonId || '').trim();
  const currentItems = Array.isArray(person[key]) ? person[key] : [];
  const existingIndex = currentItems.findIndex((item) => String(item?.person_id || '').trim() === normalizedRelatedId);

  if (!entry) {
    if (existingIndex < 0) return false;

    const nextItems = currentItems.filter((_, index) => index !== existingIndex);
    if (nextItems.length) {
      person[key] = nextItems;
    } else {
      delete person[key];
    }
    return true;
  }

  if (existingIndex < 0) {
    person[key] = [...currentItems, entry];
    return true;
  }

  if (areEntriesEqual(currentItems[existingIndex], entry)) {
    return false;
  }

  const nextItems = [...currentItems];
  nextItems[existingIndex] = entry;
  person[key] = nextItems;
  return true;
}

async function importYdb() {
  if (!ydbImportsPromise) {
    ydbImportsPromise = Promise.all([
      import('@ydbjs/core'),
      import('@ydbjs/query'),
      import('@ydbjs/auth/metadata'),
      import('@ydbjs/auth/access-token'),
      import('@ydbjs/value/primitive'),
    ]).then(([core, queryModule, metadataAuth, tokenAuth, primitive]) => ({
      Driver: core.Driver,
      query: queryModule.query,
      MetadataCredentialsProvider: metadataAuth.MetadataCredentialsProvider,
      AccessTokenCredentialsProvider: tokenAuth.AccessTokenCredentialsProvider,
      Json: primitive.Json,
    }));
  }
  return ydbImportsPromise;
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const {
        Driver,
        query,
        MetadataCredentialsProvider,
        AccessTokenCredentialsProvider,
      } = await importYdb();

      const connectionString = process.env.YDB_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('YDB_CONNECTION_STRING environment variable is required.');
      }

      const credentialsProvider = process.env.YDB_ACCESS_TOKEN
        ? new AccessTokenCredentialsProvider({
          token: process.env.YDB_ACCESS_TOKEN,
        })
        : new MetadataCredentialsProvider();

      const driver = new Driver(connectionString, { credentialsProvider });
      await driver.ready();
      return query(driver);
    })();
  }

  return sqlPromise;
}

async function jsonValue(value) {
  const { Json } = await importYdb();
  return new Json(JSON.stringify(value));
}

function parseJsonColumn(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function normalizeYamlRow(row) {
  return {
    id: String(row.id || '').trim(),
    payload: parseJsonColumn(row.payload, {}),
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

function normalizeDocumentRow(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    description: row.description == null ? null : String(row.description),
    source_type: String(row.source_type || ''),
    source_path: String(row.source_path || ''),
    extractor: parseJsonColumn(row.extractor, null),
    content_hash: row.content_hash == null ? null : String(row.content_hash),
    generated_at: row.generated_at == null ? null : String(row.generated_at),
    block_count: Number(row.block_count || 0),
    mention_count: Number(row.mention_count || 0),
  };
}

function unwrapRows(result) {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? result[0] : result;
}

async function listPeople(sql) {
  const rows = unwrapRows(await sql`SELECT id, payload FROM family_yaml ORDER BY id LIMIT ${MAX_PAGE_SIZE}`.idempotent(true));
  return rows.map((row) => {
    const normalized = normalizeYamlRow(row);
    return { id: normalized.id, payload: normalized.payload };
  });
}

async function getPerson(sql, personId) {
  const rows = unwrapRows(await sql`
    SELECT id, payload, created_at, updated_at
    FROM family_yaml
    WHERE id = ${personId}
    LIMIT 1
  `.idempotent(true));
  return rows[0] ? normalizeYamlRow(rows[0]) : null;
}

async function listPeopleIndex(sql) {
  const rows = unwrapRows(await sql`
    SELECT id, display_name
    FROM family_people
    ORDER BY display_name, id
    LIMIT ${MAX_PAGE_SIZE}
  `.idempotent(true));
  return rows.map((row) => ({
    id: String(row.id || '').trim(),
    display_name: String(row.display_name || row.id || '').trim(),
  }));
}

async function upsertPerson(sql, personId, payload, { requireExisting }) {
  const normalized = normalizePersonPayload(personId, payload);
  const existingCurrentRow = await getPerson(sql, personId);
  if (requireExisting && !existingCurrentRow) {
    const error = new Error(`Person ${personId} was not found.`);
    error.statusCode = 404;
    throw error;
  }

  const previous = existingCurrentRow ? normalizePersonPayload(existingCurrentRow.id, existingCurrentRow.payload) : null;
  const relatedIds = [...new Set([
    ...collectLinkedPersonIds(previous),
    ...collectLinkedPersonIds(normalized),
  ])].filter((id) => id !== personId);
  const relatedRows = await Promise.all(relatedIds.map((relatedId) => getPerson(sql, relatedId)));
  const relatedById = new Map();
  const changedRelatedIds = new Set();
  const missingRelatedIds = new Set();

  for (const row of relatedRows) {
    if (!row) continue;
    relatedById.set(String(row.id || '').trim(), normalizePersonPayload(row.id, row.payload));
  }

  const applyRelatedUpdate = (targetId, updater) => {
    const normalizedTargetId = String(targetId || '').trim();
    if (!normalizedTargetId || normalizedTargetId === personId) return;

    const targetPerson = relatedById.get(normalizedTargetId);
    if (!targetPerson) {
      missingRelatedIds.add(normalizedTargetId);
      return;
    }

    const changed = updater(targetPerson);
    if (changed) {
      changedRelatedIds.add(normalizedTargetId);
    }
  };

  const allParentIds = new Set([
    ...getRelationIds(previous, 'parents'),
    ...getRelationIds(normalized, 'parents'),
  ]);
  const desiredChildEntriesByParentId = new Map(
    (Array.isArray(normalized.parents) ? normalized.parents : [])
      .map((item) => {
        const targetId = String(item?.person_id || '').trim();
        const entry = buildArrayEntry(personId, buildChildRelationTypeFromParent(item?.relation_type));
        return targetId && entry ? [targetId, entry] : null;
      })
      .filter(Boolean)
  );

  for (const parentId of allParentIds) {
    applyRelatedUpdate(parentId, (targetPerson) => (
      setReciprocalEntry(targetPerson, 'children', personId, desiredChildEntriesByParentId.get(parentId) || null)
    ));
  }

  const allChildIds = new Set([
    ...getRelationIds(previous, 'children'),
    ...getRelationIds(normalized, 'children'),
  ]);
  const desiredParentEntriesByChildId = new Map(
    (Array.isArray(normalized.children) ? normalized.children : [])
      .map((item) => {
        const targetId = String(item?.person_id || '').trim();
        const entry = buildArrayEntry(personId, buildParentRelationTypeFromChild(item?.relation_type, normalized.sex));
        return targetId && entry ? [targetId, entry] : null;
      })
      .filter(Boolean)
  );

  for (const childId of allChildIds) {
    applyRelatedUpdate(childId, (targetPerson) => (
      setReciprocalEntry(targetPerson, 'parents', personId, desiredParentEntriesByChildId.get(childId) || null)
    ));
  }

  const allSiblingIds = new Set([
    ...getRelationIds(previous, 'siblings'),
    ...getRelationIds(normalized, 'siblings'),
  ]);
  const desiredSiblingRelationById = new Map(
    (Array.isArray(normalized.siblings) ? normalized.siblings : [])
      .map((item) => {
        const targetId = String(item?.person_id || '').trim();
        const relationType = canonicalSiblingRelationType(item?.relation_type);
        return targetId ? [targetId, relationType] : null;
      })
      .filter(Boolean)
  );
  const currentSiblingIds = Array.from(desiredSiblingRelationById.keys());

  for (const siblingId of allSiblingIds) {
    applyRelatedUpdate(siblingId, (targetPerson) => {
      let changed = false;
      const directEntry = desiredSiblingRelationById.has(siblingId)
        ? buildArrayEntry(personId, desiredSiblingRelationById.get(siblingId))
        : null;
      changed = setReciprocalEntry(targetPerson, 'siblings', personId, directEntry) || changed;

      if (!desiredSiblingRelationById.has(siblingId)) {
        return changed;
      }

      for (const otherSiblingId of currentSiblingIds) {
        if (otherSiblingId === siblingId) continue;
        const inferredRelationType = inferSiblingRelationType(
          desiredSiblingRelationById.get(siblingId),
          desiredSiblingRelationById.get(otherSiblingId),
        );
        const siblingEntry = buildArrayEntry(otherSiblingId, inferredRelationType);
        changed = setReciprocalEntry(targetPerson, 'siblings', otherSiblingId, siblingEntry) || changed;
      }

      return changed;
    });
  }

  const allSpouseIds = new Set([
    ...getRelationIds(previous, 'spouses'),
    ...getRelationIds(normalized, 'spouses'),
  ]);
  const desiredSpouseEntriesById = new Map(
    (Array.isArray(normalized.spouses) ? normalized.spouses : [])
      .map((item) => {
        const targetId = String(item?.person_id || '').trim();
        const entry = buildMirroredSpouseEntry(personId, item);
        return targetId && entry ? [targetId, entry] : null;
      })
      .filter(Boolean)
  );

  for (const spouseId of allSpouseIds) {
    applyRelatedUpdate(spouseId, (targetPerson) => (
      setReciprocalEntry(targetPerson, 'spouses', personId, desiredSpouseEntriesById.get(spouseId) || null)
    ));
  }

  const timestamp = nowIso();
  const rowsToUpsert = [
    {
      id: personId,
      payload: normalized,
      createdAt: existingCurrentRow?.created_at || timestamp,
    },
    ...Array.from(changedRelatedIds).map((relatedId) => {
      const sourceRow = relatedRows.find((row) => row?.id === relatedId);
      return {
        id: relatedId,
        payload: normalizePersonPayload(relatedId, relatedById.get(relatedId)),
        createdAt: sourceRow?.created_at || timestamp,
      };
    }),
  ];

  await sql.begin(async (tx) => {
    for (const row of rowsToUpsert) {
      await tx`
        UPSERT INTO family_yaml (id, payload, created_at, updated_at)
        VALUES (${row.id}, ${await jsonValue(row.payload)}, ${row.createdAt}, ${timestamp})
      `;
      await tx`
        UPSERT INTO family_people (id, display_name)
        VALUES (${row.id}, ${getDisplayName(row.payload, row.id)})
      `;
    }
  });

  return {
    id: personId,
    payload: normalized,
    synchronizedIds: Array.from(changedRelatedIds).sort(),
    skippedIds: Array.from(missingRelatedIds).sort(),
  };
}

async function listDocuments(sql) {
  const rows = unwrapRows(await sql`
    SELECT id, title, description, source_type, source_path, extractor, content_hash, generated_at, block_count, mention_count
    FROM text_documents
    ORDER BY title, id
    LIMIT ${MAX_PAGE_SIZE}
  `.idempotent(true));
  return rows.map(normalizeDocumentRow);
}

async function getDocumentRows(sql, documentId) {
  const [documentsResult, blocksResult, mentionsResult] = await Promise.all([
    sql`
      SELECT id, title, description, source_type, source_path, extractor, content_hash, generated_at, block_count, mention_count
      FROM text_documents
      WHERE id = ${documentId}
      LIMIT 1
    `.idempotent(true),
    sql`
      SELECT block_index, kind, text, mention_count
      FROM text_document_blocks
      WHERE document_id = ${documentId}
      ORDER BY block_index
      LIMIT ${MAX_PAGE_SIZE}
    `.idempotent(true),
    sql`
      SELECT block_index, mention_index, kind, text, start_offset, end_offset, source
      FROM text_document_mentions
      WHERE document_id = ${documentId}
      ORDER BY block_index, mention_index
      LIMIT ${MAX_PAGE_SIZE}
    `.idempotent(true),
  ]);
  const documents = unwrapRows(documentsResult);
  const blocks = unwrapRows(blocksResult);
  const mentions = unwrapRows(mentionsResult);

  return {
    document: documents[0] ? normalizeDocumentRow(documents[0]) : null,
    blocks,
    mentions,
  };
}

async function getDocumentChunkRows(sql, documentId, from, chunkSize) {
  const to = from + chunkSize - 1;

  const blocks = unwrapRows(await sql`
    SELECT block_index, kind, text, mention_count
    FROM text_document_blocks
    WHERE document_id = ${documentId}
      AND block_index >= ${from}
      AND block_index <= ${to}
    ORDER BY block_index
    LIMIT ${chunkSize}
  `.idempotent(true));

  if (!blocks.length) {
    return { blocks: [], mentions: [] };
  }

  const firstBlockIndex = Number(blocks[0].block_index);
  const lastBlockIndex = Number(blocks[blocks.length - 1].block_index);
  const mentions = unwrapRows(await sql`
    SELECT block_index, mention_index, kind, text, start_offset, end_offset, source
    FROM text_document_mentions
    WHERE document_id = ${documentId}
      AND block_index >= ${firstBlockIndex}
      AND block_index <= ${lastBlockIndex}
    ORDER BY block_index, mention_index
    LIMIT ${MAX_PAGE_SIZE}
  `.idempotent(true));

  return { blocks, mentions };
}

async function deleteDocument(sql, documentId) {
  const result = await getDocumentRows(sql, documentId);
  if (!result.document) {
    const error = new Error('Not found');
    error.statusCode = 404;
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM text_document_mentions WHERE document_id = ${documentId}`;
    await tx`DELETE FROM text_document_blocks WHERE document_id = ${documentId}`;
    await tx`DELETE FROM text_documents WHERE id = ${documentId}`;
  });

  return result.document;
}

async function route(event) {
  const method = String(event?.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return emptyResponse(204);

  requireApiToken(event);

  const sql = await getSql();
  const path = normalizePath(event);
  const segments = path.split('/').filter(Boolean).map(decodeId);

  if (method === 'GET' && path === '/health') {
    return jsonResponse(200, { ok: true });
  }

  if (method === 'GET' && path === '/people') {
    return jsonResponse(200, { rows: await listPeople(sql) });
  }

  if (method === 'GET' && path === '/people-index') {
    return jsonResponse(200, { rows: await listPeopleIndex(sql) });
  }

  if (segments[0] === 'people' && segments.length === 2) {
    const personId = segments[1];
    assertId(personId, 'person id');

    if (method === 'GET') {
      const row = await getPerson(sql, personId);
      if (!row) return jsonResponse(404, { error: 'Not found' });
      return jsonResponse(200, row);
    }

    if (method === 'PUT' || method === 'POST') {
      const body = parseBody(event);
      const payload = body?.payload || body;
      const row = await upsertPerson(sql, personId, payload, { requireExisting: method === 'PUT' });
      return jsonResponse(method === 'POST' ? 201 : 200, row);
    }
  }

  if (method === 'GET' && path === '/documents') {
    return jsonResponse(200, { rows: await listDocuments(sql) });
  }

  if (segments[0] === 'documents' && segments.length === 2) {
    const documentId = segments[1];
    assertId(documentId, 'document id');

    if (method === 'GET') {
      const result = await getDocumentRows(sql, documentId);
      if (!result.document) return jsonResponse(404, { error: 'Not found' });
      return jsonResponse(200, result);
    }

    if (method === 'DELETE') {
      const document = await deleteDocument(sql, documentId);
      return jsonResponse(200, { document });
    }
  }

  if (segments[0] === 'documents' && segments[2] === 'chunk' && method === 'GET') {
    const documentId = segments[1];
    assertId(documentId, 'document id');
    const from = getQueryNumber(event, 'from', 0, { min: 0 });
    const chunkSize = getQueryNumber(event, 'chunkSize', 200, { min: 1, max: DEFAULT_PAGE_SIZE });
    return jsonResponse(200, await getDocumentChunkRows(sql, documentId, from, chunkSize));
  }

  return jsonResponse(404, { error: 'Not found' });
}

module.exports.handler = async function handler(event, context) {
  try {
    return await route(event);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    const message = statusCode >= 500 ? 'Internal server error' : error.message;
    console.error(error);
    return jsonResponse(statusCode, { error: message });
  }
};
