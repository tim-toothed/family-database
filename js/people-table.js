import { getDatasetPersonName } from './person-name.js';
import { sortFamilyGroups } from './family-groups.js';

const PERSON_ID_NAME_RE = /^P\d{3}$/i;

const DEFAULT_ANCHOR_ID = 'P049';
const SURNAME_CLEAN_RE = /[^A-Za-zА-Яа-яЁё-]+/g;
const UNKNOWN_GENERATION_LABEL = '—';
const TABLE_SORTS = {
  GENERATION_DESC: 'generation-desc',
  GENERATION_ASC: 'generation-asc',
  ALPHABET_ASC: 'alphabet-asc',
  ALPHABET_DESC: 'alphabet-desc',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sanitizeSurname(surname) {
  return String(surname ?? '')
    .replace(SURNAME_CLEAN_RE, '')
    .trim();
}

function fallbackSurnameNormalForm(cleanedSurname) {
  const lower = cleanedSurname.toLowerCase().replaceAll('ё', 'е');
  const suffixMap = [
    ['цкая', 'цкий'],
    ['ская', 'ский'],
    ['ая', 'ый'],
    ['яя', 'ий'],
    ['ёва', 'ев'],
    ['ева', 'ев'],
    ['ова', 'ов'],
    ['ина', 'ин'],
  ];

  for (const [suffix, replacement] of suffixMap) {
    if (lower.endsWith(suffix)) {
      return `${lower.slice(0, -suffix.length)}${replacement}`;
    }
  }

  return lower;
}

function canonicalFamilyKey(personId, surname, warnings) {
  const cleaned = sanitizeSurname(surname);
  if (!cleaned) {
    warnings.push(
      `${personId}: surname ${JSON.stringify(surname)} could not be normalized, family_id will be unique.`
    );
    return `unknown:${personId}`;
  }

  const fallbackValue = fallbackSurnameNormalForm(cleaned);
  const normalizedCleaned = cleaned.toLowerCase().replaceAll('ё', 'е');
  if (/[?()]/.test(String(surname ?? '')) || fallbackValue !== normalizedCleaned) {
    warnings.push(
      `${personId}: fallback normalization used for surname ${JSON.stringify(surname)} -> ${JSON.stringify(fallbackValue)}.`
    );
  }

  return fallbackValue;
}

function buildFamilyIds(people) {
  const warnings = [];
  const familyKeyByPerson = new Map();
  const sortedIds = Array.from(people.keys()).sort();

  for (const personId of sortedIds) {
    const birthName = people.get(personId)?.birth_name || {};
    const surname = birthName.surname || '';
    familyKeyByPerson.set(personId, canonicalFamilyKey(personId, surname, warnings));
  }

  const uniqueKeys = Array.from(new Set(familyKeyByPerson.values())).sort();
  const familyIdByKey = new Map(uniqueKeys.map((key, index) => [key, index + 1]));
  const familyIdByPerson = new Map();

  for (const [personId, familyKey] of familyKeyByPerson.entries()) {
    familyIdByPerson.set(personId, familyIdByKey.get(familyKey));
  }

  return { familyIdByPerson, warnings };
}

function addHardEdge(hardEdgesByKey, people, missingRefs, src, dst, delta, kind) {
  if (!dst) return;
  if (!people.has(dst)) {
    missingRefs.add(dst);
    return;
  }

  const key = `${src}|${dst}|${delta}|${kind}`;
  if (!hardEdgesByKey.has(key)) {
    hardEdgesByKey.set(key, { src, dst, delta, kind });
  }
}

function buildRelationshipGraph(people) {
  const hardEdgesByKey = new Map();
  const softPairs = new Set();
  const missingRefs = new Set();

  for (const [personId, data] of people.entries()) {
    for (const parent of data.parents || []) {
      const other = parent?.person_id;
      addHardEdge(hardEdgesByKey, people, missingRefs, personId, other, -1, 'parent');
      addHardEdge(hardEdgesByKey, people, missingRefs, other, personId, 1, 'child');
    }

    for (const child of data.children || []) {
      const other = child?.person_id;
      addHardEdge(hardEdgesByKey, people, missingRefs, personId, other, 1, 'child');
      addHardEdge(hardEdgesByKey, people, missingRefs, other, personId, -1, 'parent');
    }

    for (const spouse of data.spouses || []) {
      const other = spouse?.person_id;
      addHardEdge(hardEdgesByKey, people, missingRefs, personId, other, 0, 'spouse');
      addHardEdge(hardEdgesByKey, people, missingRefs, other, personId, 0, 'spouse');
    }

    for (const sibling of data.siblings || []) {
      const other = sibling?.person_id;
      if (!other) continue;
      if (!people.has(other)) {
        missingRefs.add(other);
        continue;
      }

      const [left, right] = [personId, other].sort();
      softPairs.add(`${left}|${right}|sibling`);
    }
  }

  const hardGraph = new Map();
  for (const edge of hardEdgesByKey.values()) {
    if (!hardGraph.has(edge.src)) {
      hardGraph.set(edge.src, []);
    }
    hardGraph.get(edge.src).push(edge);
  }

  const softEdges = Array.from(softPairs)
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .map((value) => {
      const [left, right, kind] = value.split('|');
      return { left, right, kind };
    });

  return {
    hardGraph,
    softEdges,
    missingRefs: Array.from(missingRefs).sort(),
  };
}

function buildHardComponents(people, hardGraph) {
  const componentByPerson = new Map();
  const relativeGeneration = new Map();
  const componentMembers = new Map();
  const hardConflicts = [];
  let nextComponentId = 0;
  const sortedIds = Array.from(people.keys()).sort();

  for (const personId of sortedIds) {
    if (componentByPerson.has(personId)) continue;

    nextComponentId += 1;
    const componentId = nextComponentId;
    const queue = [personId];
    componentByPerson.set(personId, componentId);
    relativeGeneration.set(personId, 0);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!componentMembers.has(componentId)) {
        componentMembers.set(componentId, []);
      }
      componentMembers.get(componentId).push(current);

      for (const edge of hardGraph.get(current) || []) {
        const expected = relativeGeneration.get(current) + edge.delta;
        if (!componentByPerson.has(edge.dst)) {
          componentByPerson.set(edge.dst, componentId);
          relativeGeneration.set(edge.dst, expected);
          queue.push(edge.dst);
          continue;
        }

        if (componentByPerson.get(edge.dst) !== componentId) {
          hardConflicts.push(
            `${current} -> ${edge.dst}: edge crosses hard components unexpectedly`
          );
          continue;
        }

        if (relativeGeneration.get(edge.dst) !== expected) {
          hardConflicts.push(
            `${current} -> ${edge.dst}: expected generation offset ${expected}, got ${relativeGeneration.get(edge.dst)} (${edge.kind})`
          );
        }
      }
    }
  }

  return {
    componentByPerson,
    relativeGeneration,
    componentMembers,
    hardConflicts,
  };
}

