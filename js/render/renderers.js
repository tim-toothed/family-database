import { FIELD_LABELS, SECTION_ORDER } from '../config.js';
import { buildDocumentHref, collectDocumentSnippetTokens, parseDocumentSnippet } from '../document-links.js';
import { formatBirthName, getDatasetPersonName, getPersonDisplayName } from './person-name.js';
import {
  formatDateValue,
  getLifeEvent,
  getNamedTextEntries,
  getRelationEntries,
  personHasField,
} from '../person/model.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDisplayDate(value) {
  return formatDateValue(value);
}

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
        <div class="kv-label">${escapeHtml(shortenDetailsLabel(label))}</div>
        <div>${value}</div>
      `
    )
    .join('')}</div>`;
}

function shortenDetailsLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized.includes('\u0441\u0432\u043e\u0431\u043e\u0434') && normalized.includes('\u0434\u0430\u0442')) {
    return 'Дата (текст)';
  }

  return label;
}

function renderBirthDeath(block) {
  const event = getLifeEvent({ value: block }, 'value');
  if (!event.raw || typeof event.raw !== 'object') return '';

  return renderKvList([
    ['Дата', event.dateDisplay ? escapeHtml(event.dateDisplay) : ''],
    ['Дата в свободной форме', event.dateRaw ? renderInlineText(event.dateRaw) : ''],
    ['Место', event.place ? renderInlineText(event.place) : ''],
    ['Причина', event.cause ? renderInlineText(event.cause) : ''],
    ['Место захоронения', event.burialPlace ? renderInlineText(event.burialPlace) : ''],
  ]);
}

function renderList(items, itemRenderer, className = '') {
  const renderedItems = (items || [])
    .map((item) => itemRenderer(item))
    .filter((item) => isMeaningfulValue(item));

  if (!renderedItems.length) return '';

  const classAttr = className ? ` class="${className}"` : '';
  return `<ul${classAttr}>${renderedItems.map((item) => `<li>${item}</li>`).join('')}</ul>`;
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

function renderRelationLine(personId, relationType, dataset) {
  const personRef = formatPersonRef(personId, dataset);
  const badge = relationBadge(relationType, relationToneByLabel(relationType));
  return compactParts([personRef, badge], ' ');
}

function renderRelationEventMeta(label, values) {
  const lines = values.filter(Boolean);
  if (!lines.length) return '';

  return `<div class="relation-secondary"><i>${escapeHtml(label)}:</i> ${lines.join('; ')}</div>`;
}

function renderSpouseItem(item, dataset) {
  const personRef = formatPersonRef(item.personId, dataset);
  if (!personRef) return '';

  const marriageMeta = item.marriageEvents
    .map((entry) => {
      const parts = [];
      if (entry.dateDisplay) parts.push(escapeHtml(entry.dateDisplay));
      if (entry.place) parts.push(renderInlineText(entry.place));
      return renderRelationEventMeta('Брак', parts);
    })
    .filter(Boolean);
  const divorceMeta = item.divorceEvents
    .map((entry) => {
      const parts = [];
      if (entry.dateDisplay) parts.push(escapeHtml(entry.dateDisplay));
      if (entry.other) parts.push(renderInlineText(entry.other));
      return renderRelationEventMeta('Развод', parts);
    })
    .filter(Boolean);
  const meta = [...marriageMeta, ...divorceMeta];

  return `
    <div class="relation-stack">
      <div class="relation-main">${personRef}</div>
      ${meta.length ? `<div class="relation-meta">${meta.join(' ')}</div>` : ''}
    </div>
  `;
}

function renderChildItem(item, dataset) {
  const personRef = formatPersonRef(item.personId, dataset);
  if (!personRef) return '';

  const primaryLine = compactParts([
    personRef,
    item.relationType ? relationBadge(item.relationType, relationToneByLabel(item.relationType)) : '',
  ], ' ');

  const meta = [
    item.birthDateDisplay ? `<div class="relation-secondary">рожд.: ${escapeHtml(item.birthDateDisplay)}</div>` : '',
    item.secondParentId
      ? `<div class="relation-secondary">второй родитель: ${formatPersonRef(item.secondParentId, dataset)}</div>`
      : '',
  ].filter(Boolean);

  return `
    <div class="relation-stack">
      <div class="relation-main">${primaryLine}</div>
      ${meta.length ? `<div class="relation-meta">${meta.join('')}</div>` : ''}
    </div>
  `;
}

function renderNameChangeItem(item) {
  const name = String(item?.name || '').trim();
  const reason = String(item?.reason || '').trim();
  const showDate = reason.toLowerCase() === 'смена имени';
  const meta = [
    showDate && item?.raw?.date ? `<div class="relation-secondary"><i>Дата:</i> ${escapeHtml(formatDisplayDate(item.raw.date))}</div>` : '',
    reason ? `<div class="relation-secondary"><i>Причина:</i> ${renderInlineText(reason)}</div>` : '',
  ].filter(Boolean);

  if (!name && !meta.length) return '';

  return `
    <div class="relation-stack">
      ${name ? `<div class="relation-main">${renderInlineText(name)}</div>` : ''}
      ${meta.length ? `<div class="relation-meta">${meta.join(' ')}</div>` : ''}
    </div>
  `;
}

function renderArrayField(key, items, dataset) {
  if (!Array.isArray(items) || items.length === 0) return '';

  switch (key) {
    case 'parents':
    case 'siblings':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderRelationLine(item.personId, item.relationType, dataset));
    case 'spouses':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderSpouseItem(item, dataset), 'relation-list');
    case 'children':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderChildItem(item, dataset), 'relation-list');
    case 'name_changes':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderNameChangeItem(item), 'relation-list');
    case 'education':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.educationInfo));
    case 'jobs':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.job));
    case 'military_service':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.serviceInfo));
    case 'war_participation':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.war));
    case 'achievements':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.achievement));
    case 'residences':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderInlineText(item.residenceInfo));
    case 'sources':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => renderSimpleMarkdownLink(item.source));
    case 'media':
      return renderList(getRelationEntries({ [key]: items }, key), (item) => {
        const parts = [];
        if (item.description) parts.push(renderInlineText(item.description));
        if (item.link) parts.push(`<code>${escapeHtml(item.link)}</code>`);
        return compactParts(parts);
      });
    default:
      return renderList(items, (item) => {
        const text = JSON.stringify(item);
        return text && text !== '{}' ? escapeHtml(text) : '';
      });
  }
}

