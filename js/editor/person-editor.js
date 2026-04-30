import { FIELD_LABELS } from '../config.js';
import { getPersonDisplayName } from '../render/person-name.js';
import { getLifeEvent, migratePersonSchema } from '../person/model.js';
import { getYamlLibrary, parseYaml } from '../lib/yaml.js';

const NESTED_FIELD_LABELS = {
  surname: 'Фамилия',
  first_name: 'Имя',
  patronymic: 'Отчество',
  name: 'Фамилия Имя Отчество',
  date: 'Дата',
  day: 'День',
  month: 'Месяц',
  year: 'Год',
  date_raw: 'Дата в свободной форме',
  place: 'Место',
  reason: 'Причина',
  cause: 'Причина',
  burial_place: 'Место захоронения',
  person_id: 'Персона',
  relation_type: 'Тип связи',
  marriage: 'Брак',
  divorce: 'Развод',
  education_info: 'Информация',
  title: 'Название',
  job: 'Работа / деятельность',
  jobs: 'Работа',
  service_info: 'Запись о службе',
  war: 'Событие / конфликт',
  achievement: 'Достижение / награда',
  residence_info: 'Место проживания',
  source: 'Источник',
  description: 'Описание',
  link: 'Ссылка',
  other: 'Примечание',
  military_service: 'Военная служба',
  war_participation: 'Участие в конфликтах и военные годы',
  achievements: 'Достижения и награды',
  label: 'Название подпункта',
  text: 'Текст',
};

const RELATION_FIELD_KEYS = new Set(['person_id']);
const ENUM_FIELD_KEYS = new Set(['relation_type', 'sex', 'reason']);
const DATE_PART_KEYS = new Set(['day', 'month', 'year']);
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

function isDateSchema(schemaNode) {
  if (!isObject(schemaNode)) return false;
  const keys = Object.keys(schemaNode);
  return keys.length > 0 && keys.every((key) => DATE_PART_KEYS.has(key));
}

function isDatePartKey(key) {
  return DATE_PART_KEYS.has(key);
}

function normalizeDatePartValue(key, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric)) return normalized;

  if (key === 'day' && (numeric < 1 || numeric > 31)) return normalized;
  if (key === 'month' && (numeric < 1 || numeric > 12)) return normalized;
  if (key === 'year' && numeric < 0) return normalized;
  return numeric;
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

function isNameChangeItemPath(path) {
  return path.length >= 2 && path[path.length - 2] === 'name_changes' && typeof path[path.length - 1] === 'number';
}

