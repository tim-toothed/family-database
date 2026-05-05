import { buildDocumentHref, collectDocumentSnippetTokens, parseDocumentSnippet } from '../documents/deeplinks.js';
import { getPersonFieldLabel } from '../person/labels.js';
import {
  formatBirthName,
  formatDateValue,
  getDatasetPersonName,
  getLifeEvent,
  getNamedTextEntries,
  getRelationEntries,
} from '../person/model.js';
import {
  buildPersonDetailsModel,
  getPersonSectionViewTemplate,
} from '../person/view-model.js';
import { escapeHtml } from '../utils/normalize.js';

function isMeaningfulValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function compactParts(parts, separator = ' • ') {
  return parts.filter((part) => isMeaningfulValue(part)).join(separator);
}

function formatPersonRef(personId, dataset) {
  if (!personId) return '';
  const name = getDatasetPersonName(dataset, personId, personId);
  const hasCard = dataset.availableIds.has(personId);
  if (!hasCard) return `<span>${escapeHtml(name)}</span>`;
  return `<a href="#" class="person-link" data-person-id="${escapeHtml(personId)}">${escapeHtml(name)}</a>`;
}

function relationBadge(label, tone = 'neutral') {
  if (!label) return '';
  return `<span class="badge family-role-badge role-${tone}">${escapeHtml(label)}</span>`;
}

function relationToneByLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized.includes('мать') || normalized.includes('сест')) return 'female';
  if (normalized.includes('отец') || normalized.includes('брат') || normalized.includes('сын')) return 'male';
  return 'neutral';
}

function renderKvList(entries) {
  const meaningfulEntries = entries.filter(([, value]) => isMeaningfulValue(value));
  if (!meaningfulEntries.length) return '';

  return `<div class="kv-list">${meaningfulEntries
    .map(
      ([label, value]) => `
        <div class="kv-label">${escapeHtml(getPersonFieldLabel(label, { context: 'view' }))}</div>
        <div>${value}</div>
      `
    )
    .join('')}</div>`;
}

function renderBulletList(items, itemRenderer, className = '') {
  const renderedItems = (items || [])
    .map((item) => itemRenderer(item))
    .filter((item) => isMeaningfulValue(item));

  if (!renderedItems.length) return '';

  const classAttr = className ? ` class="${className}"` : '';
  return `<ul${classAttr}>${renderedItems.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function renderStackList(items, itemRenderer, className = '') {
  const renderedItems = (items || [])
    .map((item) => itemRenderer(item))
    .filter((item) => isMeaningfulValue(item));

  if (!renderedItems.length) return '';

  const classAttr = className ? ` ${className}` : '';
  return `<div class="relation-list${classAttr}">${renderedItems.join('')}</div>`;
}

function renderSimpleMarkdownLink(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const directDocumentSnippet = parseDocumentSnippet(text);
  if (directDocumentSnippet) {
    return `<a href="${escapeHtml(buildDocumentHref(directDocumentSnippet))}">[link]</a>`;
  }

  const match = text.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return escapeHtml(text);

  const [, label, href] = match;
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function renderInlineText(value) {
  const source = String(value || '').trim();
  if (!source) return '';

  const tokens = collectDocumentSnippetTokens(source);
  if (!tokens.length) {
    return escapeHtml(source);
  }

  let cursor = 0;
  let html = '';
  for (const token of tokens) {
    if (token.start > cursor) {
      html += escapeHtml(source.slice(cursor, token.start));
    }

    html += `<a href="${escapeHtml(buildDocumentHref({
      documentId: token.documentId,
      start: token.rangeStart,
      end: token.rangeEnd,
      headingId: token.headingId,
    }))}" class="inline-doc-link">[link]</a>`;
    cursor = token.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html;
}

function renderValue(value, valueType = 'inlineText') {
  if (valueType === 'plain') return escapeHtml(value);
  if (valueType === 'markdownLink') return renderSimpleMarkdownLink(value);
  if (valueType === 'code') return value ? `<code>${escapeHtml(value)}</code>` : '';
  return renderInlineText(value);
}

function renderRelationEventMeta(label, values) {
  const lines = values.filter(Boolean);
  if (!lines.length) return '';

  return `<div class="relation-secondary"><i>${escapeHtml(label)}:</i> ${lines.join('; ')}</div>`;
}

function renderRelationItem(item, dataset) {
  const personRef = formatPersonRef(item.personId, dataset);
  if (!personRef) return '';

  const primaryLine = compactParts([
    personRef,
    item.relationType ? relationBadge(item.relationType, relationToneByLabel(item.relationType)) : '',
  ], ' ');

  return `
    <div class="relation-stack">
      <div class="relation-main">${primaryLine}</div>
    </div>
  `;
}

