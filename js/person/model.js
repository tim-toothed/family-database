function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function hasOwnValue(value) {
  return value !== undefined && value !== null && asTrimmedString(value) !== '';
}

function normalizeNumericPart(value) {
  if (!hasOwnValue(value)) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = asTrimmedString(value);
  if (!text) return null;

  if (/^[dmy?]+$/i.test(text)) {
    return null;
  }

  const numeric = Number(text);
  return Number.isInteger(numeric) ? numeric : null;
}

function parseLegacyDatePart(value, width) {
  const text = asTrimmedString(value);
  if (!text || /^[dmy?]+$/i.test(text)) return null;
  if (!new RegExp(`^\\d{1,${width}}$`).test(text)) return null;
  return Number(text);
}

function parseLegacyDateString(value) {
  const text = asTrimmedString(value);
  if (!text) return null;

  const tripletMatch = text.match(/([A-Za-z?0-9]{1,3})\.([A-Za-z?0-9]{1,3})\.([A-Za-z?0-9]{1,4})/);
  if (tripletMatch) {
    return {
      day: parseLegacyDatePart(tripletMatch[1], 2),
      month: parseLegacyDatePart(tripletMatch[2], 2),
      year: parseLegacyDatePart(tripletMatch[3], 4),
      rawText: text,
      source: 'legacy-string',
    };
  }

  if (/^\d{4}$/.test(text)) {
    return {
      day: null,
      month: null,
      year: Number(text),
      rawText: text,
      source: 'year-string',
    };
  }

  return null;
}

function padPart(value, width, placeholder) {
  if (!Number.isInteger(value)) return placeholder;
  return String(value).padStart(width, '0');
}

function normalizeDateObject(value) {
  const object = asObject(value);
  const day = normalizeNumericPart(object.day);
  const month = normalizeNumericPart(object.month);
  const year = normalizeNumericPart(object.year);

  if (day == null && month == null && year == null) {
    return null;
  }

  return {
    day,
    month,
    year,
    rawText: '',
    source: 'object',
  };
}

export function getDateParts(value) {
  if (value === null) {
    return {
      day: null,
      month: null,
      year: null,
      rawText: '',
      source: 'null',
      isNull: true,
    };
  }

  if (isObject(value)) {
    const normalized = normalizeDateObject(value);
    if (normalized) {
      return {
        ...normalized,
        isNull: false,
      };
    }
  }

  const parsed = parseLegacyDateString(value);
  if (parsed) {
    return {
      ...parsed,
      isNull: false,
    };
  }

  const rawText = asTrimmedString(value);
  return {
    day: null,
    month: null,
    year: null,
    rawText,
    source: rawText ? 'raw-text' : 'empty',
    isNull: false,
  };
}

export function formatDateValue(value, options = {}) {
  const parts = getDateParts(value);
  if (parts.isNull) return '';

  if (options.yearOnly && Number.isInteger(parts.year)) {
    return String(parts.year);
  }

  if (parts.source === 'object' || parts.source === 'legacy-string' || parts.source === 'year-string') {
    if (parts.day == null && parts.month == null && Number.isInteger(parts.year) && options.preferYearOnly !== false) {
      return String(parts.year);
    }

    if (parts.day != null || parts.month != null || parts.year != null) {
      return [
        padPart(parts.day, 2, 'DD'),
        padPart(parts.month, 2, 'MM'),
        padPart(parts.year, 4, 'YYYY'),
      ].join('.');
    }
  }

  return parts.rawText;
}

