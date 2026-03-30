import { FIELD_LABELS, SECTION_ORDER } from './config.js';
import { formatBirthName, getDatasetPersonName } from './person-name.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPersonRef(personId, dataset) {
  if (!personId) return '—';
  const name = getDatasetPersonName(dataset, personId, personId);
  const hasCard = dataset.availableIds.has(personId);
  if (!hasCard) return `<span>${escapeHtml(name)}</span>`;
  return `<a href="#" class="person-link" data-person-id="${escapeHtml(personId)}">${escapeHtml(name)}</a>`;
}

function renderKvList(entries) {
  return `<div class="kv-list">${entries
    .map(
      ([label, value]) => `
        <div class="kv-label">${escapeHtml(label)}</div>
        <div>${value || '—'}</div>
      `
    )
    .join('')}</div>`;
}

function renderBirthDeath(block) {
  return renderKvList([
    ['Дата', escapeHtml(block.date || '—')],
    ['Как записано', escapeHtml(block.date_raw || '—')],
    ['Место', escapeHtml(block.place || '—')],
    ...(block.cause ? [['Причина', escapeHtml(block.cause)]] : []),
  ]);
}

function renderList(items, itemRenderer) {
  return `<ul>${items.map((item) => `<li>${itemRenderer(item)}</li>`).join('')}</ul>`;
}

function renderArrayField(key, items, dataset) {
  if (!Array.isArray(items) || items.length === 0) return '';

  switch (key) {
    case 'parents':
    case 'siblings':
      return renderList(items, (item) => `${formatPersonRef(item.person_id, dataset)}${item.relation_type ? ` <span class="badge">${escapeHtml(item.relation_type)}</span>` : ''}`);
    case 'spouses':
      return renderList(items, (item) => {
        const parts = [formatPersonRef(item.person_id, dataset)];
        if (item.marriage_date) parts.push(`брак: ${escapeHtml(item.marriage_date)}`);
        if (item.divorce_date) parts.push(`окончание: ${escapeHtml(item.divorce_date)}`);
        return parts.join(' • ');
      });
    case 'children':
      return renderList(items, (item) => {
        const parts = [formatPersonRef(item.person_id, dataset)];
        if (item.relation_type) parts.push(escapeHtml(item.relation_type));
        if (item.birth_date) parts.push(`рожд.: ${escapeHtml(item.birth_date)}`);
        if (item.second_parent_id) {
          parts.push(`второй родитель: ${formatPersonRef(item.second_parent_id, dataset)}`);
        }
        return parts.join(' • ');
      });
    case 'name_changes':
      return renderList(items, (item) => {
        const parts = [escapeHtml(item.name || '—')];
        if (item.date) parts.push(`дата: ${escapeHtml(item.date)}`);
        if (item.reason) parts.push(`причина: ${escapeHtml(item.reason)}`);
        return parts.join(' • ');
      });
    case 'education':
      return renderList(items, (item) => escapeHtml(item.education_info || '—'));
    case 'profession':
      return renderList(items, (item) => escapeHtml(item.title || '—'));
    case 'job_places':
      return renderList(items, (item) => escapeHtml(item.job || '—'));
    case 'residences':
      return renderList(items, (item) => escapeHtml(item.residence_info || '—'));
    case 'sources':
      return renderList(items, (item) => escapeHtml(item.source || '—'));
    case 'media':
      return renderList(items, (item) => {
        const parts = [];
        if (item.description) parts.push(escapeHtml(item.description));
        if (item.link) parts.push(`<code>${escapeHtml(item.link)}</code>`);
        return parts.join(' • ');
      });
    default:
      return renderList(items, (item) => escapeHtml(JSON.stringify(item)));
  }
}

function renderMilitary(military) {
  const chunks = [];
  if (military.military_service?.length) {
    chunks.push(`<strong>Служба</strong>${renderList(military.military_service, (item) => escapeHtml(item.service_info || '—'))}`);
  }
  if (military.war_participation?.length) {
    chunks.push(`<strong>Участие в войнах</strong>${renderList(military.war_participation, (item) => escapeHtml(item.war || '—'))}`);
  }
  if (military.awards?.length) {
    chunks.push(`<strong>Награды</strong>${renderList(military.awards, (item) => escapeHtml(item.award || '—'))}`);
  }
  return chunks.join('');
}

function renderField(key, value, dataset) {
  if (value === undefined || value === null || value === '') return '';

  if (key === 'birth' || key === 'death') {
    return renderBirthDeath(value);
  }
  if (key === 'birth_name') {
    return `<div>${escapeHtml(formatBirthName(value) || '—')}</div>`;
  }
  if (key === 'military') {
    return renderMilitary(value);
  }
  if (Array.isArray(value)) {
    return renderArrayField(key, value, dataset);
  }
  return `<div>${escapeHtml(value)}</div>`;
}

export function renderPersonDetails(personId, dataset) {
  const person = dataset.people.get(personId);
  if (!person) return null;

  const title = getDatasetPersonName(dataset, personId, personId);
  const subtitleParts = [personId];
  if (person.birth?.date) subtitleParts.push(`рожд. ${person.birth.date}`);
  if (person.death?.date) subtitleParts.push(`ум. ${person.death.date}`);

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
