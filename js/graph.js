import { getDatasetPersonName } from './person-name.js';

const EDGE_COLORS = {
  parent: '#94a3b8',
  sibling: '#22c55e',
  spouse: '#ef4444',
  neutral: '#94a3b8',
  placeholder: '#cbd5e1',
  male: '#2f6fed',
  female: '#ec4899',
};

const NODE = {
  width: 196,
  height: 92,
  baseFontSize: 16,
  minFontSize: 11,
  lineLength: 18,
};

const LAYOUT = {
  mainGenerationGapY: 220,
  mainPairGapX: 72,
  mainBranchGapX: 54,
  edgeJoinOffsetY: 92,
  focusParentGapX: 260,
  focusChildGapX: 260,
  focusSideGapX: 270,
  focusLevelGapY: 220,
};

const MAIN_LAYOUT = {
  nodeSpanColumns: 1,
  columnWidth: NODE.width + 32,
  pairGapColumns: LAYOUT.mainPairGapX / NODE.width,
  branchGapColumns: LAYOUT.mainBranchGapX / NODE.width,
};

const INSPECT_LAYOUT = {
  siblingStepColumns: 1,
  spouseStepColumns: 2,
  childStepColumns: 1,
  familyGapColumns: 1,
  mainSpouseClearanceColumns: 1,
};

// Normalizes text for case-insensitive relation checks.
function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Maps stored sex values to the labels used in the graph.
function getSexLabel(sex) {
  const s = normalizeText(sex);
  return s;
}

// Returns the accent color used for a person's node and parent edges.
function getPersonAccentColor(dataset, personId) {
  if (String(personId).startsWith('unknown:')) return EDGE_COLORS.placeholder;

  const sex = getSexLabel(dataset.people.get(personId)?.sex);
  if (sex === 'ж') return EDGE_COLORS.female;
  if (sex === 'м') return EDGE_COLORS.male;
  return EDGE_COLORS.parent;
}

// Detects whether a relation label describes adoption.
function isAdoptiveRelation(label) {
  const key = normalizeText(label);
  return key.includes('прием') || key.includes('приём') || key.includes('усынов');
}

// Detects whether a relation label describes a step relation.
function isStepRelation(label) {
  const key = normalizeText(label);
  return key.includes('мачех') || key.includes('отчим') || key.includes('свод');
}

// Detects whether a relation label describes a biological parent.
function isBiologicalParentRelation(label) {
  const key = normalizeText(label);
  return key === 'отец' || key === 'мать' || key === 'родитель';
}

// Assigns a priority score so parent relations can be ranked.
function relationPriority(label) {
  const key = normalizeText(label);
  if (key === 'мать' || key === 'отец') return 100;
  if (key === 'приёмная мать' || key === 'приемная мать' || key === 'приёмный отец' || key === 'приемный отец') return 90;
  if (key === 'родитель') return 70;
  if (key === 'мачеха' || key === 'отчим') return 40;
  return 10;
}

