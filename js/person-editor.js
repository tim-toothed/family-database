import { FIELD_LABELS } from './config.js';
import { getPersonDisplayName } from './person-name.js';

const NESTED_FIELD_LABELS = {
  surname: 'Фамилия',
  first_name: 'Имя',
  patronymic: 'Отчество',
  name: 'Фамилия Имя Отчество',
  date: 'Дата',
  date_raw: 'Дата в свободной форме',
  place: 'Место',
  reason: 'Причина',
  cause: 'Причина',
  person_id: 'Персона',
  relation_type: 'Тип связи',
  marriage_date: 'Дата брака',
  divorce_date: 'Дата развода',
  birth_date: 'Дата рождения',
  second_parent_id: 'Персона',
  education_info: 'Информация',
  title: 'Название',
  job: 'Место работы',
  service_info: 'Служба',
  war: 'Участие в войне',
  award: 'Награда',
  residence_info: 'Место проживания',
  source: 'Источник',
  description: 'Описание',
  link: 'Ссылка',
  military_service: 'Военная служба',
  war_participation: 'Участие в войнах',
  awards: 'Награды',
};

const RELATION_FIELD_KEYS = new Set(['person_id', 'second_parent_id']);
const ENUM_FIELD_KEYS = new Set(['relation_type', 'sex', 'reason']);
const DATE_FIELD_KEYS = new Set(['date', 'marriage_date', 'divorce_date', 'birth_date']);
const DATE_RE = /^(?:\d{2}|DD)\.(?:\d{2}|MM)\.(?:\d{4}|YYYY)$/;
const UNKNOWN_DATE_VALUE = '???';
const DATE_TEMPLATE_VALUE = 'DD.MM.YYYY';
let schemaBundlePromise;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function encodePath(path) {
  return path.join('.');
}

