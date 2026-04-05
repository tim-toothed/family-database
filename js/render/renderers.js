import { FIELD_LABELS, SECTION_ORDER } from '../config.js';
import { buildDocumentHref, collectDocumentSnippetTokens, parseDocumentSnippet } from '../document-links.js';
import { formatBirthName, getDatasetPersonName, getPersonDisplayName } from './person-name.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDisplayDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const yearOnlyMatch = text.match(/^DD\.MM\.(\d{4})$/);
  if (yearOnlyMatch) return yearOnlyMatch[1];

  return text;
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
  if (!block || typeof block !== 'object') return '';

  return renderKvList([
    ['Дата', block.date ? escapeHtml(formatDisplayDate(block.date)) : ''],
    ['Дата в свободной форме', block.date_raw ? escapeHtml(block.date_raw) : ''],
    ['Место', block.place ? escapeHtml(block.place) : ''],
    ['Причина', block.cause ? escapeHtml(block.cause) : ''],
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

function renderSpouseItem(item, dataset) {
  const personRef = formatPersonRef(item.person_id, dataset);
  if (!personRef) return '';

  const meta = [
    item.marriage_date ? `<div class="relation-secondary"><i>Брак:</i> ${escapeHtml(formatDisplayDate(item.marriage_date))}</div>` : '',
    item.divorce_date ? `<div class="relation-secondary"><i>Развод:</i> ${escapeHtml(formatDisplayDate(item.divorce_date))}</div>` : '',
  ].filter(Boolean);

  return `
    <div class="relation-stack">
      <div class="relation-main">${personRef}</div>
      ${meta.length ? `<div class="relation-meta">${meta.join(' ')}</div>` : ''}
    </div>
  `;
}

function renderChildItem(item, dataset) {
  const personRef = formatPersonRef(item.person_id, dataset);
  if (!personRef) return '';

  const primaryLine = compactParts([
    personRef,
    item.relation_type ? relationBadge(item.relation_type, relationToneByLabel(item.relation_type)) : '',
  ], ' ');

  const meta = [
    item.birth_date ? `<div class="relation-secondary">рожд.: ${escapeHtml(formatDisplayDate(item.birth_date))}</div>` : '',
    item.second_parent_id
      ? `<div class="relation-secondary">второй родитель: ${formatPersonRef(item.second_parent_id, dataset)}</div>`
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
    showDate && item?.date ? `<div class="relation-secondary"><i>Дата:</i> ${escapeHtml(formatDisplayDate(item.date))}</div>` : '',
    reason ? `<div class="relation-secondary"><i>Причина:</i> ${escapeHtml(reason)}</div>` : '',
  ].filter(Boolean);

  if (!name && !meta.length) return '';

  return `
    <div class="relation-stack">
      ${name ? `<div class="relation-main">${escapeHtml(name)}</div>` : ''}
      ${meta.length ? `<div class="relation-meta">${meta.join(' ')}</div>` : ''}
    </div>
  `;
}

function renderArrayField(key, items, dataset) {
  if (!Array.isArray(items) || items.length === 0) return '';

  switch (key) {
    case 'parents':
    case 'siblings':
      return renderList(items, (item) => renderRelationLine(item.person_id, item.relation_type, dataset));
    case 'spouses':
      return renderList(items, (item) => renderSpouseItem(item, dataset), 'relation-list');
    case 'children':
      return renderList(items, (item) => renderChildItem(item, dataset), 'relation-list');
    case 'name_changes':
      return renderList(items, (item) => renderNameChangeItem(item), 'relation-list');
    case 'education':
      return renderList(items, (item) => renderInlineText(String(item?.education_info || '').trim()));
    case 'profession':
      return renderList(items, (item) => renderInlineText(String(item?.title || '').trim()));
    case 'job_places':
      return renderList(items, (item) => renderInlineText(String(item?.job || '').trim()));
    case 'residences':
      return renderList(items, (item) => renderInlineText(String(item?.residence_info || '').trim()));
    case 'sources':
      return renderList(items, (item) => renderSimpleMarkdownLink(item?.source));
    case 'media':
      return renderList(items, (item) => {
        const parts = [];
        if (item?.description) parts.push(escapeHtml(item.description));
        if (item?.link) parts.push(`<code>${escapeHtml(item.link)}</code>`);
        return compactParts(parts);
      });
    default:
      return renderList(items, (item) => {
        const text = JSON.stringify(item);
        return text && text !== '{}' ? escapeHtml(text) : '';
      });
  }
}

function renderMilitary(military) {
  if (!military || typeof military !== 'object') return '';

  const chunks = [];
  const service = renderList(military.military_service, (item) => escapeHtml(String(item?.service_info || '').trim()));
  const wars = renderList(military.war_participation, (item) => escapeHtml(String(item?.war || '').trim()));
  const awards = renderList(military.awards, (item) => escapeHtml(String(item?.award || '').trim()));

  if (service) chunks.push(`<strong>Служба</strong>${service}`);
  if (wars) chunks.push(`<strong>Участие в войнах</strong>${wars}`);
  if (awards) chunks.push(`<strong>Награды</strong>${awards}`);

  return chunks.join('');
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

  if (key === 'military') {
    return renderMilitary(value);
  }

  if (Array.isArray(value)) {
    return renderArrayField(key, value, dataset);
  }

  return `<div>${renderInlineText(value)}</div>`;
}

export function renderPersonDetails(personId, dataset, options = {}) {
  const person = options.personOverride || dataset.people.get(personId);
  if (!person) return null;

  const title = options.personOverride
    ? getPersonDisplayName(person, personId)
    : getDatasetPersonName(dataset, personId, personId);

  const subtitleParts = [personId];
  if (person.birth?.date) subtitleParts.push(`рожд. ${formatDisplayDate(person.birth.date)}`);
  if (person.death?.date) subtitleParts.push(`ум. ${formatDisplayDate(person.death.date)}`);

  const sections = [];
  for (const key of SECTION_ORDER) {
    if (!(key in person)) continue;
    const rendered = renderField(key, person[key], dataset);
    if (!rendered) continue;
    sections.push(`
      <section class="field-block">
        <h3 class="field-title">${escapeHtml(FIELD_LABELS[key] || key)}</h3>
        <div class="field-value">${rendered}</div>
      </section>
    `);
  }

  return {
    title,
    subtitle: subtitleParts.join(' • '),
    html: sections.join(''),
  };
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