function resolveComponentOffsets(anchorId, componentByPerson, relativeGeneration, softEdges) {
  if (!componentByPerson.has(anchorId)) {
    throw new Error(`Anchor person ${anchorId} was not found.`);
  }

  const warnings = [];
  const componentOffsets = new Map();
  const componentGraph = new Map();
  const anchorComponent = componentByPerson.get(anchorId);

  componentOffsets.set(anchorComponent, -relativeGeneration.get(anchorId));

  for (const edge of softEdges) {
    const leftComponent = componentByPerson.get(edge.left);
    const rightComponent = componentByPerson.get(edge.right);

    if (leftComponent === rightComponent) {
      if (relativeGeneration.get(edge.left) !== relativeGeneration.get(edge.right)) {
        warnings.push(
          `Ignored ${edge.kind} edge ${edge.left} <-> ${edge.right}: same hard component but different generations (${relativeGeneration.get(edge.left)} vs ${relativeGeneration.get(edge.right)}).`
        );
      }
      continue;
    }

    const deltaLeftToRight = relativeGeneration.get(edge.left) - relativeGeneration.get(edge.right);
    const deltaRightToLeft = -deltaLeftToRight;

    if (!componentGraph.has(leftComponent)) componentGraph.set(leftComponent, []);
    if (!componentGraph.has(rightComponent)) componentGraph.set(rightComponent, []);

    componentGraph.get(leftComponent).push({
      otherComponent: rightComponent,
      delta: deltaLeftToRight,
      edge,
    });
    componentGraph.get(rightComponent).push({
      otherComponent: leftComponent,
      delta: deltaRightToLeft,
      edge,
    });
  }

  const queue = [anchorComponent];
  while (queue.length > 0) {
    const componentId = queue.shift();
    const currentOffset = componentOffsets.get(componentId);

    for (const entry of componentGraph.get(componentId) || []) {
      const expectedOffset = currentOffset + entry.delta;
      if (!componentOffsets.has(entry.otherComponent)) {
        componentOffsets.set(entry.otherComponent, expectedOffset);
        queue.push(entry.otherComponent);
        continue;
      }

      if (componentOffsets.get(entry.otherComponent) !== expectedOffset) {
        warnings.push(
          `Conflicting ${entry.edge.kind} edge ${entry.edge.left} <-> ${entry.edge.right}: component ${entry.otherComponent} expected offset ${expectedOffset}, got ${componentOffsets.get(entry.otherComponent)}.`
        );
      }
    }
  }

  return { componentOffsets, warnings };
}

