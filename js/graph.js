const EDGE_COLORS = {
  parent: '#3b82f6',
  sibling: '#22c55e',
  spouse: '#ef4444',
  neutral: '#94a3b8',
  placeholder: '#cbd5e1',
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

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getSexLabel(sex) {
  const s = normalizeText(sex);
  if (s === 'м') return 'м';
  if (s === 'ж') return 'ж';
  return null;
}

function isAdoptiveRelation(label) {
  const key = normalizeText(label);
  return key.includes('прием') || key.includes('приём') || key.includes('усынов');
}

function isStepRelation(label) {
  const key = normalizeText(label);
  return key.includes('мачех') || key.includes('отчим') || key.includes('свод');
}

function isBiologicalParentRelation(label) {
  const key = normalizeText(label);
  return key === 'отец' || key === 'мать' || key === 'родитель';
}

function relationPriority(label) {
  const key = normalizeText(label);
  if (key === 'мать' || key === 'отец') return 100;
  if (key === 'приёмная мать' || key === 'приемная мать' || key === 'приёмный отец' || key === 'приемный отец') return 90;
  if (key === 'родитель') return 70;
  if (key === 'мачеха' || key === 'отчим') return 40;
  return 10;
}

function birthYear(person) {
  const value = person?.birth?.date || '';
  const m = value.match(/(\d{4})$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function comparePeopleIds(dataset, a, b) {
  const pa = dataset.people.get(a);
  const pb = dataset.people.get(b);

  const ya = birthYear(pa);
  const yb = birthYear(pb);
  if (ya !== yb) return ya - yb;

  const na = dataset.indexById.get(a) || a;
  const nb = dataset.indexById.get(b) || b;
  return na.localeCompare(nb, 'ru');
}

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

function personName(dataset, personId) {
  if (String(personId).startsWith('unknown:')) return 'Неизвестно';
  return dataset.indexById.get(personId) || dataset.people.get(personId)?.birth_name || personId;
}

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

function computeFontSize(label) {
  const maxWord = Math.max(...String(label).split(/\s+/).map((part) => part.length), 1);
  if (maxWord >= 18) return NODE.minFontSize;
  if (maxWord >= 14) return 12;
  if (maxWord >= 10) return 14;
  return NODE.baseFontSize;
}

function makePersonNode(dataset, id, x, y, options = {}) {
  const isPlaceholder = options.isPlaceholder || String(id).startsWith('unknown:');
  const name = isPlaceholder ? 'Неизвестно' : personName(dataset, id);
  const person = isPlaceholder ? null : dataset.people.get(id);
  const subtitle = options.hideSubtitle || isPlaceholder ? '' : (person?.birth?.date || id);
  const wrapped = wrapText(name);
  const label = subtitle ? `${wrapped}\n${subtitle}` : wrapped;
  const fontSize = computeFontSize(name);

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
      : { background: '#ffffff', border: '#2f6fed' }),
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

function makeJunctionNode(id, x, y) {
  return {
    id,
    label: '',
    x,
    y,
    physics: false,
    fixed: true,
    shape: 'dot',
    size: 2,
    color: {
      background: '#64748b',
      border: '#64748b',
      highlight: '#64748b',
      hover: '#64748b',
    },
    borderWidth: 0,
  };
}

function edgeId(prefix, from, to, relation = '') {
  return `${prefix}:${from}:${to}:${relation}`;
}

function makeMainEdge(from, to) {
  return {
    id: edgeId('main', from, to),
    from,
    to,
    color: EDGE_COLORS.parent,
    width: 2,
    arrows: '',
    smooth: false,
    selectionWidth: 0,
  };
}

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

function computeKnownDepth(dataset, rootId) {
  const memo = new Map();

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
    if (rel.includes('мать')) {
      pair.push(known[0], { person_id: `unknown:${personId}:${depth + 1}:father`, relation_type: 'отец' });
    } else if (rel.includes('отец')) {
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

function subtreeWidth(node) {
  if (!node.parents?.length) return NODE.width;

  const left = subtreeWidth(node.parents[0]);
  const right = subtreeWidth(node.parents[1]);

  const pairWidth = NODE.width * 2 + LAYOUT.mainPairGapX;
  const branchesWidth = left + LAYOUT.mainBranchGapX + right;

  return Math.max(NODE.width, pairWidth, branchesWidth);
}

function assignMainPositions(node, x, positions) {
  positions.set(node.id, {
    x,
    y: -node.depth * LAYOUT.mainGenerationGapY,
    isPlaceholder: node.isPlaceholder,
  });

  if (!node.parents?.length) return subtreeWidth(node);

  const leftWidth = subtreeWidth(node.parents[0]);
  const rightWidth = subtreeWidth(node.parents[1]);

  // 1) Сначала ставим родителей строго симметрично над ребёнком
  const halfPair = (NODE.width + LAYOUT.mainPairGapX) / 2;
  let leftX = x - halfPair;
  let rightX = x + halfPair;

  // 2) Потом, если поддеревья слишком широкие и начнут пересекаться,
  //    симметрично раздвигаем обе ветки
  const minCenterDistance = (leftWidth / 2) + (rightWidth / 2) + LAYOUT.mainBranchGapX;
  const currentCenterDistance = rightX - leftX;

  if (currentCenterDistance < minCenterDistance) {
    const extra = (minCenterDistance - currentCenterDistance) / 2;
    leftX -= extra;
    rightX += extra;
  }

  assignMainPositions(node.parents[0], leftX, positions);
  assignMainPositions(node.parents[1], rightX, positions);

  return Math.max(NODE.width, (rightX - leftX) + leftWidth / 2 + rightWidth / 2);
}

function buildMainGraph(dataset, rootId) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const junctionIds = new Set();
  const maxDepth = computeKnownDepth(dataset, rootId);
  const skeleton = buildAncestorSkeleton(dataset, rootId, 0, maxDepth);
  const positions = new Map();

  assignMainPositions(skeleton, 0, positions);

  for (const [personId, pos] of positions.entries()) {
    if (nodeIds.has(personId)) continue;
    nodes.push(makePersonNode(dataset, personId, pos.x, pos.y, { isPlaceholder: pos.isPlaceholder }));
    nodeIds.add(personId);
  }

  function connect(node) {
    if (!node.parents?.length) return;

    const childPos = positions.get(node.id);
    const leftPos = positions.get(node.parents[0].id);
    const rightPos = positions.get(node.parents[1].id);
    const joinY = childPos.y - LAYOUT.edgeJoinOffsetY;

    const jointId = `junction:merge:${node.id}`;
    const leftElbowId = `junction:left:${node.id}`;
    const rightElbowId = `junction:right:${node.id}`;

    if (!junctionIds.has(jointId)) {
      nodes.push(makeJunctionNode(jointId, childPos.x, joinY));
      nodes.push(makeJunctionNode(leftElbowId, leftPos.x, joinY));
      nodes.push(makeJunctionNode(rightElbowId, rightPos.x, joinY));
      junctionIds.add(jointId);
    }

    edges.push(makeMainEdge(node.parents[0].id, leftElbowId));
    edges.push(makeMainEdge(leftElbowId, jointId));
    edges.push(makeMainEdge(node.parents[1].id, rightElbowId));
    edges.push(makeMainEdge(rightElbowId, jointId));
    edges.push(makeMainEdge(jointId, node.id));

    connect(node.parents[0]);
    connect(node.parents[1]);
  }

  connect(skeleton);

  return {
    nodes,
    edges,
    mode: 'main',
    focusNodeId: rootId,
    rootNodeId: rootId,
  };
}

function parentDisplayLabel(item) {
  const key = normalizeText(item?.relation_type);
  if (key.includes('прием') || key.includes('приём')) return key.includes('отец') ? 'приёмный отец' : 'приёмная мать';
  if (key.includes('отчим')) return 'отчим';
  if (key.includes('мачех')) return 'мачеха';
  if (key.includes('отец')) return 'отец';
  if (key.includes('мать')) return 'мать';
  return 'родитель';
}

function spouseDisplayLabel(dataset, spouseId) {
  const sex = getSexLabel(dataset.people.get(spouseId)?.sex);
  if (sex === 'м') return 'супруг';
  if (sex === 'ж') return 'супруга';
  return 'супруг';
}

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

function siblingDisplayLabel(dataset, siblingItem) {
  const raw = normalizeText(siblingItem?.relation_type);
  const sex = getSexLabel(dataset.people.get(siblingItem.person_id)?.sex);

  const suffix = sex === 'ж' ? 'сестра' : sex === 'м' ? 'брат' : 'сиблинг';
  if (raw.includes('прием') || raw.includes('приём')) return `приёмный ${suffix}`.replace('приёмный сестра', 'приёмная сестра');
  if (raw.includes('свод')) return `сводный ${suffix}`.replace('сводный сестра', 'сводная сестра');
  return suffix;
}

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

export function buildGraph(dataset, options = {}) {
  const rootId = options.rootId || dataset.indexById.keys().next().value;
  const mode = options.mode || 'main';
  const focusNodeId = options.focusNodeId || rootId;

  if (mode === 'focused') {
    return buildFocusedGraph(dataset, focusNodeId);
  }

  return buildMainGraph(dataset, rootId);
}

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
        navigationButtons: true,
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