export function getDateYear(value) {
  const parts = getDateParts(value);
  if (Number.isInteger(parts.year)) {
    return parts.year;
  }

  const match = parts.rawText.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function hasDateValue(value) {
  const parts = getDateParts(value);
  return parts.isNull || Boolean(parts.rawText) || parts.day != null || parts.month != null || parts.year != null;
}

export function getBirthNameParts(person) {
  const birthName = asObject(person?.birth_name);
  return {
    surname: asTrimmedString(birthName.surname),
    firstName: asTrimmedString(birthName.first_name),
    patronymic: asTrimmedString(birthName.patronymic),
  };
}

export function formatBirthName(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  const parts = getBirthNameParts({ birth_name: value });
  return [parts.surname, parts.firstName, parts.patronymic]
    .filter(Boolean)
    .join(' ');
}

export function getPersonDisplayName(person, fallback = '') {
  return formatBirthName(person?.birth_name) || String(fallback ?? '').trim();
}

export function migrateDateValue(value) {
  if (value === null) return null;
  if (isObject(value)) {
    const day = normalizeNumericPart(value.day);
    const month = normalizeNumericPart(value.month);
    const year = normalizeNumericPart(value.year);
    if (day == null && month == null && year == null) {
      return {};
    }
    return {
      ...(day != null ? { day } : {}),
      ...(month != null ? { month } : {}),
      ...(year != null ? { year } : {}),
    };
  }

  const parsed = parseLegacyDateString(value);
  if (parsed) {
    const next = {};
    if (parsed.day != null) next.day = parsed.day;
    if (parsed.month != null) next.month = parsed.month;
    if (parsed.year != null) next.year = parsed.year;
    return next;
  }

  return {};
}

function migrateLifeEventBlock(block) {
  if (!isObject(block)) {
    return block;
  }

  const migrated = { ...block };
  if (Object.prototype.hasOwnProperty.call(migrated, 'date')) {
    migrated.date = migrated.date === null ? null : migrateDateValue(migrated.date);
  }
  return migrated;
}

function migrateDateEntryBlock(block, key = 'date') {
  if (!isObject(block)) {
    return block;
  }

  const migrated = { ...block };
  if (Object.prototype.hasOwnProperty.call(migrated, key)) {
    migrated[key] = migrated[key] === null ? null : migrateDateValue(migrated[key]);
  }
  return migrated;
}

function migrateChildRelationBlock(block) {
  if (!isObject(block)) {
    return block;
  }

  const migrated = { ...block };
  delete migrated.birth_date;
  delete migrated.second_parent_id;
  return migrated;
}

function migrateEventList(value, legacyDateValue, detailKey) {
  const sourceItems = Array.isArray(value)
    ? value
    : isObject(value)
      ? [value]
      : [];
  const migratedItems = sourceItems
    .map((item) => {
      const entry = asObject(item);
      const migrated = { ...entry };
      if (Object.prototype.hasOwnProperty.call(migrated, 'date')) {
        migrated.date = migrated.date === null ? null : migrateDateValue(migrated.date);
      }
      if (!hasOwnValue(migrated[detailKey])) {
        delete migrated[detailKey];
      }
      if (!hasOwnValue(migrated.place)) delete migrated.place;
      if (!hasOwnValue(migrated.other)) delete migrated.other;
      return migrated;
    })
    .filter((item) => item.date === null || hasDateValue(item.date) || hasOwnValue(item.place) || hasOwnValue(item.other));

  if (migratedItems.length > 0) {
    return migratedItems;
  }

  if (!hasOwnValue(legacyDateValue)) {
    return [];
  }

  const migratedDate = migrateDateValue(legacyDateValue);
  if (!hasDateValue(migratedDate)) {
    return [];
  }

  return [{ date: migratedDate }];
}

function normalizeOtherInfoValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) {
    return [{
      label: 'Заметка',
      text,
    }];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          const entryText = item.trim();
          return entryText ? { text: entryText } : null;
        }

        if (!isObject(item)) return null;
        const textValue = asTrimmedString(item.text || item.value || item.content);
        const label = asTrimmedString(item.label);
        if (!textValue) return null;
        return {
          ...(label ? { label } : {}),
          text: textValue,
        };
      })
      .filter(Boolean);
  }

  if (!isObject(value)) {
    return [];
  }

  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      const entryText = rawValue.trim();
      if (!entryText) continue;
      entries.push({
        key: rawKey,
        label: rawKey.startsWith('other_info') ? '' : rawKey,
        text: entryText,
      });
      continue;
    }

    if (!isObject(rawValue)) continue;
    const textValue = asTrimmedString(rawValue.text || rawValue.value || rawValue.content);
    if (!textValue) continue;
    entries.push({
      key: rawKey,
      label: asTrimmedString(rawValue.label) || (rawKey.startsWith('other_info') ? '' : rawKey),
      text: textValue,
    });
  }

  return entries.map((entry) => ({
    ...(entry.label ? { label: entry.label } : {}),
    text: entry.text,
  }));
}

export function migratePersonSchema(payload, fallbackId = '') {
  const object = asObject(payload);
  const migrated = {
    ...object,
    id: asTrimmedString(object.id || fallbackId),
  };

  if (isObject(migrated.birth)) {
    migrated.birth = migrateLifeEventBlock(migrated.birth);
  }

  if (isObject(migrated.death)) {
    migrated.death = migrateLifeEventBlock(migrated.death);
  }

  if (Array.isArray(migrated.name_changes)) {
    migrated.name_changes = migrated.name_changes.map((item) => migrateDateEntryBlock(item, 'date'));
  }

  if (Array.isArray(migrated.children)) {
    migrated.children = migrated.children.map((item) => migrateChildRelationBlock(item));
  }

  if (Array.isArray(migrated.spouses)) {
    migrated.spouses = migrated.spouses.map((item) => {
      const spouse = asObject(item);
      const nextSpouse = { ...spouse };
      const marriage = migrateEventList(spouse.marriage, spouse.marriage_date, 'place');
      const divorce = migrateEventList(spouse.divorce, spouse.divorce_date, 'other');

      if (marriage.length > 0) {
        nextSpouse.marriage = marriage;
      } else {
        delete nextSpouse.marriage;
      }

      if (divorce.length > 0) {
        nextSpouse.divorce = divorce;
      } else {
        delete nextSpouse.divorce;
      }

      delete nextSpouse.marriage_date;
      delete nextSpouse.divorce_date;
      return nextSpouse;
    });
  }

  if (Object.prototype.hasOwnProperty.call(migrated, 'other_info')) {
    migrated.other_info = normalizeOtherInfoValue(migrated.other_info);
  }

  return migrated;
}

export function normalizeLoadedPerson(payload, fallbackId = '') {
  return migratePersonSchema(payload, fallbackId);
}