function parsePath(path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function getFieldLabel(key) {
  return FIELD_LABELS[key] || NESTED_FIELD_LABELS[key] || key.replaceAll('_', ' ');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isGenericSchemaHint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'text';
}

function extractSchemaOptions(schemaNode) {
  if (typeof schemaNode !== 'string') return [];
  const match = schemaNode.match(/\(([^()]+)\)\s*$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDateValue(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return normalized;
  if (normalized === UNKNOWN_DATE_VALUE || normalized === DATE_TEMPLATE_VALUE) {
    return '';
  }
  return normalized;
}

function createEmptyValue(schemaNode) {
  if (Array.isArray(schemaNode)) return [];
  if (isObject(schemaNode)) {
    return Object.fromEntries(
      Object.keys(schemaNode).map((key) => [key, createEmptyValue(schemaNode[key])])
    );
  }
  return '';
}

function getSchemaNode(schemaNode, path) {
  let current = schemaNode;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[0];
      continue;
    }
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function ensureContainer(target, path) {
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

function formatPersonOption(personId, peopleById) {
  const name = peopleById?.get(personId);
  if (!name || name === personId) return personId;
  return `${name} [${personId}]`;
}

function resolvePersonInput(value, peopleById, optionValueToId) {
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

function hydrateDraftValue(value, schemaNode, path, peopleById) {
  const key = path[path.length - 1];

  if (Array.isArray(value)) {
    const itemSchema = Array.isArray(schemaNode) ? schemaNode[0] : undefined;
    return value.map((item, index) => hydrateDraftValue(item, itemSchema, [...path, index], peopleById));
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        hydrateDraftValue(childValue, schemaNode?.[childKey], [...path, childKey], peopleById),
      ])
    );
  }

  if (RELATION_FIELD_KEYS.has(key) && typeof value === 'string') {
    return formatPersonOption(value, peopleById);
  }

  return value;
}

function renderScalarEditor(path, key, value, schemaNode, context) {
  const label = getFieldLabel(key);
  const encodedPath = escapeHtml(encodePath(path));
  const fieldValue = value === null ? '' : escapeHtml(value ?? '');
  const rawValue = value === null ? '' : String(value ?? '');
  const multiline = ['other_info', 'character', 'appearance', 'health', 'hobbies'].includes(key);
  const hint = typeof schemaNode === 'string' && !isGenericSchemaHint(schemaNode)
    ? escapeHtml(schemaNode.trim())
    : '';
  const showInlineLabel = path.length > 1;
  const disabled = context.disableInputs ? ' disabled' : '';
  const enumOptions = ENUM_FIELD_KEYS.has(key) ? extractSchemaOptions(schemaNode) : [];
  const relationOptions = RELATION_FIELD_KEYS.has(key) ? (context.personOptionEntries || []) : [];
  const isSelectField = (RELATION_FIELD_KEYS.has(key) && relationOptions.length)
    || (ENUM_FIELD_KEYS.has(key) && enumOptions.length);
  const placeholder = RELATION_FIELD_KEYS.has(key)
    ? ' placeholder="Выберите персону"'
    : ENUM_FIELD_KEYS.has(key)
      ? ' placeholder="Выберите из списка"'
      : '';

  if (key === 'divorce_date') {
    const hasDivorceDateField = value !== undefined;
    return `
      <div class="editor-divorce-field">
        <label class="editor-checkbox">
          <input type="checkbox" data-action="toggle-divorced" data-divorce-path="${encodedPath}" ${hasDivorceDateField ? 'checked' : ''}${disabled} />
          <span>Разведены</span>
        </label>
        ${hasDivorceDateField ? `
          <label class="editor-field">
            <span class="editor-label">${escapeHtml(label)}</span>
            <input class="editor-input" data-path="${encodedPath}" type="text" value="${fieldValue}"${disabled} />
            ${hint ? `<span class="editor-hint">${hint}</span>` : ''}
          </label>
        ` : ''}
      </div>
    `;
  }

  if (isSelectField) {
    const selectOptions = RELATION_FIELD_KEYS.has(key)
      ? relationOptions.map((entry) => ({ value: entry.label, label: entry.label }))
      : enumOptions.map((option) => ({ value: option, label: option }));
    const hasCurrentOption = selectOptions.some((option) => option.value === rawValue);
    const emptyLabel = RELATION_FIELD_KEYS.has(key) ? 'Выберите персону' : 'Выберите из списка';

    return `
      <label class="editor-field">
        ${showInlineLabel ? `<span class="editor-label">${escapeHtml(label)}</span>` : ''}
        <select class="editor-input" data-path="${encodedPath}"${disabled}>
          <option value="">${emptyLabel}</option>
          ${!hasCurrentOption && rawValue ? `<option value="${escapeHtml(rawValue)}" selected>${escapeHtml(rawValue)}</option>` : ''}
          ${selectOptions.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === rawValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
        </select>
        ${hint ? `<span class="editor-hint">${hint}</span>` : ''}
      </label>
    `;
  }

  return `
    <label class="editor-field">
      ${showInlineLabel ? `<span class="editor-label">${escapeHtml(label)}</span>` : ''}
      ${multiline
        ? `<textarea class="editor-input editor-input-textarea" data-path="${encodedPath}" rows="4"${disabled}${placeholder}>${fieldValue}</textarea>`
        : `<input class="editor-input" data-path="${encodedPath}" type="text" value="${fieldValue}"${disabled}${placeholder} />`}
      ${hint ? `<span class="editor-hint">${hint}</span>` : ''}
    </label>
  `;
}

function renderObjectEditor(schemaNode, value, path, context) {
  const objectValue = isObject(value) ? value : {};
  return `
    <div class="editor-grid">
      ${Object.keys(schemaNode).map((key) => {
        const childSchema = schemaNode[key];
        const childPath = [...path, key];
        const childContent = renderEditorNode(childSchema, objectValue[key], childPath, key, context);
        const needsSubsection = Array.isArray(childSchema) || isObject(childSchema);

        if (!needsSubsection) {
          return childContent;
        }

        return `
          <div class="editor-subsection">
            <div class="editor-subsection-title">${escapeHtml(getFieldLabel(key))}</div>
            ${childContent}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderArrayEditor(schemaNode, value, path, key, context) {
  const items = Array.isArray(value) ? value : [];
  const arrayPath = escapeHtml(encodePath(path));

  return `
    <div class="editor-array" data-array-path="${arrayPath}">
      ${items.length
        ? items.map((item, index) => `
            <div class="editor-array-item">
              <button class="editor-array-remove" type="button" data-action="remove-array-item" data-array-path="${arrayPath}" data-index="${index}" aria-label="Удалить запись" title="Удалить запись">&times;</button>
                  Удалить
              ${renderEditorNode(schemaNode, item, [...path, index], key, context)}
            </div>
          `).join('')
        : '<div class="editor-array-empty">Поле пока пустое.</div>'}
      <button class="editor-array-action" type="button" data-action="add-array-item" data-array-path="${arrayPath}">Добавить запись</button>
    </div>
  `;
}

function renderArrayEditorCompact(schemaNode, value, path, key, context) {
  const items = Array.isArray(value) ? value : [];
  const arrayPath = escapeHtml(encodePath(path));

  return `
    <div class="editor-array" data-array-path="${arrayPath}">
      ${items.length
        ? items.map((item, index) => `
            <div class="editor-array-item">
              <button class="editor-array-remove" type="button" data-action="remove-array-item" data-array-path="${arrayPath}" data-index="${index}" aria-label="Удалить запись" title="Удалить запись">&times;</button>
              ${renderEditorNode(schemaNode, item, [...path, index], key, context)}
            </div>
          `).join('')
        : '<div class="editor-array-empty">Поле пока пустое.</div>'}
      <button class="editor-array-action" type="button" data-action="add-array-item" data-array-path="${arrayPath}">Добавить запись</button>
    </div>
  `;
}

function renderEditorNode(schemaNode, value, path, key, context) {
  if (Array.isArray(schemaNode)) {
    return renderArrayEditorCompact(schemaNode[0], value, path, key, context);
  }
  if (isObject(schemaNode)) {
    return renderObjectEditor(schemaNode, value, path, context);
  }
  return renderScalarEditor(path, key, value, schemaNode, context);
}

function buildSubtitle(personId, person) {
  const subtitleParts = [personId];
  if (person.birth?.date) subtitleParts.push(`рожд. ${person.birth.date}`);
  if (person.death?.date) subtitleParts.push(`ум. ${person.death.date}`);
  if (person.death?.date === null) subtitleParts.push('жив(-а)');
  return subtitleParts.join(' • ');
}

function extractTopLevelDescriptions(text) {
  const descriptions = {};
  let commentBuffer = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const commentMatch = rawLine.match(/^\s*#\s?(.*)$/);
    if (commentMatch) {
      const comment = commentMatch[1].trim();
      if (comment) commentBuffer.push(comment);
      continue;
    }

    const topLevelMatch = rawLine.match(/^([a-z_][a-z0-9_]*):/i);
    if (topLevelMatch) {
      if (commentBuffer.length) descriptions[topLevelMatch[1]] = commentBuffer.join(' ');
      commentBuffer = [];
      continue;
    }

    commentBuffer = [];
  }

  return descriptions;
}

async function loadEditorSchemaBundle() {
  if (!schemaBundlePromise) {
    schemaBundlePromise = fetch('./structure.yaml')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Не удалось загрузить structure.yaml: ${response.status}`);
        }
        return response.text();
      })
      .then((text) => ({
        schema: jsyaml.load(text),
        descriptions: extractTopLevelDescriptions(text),
      }));
  }
  return schemaBundlePromise;
}

function normalizeDraftValue(value, schemaNode, path, options) {
  const key = path[path.length - 1];

  if (Array.isArray(value)) {
    const itemSchema = Array.isArray(schemaNode) ? schemaNode[0] : undefined;
    return value
      .map((item, index) => normalizeDraftValue(item, itemSchema, [...path, index], options))
      .filter((item) => item !== undefined);
  }

  if (isObject(value)) {
    const result = {};
    const keys = new Set([...Object.keys(schemaNode || {}), ...Object.keys(value)]);
    for (const childKey of keys) {
      if (!(childKey in value)) continue;
      const normalized = normalizeDraftValue(value[childKey], schemaNode?.[childKey], [...path, childKey], options);
      if (normalized !== undefined) result[childKey] = normalized;
    }
    return result;
  }

  if (RELATION_FIELD_KEYS.has(key)) {
    const resolved = resolvePersonInput(value, options.peopleById, options.optionValueToId);
    return resolved === '' ? '' : resolved;
  }

  if (DATE_FIELD_KEYS.has(key)) {
    return normalizeDateValue(value);
  }

  return value;
}

export function normalizePersonDraft(draft, schema, options = {}) {
  return normalizeDraftValue(draft, schema, [], options);
}

function validateDraftNode(value, schemaNode, path, errors, options) {
  const key = path[path.length - 1];

  if (RELATION_FIELD_KEYS.has(key)) {
    const raw = String(value || '').trim();
    if (raw && resolvePersonInput(raw, options.peopleById, options.optionValueToId) === null) {
      errors.push(`Поле "${getFieldLabel(key)}" должно ссылаться на существующую персону.`);
    }
  }

  if (ENUM_FIELD_KEYS.has(key)) {
    const raw = String(value || '').trim();
    const optionsList = extractSchemaOptions(schemaNode);
    if (raw && optionsList.length && !optionsList.includes(raw)) {
      errors.push(`Поле "${getFieldLabel(key)}" должно содержать одно из предложенных значений.`);
    }
  }

  if (DATE_FIELD_KEYS.has(key) && value !== null) {
    const raw = normalizeDateValue(value);
    if (raw && !DATE_RE.test(raw)) {
      errors.push(`Поле "${getFieldLabel(key)}" должно быть в формате DD.MM.YYYY или быть пустым.`);
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = Array.isArray(schemaNode) ? schemaNode[0] : undefined;
    value.forEach((item, index) => validateDraftNode(item, itemSchema, [...path, index], errors, options));
    return;
  }

  if (isObject(value)) {
    Object.entries(value).forEach(([childKey, childValue]) => {
      validateDraftNode(childValue, schemaNode?.[childKey], [...path, childKey], errors, options);
    });
  }
}

function pruneBySchema(value, schemaNode, path = []) {
  if (Array.isArray(value)) {
    const itemSchema = Array.isArray(schemaNode) ? schemaNode[0] : undefined;
    const items = value
      .map((item, index) => pruneBySchema(item, itemSchema, [...path, index]))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }

  if (isObject(value)) {
    const ordered = {};
    const schemaKeys = isObject(schemaNode) ? Object.keys(schemaNode) : [];
    const extraKeys = Object.keys(value).filter((key) => !schemaKeys.includes(key));
    for (const key of [...schemaKeys, ...extraKeys]) {
      if (!(key in value)) continue;
      const next = pruneBySchema(value[key], schemaNode?.[key], [...path, key]);
      if (next !== undefined) ordered[key] = next;
    }
    return Object.keys(ordered).length ? ordered : undefined;
  }

  if (value === null) {
    if (path.join('.') === 'death.date') return null;
    return undefined;
  }

  if (typeof value === 'string' && !value.trim()) return undefined;
  if (value === undefined) return undefined;
  return value;
}

export async function loadEditorSchema() {
  const bundle = await loadEditorSchemaBundle();
  return bundle.schema;
}

export async function loadEditorDescriptions() {
  const bundle = await loadEditorSchemaBundle();
  return bundle.descriptions;
}

export function clonePersonDraft(person) {
  return JSON.parse(JSON.stringify(person || {}));
}

export function hydrateDraftForEditor(person, schema, peopleById) {
  return hydrateDraftValue(clonePersonDraft(person), schema, [], peopleById);
}

export function createDraftFromSchema(schema) {
  return createEmptyValue(schema);
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

export function updateDraftValue(draft, pathString, value) {
  const path = parsePath(pathString);
  if (!path.length) return;
  const container = ensureContainer(draft, path);
  container[path[path.length - 1]] = value;
}

export function addDraftArrayItem(draft, schema, arrayPathString) {
  const path = parsePath(arrayPathString);
  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];
  if (!Array.isArray(container[leaf])) container[leaf] = [];
  const itemSchema = getSchemaNode(schema, path);
  const nextItem = createEmptyValue(Array.isArray(itemSchema) ? itemSchema[0] : itemSchema);
  if (leaf === 'spouses' && isObject(nextItem) && 'divorce_date' in nextItem) {
    delete nextItem.divorce_date;
  }
  container[leaf].push(nextItem);
}

export function removeDraftArrayItem(draft, arrayPathString, index) {
  const path = parsePath(arrayPathString);
  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];
  if (!Array.isArray(container[leaf])) return;
  container[leaf].splice(index, 1);
}

export function setAliveState(draft, isAlive) {
  if (!isObject(draft.death)) draft.death = {};
  draft.death.date = isAlive ? null : '';
}

export function setDivorcedState(draft, pathString, isDivorced) {
  const path = parsePath(pathString);
  if (!path.length) return;

  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];

  if (isDivorced) {
    if (container[leaf] === undefined || container[leaf] === null) {
      container[leaf] = '';
    }
    return;
  }

  delete container[leaf];
}

export function renderEditablePersonDetails(personId, person, schema, descriptions = {}, options = {}) {
  if (!person || !schema) return null;

  const title = getPersonDisplayName(person, personId);
  const sections = Object.keys(schema).map((key) => {
    const isAlive = key === 'death' && person.death?.date === null;
    const isSectionDisabled = key === 'id' || (key === 'death' && isAlive);
    return `
      <section class="field-block is-editing${isSectionDisabled ? ' is-disabled' : ''}">
        <div class="editor-section-head">
          <h3 class="field-title">${escapeHtml(getFieldLabel(key))}</h3>
          ${key === 'death' ? `
            <label class="editor-checkbox">
              <input type="checkbox" data-action="toggle-alive" ${isAlive ? 'checked' : ''} />
              <span>Жив(-а)</span>
            </label>
          ` : ''}
        </div>
        ${descriptions[key] ? `<p class="editor-section-note">${escapeHtml(descriptions[key])}</p>` : ''}
        <div class="field-value">
          ${renderEditorNode(schema[key], person[key], [key], key, {
            personOptionEntries: options.personOptionEntries,
            enumListIdPrefix: options.enumListIdPrefix,
            disableInputs: isSectionDisabled,
          })}
        </div>
      </section>
    `;
  });

  return {
    title,
    subtitle: buildSubtitle(personId, person),
    html: sections.join(''),
  };
}

export function validatePersonDraft(draft, schema, options = {}) {
  const errors = [];
  const normalized = normalizeDraftValue(draft, schema, [], options);

  const idValue = String(normalized?.id || '').trim();
  if (!idValue) errors.push('Поле "ID" обязательно для заполнения.');

  const birthName = normalized?.birth_name || {};
  const hasBirthName = ['surname', 'first_name', 'patronymic'].some((key) => String(birthName?.[key] || '').trim());
  if (!hasBirthName) errors.push('Нужно заполнить хотя бы одно поле в блоке "Имя при рождении".');

  const sexValue = String(normalized?.sex || '').trim();
  if (!sexValue) errors.push('Поле "Пол" обязательно для заполнения.');

  const birthDate = normalizeDateValue(normalized?.birth?.date);
  if (!birthDate) {
    errors.push('Поле "Дата" в блоке "Рождение" обязательно для заполнения.');
  } else if (birthDate !== UNKNOWN_DATE_VALUE && !DATE_RE.test(birthDate)) {
    errors.push('Дата рождения должна быть в формате DD.MM.YYYY или ???.');
  }

  validateDraftNode(normalized, schema, [], errors, options);

  return {
    valid: errors.length === 0,
    errors,
    normalized,
  };
}

function hasMeaningfulValueForEditor(value, path = []) {
  if (Array.isArray(value)) {
    return value.some((item, index) => hasMeaningfulValueForEditor(item, [...path, index]));
  }

  if (isObject(value)) {
    return Object.entries(value).some(([key, childValue]) => (
      hasMeaningfulValueForEditor(childValue, [...path, key])
    ));
  }

  if (value === null) {
    return path.join('.') !== 'death.date';
  }

  if (value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  return true;
}

function hasMeaningfulContentExcludingIdForEditor(value) {
  if (!isObject(value)) return false;

  return Object.entries(value).some(([key, childValue]) => {
    if (key === 'id') return false;
    return hasMeaningfulValueForEditor(childValue, [key]);
  });
}

export function validateEditorPersonDraft(draft, schema, options = {}) {
  const errors = [];
  const normalized = normalizeDraftValue(draft, schema, [], options);

  const idValue = String(normalized?.id || '').trim();
  if (!idValue) errors.push('Поле "ID" обязательно для заполнения.');

  if (options.requireNonIdContent && !hasMeaningfulContentExcludingIdForEditor(normalized)) {
    errors.push('Для новой карточки нужно заполнить хотя бы одно поле помимо ID.');
  }

  validateDraftNode(normalized, schema, [], errors, options);

  return {
    valid: errors.length === 0,
    errors,
    normalized,
  };
}

export function renderPersonYaml(person, schema) {
  const normalized = pruneBySchema(person, schema);
  return `${jsyaml.dump(normalized || {}, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  })}`;
}