function buildGenerationIds(people, anchorId) {
  const { hardGraph, softEdges, missingRefs } = buildRelationshipGraph(people);
  const { componentByPerson, relativeGeneration, componentMembers, hardConflicts } = buildHardComponents(
    people,
    hardGraph
  );
  const { componentOffsets, warnings: softWarnings } = resolveComponentOffsets(
    anchorId,
    componentByPerson,
    relativeGeneration,
    softEdges
  );

  const generationByPerson = new Map();
  const unresolvedComponents = [];

  for (const [componentId, members] of Array.from(componentMembers.entries()).sort((a, b) => a[0] - b[0])) {
    const offset = componentOffsets.get(componentId);
    if (offset === undefined) {
      unresolvedComponents.push(
        `Component ${componentId} has no path to anchor ${anchorId}: ${members.slice().sort().join(', ')}`
      );
      for (const personId of members) {
        generationByPerson.set(personId, null);
      }
      continue;
    }

    for (const personId of members) {
      generationByPerson.set(personId, relativeGeneration.get(personId) + offset);
    }
  }

  const warnings = [];
  if (missingRefs.length > 0) {
    warnings.push(`Missing referenced people: ${missingRefs.join(', ')}`);
  }
  warnings.push(...hardConflicts, ...softWarnings, ...unresolvedComponents);

  return { generationByPerson, warnings, missingRefs };
}

function getNameTailSortBucket(row) {
  if (row.hasIdFallbackName) return 2;
  if (row.hasUnknownSurname) return 1;
  return 0;
}

function compareTrailingNameBuckets(left, right) {
  return getNameTailSortBucket(left) - getNameTailSortBucket(right);
}

function compareAlphabeticalAsc(left, right) {
  const unknownCompare = compareTrailingNameBuckets(left, right);
  if (unknownCompare !== 0) return unknownCompare;

  if (left.familyId !== right.familyId) return left.familyId - right.familyId;

  const firstNameCompare = left.firstName.localeCompare(right.firstName, 'ru');
  if (firstNameCompare !== 0) return firstNameCompare;

  const patronymicCompare = left.patronymic.localeCompare(right.patronymic, 'ru');
  if (patronymicCompare !== 0) return patronymicCompare;

  const fullNameCompare = left.fullName.localeCompare(right.fullName, 'ru');
  if (fullNameCompare !== 0) return fullNameCompare;

  return left.personId.localeCompare(right.personId, 'ru');
}

function compareAlphabeticalDesc(left, right) {
  const unknownCompare = compareTrailingNameBuckets(left, right);
  if (unknownCompare !== 0) return unknownCompare;

  if (left.familyId !== right.familyId) return right.familyId - left.familyId;

  const firstNameCompare = right.firstName.localeCompare(left.firstName, 'ru');
  if (firstNameCompare !== 0) return firstNameCompare;

  const patronymicCompare = right.patronymic.localeCompare(left.patronymic, 'ru');
  if (patronymicCompare !== 0) return patronymicCompare;

  const fullNameCompare = right.fullName.localeCompare(left.fullName, 'ru');
  if (fullNameCompare !== 0) return fullNameCompare;

  return right.personId.localeCompare(left.personId, 'ru');
}

function compareGeneration(left, right, direction) {
  const leftGeneration = left.generationId ?? Number.NEGATIVE_INFINITY;
  const rightGeneration = right.generationId ?? Number.NEGATIVE_INFINITY;
  if (leftGeneration !== rightGeneration) {
    return direction === 'asc'
      ? leftGeneration - rightGeneration
      : rightGeneration - leftGeneration;
  }

  return compareAlphabeticalAsc(left, right);
}

