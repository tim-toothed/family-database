import {
  getBirthYear,
  getDatasetPersonName,
  getDateYear,
  getLifeYears as getPersonLifeYears,
  getPersonSex,
  getRelationEntries,
} from '../person/model.js';
import { normalizeText } from '../utils/normalize.js';

export const EDGE_COLORS = {
  parent: '#94a3b8',
  placeholder: '#94a3b8',
  male: '#2f6fed',
  female: '#ec4899',
};

export const NODE = {
  width: 196,
  height: 92,
  baseFontSize: 16,
  minFontSize: 11,
  lineLength: 18,
};

export const GRAPH_VIEW = {
  fitPadding: 48,
  minZoom: 0.18,
  maxZoom: 2.4,
};

export const GRAPH_VISUALIZATIONS = [
  { id: 'tree', label: 'Дерево' },
  { id: 'radial', label: 'Радиальный' },
  { id: 'panorama', label: 'Панорама' },
];

export function getGraphVisualizationLabel(mode) {
  return GRAPH_VISUALIZATIONS.find((item) => item.id === mode)?.label || 'Граф';
}

export function getD3() {
  if (!globalThis.d3) {
    throw new Error('d3 is not loaded');
  }

  return globalThis.d3;
}

export function getSexLabel(sex) {
  return normalizeText(sex?.sex ?? sex);
}

export function isPlaceholderId(personId) {
  return String(personId).startsWith('unknown:');
}

export function personName(dataset, personId) {
  if (isPlaceholderId(personId)) return 'Неизвестно';
  return getDatasetPersonName(dataset, personId, personId);
}

export function extractYear(value) {
  const year = getDateYear(value);
  return year == null ? null : String(year);
}

export function getLifeYears(person) {
  return getPersonLifeYears(person);
}

export function wrapText(value, maxLineLength = NODE.lineLength, maxLines = 4) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['Без имени'];

  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    if (`${currentLine} ${word}`.length <= maxLineLength) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.slice(0, maxLines);
}

export function computeFontSize(label) {
  const longestWord = Math.max(...String(label).split(/\s+/).map((part) => part.length), 1);
  if (longestWord >= 18) return NODE.minFontSize;
  if (longestWord >= 14) return 12;
  if (longestWord >= 10) return 14;
  return NODE.baseFontSize;
}

export function birthYear(person) {
  return getBirthYear(person) ?? Number.MAX_SAFE_INTEGER;
}

export function comparePeopleIds(dataset, leftPersonId, rightPersonId) {
  const leftPerson = dataset.people.get(leftPersonId);
  const rightPerson = dataset.people.get(rightPersonId);

  const yearDiff = birthYear(leftPerson) - birthYear(rightPerson);
  if (yearDiff !== 0) return yearDiff;

  const leftName = getDatasetPersonName(dataset, leftPersonId, leftPersonId);
  const rightName = getDatasetPersonName(dataset, rightPersonId, rightPersonId);
  return leftName.localeCompare(rightName, 'ru');
}

export function parentRank(dataset, parentEntry) {
  const relation = normalizeText(parentEntry?.relationType ?? parentEntry?.relation_type);
  if (relation.includes('мать')) return 0;
  if (relation.includes('отец')) return 1;

  const sex = getPersonSex(dataset.people.get(parentEntry?.personId ?? parentEntry?.person_id));
  if (sex === 'ж') return 0;
  if (sex === 'м') return 1;
  return 2;
}

export function compareParents(dataset, left, right) {
  const rankDiff = parentRank(dataset, left) - parentRank(dataset, right);
  if (rankDiff !== 0) return rankDiff;
  return comparePeopleIds(dataset, left.personId ?? left.person_id, right.personId ?? right.person_id);
}

export function uniqueByPersonId(list) {
  const seen = new Set();
  const result = [];

  for (const item of list || []) {
    const personId = item?.personId ?? item?.person_id;
    if (!personId || personId === '???' || seen.has(personId)) {
      continue;
    }

    seen.add(personId);
    result.push({
      ...item,
      personId,
      person_id: personId,
      relationType: item?.relationType ?? item?.relation_type,
      relation_type: item?.relationType ?? item?.relation_type,
    });
  }

  return result;
}

export function makePlaceholderParent(personId, generation, slot) {
  return { person_id: `unknown:${personId}:${generation}:${slot}` };
}

export function getParentPair(dataset, personId, generation) {
  const knownParents = uniqueByPersonId(getRelationEntries(dataset.people.get(personId), 'parents'))
    .sort((left, right) => compareParents(dataset, left, right))
    .slice(0, 2);

  if (!knownParents.length) return [];
  if (knownParents.length === 2) return knownParents;

  const [knownParent] = knownParents;
  const relation = normalizeText(knownParent?.relationType);
  const sex = getPersonSex(dataset.people.get(knownParent.personId));

  if (relation.includes('отец') || sex === 'м') {
    return [makePlaceholderParent(personId, generation + 1, 'mother'), { ...knownParent, person_id: knownParent.personId }];
  }

  if (relation.includes('мать') || sex === 'ж') {
    return [{ ...knownParent, person_id: knownParent.personId }, makePlaceholderParent(personId, generation + 1, 'father')];
  }

  return [{ ...knownParent, person_id: knownParent.personId }, makePlaceholderParent(personId, generation + 1, 'parent')];
}

