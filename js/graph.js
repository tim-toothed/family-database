const EDGE_COLORS = {
  parent: '#3b82f6',   // родители
  sibling: '#22c55e',  // братья/сёстры
  spouse: '#ef4444',   // супруги
};

const LAYOUT = {
  componentGapX: 1400,
  componentGapY: 1100,

  mainX: 0,
  levelGapY: 220,

  spouseGapX: 280,
  siblingGapX: 280,

  sideBranchStartX: 420,
  sideBranchChildGapX: 260,
  sideBranchLevelGapY: 210,

  orphanGridCols: 4,
  orphanGapX: 300,
  orphanGapY: 140,
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

function normalizeParentRelation(label) {
  const key = normalizeText(label);

  if (key === 'отец') return 'отец';
  if (key === 'мать') return 'мать';
  if (key === 'отчим') return 'отчим';
  if (key === 'мачеха') return 'мачеха';
  if (key === 'приемный отец' || key === 'приёмный отец') return 'приёмный отец';
  if (key === 'приемная мать' || key === 'приёмная мать') return 'приёмная мать';

  return 'родитель';
}

function normalizeChildRelation(label, parentSex) {
  const key = normalizeText(label);
  const sex = getSexLabel(parentSex);

  if (key.includes('усынов') || key.includes('прием') || key.includes('приём')) {
    if (sex === 'м') return 'приёмный отец';
    if (sex === 'ж') return 'приёмная мать';
    return 'приёмный родитель';
  }

  if (key.includes('свод')) {
    if (sex === 'м') return 'отчим';
    if (sex === 'ж') return 'мачеха';
    return 'сводный родитель';
  }

  if (sex === 'м') return 'отец';
  if (sex === 'ж') return 'мать';
  return 'родитель';
}

function relationPriority(label) {
  const key = normalizeText(label);

  if (
    key === 'отец' ||
    key === 'мать' ||
    key === 'отчим' ||
    key === 'мачеха' ||
    key === 'приёмный отец' ||
    key === 'приемный отец' ||
    key === 'приёмная мать' ||
    key === 'приемная мать'
  ) {
    return 100;
  }

  if (
    key === 'родитель' ||
    key === 'приёмный родитель' ||
    key === 'приемный родитель' ||
    key === 'сводный родитель'
  ) {
    return 60;
  }

  return 10;
}

function siblingLabel(personA, personB) {
  const a = getSexLabel(personA?.sex);
  const b = getSexLabel(personB?.sex);

  if (a === 'м' && b === 'м') return 'братья';
  if (a === 'ж' && b === 'ж') return 'сёстры';
  return 'брат/сестра';
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

function makeDirectedEdge(from, to, relation) {
  return {
    from,
    to,
    label: relation,
    arrows: 'to',
    font: { align: 'top', size: 10 },
    color: EDGE_COLORS.parent,
    smooth: { type: 'dynamic' },
  };
}

function makeUndirectedEdge(from, to, relation, dashes = false, color = '#95a2bd') {
  return {
    from,
    to,
    label: relation,
    dashes,
    arrows: '',
    font: { align: 'top', size: 10 },
    color,
    smooth: { type: 'dynamic' },
  };
}

function addOrMergeDirectedEdge(edgesMap, from, to, relation) {
  if (!from || !to || from === '???' || to === '???' || from === to) return;

  const key = `${from}->${to}`;
  const nextPriority = relationPriority(relation);
  const prev = edgesMap.get(key);

  if (!prev) {
    edgesMap.set(key, makeDirectedEdge(from, to, relation));
    return;
  }

  const prevPriority = relationPriority(prev.label);
  if (nextPriority > prevPriority) {
    edgesMap.set(key, makeDirectedEdge(from, to, relation));
  }
}

function addUndirectedEdgeSafe(edgesMap, from, to, relation, dashes = false, color) {
  if (!from || !to || from === '???' || to === '???' || from === to) return;

  const [a, b] = [from, to].sort();
  const key = `${a}<->${b}::${relation}`;

  if (edgesMap.has(key)) return;
  edgesMap.set(key, makeUndirectedEdge(a, b, relation, dashes, color));
}

function buildRelations(dataset) {
  const directedEdgesMap = new Map();
  const undirectedEdgesMap = new Map();

  for (const [id, person] of dataset.people.entries()) {
    for (const parent of person.parents || []) {
      addOrMergeDirectedEdge(
        directedEdgesMap,
        parent.person_id,
        id,
        normalizeParentRelation(parent.relation_type)
      );
    }
  }

  for (const [id, person] of dataset.people.entries()) {
    for (const child of person.children || []) {
      addOrMergeDirectedEdge(
        directedEdgesMap,
        id,
        child.person_id,
        normalizeChildRelation(child.relation_type, person.sex)
      );

      if (child.second_parent_id && child.second_parent_id !== '???') {
        const secondParent = dataset.people.get(child.second_parent_id);

        addOrMergeDirectedEdge(
          directedEdgesMap,
          child.second_parent_id,
          child.person_id,
          normalizeChildRelation(child.relation_type, secondParent?.sex)
        );
      }
    }

    for (const sibling of person.siblings || []) {
      const siblingPerson = dataset.people.get(sibling.person_id);
      const label = siblingLabel(person, siblingPerson);

      addUndirectedEdgeSafe(
        undirectedEdgesMap,
        id,
        sibling.person_id,
        label,
        true,
        EDGE_COLORS.sibling
      );
    }

    for (const spouse of person.spouses || []) {
      addUndirectedEdgeSafe(
        undirectedEdgesMap,
        id,
        spouse.person_id,
        'супруги',
        false,
        EDGE_COLORS.spouse
      );
    }
  }

  return {
    directedEdges: Array.from(directedEdgesMap.values()),
    undirectedEdges: Array.from(undirectedEdgesMap.values()),
  };
}

function buildLookupMaps(dataset, directedEdges, undirectedEdges) {
  const parentsOf = new Map();
  const childrenOf = new Map();
  const spousesOf = new Map();
  const siblingsOf = new Map();
  const undirectedAdj = new Map();

  for (const id of dataset.indexById.keys()) {
    parentsOf.set(id, []);
    childrenOf.set(id, []);
    spousesOf.set(id, []);
    siblingsOf.set(id, []);
    undirectedAdj.set(id, new Set());
  }

  for (const edge of directedEdges) {
    if (!parentsOf.has(edge.to)) parentsOf.set(edge.to, []);
    if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);

    parentsOf.get(edge.to).push(edge.from);
    childrenOf.get(edge.from).push(edge.to);

    undirectedAdj.get(edge.from)?.add(edge.to);
    undirectedAdj.get(edge.to)?.add(edge.from);
  }

  for (const edge of undirectedEdges) {
    if (edge.label === 'супруги') {
      spousesOf.get(edge.from)?.push(edge.to);
      spousesOf.get(edge.to)?.push(edge.from);
    } else {
      siblingsOf.get(edge.from)?.push(edge.to);
      siblingsOf.get(edge.to)?.push(edge.from);
    }

    undirectedAdj.get(edge.from)?.add(edge.to);
    undirectedAdj.get(edge.to)?.add(edge.from);
  }

  for (const [id, list] of parentsOf.entries()) {
    list.sort((a, b) => comparePeopleIds(dataset, a, b));
  }
  for (const [id, list] of childrenOf.entries()) {
    list.sort((a, b) => comparePeopleIds(dataset, a, b));
  }
  for (const [id, list] of spousesOf.entries()) {
    list.sort((a, b) => comparePeopleIds(dataset, a, b));
  }
  for (const [id, list] of siblingsOf.entries()) {
    list.sort((a, b) => comparePeopleIds(dataset, a, b));
  }

  return { parentsOf, childrenOf, spousesOf, siblingsOf, undirectedAdj };
}

function getConnectedComponents(dataset, adjacency) {
  const visited = new Set();
  const components = [];

  for (const id of dataset.indexById.keys()) {
    if (visited.has(id)) continue;

    const queue = [id];
    const component = [];
    visited.add(id);

    while (queue.length) {
      const current = queue.shift();
      component.push(current);

      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    components.push(component.sort((a, b) => comparePeopleIds(dataset, a, b)));
  }

  return components;
}

function findLongestPathInComponent(component, childrenOf, dataset) {
  const componentSet = new Set(component);
  const memo = new Map();
  const nextMap = new Map();

  function dfs(nodeId, visiting = new Set()) {
    if (!componentSet.has(nodeId)) return 1;
    if (memo.has(nodeId)) return memo.get(nodeId);

    if (visiting.has(nodeId)) {
      // На случай кривых данных не уходим в рекурсивный ад.
      return 1;
    }

    visiting.add(nodeId);

    let bestLen = 1;
    let bestChild = null;

    for (const childId of childrenOf.get(nodeId) || []) {
      if (!componentSet.has(childId)) continue;

      const len = 1 + dfs(childId, visiting);
      if (len > bestLen) {
        bestLen = len;
        bestChild = childId;
      } else if (len === bestLen && bestChild) {
        if (comparePeopleIds(dataset, childId, bestChild) < 0) {
          bestChild = childId;
        }
      }
    }

    visiting.delete(nodeId);

    memo.set(nodeId, bestLen);
    if (bestChild) nextMap.set(nodeId, bestChild);
    return bestLen;
  }

  let bestRoot = component[0];
  let bestLen = 0;

  for (const id of component) {
    const len = dfs(id);
    if (len > bestLen) {
      bestLen = len;
      bestRoot = id;
    } else if (len === bestLen && comparePeopleIds(dataset, id, bestRoot) < 0) {
      bestRoot = id;
    }
  }

  const path = [];
  let current = bestRoot;
  const seen = new Set();

  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = nextMap.get(current);
  }

  return path;
}

function assignNodePosition(nodeMeta, id, x, y) {
  const existing = nodeMeta.get(id);

  if (!existing) {
    nodeMeta.set(id, { x, y });
    return;
  }

  // Если уже есть позиция, оставляем первую.
  // Нам не нужна война координат между ветками.
}

function layoutSideSubtree({
  rootId,
  baseX,
  baseY,
  direction,
  dataset,
  childrenOf,
  spousesOf,
  siblingsOf,
  nodeMeta,
  visited,
}) {
  if (!rootId || visited.has(rootId)) return;
  visited.add(rootId);

  assignNodePosition(nodeMeta, rootId, baseX, baseY);

  const spouses = (spousesOf.get(rootId) || []).filter((id) => !visited.has(id));
  spouses.forEach((spouseId, index) => {
    const offset = (index + 1) * LAYOUT.spouseGapX * direction;
    assignNodePosition(nodeMeta, spouseId, baseX + offset, baseY);
    visited.add(spouseId);
  });

  const siblings = (siblingsOf.get(rootId) || []).filter((id) => !visited.has(id));
  siblings.forEach((sibId, index) => {
    const offset = (index + 1) * LAYOUT.siblingGapX * direction;
    assignNodePosition(nodeMeta, sibId, baseX - offset, baseY);
    visited.add(sibId);
  });

  const children = (childrenOf.get(rootId) || []).filter((id) => !visited.has(id));

  children.forEach((childId, index) => {
    const centerShift = index - (children.length - 1) / 2;
    const childX = baseX + centerShift * LAYOUT.sideBranchChildGapX;
    const childY = baseY + LAYOUT.sideBranchLevelGapY;

    layoutSideSubtree({
      rootId: childId,
      baseX: childX,
      baseY: childY,
      direction,
      dataset,
      childrenOf,
      spousesOf,
      siblingsOf,
      nodeMeta,
      visited,
    });
  });
}

function layoutComponent({
  component,
  componentIndex,
  spine,
  dataset,
  childrenOf,
  spousesOf,
  siblingsOf,
  nodeMeta,
  visitedGlobal,
}) {
  const baseX = componentIndex * LAYOUT.componentGapX;
  const baseY = 120;

  const spineSet = new Set(spine);
  const spineNext = new Map();

  for (let i = 0; i < spine.length - 1; i += 1) {
    spineNext.set(spine[i], spine[i + 1]);
  }

  spine.forEach((personId, levelIndex) => {
    const x = baseX + LAYOUT.mainX;
    const y = baseY + levelIndex * LAYOUT.levelGapY;

    assignNodePosition(nodeMeta, personId, x, y);
    visitedGlobal.add(personId);

    const spouses = (spousesOf.get(personId) || []).filter((id) => !visitedGlobal.has(id));
    spouses.forEach((spouseId, index) => {
      assignNodePosition(
        nodeMeta,
        spouseId,
        x + (index + 1) * LAYOUT.spouseGapX,
        y
      );
      visitedGlobal.add(spouseId);
    });

    const siblings = (siblingsOf.get(personId) || []).filter((id) => !visitedGlobal.has(id));
    siblings.forEach((sibId, index) => {
      assignNodePosition(
        nodeMeta,
        sibId,
        x - (index + 1) * LAYOUT.siblingGapX,
        y
      );
      visitedGlobal.add(sibId);
    });

    const children = (childrenOf.get(personId) || []).filter((id) => !spineSet.has(id));
    const nextOnSpine = spineNext.get(personId);

    const sideChildren = children.filter((childId) => childId !== nextOnSpine);

    sideChildren.forEach((childId, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      const branchColumn = Math.floor(index / 2) + 1;

      const childX =
        x + direction * (LAYOUT.sideBranchStartX + (branchColumn - 1) * 320);
      const childY = y + LAYOUT.sideBranchLevelGapY;

      layoutSideSubtree({
        rootId: childId,
        baseX: childX,
        baseY: childY,
        direction,
        dataset,
        childrenOf,
        spousesOf,
        siblingsOf,
        nodeMeta,
        visited: visitedGlobal,
      });
    });
  });

  // Всё, что осталось в компоненте неразложенным, укладываем в хвост кластера.
  const leftovers = component.filter((id) => !visitedGlobal.has(id));
  leftovers.forEach((id, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);

    assignNodePosition(
      nodeMeta,
      id,
      baseX + 700 + col * 280,
      baseY + row * 140
    );
    visitedGlobal.add(id);
  });
}