// Extracts a person's birth year for sorting.
function birthYear(person) {
  const value = person?.birth?.date || '';
  const m = value.match(/(\d{4})$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Sorts people by birth year and then by display name.
function comparePeopleIds(dataset, a, b) {
  const pa = dataset.people.get(a);
  const pb = dataset.people.get(b);

  const ya = birthYear(pa);
  const yb = birthYear(pb);
  if (ya !== yb) return ya - yb;

  const na = getDatasetPersonName(dataset, a, a);
  const nb = getDatasetPersonName(dataset, b, b);
  return na.localeCompare(nb, 'ru');
}

// Sorts parent entries with mothers first and then by person order.
function compareParents(dataset, left, right) {
  const order = (item) => {
    const rel = normalizeText(item.relation_type);
    if (rel.includes('мать')) return 0;
    if (rel.includes('отец')) return 1;
    return 2;
  };

  const byType = order(left) - order(right);
  if (byType !== 0) return byType;
  return comparePeopleIds(dataset, left.person_id, right.person_id);
}

// Returns the display name for a person or placeholder node.
function personName(dataset, personId) {
  if (String(personId).startsWith('unknown:')) return 'Неизвестно';
  return getDatasetPersonName(dataset, personId, personId);
}

// Wraps long names into multiple lines for node labels.
function wrapText(value, maxLineLength = NODE.lineLength) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Без имени';

  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (`${current} ${word}`.length <= maxLineLength) {
      current += ` ${word}`;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines.slice(0, 4).join('\n');
}

// Chooses a readable font size based on the longest word.
function computeFontSize(label) {
  const maxWord = Math.max(...String(label).split(/\s+/).map((part) => part.length), 1);
  if (maxWord >= 18) return NODE.minFontSize;
  if (maxWord >= 14) return 12;
  if (maxWord >= 10) return 14;
  return NODE.baseFontSize;
}

// Pulls a four-digit year from a date-like value.
function extractYear(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/(\d{4})/);
  return match ? match[1] : null;
}

// Formats the birth and death years shown under a name.
function getLifeYears(person) {
  if (!person) return '';

  const birthDate = person?.birth?.date;
  const deathDate = person?.death?.date;

  const birthYear = extractYear(birthDate);

  // жив: death.date === null
  if (deathDate === null) {
    return birthYear ?? '';
  }

  const deathYear = extractYear(deathDate);
  if (!birthYear && !deathYear) return '';
  if (birthYear && deathYear) return `${birthYear}-${deathYear}`;
  if (birthYear) return birthYear;
  if (deathYear) return deathYear;
  return '';
}

// Builds a vis-network node for a real person or placeholder.
function makePersonNode(dataset, id, x, y, options = {}) {
  const isPlaceholder = options.isPlaceholder || String(id).startsWith('unknown:');
  const name = isPlaceholder ? 'Неизвестно' : personName(dataset, id);
  const person = isPlaceholder ? null : dataset.people.get(id);
  const subtitle = options.hideSubtitle || isPlaceholder ? '' : getLifeYears(person);
  const wrapped = wrapText(name);
  const label = subtitle ? `${wrapped}\n${subtitle}` : wrapped;
  const fontSize = computeFontSize(name);

  const sex = getSexLabel(person?.sex);

  // 👇 добавляем выбор цвета
  const genderColor = (() => {
    if (sex === 'ж') {
      return { background: '#ffffff', border: EDGE_COLORS.female }; // розовый
    }
    if (sex === 'м') {
      return { background: '#ffffff', border: EDGE_COLORS.male }; // синий (как сейчас)
    }
    return { background: '#ffffff', border: EDGE_COLORS.male }; // fallback
  })();

  return {
    id,
    label,
    title: `${name}${subtitle ? `\n${subtitle}` : ''}`,
    shape: 'box',
    x,
    y,
    physics: false,
    fixed: true,
    widthConstraint: { minimum: NODE.width, maximum: NODE.width },
    heightConstraint: { minimum: NODE.height, maximum: NODE.height },
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
    borderWidth: options.borderWidth ?? 1.6,

    color: options.color || (isPlaceholder
      ? { background: '#f8fafc', border: '#94a3b8' }
      : genderColor
    ),

    font: {
      face: 'Inter, system-ui, sans-serif',
      size: fontSize,
      multi: false,
      vadjust: -2,
      color: isPlaceholder ? '#64748b' : '#334155',
    },
    shapeProperties: { borderDashes: isPlaceholder ? [6, 4] : false, borderRadius: 12 },
    chosen: {
      node(values) {
        if (!isPlaceholder) values.borderWidth = 2.4;
      },
    },
  };
}

// Creates a tiny hidden helper node used to route edges.
function makeJunctionNode(id, x, y) {
  return {
    id,
    label: '',
    x,
    y,
    physics: false,
    fixed: true,
    shape: 'square',
    size: 1,
    color: {
      background: '#94a3b8',
      border: '#94a3b8',
      highlight: '#94a3b8',
      hover: '#94a3b8',
    },
    borderWidth: 0,
  };
}

// Generates a stable edge id from connection details.
function edgeId(prefix, from, to, relation = '') {
  return `${prefix}:${from}:${to}:${relation}`;
}

// Creates an unlabeled edge for the main ancestor tree.
function makeMainEdge(from, to, options = {}) {
  return {
    id: edgeId('main', from, to, options.relation || ''),
    from,
    to,
    color: options.color || EDGE_COLORS.parent,
    width: options.width ?? 2,
    dashes: Boolean(options.dashes),
    arrows: '',
    smooth: false,
    selectionWidth: 0,
  };
}

// Creates a labeled edge for the focused relationship view.
function makeFocusedEdge(from, to, label, options = {}) {
  return {
    id: edgeId('focus', from, to, label),
    from,
    to,
    label,
    arrows: options.arrows ?? '',
    color: options.color || EDGE_COLORS.neutral,
    width: options.width ?? 2,
    dashes: Boolean(options.dashes),
    font: { align: 'middle', size: 12, strokeWidth: 3, strokeColor: '#ffffff' },
    smooth: false,
  };
}

// Removes duplicate or invalid relation entries by person id.
function uniqueByPersonId(list) {
  const seen = new Set();
  const result = [];
  for (const item of list || []) {
    if (!item?.person_id || item.person_id === '???' || seen.has(item.person_id)) continue;
    seen.add(item.person_id);
    result.push(item);
  }
  return result;
}

// Selects the best parent pair to display for a person.
function pickPrimaryParents(person, dataset) {
  const allParents = uniqueByPersonId(person?.parents || []);
  if (!allParents.length) return [];

  const adoptive = allParents.filter((item) => isAdoptiveRelation(item.relation_type));
  if (adoptive.length >= 2) {
    return adoptive.sort((a, b) => compareParents(dataset, a, b)).slice(0, 2);
  }

  const biological = allParents.filter((item) => isBiologicalParentRelation(item.relation_type));
  if (biological.length >= 2) {
    return biological.sort((a, b) => compareParents(dataset, a, b)).slice(0, 2);
  }

  const fallback = allParents
    .filter((item) => !isStepRelation(item.relation_type))
    .sort((a, b) => relationPriority(b.relation_type) - relationPriority(a.relation_type) || compareParents(dataset, a, b));

  return fallback.slice(0, 2);
}

// Returns up to two ordered parents for the given person.
function getKnownParentPair(dataset, personId) {
  const person = dataset.people.get(personId);
  const parents = pickPrimaryParents(person, dataset).sort((a, b) => compareParents(dataset, a, b));
  const mother = parents.find((item) => normalizeText(item.relation_type).includes('мать')) || parents[0] || null;
  const father = parents.find((item) => normalizeText(item.relation_type).includes('отец')) || parents.find((item) => item !== mother) || null;

  const pair = [];
  if (mother) pair.push(mother);
  if (father && father !== mother) pair.push(father);

  for (const item of parents) {
    if (pair.length >= 2) break;
    if (!pair.includes(item)) pair.push(item);
  }

  return pair.slice(0, 2);
}

// Calculates how many ancestor levels can be shown from the root.
function computeKnownDepth(dataset, rootId) {
  const memo = new Map();

  // Recursively measures ancestor depth with memoization.
  function walk(personId) {
    if (!personId || String(personId).startsWith('unknown:')) return 0;
    if (memo.has(personId)) return memo.get(personId);

    const parents = getKnownParentPair(dataset, personId);
    if (!parents.length) {
      memo.set(personId, 0);
      return 0;
    }

    const depth = 1 + Math.max(...parents.map((item) => walk(item.person_id)));
    memo.set(personId, depth);
    return depth;
  }

  return walk(rootId);
}

// Builds a recursive ancestor structure used for main layout.
function buildAncestorSkeleton(dataset, personId, depth, maxDepth, side = 'root') {
  const node = {
    id: personId,
    depth,
    side,
    isPlaceholder: String(personId).startsWith('unknown:'),
    parents: [],
  };

  if (depth >= maxDepth || node.isPlaceholder) {
    return node;
  }

  const known = getKnownParentPair(dataset, personId);
  const pair = [];

  if (known.length >= 2) {
    pair.push(known[0], known[1]);
  } else if (known.length === 1) {
    const rel = normalizeText(known[0].relation_type);
    if (rel.includes('ма')) {
      pair.push(known[0], { person_id: `unknown:${personId}:${depth + 1}:father`, relation_type: 'отец' });
    } else if (rel.includes('от')) {
      pair.push({ person_id: `unknown:${personId}:${depth + 1}:mother`, relation_type: 'мать' }, known[0]);
    } else {
      pair.push(known[0], { person_id: `unknown:${personId}:${depth + 1}:parent`, relation_type: 'родитель' });
    }
  } else {
    return node;
  }

  node.parents = pair.map((item, index) => buildAncestorSkeleton(dataset, item.person_id, depth + 1, maxDepth, index === 0 ? 'left' : 'right'));
  return node;
}

// Converts a logical main-tree column into an x coordinate in pixels.
function mainColumnToX(column) {
  return Math.round(column * MAIN_LAYOUT.columnWidth);
}

// Converts an ancestor depth into the fixed y coordinate for that generation.
function mainDepthToY(depth) {
  return -depth * LAYOUT.mainGenerationGapY;
}

// Measures how many logical columns an ancestor subtree needs.
function measureMainSubtree(node, measurements) {
  if (measurements.has(node.id)) return measurements.get(node.id);

  let span = MAIN_LAYOUT.nodeSpanColumns;

  if (node.parents?.length) {
    const leftSpan = measureMainSubtree(node.parents[0], measurements).span;
    const rightSpan = measureMainSubtree(node.parents[1], measurements).span;
    const pairSpan = (MAIN_LAYOUT.nodeSpanColumns * 2) + MAIN_LAYOUT.pairGapColumns;
    const branchSpan = leftSpan + MAIN_LAYOUT.branchGapColumns + rightSpan;

    span = Math.max(MAIN_LAYOUT.nodeSpanColumns, pairSpan, branchSpan);
  }

  const measurement = { span };
  measurements.set(node.id, measurement);
  return measurement;
}

// Assigns logical columns to each node in the main ancestor tree.
function assignMainColumns(node, column, measurements, positions) {
  positions.set(node.id, {
    column,
    depth: node.depth,
    isPlaceholder: node.isPlaceholder,
  });

  if (!node.parents?.length) return measurements.get(node.id).span;

  const leftSpan = measurements.get(node.parents[0].id).span;
  const rightSpan = measurements.get(node.parents[1].id).span;

  // 1) Сначала ставим родителей строго симметрично над ребёнком
  const pairOffset = (MAIN_LAYOUT.nodeSpanColumns + MAIN_LAYOUT.pairGapColumns) / 2;
  let leftColumn = column - pairOffset;
  let rightColumn = column + pairOffset;

  // 2) Потом, если поддеревья слишком широкие и начнут пересекаться,
  //    симметрично раздвигаем обе ветки
  const minCenterDistance = (leftSpan / 2) + (rightSpan / 2) + MAIN_LAYOUT.branchGapColumns;
  const currentCenterDistance = rightColumn - leftColumn;

  if (currentCenterDistance < minCenterDistance) {
    const extra = (minCenterDistance - currentCenterDistance) / 2;
    leftColumn -= extra;
    rightColumn += extra;
  }

  assignMainColumns(node.parents[0], leftColumn, measurements, positions);
  assignMainColumns(node.parents[1], rightColumn, measurements, positions);

  return Math.max(MAIN_LAYOUT.nodeSpanColumns, (rightColumn - leftColumn) + leftSpan / 2 + rightSpan / 2);
}

// Builds a lookup from every ancestor node to the child that leads back to the root.
function buildPathChildMap(node, childByAncestor = new Map()) {
  for (const parent of node.parents || []) {
    childByAncestor.set(parent.id, node.id);
    buildPathChildMap(parent, childByAncestor);
  }

  return childByAncestor;
}

// Returns all known parent ids for a person.
function getParentIds(dataset, personId) {
  return uniqueByPersonId(dataset.people.get(personId)?.parents || [])
    .map((item) => item.person_id)
    .filter(Boolean);
}

// Finds the other parent of a child relative to the focused person.
function getCoParentId(dataset, personId, childId) {
  const parents = getParentIds(dataset, childId);
  return parents.find((parentId) => parentId !== personId) || null;
}

// Returns ids of parents shared by two people.
function getSharedParentIds(dataset, leftPersonId, rightPersonId) {
  const leftParents = new Set(getParentIds(dataset, leftPersonId));
  return getParentIds(dataset, rightPersonId).filter((parentId) => leftParents.has(parentId));
}

// Groups a person's non-path children by their co-parent.
function groupChildrenByCoParent(dataset, focusNodeId, excludedChildId = null) {
  const person = dataset.people.get(focusNodeId);
  const children = uniqueByPersonId(person?.children || [])
    .sort((a, b) => comparePeopleIds(dataset, a.person_id, b.person_id))
    .filter((item) => item.person_id !== excludedChildId);

  const groups = new Map();
  for (const child of children) {
    const coParentId = getCoParentId(dataset, focusNodeId, child.person_id) || 'unknown';
    if (!groups.has(coParentId)) groups.set(coParentId, []);
    groups.get(coParentId).push(child);
  }

  return groups;
}

// Adds a person node once and caches its logical grid position.
function ensurePersonNode(dataset, nodes, nodeIds, positions, personId, column, depth, options = {}) {
  if (nodeIds.has(personId)) return;

  positions.set(personId, {
    column,
    depth,
    isPlaceholder: Boolean(options.isPlaceholder || String(personId).startsWith('unknown:')),
  });

  nodes.push(makePersonNode(
    dataset,
    personId,
    mainColumnToX(column),
    mainDepthToY(depth),
    options
  ));
  nodeIds.add(personId);
}

// Adds a routing node once and caches its logical grid position.
function ensureJunctionNode(nodes, junctionIds, positions, junctionId, column, depth) {
  if (junctionIds.has(junctionId)) return;

  positions.set(junctionId, { column, depth, isPlaceholder: false });
  nodes.push(makeJunctionNode(junctionId, mainColumnToX(column), mainDepthToY(depth)));
  junctionIds.add(junctionId);
}

// Adds an edge only once.
function ensureEdge(edges, edgeIds, edge) {
  if (edgeIds.has(edge.id)) return;
  edges.push(edge);
  edgeIds.add(edge.id);
}

// Moves all visible nodes on one side of the focus row and above.
function shiftSidePositions(positions, focusColumn, focusDepth, direction, delta) {
  if (!delta) return;

  for (const pos of positions.values()) {
    if (pos.depth < focusDepth) continue;
    if (direction < 0 && pos.column < focusColumn) {
      pos.column += delta;
    }
    if (direction > 0 && pos.column > focusColumn) {
      pos.column += delta;
    }
  }
}

// Converts a logical column into an integer occupancy key.
function occupancyColumnKey(column) {
  return Math.round(column * 2);
}

// Computes the minimal side shift needed to clear same-row occupancy collisions.
function computeSideShiftDelta(existingColumns, inspectColumns, direction) {
  if (!existingColumns.length || !inspectColumns.length) return 0;

  const minGapColumns = MAIN_LAYOUT.nodeSpanColumns;
  const epsilon = 1e-6;
  const step = direction < 0 ? -1 : 1;
  let delta = 0;

  while (existingColumns.some((column) => (
    inspectColumns.some((inspectColumn) => Math.abs((column + delta) - inspectColumn) < (minGapColumns - epsilon))
  ))) {
    delta += step;
  }

  return delta;
}

// Returns evenly spaced columns for a row centered on the given anchor.
function buildCenteredRowColumns(centerColumn, count, stepColumns) {
  if (!count) return [];

  const startColumn = centerColumn - (((count - 1) * stepColumns) / 2);
  return Array.from({ length: count }, (_, index) => startColumn + (index * stepColumns));
}

// Highlights the inspected person while preserving their gender color.
function emphasizeFocusNode(dataset, nodes, focusNodeId) {
  const node = nodes.find((item) => item.id === focusNodeId);
  if (!node) return;

  const accentColor = getPersonAccentColor(dataset, focusNodeId);
  node.borderWidth = Math.max(node.borderWidth || 0, 3);
  node.color = {
    ...(typeof node.color === 'object' ? node.color : {}),
    border: accentColor,
  };
  node.shadow = {
    enabled: true,
    color: `${accentColor}44`,
    size: 16,
    x: 0,
    y: 0,
  };
}

// Creates the orthogonal parent-child edges used by the main tree and inspect children.
function connectParentsToChild(dataset, graphState, parentIds, childId, relationPrefix) {
  const {
    nodes,
    edges,
    junctionIds,
    edgeIds,
    positions,
  } = graphState;

  if (!positions.has(childId) || !parentIds.length) return;

  const childPos = positions.get(childId);
  const joinDepth = childPos.depth + (LAYOUT.edgeJoinOffsetY / LAYOUT.mainGenerationGapY);
  const mergeId = `junction:${relationPrefix}:merge:${childId}`;

  ensureJunctionNode(nodes, junctionIds, positions, mergeId, childPos.column, joinDepth);
  ensureEdge(edges, edgeIds, makeMainEdge(mergeId, childId, {
    color: EDGE_COLORS.parent,
    relation: `${relationPrefix}:merge-drop`,
  }));

  for (const parentId of parentIds) {
    if (!positions.has(parentId)) continue;

    const parentPos = positions.get(parentId);
    const accentColor = getPersonAccentColor(dataset, parentId);
    const elbowId = `junction:${relationPrefix}:parent:${childId}:${parentId}`;

    ensureJunctionNode(nodes, junctionIds, positions, elbowId, parentPos.column, joinDepth);
    ensureEdge(edges, edgeIds, makeMainEdge(parentId, elbowId, {
      color: accentColor,
      relation: `${relationPrefix}:parent-drop`,
    }));
    ensureEdge(edges, edgeIds, makeMainEdge(elbowId, mergeId, {
      color: accentColor,
      relation: `${relationPrefix}:parent-merge`,
    }));
  }
}

// Renders the fixed ancestor backbone of the main tree.
function renderMainConnections(node, dataset, graphState) {
  if (!node.parents?.length) return;

  connectParentsToChild(
    dataset,
    graphState,
    node.parents.map((parent) => parent.id),
    node.id,
    `main:${node.id}`
  );

  renderMainConnections(node.parents[0], dataset, graphState);
  renderMainConnections(node.parents[1], dataset, graphState);
}

// Plans inspect placements on the fixed grid before rendering any new nodes.
function buildInspectPlan(dataset, focusNodeId, positions, childByAncestor) {
  if (!focusNodeId || !positions.has(focusNodeId)) return null;

  const person = dataset.people.get(focusNodeId);
  if (!person) return null;

  const focusPos = positions.get(focusNodeId);
  const focusColumn = focusPos.column;
  const focusDepth = focusPos.depth;
  const focusChildId = childByAncestor.get(focusNodeId) || null;
  const mainSpouseId = focusChildId ? getCoParentId(dataset, focusNodeId, focusChildId) : null;
  const sex = getSexLabel(person.sex);
  const spouseDirection = sex === 'ж' ? 1 : -1;
  const siblingDirection = spouseDirection * -1;

  const siblings = uniqueByPersonId(person.siblings || [])
    .sort((a, b) => (
      getSharedParentIds(dataset, focusNodeId, b.person_id).length
      - getSharedParentIds(dataset, focusNodeId, a.person_id).length
    ) || comparePeopleIds(dataset, a.person_id, b.person_id));
  const siblingEntries = siblings.map((item, index) => ({
    personId: item.person_id,
    column: focusColumn + (siblingDirection * INSPECT_LAYOUT.siblingStepColumns * (index + 1)),
  }));
  const siblingColumns = [focusColumn, ...siblingEntries.map((entry) => entry.column)];
  const siblingCenter = siblingColumns.length > 1
    ? (Math.min(...siblingColumns) + Math.max(...siblingColumns)) / 2
    : focusColumn;

  const childrenByCoParent = groupChildrenByCoParent(dataset, focusNodeId, focusChildId);
  const spouses = uniqueByPersonId(person.spouses || [])
    .sort((a, b) => comparePeopleIds(dataset, a.person_id, b.person_id));
  const spouseIds = new Set(spouses.map((item) => item.person_id));
  const spouseOrder = spouses
    .map((item) => item.person_id)
    .filter((personId) => personId !== mainSpouseId);

  for (const [coParentId] of childrenByCoParent.entries()) {
    if (coParentId === 'unknown' || coParentId === mainSpouseId) continue;
    if (spouseIds.has(coParentId)) continue;
    if (!dataset.people.has(coParentId)) continue;
    spouseOrder.push(coParentId);
  }

  const soloChildIds = (childrenByCoParent.get('unknown') || [])
    .map((item) => item.person_id);

  const mainSharedChildIds = mainSpouseId
    ? uniqueByPersonId(person.children || [])
      .filter((item) => getCoParentId(dataset, focusNodeId, item.person_id) === mainSpouseId)
      .map((item) => item.person_id)
    : [];
  const mainChildAnchorColumn = focusChildId && positions.has(focusChildId)
    ? positions.get(focusChildId).column
    : (mainSpouseId && positions.has(mainSpouseId)
      ? (focusColumn + positions.get(mainSpouseId).column) / 2
      : focusColumn);
  const mainChildColumns = buildCenteredRowColumns(
    mainChildAnchorColumn,
    mainSharedChildIds.length,
    INSPECT_LAYOUT.childStepColumns
  );
  const mainChildEntries = mainSharedChildIds.map((childId, index) => ({
    childId,
    column: mainChildColumns[index],
    isExisting: childId === focusChildId && positions.has(childId),
  }));
  const mainExtraChildEntries = mainChildEntries.filter((entry) => !entry.isExisting);

  const mainFamilySideColumns = [];
  if (mainSpouseId && positions.has(mainSpouseId)) {
    mainFamilySideColumns.push(positions.get(mainSpouseId).column);
  }
  mainFamilySideColumns.push(...mainChildEntries.map((entry) => entry.column));

  const mainFamilyBoundaryColumn = mainFamilySideColumns.length
    ? (spouseDirection < 0 ? Math.min(...mainFamilySideColumns) : Math.max(...mainFamilySideColumns))
    : null;

  let spouseCursor = mainFamilyBoundaryColumn != null
    ? mainFamilyBoundaryColumn + (spouseDirection * INSPECT_LAYOUT.mainSpouseClearanceColumns)
    : focusColumn + (spouseDirection * INSPECT_LAYOUT.spouseStepColumns);
  const spouseEntries = [];

  for (const spouseId of spouseOrder) {
    const childIds = (childrenByCoParent.get(spouseId) || [])
      .map((item) => item.person_id);
    const spouseColumn = spouseCursor;
    const childColumns = childIds.map((childId, index) => (
      spouseColumn + (spouseDirection * INSPECT_LAYOUT.childStepColumns * index)
    ));

    spouseEntries.push({
      spouseId,
      spouseColumn,
      childIds,
      childColumns,
    });

    const occupiedWidth = Math.max(1, childIds.length);
    spouseCursor = spouseColumn + (spouseDirection * (occupiedWidth + INSPECT_LAYOUT.familyGapColumns));
  }

  const sameRowMainNodes = Array.from(positions.entries())
    .filter(([personId, pos]) => (
      !String(personId).startsWith('junction:')
      && pos.depth === focusDepth
      && personId !== focusNodeId
    ));

  const leftInspectColumns = [...siblingEntries, ...spouseEntries]
    .map((entry) => entry.column ?? entry.spouseColumn)
    .filter((column) => column < focusColumn);
  const rightInspectColumns = [...siblingEntries, ...spouseEntries]
    .map((entry) => entry.column ?? entry.spouseColumn)
    .filter((column) => column > focusColumn);
  const sameRowMainColumns = sameRowMainNodes.map(([, pos]) => pos.column);
  const leftBlockingColumns = sameRowMainColumns.filter((column) => column < focusColumn);
  const rightBlockingColumns = sameRowMainColumns.filter((column) => column > focusColumn);
  const leftSideShiftDelta = computeSideShiftDelta(leftBlockingColumns, leftInspectColumns, -1);
  const rightSideShiftDelta = computeSideShiftDelta(rightBlockingColumns, rightInspectColumns, 1);

  return {
    focusNodeId,
    focusColumn,
    focusDepth,
    focusChildId,
    mainSpouseId,
    siblingEntries,
    spouseEntries,
    soloChildIds,
    mainChildEntries,
    mainExtraChildEntries,
    siblingDirection,
    spouseDirection,
    leftSideShiftDelta,
    rightSideShiftDelta,
  };
}

// Applies the row and subtree shifts required by the inspect expansion.
function applyInspectPlan(plan, positions) {
  if (!plan) return;

  shiftSidePositions(positions, plan.focusColumn, plan.focusDepth, -1, plan.leftSideShiftDelta);
  shiftSidePositions(positions, plan.focusColumn, plan.focusDepth, 1, plan.rightSideShiftDelta);

  for (const entry of plan.mainChildEntries || []) {
    if (!positions.has(entry.childId)) continue;

    const pos = positions.get(entry.childId);
    pos.column = entry.column;
    pos.depth = plan.focusDepth - 1;
  }
}

// Draws a dashed horizontal chain through nodes on the same row.
function connectHorizontalChain(edges, edgeIds, nodeIds, relationPrefix, color) {
  if (nodeIds.length < 2) return;

  for (let index = 1; index < nodeIds.length; index += 1) {
    ensureEdge(edges, edgeIds, makeMainEdge(nodeIds[index - 1], nodeIds[index], {
      color,
      relation: `${relationPrefix}:${index}`,
      dashes: true,
      width: 2.2,
    }));
  }
}

// Renders inspect siblings, spouses and children on the fixed grid.
function renderInspectOverlay(dataset, plan, graphState) {
  if (!plan) return;

  const {
    nodes,
    edges,
    nodeIds,
    edgeIds,
    positions,
  } = graphState;

  emphasizeFocusNode(dataset, nodes, plan.focusNodeId);

  for (const entry of plan.siblingEntries) {
    ensurePersonNode(dataset, nodes, nodeIds, positions, entry.personId, entry.column, plan.focusDepth);
  }

  for (const entry of plan.spouseEntries) {
    ensurePersonNode(dataset, nodes, nodeIds, positions, entry.spouseId, entry.spouseColumn, plan.focusDepth);
  }

  const siblingChainIds = [plan.focusNodeId, ...plan.siblingEntries.map((entry) => entry.personId)]
    .filter((personId) => positions.has(personId))
    .sort((leftId, rightId) => positions.get(leftId).column - positions.get(rightId).column);
  connectHorizontalChain(edges, edgeIds, siblingChainIds, `inspect-siblings:${plan.focusNodeId}`, EDGE_COLORS.sibling);

  const spouseChainIds = [
    ...plan.spouseEntries.map((entry) => entry.spouseId),
    plan.focusNodeId,
    ...(plan.mainSpouseId && positions.has(plan.mainSpouseId) ? [plan.mainSpouseId] : []),
  ]
    .filter((personId, index, array) => array.indexOf(personId) === index)
    .filter((personId) => positions.has(personId))
    .sort((leftId, rightId) => positions.get(leftId).column - positions.get(rightId).column);
  connectHorizontalChain(edges, edgeIds, spouseChainIds, `inspect-spouses:${plan.focusNodeId}`, EDGE_COLORS.spouse);

  if (plan.mainSpouseId && positions.has(plan.mainSpouseId)) {
    for (const entry of plan.mainExtraChildEntries) {
      ensurePersonNode(
        dataset,
        nodes,
        nodeIds,
        positions,
        entry.childId,
        entry.column,
        plan.focusDepth - 1
      );
      connectParentsToChild(
        dataset,
        graphState,
        [plan.focusNodeId, plan.mainSpouseId],
        entry.childId,
        `inspect-main-child:${plan.focusNodeId}:${entry.childId}`
      );
    }

    const mainChildChainIds = plan.mainChildEntries
      .map((entry) => entry.childId)
      .filter((childId) => positions.has(childId))
      .sort((leftId, rightId) => positions.get(leftId).column - positions.get(rightId).column);
    connectHorizontalChain(edges, edgeIds, mainChildChainIds, `inspect-main-children:${plan.focusNodeId}`, EDGE_COLORS.sibling);
  }

  for (const entry of plan.spouseEntries) {
    const childChainIds = [];

    for (const [index, childId] of entry.childIds.entries()) {
      ensurePersonNode(
        dataset,
        nodes,
        nodeIds,
        positions,
        childId,
        entry.childColumns[index],
        plan.focusDepth - 1
      );
      connectParentsToChild(
        dataset,
        graphState,
        [plan.focusNodeId, entry.spouseId],
        childId,
        `inspect-other-child:${plan.focusNodeId}:${entry.spouseId}:${childId}`
      );
      childChainIds.push(childId);
    }

    childChainIds.sort((leftId, rightId) => positions.get(leftId).column - positions.get(rightId).column);
    connectHorizontalChain(edges, edgeIds, childChainIds, `inspect-other-children:${plan.focusNodeId}:${entry.spouseId}`, EDGE_COLORS.sibling);
  }

  if (plan.soloChildIds.length) {
    const soloColumns = plan.soloChildIds.map((childId, index) => (
      plan.focusColumn + (plan.spouseDirection * INSPECT_LAYOUT.childStepColumns * (index + 1))
    ));
    const soloChainIds = [];

    for (const [index, childId] of plan.soloChildIds.entries()) {
      ensurePersonNode(
        dataset,
        nodes,
        nodeIds,
        positions,
        childId,
        soloColumns[index],
        plan.focusDepth - 1
      );
      connectParentsToChild(
        dataset,
        graphState,
        [plan.focusNodeId],
        childId,
        `inspect-solo-child:${plan.focusNodeId}:${childId}`
      );
      soloChainIds.push(childId);
    }

    soloChainIds.sort((leftId, rightId) => positions.get(leftId).column - positions.get(rightId).column);
    connectHorizontalChain(edges, edgeIds, soloChainIds, `inspect-solo-children:${plan.focusNodeId}`, EDGE_COLORS.sibling);
  }
}

// Validates the final fixed-grid layout.
function validateGraphLayout(graphData, positions) {
  const issues = [];
  const seenNodeIds = new Set();
  const seenEdgeIds = new Set();
  const occupied = new Map();

  for (const node of graphData.nodes) {
    if (seenNodeIds.has(node.id)) {
      issues.push(`Duplicate node id: ${node.id}`);
    }
    seenNodeIds.add(node.id);

    if (String(node.id).startsWith('junction:')) continue;
    const pos = positions.get(node.id);
    if (!pos) continue;

    const key = `${pos.depth}:${occupancyColumnKey(pos.column)}`;
    if (occupied.has(key)) {
      issues.push(`Cell collision: ${occupied.get(key)} and ${node.id}`);
    } else {
      occupied.set(key, node.id);
    }
  }

  for (const edge of graphData.edges) {
    if (seenEdgeIds.has(edge.id)) {
      issues.push(`Duplicate edge id: ${edge.id}`);
    }
    seenEdgeIds.add(edge.id);

    if (!seenNodeIds.has(edge.from)) {
      issues.push(`Missing edge source: ${edge.id}`);
    }
    if (!seenNodeIds.has(edge.to)) {
      issues.push(`Missing edge target: ${edge.id}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

// Builds the full ancestor graph and optionally overlays inspect nodes into the same grid.
function buildMainGraph(dataset, rootId, focusNodeId = null) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const junctionIds = new Set();
  const edgeIds = new Set();
  const maxDepth = computeKnownDepth(dataset, rootId);
  const skeleton = buildAncestorSkeleton(dataset, rootId, 0, maxDepth);
  const measurements = new Map();
  const positions = new Map();
  const childByAncestor = buildPathChildMap(skeleton);
  measureMainSubtree(skeleton, measurements);
  assignMainColumns(skeleton, 0, measurements, positions);

  const inspectPlan = focusNodeId
    ? buildInspectPlan(dataset, focusNodeId, positions, childByAncestor)
    : null;

  applyInspectPlan(inspectPlan, positions);

  for (const [personId, pos] of positions.entries()) {
    if (String(personId).startsWith('junction:')) continue;
    if (nodeIds.has(personId)) continue;

    nodes.push(makePersonNode(
      dataset,
      personId,
      mainColumnToX(pos.column),
      mainDepthToY(pos.depth),
      { isPlaceholder: pos.isPlaceholder }
    ));
    nodeIds.add(personId);
  }

  const graphState = {
    nodes,
    edges,
    nodeIds,
    junctionIds,
    edgeIds,
    positions,
  };

  renderMainConnections(skeleton, dataset, graphState);
  renderInspectOverlay(dataset, inspectPlan, graphState);

  const validation = validateGraphLayout({ nodes, edges }, positions);

  return {
    nodes,
    edges,
    mode: 'main',
    focusNodeId: focusNodeId || rootId,
    rootNodeId: rootId,
    validation,
  };
}

// Converts a parent relation into a readable edge label.
function parentDisplayLabel(item) {
  const key = normalizeText(item?.relation_type);
  if (key.includes('прием') || key.includes('приём')) return key.includes('отец') ? 'приёмный отец' : 'приёмная мать';
  if (key.includes('отчим')) return 'отчим';
  if (key.includes('мачех')) return 'мачеха';
  if (key.includes('отец')) return 'отец';
  if (key.includes('мать')) return 'мать';
  return 'родитель';
}

// Returns the spouse label based on the related person's sex.
function spouseDisplayLabel(dataset, spouseId) {
  const sex = getSexLabel(dataset.people.get(spouseId)?.sex);
  if (sex === 'м') return 'супруг';
  if (sex === 'ж') return 'супруга';
  return 'супруг';
}

// Converts a child relation into a readable edge label.
function childDisplayLabel(dataset, childItem) {
  const raw = normalizeText(childItem?.relation_type);
  const sex = getSexLabel(dataset.people.get(childItem.person_id)?.sex);

  if (raw.includes('прием') || raw.includes('приём') || raw.includes('усынов')) {
    if (sex === 'ж') return 'приёмная дочь';
    if (sex === 'м') return 'приёмный сын';
    return 'приёмный ребёнок';
  }

  if (sex === 'ж') return 'дочь';
  if (sex === 'м') return 'сын';
  return 'ребёнок';
}

// Converts a sibling relation into a readable edge label.
function siblingDisplayLabel(dataset, siblingItem) {
  const raw = normalizeText(siblingItem?.relation_type);
  const sex = getSexLabel(dataset.people.get(siblingItem.person_id)?.sex);

  const suffix = sex === 'ж' ? 'сестра' : sex === 'м' ? 'брат' : 'сиблинг';
  if (raw.includes('прием') || raw.includes('приём')) return `приёмный ${suffix}`.replace('приёмный сестра', 'приёмная сестра');
  if (raw.includes('свод')) return `сводный ${suffix}`.replace('сводный сестра', 'сводная сестра');
  return suffix;
}

// Spreads a side group horizontally around a center line.
function layoutHorizontalGroup(centerX, y, gapX, items, side) {
  if (!items.length) return new Map();
  const positions = new Map();
  const count = items.length;
  const dir = side === 'left' ? -1 : 1;

  items.forEach((item, index) => {
    const offset = ((count - 1) / 2 - index) * gapX;
    positions.set(item.person_id, {
      x: centerX + dir * (gapX + offset),
      y,
    });
  });

  return positions;
}

// Builds the focused graph with direct relatives around one person.
function buildFocusedGraph(dataset, personId) {
  const nodes = [];
  const edges = [];
  const person = dataset.people.get(personId);
  const center = { x: 0, y: 0 };

  nodes.push(
    makePersonNode(dataset, personId, center.x, center.y, {
      borderWidth: 2.4,
      color: { background: '#eff6ff', border: '#1d4ed8' },
    })
  );

  const parents = uniqueByPersonId(person?.parents || []).sort((a, b) => compareParents(dataset, a, b));
  const children = uniqueByPersonId(person?.children || []).sort((a, b) => comparePeopleIds(dataset, a.person_id, b.person_id));
  const siblings = uniqueByPersonId(person?.siblings || []).sort((a, b) => comparePeopleIds(dataset, a.person_id, b.person_id));
  const spouses = uniqueByPersonId(person?.spouses || []).sort((a, b) => comparePeopleIds(dataset, a.person_id, b.person_id));

  const parentStartX = -((parents.length - 1) * LAYOUT.focusParentGapX) / 2;
  parents.forEach((item, index) => {
    const x = parentStartX + index * LAYOUT.focusParentGapX;
    const y = -LAYOUT.focusLevelGapY;
    nodes.push(makePersonNode(dataset, item.person_id, x, y));
    edges.push(makeFocusedEdge(item.person_id, personId, parentDisplayLabel(item), { color: EDGE_COLORS.parent }));
  });

  const childStartX = -((children.length - 1) * LAYOUT.focusChildGapX) / 2;
  children.forEach((item, index) => {
    const x = childStartX + index * LAYOUT.focusChildGapX;
    const y = LAYOUT.focusLevelGapY;
    nodes.push(makePersonNode(dataset, item.person_id, x, y));
    edges.push(makeFocusedEdge(personId, item.person_id, childDisplayLabel(dataset, item), { color: EDGE_COLORS.parent }));
  });

  const spousePositions = layoutHorizontalGroup(center.x, center.y, LAYOUT.focusSideGapX, spouses, 'left');
  spouses.forEach((item) => {
    const pos = spousePositions.get(item.person_id);
    nodes.push(makePersonNode(dataset, item.person_id, pos.x, pos.y));
    edges.push(makeFocusedEdge(item.person_id, personId, spouseDisplayLabel(dataset, item.person_id), { color: EDGE_COLORS.spouse }));
  });

  const siblingPositions = layoutHorizontalGroup(center.x, center.y, LAYOUT.focusSideGapX, siblings, 'right');
  siblings.forEach((item) => {
    const pos = siblingPositions.get(item.person_id);
    nodes.push(makePersonNode(dataset, item.person_id, pos.x, pos.y));
    edges.push(makeFocusedEdge(personId, item.person_id, siblingDisplayLabel(dataset, item), { color: EDGE_COLORS.sibling, dashes: true }));
  });

  return {
    nodes,
    edges,
    mode: 'focused',
    focusNodeId: personId,
  };
}

// Builds either the main ancestor graph or the focused relation graph.
export function buildGraph(dataset, options = {}) {
  const rootId = options.rootId || dataset.people.keys().next().value;
  const mode = options.mode || 'main';
  const focusNodeId = options.focusNodeId || null;

  if (mode === 'focused') {
    return buildFocusedGraph(dataset, focusNodeId || rootId);
  }

  return buildMainGraph(dataset, rootId, focusNodeId);
}

// Creates and wires up the vis-network instance for the graph.
export function createNetwork(container, graphData, handlers = {}) {
  const network = new vis.Network(
    container,
    {
      nodes: new vis.DataSet(graphData.nodes),
      edges: new vis.DataSet(graphData.edges),
    },
    {
      autoResize: true,
      interaction: {
        hover: true,
        navigationButtons: false,
        keyboard: true,
        dragNodes: false,
        dragView: true,
        zoomView: true,
      },
      layout: {
        improvedLayout: false,
      },
      physics: false,
      nodes: {
        shapeProperties: { borderRadius: 12 },
      },
      edges: {
        smooth: false,
        selectionWidth: 0,
      },
    }
  );

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      handlers.onSelect?.(params.nodes[0]);
    } else {
      handlers.onSelect?.(null);
    }
  });

  network.on('afterDrawing', () => {
    handlers.onViewportChanged?.();
  });
  network.on('zoom', () => handlers.onViewportChanged?.());
  network.on('dragEnd', () => handlers.onViewportChanged?.());
  network.on('resize', () => handlers.onViewportChanged?.());

  return network;
}