export function makePersonGraphNode(dataset, personId, x, y) {
  const isPlaceholder = isPlaceholderId(personId);
  const name = personName(dataset, personId);
  const person = isPlaceholder ? null : dataset.people.get(personId);
  const subtitle = isPlaceholder ? '' : getLifeYears(person);
  const sex = getPersonSex(person);

  const color = isPlaceholder
    ? { background: '#f8fafc', border: EDGE_COLORS.placeholder }
    : sex === 'ж'
      ? { background: '#ffffff', border: EDGE_COLORS.female }
      : { background: '#ffffff', border: EDGE_COLORS.male };

  return {
    id: personId,
    kind: 'person',
    isPlaceholder,
    fullName: name,
    title: `${name}${subtitle ? `\n${subtitle}` : ''}`,
    nameLines: wrapText(name),
    subtitle,
    fontSize: computeFontSize(name),
    color,
    x,
    y,
    focusX: x,
    focusY: y,
    width: NODE.width,
    height: NODE.height,
  };
}

export function computeBounds(nodes, extras = []) {
  const source = [...nodes, ...extras];
  if (!source.length) {
    return {
      minX: -1,
      minY: -1,
      maxX: 1,
      maxY: 1,
      width: 2,
      height: 2,
    };
  }

  const minX = Math.min(...source.map((item) => item.minX));
  const minY = Math.min(...source.map((item) => item.minY));
  const maxX = Math.max(...source.map((item) => item.maxX));
  const maxY = Math.max(...source.map((item) => item.maxY));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export class BaseD3Network {
  constructor(container, graphData, handlers = {}) {
    this.container = container;
    this.graphData = graphData;
    this.handlers = handlers;
    this.nodeMap = new Map(graphData.nodes.map((node) => [node.id, node]));
    this.selectedNodeIds = new Set();
    this.body = {
      data: {
        nodes: {
          get: (id) => this.nodeMap.get(id) || null,
        },
      },
    };

    this.renderShell();
    this.installZoom();
    this.draw();
  }

  renderShell() {
    const d3 = getD3();

    this.container.innerHTML = '';
    this.container.classList.add('tree-graph');

    this.stage = document.createElement('div');
    this.stage.className = 'tree-stage';
    this.container.append(this.stage);

    this.svg = d3.select(this.stage)
      .append('svg')
      .attr('class', 'tree-canvas')
      .attr('width', '100%')
      .attr('height', '100%')
      .on('click', () => {
        this.handlers.onSelect?.(null);
      });

    this.viewport = this.svg.append('g').attr('class', 'tree-viewport');
  }

  installZoom() {
    const d3 = getD3();

    this.zoomBehavior = d3.zoom()
      .scaleExtent([GRAPH_VIEW.minZoom, GRAPH_VIEW.maxZoom])
      .on('zoom', (event) => {
        this.currentTransform = event.transform;
        this.viewport.attr('transform', event.transform.toString());
        this.handlers.onViewportChanged?.();
      });

    this.svg.call(this.zoomBehavior);
  }

  applyTransform(transform, animation) {
    const selection = this.svg;

    if (animation) {
      selection
        .transition()
        .duration(220)
        .call(this.zoomBehavior.transform, transform);
      return;
    }

    selection.call(this.zoomBehavior.transform, transform);
  }

  fit(options = {}) {
    const d3 = getD3();
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const bounds = this.graphData.bounds;
    const scale = Math.max(
      GRAPH_VIEW.minZoom,
      Math.min(
        GRAPH_VIEW.maxZoom,
        Math.min(
          (width - (GRAPH_VIEW.fitPadding * 2)) / bounds.width,
          (height - (GRAPH_VIEW.fitPadding * 2)) / bounds.height
        )
      )
    );
    const centerX = bounds.minX + (bounds.width / 2);
    const centerY = bounds.minY + (bounds.height / 2);
    const transform = d3.zoomIdentity
      .translate((width / 2) - (centerX * scale), (height / 2) - (centerY * scale))
      .scale(scale);

    this.applyTransform(transform, Boolean(options.animation));
  }

  focus(nodeId, options = {}) {
    const d3 = getD3();
    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const scale = Math.max(
      GRAPH_VIEW.minZoom,
      Math.min(GRAPH_VIEW.maxZoom, Number(options.scale) || 1)
    );
    const transform = d3.zoomIdentity
      .translate((width / 2) - ((node.focusX ?? node.x) * scale), (height / 2) - ((node.focusY ?? node.y) * scale))
      .scale(scale);

    this.applyTransform(transform, Boolean(options.animation));
  }

  selectNodes(nodeIds = []) {
    this.selectedNodeIds = new Set(nodeIds);
    this.updateSelection();
  }

  redraw() {
    this.handlers.onViewportChanged?.();
  }

  destroy() {
    this.container.classList.remove('tree-graph');
    this.container.innerHTML = '';
    this.nodeMap.clear();
    this.selectedNodeIds.clear();
  }
}