export function sortPeopleTableRows(rows, sortMode = TABLE_SORTS.ALPHABET_ASC) {
  const copy = rows.slice();

  if (sortMode === TABLE_SORTS.ALPHABET_ASC) {
    return copy.sort(compareAlphabeticalAsc);
  }

  if (sortMode === TABLE_SORTS.ALPHABET_DESC) {
    return copy.sort(compareAlphabeticalDesc);
  }

  if (sortMode === TABLE_SORTS.GENERATION_ASC) {
    return copy.sort((left, right) => compareGeneration(left, right, 'asc'));
  }

  return copy.sort((left, right) => compareGeneration(left, right, 'desc'));
}

function getGenerationLabel(generationId) {
  return generationId ?? UNKNOWN_GENERATION_LABEL;
}

export function buildPeopleTableData(dataset, options = {}) {
  const people = dataset?.people;
  if (!(people instanceof Map) || people.size === 0) {
    return {
      anchorId: null,
      rows: [],
      familyIdByPerson: new Map(),
      generationByPerson: new Map(),
      warnings: [],
    };
  }

  const fallbackAnchorId = people.has(DEFAULT_ANCHOR_ID)
    ? DEFAULT_ANCHOR_ID
    : Array.from(people.keys()).sort()[0];
  const anchorId = people.has(options.anchorId) ? options.anchorId : fallbackAnchorId;

  const { familyIdByPerson, warnings: familyWarnings } = buildFamilyIds(people);
  const { generationByPerson, warnings: generationWarnings } = buildGenerationIds(people, anchorId);

  const rows = Array.from(people.keys()).map((personId) => {
    const person = people.get(personId) || {};
    const birthName = person.birth_name || {};
    const fullName = getDatasetPersonName(dataset, personId, personId);

    return {
      personId,
      familyId: familyIdByPerson.get(personId),
      generationId: generationByPerson.get(personId) ?? null,
      fullName,
      hasUnknownSurname: String(birthName.surname || '').trim().startsWith('???'),
      hasIdFallbackName: PERSON_ID_NAME_RE.test(String(fullName).trim()),
      firstName: String(birthName.first_name || ''),
      patronymic: String(birthName.patronymic || ''),
    };
  });

  return {
    anchorId,
    rows,
    familyIdByPerson,
    generationByPerson,
    warnings: [...familyWarnings, ...generationWarnings],
  };
}