function getEditorSectionAnchorId(key) {
  return `editor-section-${String(key || '').trim()}`;
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
  const multiline = ['character', 'appearance', 'health', 'hobbies', 'text'].includes(key);
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
  const isNumberField = isDatePartKey(key);
  const numberAttributes = key === 'day'
    ? ' min="1" max="31" step="1" inputmode="numeric"'
    : key === 'month'
      ? ' min="1" max="12" step="1" inputmode="numeric"'
      : key === 'year'
        ? ' min="0" step="1" inputmode="numeric"'
        : '';

  if (isSelectField) {
    if (RELATION_FIELD_KEYS.has(key) && context.enableRelationPicker) {
      return `
        <label class="editor-field editor-relation-picker" data-relation-picker>
          ${showInlineLabel ? `<span class="editor-label">${escapeHtml(label)}</span>` : ''}
          <input
            class="editor-input"
            data-path="${encodedPath}"
            data-relation-input
            type="text"
            value="${fieldValue}"
            autocomplete="off"
            placeholder="Выберите персону"
            aria-expanded="false"
            ${disabled}
          />
          <div class="editor-relation-suggestions" data-relation-suggestions role="listbox" hidden></div>
          ${hint ? `<span class="editor-hint">${hint}</span>` : ''}
        </label>
      `;
    }

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

  const textControl = multiline
    ? `<textarea class="editor-input editor-input-textarea editor-link-mask-target" data-path="${encodedPath}" rows="4"${disabled}${placeholder}>${fieldValue}</textarea>`
    : `<input class="editor-input editor-link-mask-target" data-path="${encodedPath}" type="${isNumberField ? 'number' : 'text'}" value="${fieldValue}"${disabled}${placeholder}${isNumberField ? numberAttributes : ''} />`;

  return `
    <label class="editor-field">
      ${showInlineLabel ? `<span class="editor-label">${escapeHtml(label)}</span>` : ''}
      <div class="editor-link-mask-shell${multiline ? ' is-textarea' : ''}${disabled ? ' is-disabled' : ''}" data-link-mask-shell>
        ${textControl}
        <div class="editor-link-mask-overlay hidden${multiline ? ' is-textarea' : ''}" data-link-mask-overlay aria-hidden="true"></div>
      </div>
      ${hint ? `<span class="editor-hint">${hint}</span>` : ''}
    </label>
  `;
}

function renderOtherInfoEditor(value, path, context) {
  const entries = Array.isArray(value)
    ? value.map((entryValue, index) => [index, entryValue])
    : isObject(value)
      ? Object.entries(value)
      : [];
  const containerPath = escapeHtml(encodePath(path));
  const disabled = context.disableInputs ? ' disabled' : '';

  return `
    <div class="editor-array editor-other-info" data-other-info-path="${containerPath}">
      ${entries.length
        ? entries.map(([entryKey, entryValue], index) => {
          const normalized = isObject(entryValue)
            ? entryValue
            : { label: '', text: String(entryValue ?? '') };
          const basePath = [...path, entryKey];
          return `
            <div class="editor-array-item editor-other-info-item">
              <div class="editor-array-item-head">
                <span class="editor-array-item-title">Запись ${index + 1}</span>
                <button
                  class="editor-array-remove"
                  type="button"
                  data-action="remove-other-info-entry"
                  data-other-info-path="${containerPath}"
                  data-other-info-index="${escapeHtml(entryKey)}"
                  aria-label="Удалить запись ${index + 1}"
                  ${disabled}
                >Удалить</button>
              </div>
              <div class="editor-grid">
                ${renderScalarEditor([...basePath, 'label'], 'label', normalized.label, '', context)}
                ${renderScalarEditor([...basePath, 'text'], 'text', normalized.text, '', context)}
              </div>
            </div>
          `;
        }).join('')
        : ''}
      <button class="editor-array-action" type="button" data-action="add-other-info-entry" data-other-info-path="${containerPath}"${disabled}>+ Добавить запись</button>
    </div>
  `;
}

function renderDateObjectEditor(schemaNode, value, path, context) {
  const objectValue = isObject(value) ? value : {};

  return `
    <div class="editor-date-row">
      ${['day', 'month', 'year'].map((partKey) => renderScalarEditor(
        [...path, partKey],
        partKey,
        objectValue[partKey],
        schemaNode?.[partKey],
        context,
      )).join('')}
    </div>
  `;
}

function renderLabeledDateEditor(label, schemaNode, value, path, context) {
  return `
    <div class="editor-field">
      <span class="editor-label">${escapeHtml(label)}</span>
      ${renderDateObjectEditor(schemaNode, value, path, context)}
    </div>
  `;
}

function renderSpouseItemEditor(schemaNode, value, path, context) {
  const objectValue = isObject(value) ? value : {};
  const marriageSchema = Array.isArray(schemaNode?.marriage) ? schemaNode.marriage[0] : {};
  const divorceSchema = Array.isArray(schemaNode?.divorce) ? schemaNode.divorce[0] : {};
  const marriageValue = Array.isArray(objectValue.marriage) && isObject(objectValue.marriage[0]) ? objectValue.marriage[0] : {};
  const divorceItems = Array.isArray(objectValue.divorce) ? objectValue.divorce : [];
  const divorceValue = isObject(divorceItems[0]) ? divorceItems[0] : {};
  const divorceEnabled = divorceItems.length > 0;
  const divorcePath = [...path, 'divorce'];

  return `
    <div class="editor-grid editor-spouse-item">
      ${renderScalarEditor([...path, 'person_id'], 'person_id', objectValue.person_id, schemaNode?.person_id, context)}
      ${renderLabeledDateEditor('Дата брака', marriageSchema?.date, marriageValue.date, [...path, 'marriage', 0, 'date'], context)}
      ${renderScalarEditor([...path, 'marriage', 0, 'place'], 'place', marriageValue.place, marriageSchema?.place, context)}
      <label class="editor-checkbox">
        <input
          type="checkbox"
          data-action="toggle-divorced"
          data-divorce-path="${escapeHtml(encodePath(divorcePath))}"
          ${divorceEnabled ? 'checked' : ''}
          ${context.disableInputs ? ' disabled' : ''}
        />
        <span>Развод</span>
      </label>
      ${divorceEnabled ? `
        ${renderLabeledDateEditor('Дата развода', divorceSchema?.date, divorceValue.date, [...path, 'divorce', 0, 'date'], context)}
        ${renderScalarEditor([...path, 'divorce', 0, 'other'], 'other', divorceValue.other, divorceSchema?.other, context)}
      ` : ''}
    </div>
  `;
}

function renderSpousesEditor(schemaNode, value, path, context) {
  const items = Array.isArray(value) ? value : [];
  const arrayPath = escapeHtml(encodePath(path));

  return `
    <div class="editor-array" data-array-path="${arrayPath}">
      ${items.length
        ? items.map((item, index) => `
            <div class="editor-array-item">
              <div class="editor-array-item-head">
                <span class="editor-array-item-title">Запись ${index + 1}</span>
                <button class="editor-array-remove" type="button" data-action="remove-array-item" data-array-path="${arrayPath}" data-index="${index}" aria-label="Удалить запись ${index + 1}">Удалить</button>
              </div>
              ${renderSpouseItemEditor(schemaNode, item, [...path, index], context)}
            </div>
          `).join('')
        : ''}
      <button class="editor-array-action" type="button" data-action="add-array-item" data-array-path="${arrayPath}">+ Добавить запись</button>
    </div>
  `;
}

function renderObjectEditor(schemaNode, value, path, context) {
  const objectValue = isObject(value) ? value : {};
  return `
    <div class="editor-grid">
      ${Object.keys(schemaNode).map((key) => {
        if (key === 'date' && isNameChangeItemPath(path)) {
          const reason = String(objectValue.reason || '').trim().toLowerCase();
          if (reason !== 'смена имени') {
            return '';
          }
        }

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

function renderArrayEditorClean(schemaNode, value, path, key, context) {
  const items = Array.isArray(value) ? value : [];
  const arrayPath = escapeHtml(encodePath(path));

  return `
    <div class="editor-array" data-array-path="${arrayPath}">
      ${items.length
        ? items.map((item, index) => `
            <div class="editor-array-item">
              <div class="editor-array-item-head">
                <span class="editor-array-item-title">Запись ${index + 1}</span>
                <button class="editor-array-remove" type="button" data-action="remove-array-item" data-array-path="${arrayPath}" data-index="${index}" aria-label="Удалить запись ${index + 1}">Удалить</button>
              </div>
              ${renderEditorNode(schemaNode, item, [...path, index], key, context)}
            </div>
          `).join('')
        : ''}
      <button class="editor-array-action" type="button" data-action="add-array-item" data-array-path="${arrayPath}">+ Добавить запись</button>
    </div>
  `;
}

function renderEditorNode(schemaNode, value, path, key, context) {
  if (key === 'other_info') {
    return renderOtherInfoEditor(value, path, context);
  }
  if (key === 'spouses' && Array.isArray(schemaNode)) {
    return renderSpousesEditor(schemaNode[0], value, path, context);
  }
  if (Array.isArray(schemaNode)) {
    return renderArrayEditorClean(schemaNode[0], value, path, key, context);
  }
  if (isDateSchema(schemaNode)) {
    return renderDateObjectEditor(schemaNode, value, path, context);
  }
  if (isObject(schemaNode)) {
    return renderObjectEditor(schemaNode, value, path, context);
  }
  return renderScalarEditor(path, key, value, schemaNode, context);
}

function buildSubtitle(personId, person) {
  const subtitleParts = [personId];
  const birth = getLifeEvent(person, 'birth');
  const death = getLifeEvent(person, 'death');
  if (birth.dateDisplay) subtitleParts.push(`рожд. ${birth.dateDisplay}`);
  if (death.dateDisplay) subtitleParts.push(`ум. ${death.dateDisplay}`);
  if (death.isAlive) subtitleParts.push('жив(-а)');
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
      .then(async (text) => ({
        schema: await parseYaml(text),
        descriptions: extractTopLevelDescriptions(text),
      }));
  }
  return schemaBundlePromise;
}

function normalizeDraftValue(value, schemaNode, path, options) {
  const key = path[path.length - 1];

  if (isDateSchema(schemaNode)) {
    if (value === null) return null;
    const objectValue = isObject(value) ? value : {};
    const result = {};
    for (const partKey of ['day', 'month', 'year']) {
      const normalizedPart = normalizeDatePartValue(partKey, objectValue[partKey]);
      if (normalizedPart !== '') {
        result[partKey] = normalizedPart;
      }
    }
    return result;
  }

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
    return resolved === null ? value : resolved;
  }

  if (isDatePartKey(key)) {
    return normalizeDatePartValue(key, value);
  }

  return value;
}

export function normalizePersonDraft(draft, schema, options = {}) {
  return pruneBySchema(normalizeDraftValue(draft, schema, [], options), schema) || {};
}

function validateDraftNode(value, schemaNode, path, errors, options) {
  const key = path[path.length - 1];

  if (isDateSchema(schemaNode)) {
    if (value === null) {
      return;
    }

    if (!isObject(value)) {
      errors.push(`Поле "${getFieldLabel(key)}" должно содержать подполя day, month и year.`);
      return;
    }

    const day = value.day;
    const month = value.month;
    const year = value.year;

    if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 31)) {
      errors.push('Поле "День" должно быть числом от 1 до 31.');
    }
    if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
      errors.push('Поле "Месяц" должно быть числом от 1 до 12.');
    }
    if (year !== undefined && (!Number.isInteger(year) || year < 0)) {
      errors.push('Поле "Год" должно быть неотрицательным целым числом.');
    }
    return;
  }

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
  if (isDateSchema(schemaNode)) {
    if (value === null) {
      if (path.join('.') === 'death.date') return null;
      return undefined;
    }

    const objectValue = isObject(value) ? value : {};
    const ordered = {};
    for (const partKey of ['day', 'month', 'year']) {
      if (Number.isInteger(objectValue[partKey])) {
        ordered[partKey] = objectValue[partKey];
      }
    }
    return Object.keys(ordered).length ? ordered : undefined;
  }

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
  return hydrateDraftValue(migratePersonSchema(clonePersonDraft(person)), schema, [], peopleById);
}

export function createDraftFromSchema(schema) {
  return createEmptyValue(schema);
}

function buildEditableSectionView(sectionKey, person, schema, descriptions = {}, options = {}) {
  const schemaNode = schema?.[sectionKey];
  if (schemaNode === undefined) return null;

  const isAlive = sectionKey === 'death' && getLifeEvent(person, 'death').isAlive;
  const isSectionCollapsed = sectionKey === 'death' && isAlive;
  const isSectionDisabled = sectionKey === 'id';
  const sectionLabel = getFieldLabel(sectionKey);

  return {
    key: sectionKey,
    label: sectionLabel,
    description: descriptions[sectionKey] || '',
    isCollapsed: isSectionCollapsed,
    isDisabled: isSectionDisabled,
    headerControlHtml: sectionKey === 'death'
      ? `
        <label class="editor-checkbox">
          <input type="checkbox" data-action="toggle-alive" ${isAlive ? 'checked' : ''} />
          <span>Жив(-а)</span>
        </label>
      `
      : '',
    bodyHtml: isSectionCollapsed
      ? ''
      : renderEditorNode(schemaNode, person?.[sectionKey], [sectionKey], sectionKey, {
        personOptionEntries: options.personOptionEntries,
        enumListIdPrefix: options.enumListIdPrefix,
        disableInputs: isSectionDisabled,
        enableRelationPicker: options.enableRelationPicker,
      }),
  };
}

export function renderEditablePersonSection(sectionKey, person, schema, descriptions = {}, options = {}) {
  return buildEditableSectionView(sectionKey, person, schema, descriptions, options);
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
  container[leaf].push(nextItem);
}

export function addOtherInfoEntry(draft, pathString) {
  const path = parsePath(pathString);
  if (!path.length) return;

  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];
  if (!Array.isArray(container[leaf])) {
    container[leaf] = isObject(container[leaf])
      ? Object.values(container[leaf]).map((entry) => (
        isObject(entry) ? { ...entry } : { label: '', text: String(entry ?? '') }
      ))
      : [];
  }

  container[leaf].push({
    label: '',
    text: '',
  });
}

export function removeOtherInfoEntry(draft, pathString, entryIndex) {
  const path = parsePath(pathString);
  if (!path.length) return;

  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];
  if (Array.isArray(container[leaf])) {
    container[leaf].splice(Number(entryIndex), 1);
    return;
  }

  if (isObject(container[leaf])) {
    delete container[leaf][entryIndex];
  }
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
  draft.death.date = isAlive ? null : {};
}

export function setDivorcedState(draft, pathString, isDivorced) {
  const path = parsePath(pathString);
  if (!path.length) return;

  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];

  if (isDivorced) {
    if (container[leaf] === undefined || container[leaf] === null) {
      container[leaf] = [{}];
    }
    return;
  }

  delete container[leaf];
}

export function syncNameChangeDateField(draft, reasonPathString, reasonValue) {
  const path = parsePath(reasonPathString);
  if (!path.length) return;

  const container = ensureContainer(draft, path);
  const leaf = path[path.length - 1];
  container[leaf] = reasonValue;

  const normalizedReason = String(reasonValue || '').trim().toLowerCase();
  if (normalizedReason === 'смена имени') {
    if (container.date === undefined || container.date === null) {
      container.date = {};
    }
    return;
  }

  delete container.date;
}

export function renderEditablePersonDetails(personId, person, schema, descriptions = {}, options = {}) {
  if (!person || !schema) return null;

  const title = getPersonDisplayName(person, personId);
  const sections = Object.keys(schema).map((key) => {
    const section = buildEditableSectionView(key, person, schema, descriptions, options);
    if (!section) return '';

    return `
      <section
        id="${escapeHtml(getEditorSectionAnchorId(key))}"
        class="field-block is-editing${section.isDisabled ? ' is-disabled' : ''}${section.isCollapsed ? ' is-collapsed' : ''}"
        data-editor-section
        data-section-key="${escapeHtml(key)}"
        data-section-label="${escapeHtml(section.label)}"
      >
        <div class="editor-section-head">
          <h3 class="field-title">${escapeHtml(section.label)}</h3>
          ${section.headerControlHtml}
        </div>
        ${section.description ? `<p class="editor-section-note">${escapeHtml(section.description)}</p>` : ''}
        ${section.isCollapsed ? '' : `
          <div class="field-value">
            ${section.bodyHtml}
          </div>
        `}
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
  const normalizedDraft = normalizeDraftValue(draft, schema, [], options);
  const normalized = pruneBySchema(normalizedDraft, schema) || {};

  const idValue = String(normalized?.id || '').trim();
  if (!idValue) errors.push('Поле "ID" обязательно для заполнения.');

  const birthName = normalized?.birth_name || {};
  const hasBirthName = ['surname', 'first_name', 'patronymic'].some((key) => String(birthName?.[key] || '').trim());
  if (!hasBirthName) errors.push('Нужно заполнить хотя бы одно поле в блоке "Имя при рождении".');

  const sexValue = String(normalized?.sex || '').trim();
  if (!sexValue) errors.push('Поле "Пол" обязательно для заполнения.');

  validateDraftNode(normalizedDraft, schema, [], errors, options);

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
  const normalizedDraft = normalizeDraftValue(draft, schema, [], options);
  const normalized = pruneBySchema(normalizedDraft, schema) || {};

  const idValue = String(normalized?.id || '').trim();
  if (!idValue) errors.push('Поле "ID" обязательно для заполнения.');

  if (options.requireNonIdContent && !hasMeaningfulContentExcludingIdForEditor(normalized)) {
    errors.push('Для новой карточки нужно заполнить хотя бы одно поле помимо ID.');
  }

  validateDraftNode(normalizedDraft, schema, [], errors, options);

  return {
    valid: errors.length === 0,
    errors,
    normalized,
  };
}

export function renderPersonYaml(person, schema) {
  const normalized = pruneBySchema(person, schema);
  return `${getYamlLibrary().dump(normalized || {}, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  })}`;
}