function renderField(key, value, dataset) {
  if (value === undefined || value === null || value === '') return '';

  if (key === 'birth' || key === 'death') {
    return renderBirthDeath(value);
  }

  if (key === 'birth_name') {
    const name = formatBirthName(value);
    return name ? `<div>${escapeHtml(name)}</div>` : '';
  }

  if (key === 'other_info') {
    const entries = getNamedTextEntries(value, {
      baseKey: 'other_info',
      labelPrefix: 'Other info',
    });
    if (entries.length > 0) {
      if (entries.length === 1 && !entries[0].label) {
        return `<div>${renderInlineText(entries[0].text)}</div>`;
      }

      return renderKvList(entries.map((entry) => [
        entry.label || FIELD_LABELS[key] || key,
        renderInlineText(entry.text),
      ]));
    }
  }

  if (Array.isArray(value)) {
    return renderArrayField(key, value, dataset);
  }

  if (value && typeof value === 'object') {
    const entries = getNamedTextEntries(value, {
      baseKey: key,
      labelPrefix: key,
    });
    if (entries.length > 0) {
      return renderKvList(entries.map((entry) => [entry.label || key, renderInlineText(entry.text)]));
    }
  }

  return `<div>${renderInlineText(value)}</div>`;
}

function buildPersonSections(person, dataset) {
  const sections = [];

  for (const key of SECTION_ORDER) {
    if (!personHasField(person, key)) continue;
    const rendered = renderField(key, person[key], dataset);
    if (!rendered) continue;
    sections.push({
      key,
      label: FIELD_LABELS[key] || key,
      html: rendered,
    });
  }

  return sections;
}

export function buildPersonDetailsView(personId, dataset, options = {}) {
  const person = options.personOverride || dataset.people.get(personId);
  if (!person) return null;

  const title = options.personOverride
    ? getPersonDisplayName(person, personId)
    : getDatasetPersonName(dataset, personId, personId);

  const subtitleParts = [personId];
  const birth = getLifeEvent(person, 'birth');
  const death = getLifeEvent(person, 'death');
  if (birth.dateDisplay) subtitleParts.push(`рожд. ${birth.dateDisplay}`);
  if (death.dateDisplay) subtitleParts.push(`ум. ${death.dateDisplay}`);

  const sections = buildPersonSections(person, dataset);

  return {
    title,
    subtitle: subtitleParts.join(' • '),
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