export function renderPeopleTable(container, dataset, tableData, options = {}) {
  if (!container) return;

  const sortMode = options.sortMode || TABLE_SORTS.ALPHABET_ASC;
  const selectedPersonId = options.selectedPersonId || null;
  const groupByFamily = options.groupByFamily !== false;
  const familyGroups = options.familyGroups || dataset.familyGroups || { groups: [] };
  const knownGenerations = (groupByFamily ? familyGroups.groups : tableData.rows)
    .map((item) => item.generationId)
    .filter((value) => value !== null);
  const generationRange = knownGenerations.length > 0
    ? `${Math.min(...knownGenerations)}…${Math.max(...knownGenerations)}`
    : UNKNOWN_GENERATION_LABEL;
  const sortedGroups = sortFamilyGroups(familyGroups.groups, sortMode);
  const sortedRows = sortPeopleTableRows(tableData.rows, sortMode);
  const familyGroupCount = familyGroups.groups.filter((group) => group.kind === 'family').length;
  const renderedRowCount = familyGroups.groups.reduce((sum, group) => sum + group.members.length, 0);

  container.innerHTML = `
    <div class="people-table-toolbar">
      <div class="people-table-summary">
        <div>Людей: <strong>${tableData.rows.length}</strong></div>
        ${groupByFamily ? `<div>Семей: <strong>${familyGroupCount}</strong></div>` : ''}
        ${groupByFamily ? `<div>Строк в таблице: <strong>${renderedRowCount}</strong></div>` : ''}
        <div>Диапазон поколений: <strong>${escapeHtml(generationRange)}</strong></div>
      </div>
      <div class="people-table-controls">
        <label class="people-table-group-toggle">
          <input type="checkbox" id="familyGroupingToggle"${groupByFamily ? ' checked' : ''} />
          <span>Группировать по семье</span>
        </label>
        <details class="people-table-sort-menu">
          <summary class="people-table-sort-trigger" aria-label="Сортировка таблицы" title="Сортировка">
            ⇅
          </summary>
          <div class="people-table-sort-popup" role="group" aria-label="Сортировка таблицы">
            <button
              type="button"
              class="people-table-sort-button${sortMode === TABLE_SORTS.GENERATION_DESC ? ' is-active' : ''}"
              data-sort-mode="${TABLE_SORTS.GENERATION_DESC}"
            >
              <span>Поколения</span>
              <span class="sort-arrow sort-arrow-desc">↓</span>
            </button>
            <button
              type="button"
              class="people-table-sort-button${sortMode === TABLE_SORTS.GENERATION_ASC ? ' is-active' : ''}"
              data-sort-mode="${TABLE_SORTS.GENERATION_ASC}"
            >
              <span>Поколения</span>
              <span class="sort-arrow sort-arrow-asc">↑</span>
            </button>
            <button
              type="button"
              class="people-table-sort-button${sortMode === TABLE_SORTS.ALPHABET_ASC ? ' is-active' : ''}"
              data-sort-mode="${TABLE_SORTS.ALPHABET_ASC}"
            >
              <span>Алфавит</span>
              <span class="sort-arrow sort-arrow-asc">↑</span>
            </button>
            <button
              type="button"
              class="people-table-sort-button${sortMode === TABLE_SORTS.ALPHABET_DESC ? ' is-active' : ''}"
              data-sort-mode="${TABLE_SORTS.ALPHABET_DESC}"
            >
              <span>Алфавит</span>
              <span class="sort-arrow sort-arrow-desc">↓</span>
            </button>
          </div>
        </details>
      </div>
    </div>
    ${groupByFamily ? `
      <div class="family-groups">
        ${sortedGroups.map((group) => `
          <section
            class="family-group family-group-${escapeHtml(group.kind)}"
            style="--group-color: ${escapeHtml(group.color)}; --group-soft: ${escapeHtml(group.softColor)};"
          >
            <div class="family-group-header">
              <div class="family-group-title">${escapeHtml(group.title)}</div>
              <div class="family-group-meta">
                ${group.kind === 'family'
                  ? `Поколение ${escapeHtml(getGenerationLabel(group.generationId))} • ${group.childIds.length} детей`
                  : `${group.members.length} человек`}
              </div>
            </div>
            <table class="people-table-grid family-group-grid">
              <thead>
                <tr>
                  <th scope="col">Поколение</th>
                  <th scope="col">Полное имя</th>
                </tr>
              </thead>
              <tbody>
                ${group.members.map((member) => `
                  <tr
                    class="people-table-row${member.personId === selectedPersonId ? ' is-selected' : ''}"
                    data-person-id="${escapeHtml(member.personId)}"
                    tabindex="0"
                  >
                    <td class="people-table-generation">${escapeHtml(getGenerationLabel(member.generationId))}</td>
                    <td class="people-table-name-cell">
                      <div class="people-table-name">
                        ${escapeHtml(member.fullName)}
                        ${member.roleLabel ? `<span class="badge family-role-badge role-${escapeHtml(member.roleTone)}">${escapeHtml(member.roleLabel)}</span>` : ''}
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </section>
        `).join('')}
      </div>
    ` : `
      <table class="people-table-grid">
        <thead>
          <tr>
            <th scope="col">Поколение</th>
            <th scope="col">Полное имя</th>
          </tr>
        </thead>
        <tbody>
          ${sortedRows.map((row) => `
            <tr
              class="people-table-row${row.personId === selectedPersonId ? ' is-selected' : ''}"
              data-person-id="${escapeHtml(row.personId)}"
              tabindex="0"
            >
              <td class="people-table-generation">${escapeHtml(getGenerationLabel(row.generationId))}</td>
              <td class="people-table-name-cell">
                <div class="people-table-name">${escapeHtml(row.fullName)}</div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  `;

  const groupingToggle = container.querySelector('#familyGroupingToggle');
  groupingToggle?.addEventListener('change', () => {
    options.onGroupingChange?.(groupingToggle.checked);
  });

  container.querySelectorAll('[data-person-id]').forEach((row) => {
    const activate = () => {
      options.onSelect?.(row.dataset.personId);
    };

    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });

  container.querySelectorAll('[data-sort-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      options.onSortChange?.(button.dataset.sortMode);
      button.closest('details')?.removeAttribute('open');
    });
  });
}

export function setPeopleTableSelection(container, personId) {
  if (!container) return;

  container.querySelectorAll('.people-table-row.is-selected').forEach((row) => {
    row.classList.remove('is-selected');
  });

  if (!personId) return;

  container.querySelectorAll(`.people-table-row[data-person-id="${CSS.escape(personId)}"]`).forEach((row) => {
    row.classList.add('is-selected');
  });
}

export { TABLE_SORTS };