const CUSTOM_SECTION_RENDERERS = {
  birthName(_key, value) {
    const name = formatBirthName(value);
    return name ? `<div>${escapeHtml(name)}</div>` : '';
  },

  spouses(key, value, dataset) {
    const entries = getRelationEntries({ [key]: value }, key);
    return renderStackList(entries, (item) => {
      const personRef = formatPersonRef(item.personId, dataset);
      if (!personRef) return '';

      const marriageMeta = item.marriageEvents
        .map((entry) => renderRelationEventMeta(getPersonFieldLabel('marriage'), [
          renderValue(entry.dateDisplay, 'plain'),
          renderValue(entry.place),
        ]))
        .filter(Boolean);
      const divorceMeta = item.divorceEvents
        .map((entry) => renderRelationEventMeta(getPersonFieldLabel('divorce'), [
          renderValue(entry.dateDisplay, 'plain'),
          renderValue(entry.other),
        ]))
        .filter(Boolean);
      const meta = [...marriageMeta, ...divorceMeta];

      return `
        <div class="relation-stack">
          <div class="relation-main">${personRef}</div>
          ${meta.length ? `<div class="relation-meta">${meta.join(' ')}</div>` : ''}
        </div>
      `;
    });
  },

  media(key, value) {
    const entries = getRelationEntries({ [key]: value }, key);
    return renderBulletList(entries, (item) => compactParts([
      renderValue(item.description),
      renderValue(item.link, 'code'),
    ]));
  },
};

function renderCleanText(value) {
  if (value && typeof value === 'object') {
    const entries = getNamedTextEntries(value);
    if (entries.length) {
      return renderCleanListRows(entries.map((entry) => [
        entry.label || entry.key,
        renderValue(entry.text),
      ]));
    }
  }

  return `<div>${renderValue(value)}</div>`;
}

function renderCleanListRows(rows) {
  return renderKvList(rows);
}

function normalizeDisplayKey(key) {
  if (key === 'dateRaw') return 'date_raw';
  if (key === 'burialPlace') return 'burial_place';
  if (key === 'relationType') return 'relation_type';
  return key;
}

function renderObjectEntries(value, options = {}) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .map(([key, nested]) => [
      normalizeDisplayKey(key),
      renderEntryValue(key, nested, options),
    ])
    .filter(([, rendered]) => isMeaningfulValue(rendered));
}

function renderEntryValue(key, value, options = {}) {
  if (key === 'date' || key === 'dateValue') return renderValue(formatDateValue(value), 'plain');
  if (key === 'dateDisplay') return renderValue(value, 'plain');
  if (key === 'raw' || key === 'dateParts' || key === 'year' || key === 'isAlive') return '';
  return renderValue(value, options.valueType);
}

function renderCleanList(key, value, template) {
  if (template.event) {
    const event = getLifeEvent({ value }, 'value');
    if (!event.raw || typeof event.raw !== 'object') return '';
    return renderCleanListRows(renderObjectEntries(event.raw));
  }

  if (template.namedText) {
    const entries = getNamedTextEntries(value, {
      baseKey: template.baseKey || key,
      labelPrefix: template.labelPrefix || key,
    });
    if (template.singleUnlabeledAsText && entries.length === 1 && !entries[0].label) {
      return `<div>${renderValue(entries[0].text)}</div>`;
    }
    return renderCleanListRows(entries.map((entry) => [
      entry.label || key,
      renderValue(entry.text),
    ]));
  }

  if (Array.isArray(value)) {
    const entries = getRelationEntries({ [key]: value }, key);
    return renderStackList(entries, (entry) => renderCleanListRows(renderObjectEntries(entry.raw)));
  }

  return renderCleanText(value);
}

function renderBulletListTemplate(key, value, template) {
  const entries = getRelationEntries({ [key]: value }, key);
  return renderBulletList(entries, (item) => {
    const values = Object.values(item.raw || item).map((nested) => renderValue(nested, template.valueType));
    return compactParts(values);
  });
}

function renderRelationsList(key, value, dataset) {
  const entries = getRelationEntries({ [key]: value }, key);
  return renderStackList(entries, (item) => renderRelationItem(item, dataset));
}

function renderSectionValue(key, value, template, dataset) {
  if (value === undefined || value === null || value === '') return '';

  switch (template.type) {
    case 'bulletList':
      return renderBulletListTemplate(key, value, template);
    case 'relationsList':
      return renderRelationsList(key, value, dataset);
    case 'cleanList':
      return renderCleanList(key, value, template);
    case 'custom':
      return CUSTOM_SECTION_RENDERERS[template.name]?.(key, value, dataset) || '';
    case 'cleanText':
    default:
      return renderCleanText(value);
  }
}

export function renderField(key, value, dataset) {
  return renderSectionValue(key, value, getPersonSectionViewTemplate(key), dataset);
}

export function buildPersonDetailsView(personId, dataset, options = {}) {
  const detailsModel = buildPersonDetailsModel(personId, dataset, options);
  if (!detailsModel) return null;
  const sections = detailsModel.sections
    .map((section) => ({
      ...section,
      html: renderSectionValue(section.key, section.value, section.template, dataset),
    }))
    .filter((section) => section.html);

  return {
    title: detailsModel.title,
    subtitle: detailsModel.subtitle,
    sections,
    html: sections.map((section) => `
      <section class="field-block">
        <h3 class="field-title">${escapeHtml(section.label)}</h3>
        <div class="field-value">${section.html}</div>
      </section>
    `).join(''),
  };
}

export function renderPersonDetails(personId, dataset, options = {}) {
  return buildPersonDetailsView(personId, dataset, options);
}

export function bindPersonLinks(root, onClick) {
  root.querySelectorAll('[data-person-id]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const personId = link.dataset.personId;
      onClick(personId);
    });
  });
}