export function getLifeEvent(person, key) {
  const block = asObject(person?.[key]);
  const dateValue = Object.prototype.hasOwnProperty.call(block, 'date') ? block.date : undefined;

  return {
    raw: block,
    dateValue,
    dateDisplay: formatDateValue(dateValue),
    dateParts: getDateParts(dateValue),
    year: getDateYear(dateValue),
    dateRaw: asTrimmedString(block.date_raw),
    place: asTrimmedString(block.place),
    cause: asTrimmedString(block.cause),
    burialPlace: asTrimmedString(block.burial_place),
    other: asTrimmedString(block.other),
    isAlive: key === 'death' && dateValue === null,
  };
}

function normalizeEventEntry(item, detailKey = 'other') {
  const object = asObject(item);
  const dateValue = Object.prototype.hasOwnProperty.call(object, 'date') ? object.date : undefined;
  const place = asTrimmedString(object.place);
  const other = asTrimmedString(object.other);
  const detailValue = asTrimmedString(object[detailKey]);

  return {
    raw: object,
    dateValue,
    dateDisplay: formatDateValue(dateValue),
    dateParts: getDateParts(dateValue),
    year: getDateYear(dateValue),
    place,
    other,
    detail: detailValue,
  };
}

function normalizeEventList(value, legacyDateValue, detailKey) {
  const sourceItems = Array.isArray(value)
    ? value
    : isObject(value)
      ? [value]
      : [];
  const items = sourceItems
    .map((item) => normalizeEventEntry(item, detailKey))
    .filter((item) => hasDateValue(item.dateValue) || item.place || item.other);

  if (items.length > 0) {
    return items;
  }

  if (hasOwnValue(legacyDateValue)) {
    return [normalizeEventEntry({ date: legacyDateValue }, detailKey)];
  }

  return [];
}

export function getRelationEntries(person, key) {
  return asArray(person?.[key]).map((item) => {
    const object = asObject(item);
    return {
      raw: object,
      personId: asTrimmedString(object.person_id),
      relationType: asTrimmedString(object.relation_type),
      name: asTrimmedString(object.name),
      reason: asTrimmedString(object.reason),
      educationInfo: asTrimmedString(object.education_info),
      title: asTrimmedString(object.title),
      job: asTrimmedString(object.job),
      residenceInfo: asTrimmedString(object.residence_info),
      source: asTrimmedString(object.source),
      description: asTrimmedString(object.description),
      link: asTrimmedString(object.link),
      serviceInfo: asTrimmedString(object.service_info),
      war: asTrimmedString(object.war),
      award: asTrimmedString(object.award),
      marriageEvents: normalizeEventList(object.marriage, object.marriage_date, 'place'),
      divorceEvents: normalizeEventList(object.divorce, object.divorce_date, 'other'),
    };
  });
}

export function getRelationPersonIds(person, key) {
  return getRelationEntries(person, key)
    .map((entry) => entry.personId)
    .filter(Boolean);
}

export function getPersonSex(person) {
  return asTrimmedString(person?.sex).toLowerCase();
}

export function getLifeYears(person) {
  if (!person) return '';

  const birthYear = getDateYear(person?.birth?.date);
  const deathValue = person?.death?.date;

  if (deathValue === null) {
    return birthYear ?? '';
  }

  const deathYear = getDateYear(deathValue);
  if (!birthYear && !deathYear) return '';
  if (birthYear && deathYear) return `${birthYear}-${deathYear}`;
  return String(birthYear || deathYear || '');
}

export function getBirthYear(person) {
  return getDateYear(person?.birth?.date);
}

export function getNamedTextEntries(value, options = {}) {
  const labelPrefix = options.labelPrefix || 'Item';
  const stringValue = typeof value === 'string' ? value.trim() : '';
  if (stringValue) {
    return [{
      key: options.baseKey || 'value',
      label: options.defaultLabel || '',
      text: stringValue,
    }];
  }

  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        if (typeof item === 'string') {
          const text = item.trim();
          if (!text) return null;
          return {
            key: `${options.baseKey || labelPrefix}_${index + 1}`,
            label: '',
            text,
          };
        }

        if (!isObject(item)) return null;
        const text = asTrimmedString(item.text || item.value || item.content);
        if (!text) return null;
        return {
          key: `${options.baseKey || labelPrefix}_${index + 1}`,
          label: asTrimmedString(item.label),
          text,
        };
      })
      .filter(Boolean);
  }

  if (isObject(value)) {
    return Object.entries(value)
      .map(([key, item], index) => {
        if (typeof item === 'string') {
          const text = item.trim();
          if (!text) return null;
          return {
            key,
            label: key && !key.startsWith('other_info') ? key : '',
            text,
          };
        }

        if (isObject(item)) {
          const text = asTrimmedString(item.text || item.value || item.content);
          if (!text) return null;
          return {
            key,
            label: asTrimmedString(item.label) || (key && !key.startsWith('other_info') ? key : ''),
            text,
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  return [];
}

export function personHasField(person, key) {
  return Object.prototype.hasOwnProperty.call(asObject(person), key);
}
