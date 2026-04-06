import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from '../config.js';
import { normalizeLoadedPerson } from '../person/model.js';

const { url, publishableKey, schema, tables } = SUPABASE_CONFIG;

if (!url || !publishableKey) {
  throw new Error('Supabase URL или publishable key не настроены в js/config.js.');
}

const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
const schemaClient = schema ? supabase.schema(schema) : supabase;

function normalizePersonPayload(personId, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Некорректный payload для ${personId}.`);
  }

  return normalizeLoadedPerson(payload, personId);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
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

async function loadYamlRowsByIds(ids) {
  const normalizedIds = [...new Set(
    (ids || []).map((id) => String(id || '').trim()).filter(Boolean)
  )];
  if (!normalizedIds.length) return [];

  const { data, error } = await schemaClient
    .from(tables.yaml)
    .select('id, payload')
    .in('id', normalizedIds);

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function persistPersonWithReciprocalLinks(personId, payload, options = {}) {
  const normalized = normalizePersonPayload(personId, payload);
  const shouldRequireExisting = options.requireExisting !== false;

  const { data: existingCurrentRow, error: existingCurrentError } = await schemaClient
    .from(tables.yaml)
    .select('id, payload')
    .eq('id', personId)
    .maybeSingle();

  if (existingCurrentError) {
    throw new Error(existingCurrentError.message);
  }

  if (shouldRequireExisting && !existingCurrentRow) {
    throw new Error(`Карточка ${personId} не найдена в Supabase.`);
  }

  const previous = existingCurrentRow
    ? normalizePersonPayload(existingCurrentRow.id, existingCurrentRow.payload)
    : null;

  const relatedIds = [...new Set([
    ...collectLinkedPersonIds(previous),
    ...collectLinkedPersonIds(normalized),
  ])].filter((id) => id !== personId);

  const relatedRows = await loadYamlRowsByIds(relatedIds);
  const relatedById = new Map(
    relatedRows.map((row) => [String(row.id || '').trim(), normalizePersonPayload(row.id, row.payload)])
  );

  const changedRelatedIds = new Set();
  const missingRelatedIds = new Set();

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

  const rowsToUpsert = [
    {
      id: personId,
      payload: normalized,
    },
    ...Array.from(changedRelatedIds).map((relatedId) => ({
      id: relatedId,
      payload: normalizePersonPayload(relatedId, relatedById.get(relatedId)),
    })),
  ];

  const { error } = await schemaClient
    .from(tables.yaml)
    .upsert(rowsToUpsert, {
      onConflict: 'id',
    });

  if (error) {
    throw new Error(error.message);
  }

  return {
    normalized,
    synchronizedIds: Array.from(changedRelatedIds).sort(),
    skippedIds: Array.from(missingRelatedIds).sort(),
  };
}

export async function loadPeopleIndex() {
  const { data, error } = await schemaClient
    .from(tables.people)
    .select('id, display_name');

  if (error) {
    throw new Error(error.message);
  }

  return new Map(
    (data || []).map((row) => [
      String(row.id || '').trim(),
      String(row.display_name || row.id || '').trim(),
    ])
  );
}

export async function loadEditablePerson(personId) {
  const { data, error } = await schemaClient
    .from(tables.yaml)
    .select('id, payload')
    .eq('id', personId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;
  return normalizePersonPayload(data.id, data.payload);
}

export async function saveEditablePerson(personId, payload) {
  return persistPersonWithReciprocalLinks(personId, payload, {
    requireExisting: true,
  });
}

export async function createEditablePerson(personId, payload) {
  return persistPersonWithReciprocalLinks(personId, payload, {
    requireExisting: false,
  });
}