function placeOrphans({
  orphanComponents,
  nonOrphanComponentCount,
  dataset,
  nodeMeta,
}) {
  if (!orphanComponents.length) return;

  const startX = 0;
  const startY = nonOrphanComponentCount * 0 + 1200;

  const orphanIds = orphanComponents.flat().sort((a, b) => comparePeopleIds(dataset, a, b));

  orphanIds.forEach((id, index) => {
    const col = index % LAYOUT.orphanGridCols;
    const row = Math.floor(index / LAYOUT.orphanGridCols);

    assignNodePosition(
      nodeMeta,
      id,
      startX + col * LAYOUT.orphanGapX,
      startY + row * LAYOUT.orphanGapY
    );
  });
}

export function buildGraph(dataset) {
  const nodes = [];
  const { directedEdges, undirectedEdges } = buildRelations(dataset);
  const { childrenOf, spousesOf, siblingsOf, undirectedAdj } = buildLookupMaps(
    dataset,
    directedEdges,
    undirectedEdges
  );

  const components = getConnectedComponents(dataset, undirectedAdj);
  const orphanComponents = components.filter((c) => c.length === 1);
  const mainComponents = components.filter((c) => c.length > 1);

  const nodeMeta = new Map();
  const visitedGlobal = new Set();

  mainComponents.forEach((component, componentIndex) => {
    const spine = findLongestPathInComponent(component, childrenOf, dataset);

    layoutComponent({
      component,
      componentIndex,
      spine,
      dataset,
      childrenOf,
      spousesOf,
      siblingsOf,
      nodeMeta,
      visitedGlobal,
    });
  });

  placeOrphans({
    orphanComponents,
    nonOrphanComponentCount: mainComponents.length,
    dataset,
    nodeMeta,
  });

  for (const [id, name] of dataset.indexById.entries()) {
    const person = dataset.people.get(id);
    const subtitle = person?.birth?.date || id;
    const pos = nodeMeta.get(id) || { x: 0, y: 0 };

    nodes.push({
      id,
      label: name,
      title: `${name}\n${subtitle}`,
      shape: 'box',
      borderWidth: person ? 1.5 : 1,
      color: person
        ? { background: '#ffffff', border: '#2f6fed' }
        : { background: '#f3f5f9', border: '#c0c8d8' },
      font: { face: 'Inter, system-ui, sans-serif', size: 14 },
      margin: 10,
      x: pos.x,
      y: pos.y,
      physics: false,
    });
  }

  return {
    nodes,
    edges: [...directedEdges, ...undirectedEdges],
  };
}

export function createNetwork(container, graphData, onSelect) {
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
        dragNodes: true,
        dragView: true,
        zoomView: true,
      },
      layout: {
        improvedLayout: false,
      },
      physics: false,
      edges: {
        smooth: {
          type: 'cubicBezier',
          roundness: 0.15,
        },
        arrows: {
          to: {
            enabled: true,
            scaleFactor: 0.7,
          },
        },
      },
    }
  );

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      onSelect(params.nodes[0]);
    }
  });

  return network;
}