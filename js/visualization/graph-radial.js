import {
  BaseD3Network,
  computeBounds,
  getD3,
  getLifeYears,
  getParentPair,
  isPlaceholderId,
  personName,
  wrapText,
} from './graph-shared.js';

const RADIAL_LAYOUT = {
  fanAngle: (210 * Math.PI) / 180,
  rootRadius: 34,
  ringWidth: 84,
  outerPadding: 22,
  labelPadding: 12,
  labelArcPadding: 10,
  maxFontSize: 14,
  minFontSize: 4.5,
  rootMaxFontSize: 6.5,
  rootMinFontSize: 4.5,
};

const RADIAL_BRANCH_COLORS = ['#8eb6de', '#f1b1a2', '#96d7cf', '#caa0bb'];
const FAN_START_ANGLE = -(RADIAL_LAYOUT.fanAngle / 2);

function polarToCartesian(angle, radius) {
  return {
    x: Math.sin(angle) * radius,
    y: -Math.cos(angle) * radius,
  };
}

function slotIndexFromPath(path) {
  return path.reduce((index, branch) => (index * 2) + branch, 0);
}

function createPlaceholderId(path) {
  return `unknown:radial:${path.length ? path.join('') : 'root'}`;
}

function collectKnownDepth(dataset, personId, trail = new Set()) {
  if (!personId || isPlaceholderId(personId) || trail.has(personId)) {
    return 0;
  }

  const nextTrail = new Set(trail);
  nextTrail.add(personId);

  const parents = getParentPair(dataset, personId, nextTrail.size)
    .filter((parent) => parent?.person_id && !isPlaceholderId(parent.person_id));

  if (!parents.length) {
    return 0;
  }

  return 1 + Math.max(
    ...parents.map((parent) => collectKnownDepth(dataset, parent.person_id, nextTrail))
  );
}

function buildRadialHierarchy(dataset, personId, generation, maxGeneration, path = [], trail = new Set()) {
  const node = {
    kind: 'person',
    id: personId,
    generation,
    path,
    children: [],
  };

  if (generation >= maxGeneration) {
    return node;
  }

  const canFollowKnownPerson = Boolean(personId) && !isPlaceholderId(personId) && !trail.has(personId);
  const nextTrail = new Set(trail);
  if (canFollowKnownPerson) {
    nextTrail.add(personId);
  }

  let parents = [];
  if (canFollowKnownPerson) {
    parents = getParentPair(dataset, personId, generation);
  }

  if (parents.length !== 2) {
    parents = [0, 1].map((branch) => ({
      person_id: createPlaceholderId([...path, branch]),
    }));
  }

  node.children = parents.map((parent, branch) => (
    buildRadialHierarchy(
      dataset,
      parent.person_id,
      generation + 1,
      maxGeneration,
      [...path, branch],
      nextTrail
    )
  ));

  return node;
}

function pastelizeColor(color, amount) {
  const d3 = getD3();
  return d3.interpolateRgb(color, '#ffffff')(amount);
}

function radialBranchColor(path, isPlaceholder, depth) {
  if (isPlaceholder) return '#f4f5f7';
  if (!path.length) return '#e8eef5';

  const first = path[0] ?? 0;
  const second = path[1] ?? first;
  const branchIndex = Math.min(RADIAL_BRANCH_COLORS.length - 1, (first * 2) + second);
  return pastelizeColor(RADIAL_BRANCH_COLORS[branchIndex], Math.min(0.16, depth * 0.02));
}

function fitLabel(fullName, subtitle, thickness, arcLength, options = {}) {
  const isRoot = Boolean(options.isRoot);
  const horizontal = Boolean(options.horizontal);
  const normalizedName = String(fullName || '').trim();
  const normalizedSubtitle = String(subtitle || '').trim();

  if (!normalizedName && !normalizedSubtitle) {
    return {
      fontSize: isRoot ? RADIAL_LAYOUT.rootMinFontSize : RADIAL_LAYOUT.minFontSize,
      lineHeight: (isRoot ? RADIAL_LAYOUT.rootMinFontSize : RADIAL_LAYOUT.minFontSize) * 1.02,
      lines: [],
    };
  }

  const maxFontSize = isRoot ? RADIAL_LAYOUT.rootMaxFontSize : RADIAL_LAYOUT.maxFontSize;
  const minFontSize = isRoot ? RADIAL_LAYOUT.rootMinFontSize : RADIAL_LAYOUT.minFontSize;
  const availableWidth = Math.max(
    24,
    (
      isRoot
        ? ((RADIAL_LAYOUT.rootRadius * 2) * 0.88)
        : horizontal
          ? arcLength * 0.72
          : thickness * 0.82
    ) - (isRoot ? RADIAL_LAYOUT.labelPadding : (RADIAL_LAYOUT.labelPadding * 2))
  );
  const availableHeight = Math.max(
    14,
    (
      isRoot
        ? ((RADIAL_LAYOUT.rootRadius * 2) * 0.72)
        : horizontal
          ? thickness * 0.74
          : arcLength * 0.82
    ) - (isRoot ? RADIAL_LAYOUT.labelArcPadding : (RADIAL_LAYOUT.labelArcPadding * 2))
  );

  let fallbackLayout = null;

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 0.5) {
    const lineHeight = fontSize * (isRoot ? 1.02 : 1.08);
    const widthFactor = isRoot ? 0.48 : 0.58;
    const maxLineLength = Math.max(4, Math.floor(availableWidth / (fontSize * widthFactor)));
    const nameLines = normalizedName ? wrapText(normalizedName, maxLineLength, 99) : [];
    const yearLines = normalizedSubtitle ? wrapText(normalizedSubtitle, Math.max(4, maxLineLength + 2), 99) : [];
    const lines = [
      ...nameLines.map((value) => ({ value, kind: 'name' })),
      ...yearLines.map((value) => ({ value, kind: 'years' })),
    ];
    const longestLine = Math.max(...lines.map((line) => line.value.length), 0);
    const estimatedLineWidth = longestLine * fontSize * widthFactor;

    const totalHeight = lines.length * lineHeight;
    const layout = {
      fontSize,
      lineHeight,
      lines,
    };

    if (!fallbackLayout) {
      fallbackLayout = layout;
    }

    if (estimatedLineWidth <= availableWidth && totalHeight <= availableHeight) {
      return layout;
    }
  }

  return fallbackLayout || {
    fontSize: minFontSize,
    lineHeight: minFontSize * 1.08,
    lines: normalizedName ? [{ value: normalizedName, kind: 'name' }] : [],
  };
}

function shouldUseRootParallelRotation(node) {
  if (node.isRoot || node.generation > 3) return false;

  const angleDegrees = Math.abs((node.angle * 180) / Math.PI);

  if (node.generation === 1) return true;
  if (node.generation === 2) return angleDegrees <= 40;
  if (node.generation === 3) return angleDegrees <= 55;
  return false;
}

function adjustRootParallelRotation(node, angleDegrees) {
  let rotation = angleDegrees;

  // Push the outer pair of the central 3rd-generation sectors a bit
  // farther away from horizontal while preserving mirrored direction.
  if (node.generation === 3 && Math.abs(angleDegrees) >= 24) {
    rotation *= 1.8;
  }

  return rotation;
}

function collectSectorBoundAngles(startAngle, endAngle) {
  const angles = [startAngle, endAngle];
  const criticalAngles = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI];

  for (const angle of criticalAngles) {
    if (angle > startAngle && angle < endAngle) {
      angles.push(angle);
    }
  }

  return angles;
}

function createRadialNode(dataset, entry) {
  const isRoot = entry.generation === 0;
  const isPlaceholder = isPlaceholderId(entry.id);
  const fullName = isPlaceholder ? '' : personName(dataset, entry.id);
  const person = isPlaceholder ? null : dataset.people.get(entry.id);
  const subtitle = isPlaceholder ? '' : getLifeYears(person);

  if (isRoot) {
    const labelLayout = fitLabel(fullName, subtitle, RADIAL_LAYOUT.rootRadius * 2, RADIAL_LAYOUT.rootRadius * 2, {
      isRoot: true,
    });

    return {
      id: entry.id,
      kind: 'radial-person',
      isRoot: true,
      generation: entry.generation,
      isPlaceholder,
      fullName,
      subtitle,
      title: fullName ? `${fullName}${subtitle ? `\n${subtitle}` : ''}` : '',
      startAngle: null,
      endAngle: null,
      innerRadius: 0,
      outerRadius: RADIAL_LAYOUT.rootRadius,
      fill: radialBranchColor(entry.path || [], isPlaceholder, 0),
      stroke: '#6f7a85',
      path: entry.path || [],
      angle: 0,
      x: 0,
      y: 0,
      focusX: 0,
      focusY: 0,
      labelLayout,
      minX: -RADIAL_LAYOUT.rootRadius,
      maxX: RADIAL_LAYOUT.rootRadius,
      minY: -RADIAL_LAYOUT.rootRadius,
      maxY: RADIAL_LAYOUT.rootRadius,
    };
  }

  const generation = entry.generation;
  const slotCount = 2 ** generation;
  const slotWidth = RADIAL_LAYOUT.fanAngle / slotCount;
  const slotIndex = slotIndexFromPath(entry.path);
  const startAngle = FAN_START_ANGLE + (slotIndex * slotWidth);
  const endAngle = startAngle + slotWidth;
  const innerRadius = RADIAL_LAYOUT.rootRadius + ((generation - 1) * RADIAL_LAYOUT.ringWidth);
  const outerRadius = RADIAL_LAYOUT.rootRadius + (generation * RADIAL_LAYOUT.ringWidth);
  const angle = (startAngle + endAngle) / 2;
  const radius = (innerRadius + outerRadius) / 2;
  const { x, y } = polarToCartesian(angle, radius);
  const arcLength = (endAngle - startAngle) * radius;
  const labelLayout = fitLabel(fullName, subtitle, outerRadius - innerRadius, arcLength, {
    horizontal: generation <= 3,
  });
  const boundAngles = collectSectorBoundAngles(startAngle, endAngle);
  const boundPoints = [];

  for (const boundAngle of boundAngles) {
    boundPoints.push(polarToCartesian(boundAngle, innerRadius));
    boundPoints.push(polarToCartesian(boundAngle, outerRadius));
  }

  return {
    id: entry.id,
    kind: 'radial-person',
    isRoot: false,
    generation,
    isPlaceholder,
    fullName,
    subtitle,
    title: fullName ? `${fullName}${subtitle ? `\n${subtitle}` : ''}` : '',
    startAngle,
    endAngle,
    innerRadius,
    outerRadius,
    fill: radialBranchColor(entry.path || [], isPlaceholder, generation),
    stroke: '#6f7a85',
    path: entry.path || [],
    angle,
    x,
    y,
    focusX: x,
    focusY: y,
    labelLayout,
    minX: Math.min(...boundPoints.map((point) => point.x)),
    maxX: Math.max(...boundPoints.map((point) => point.x)),
    minY: Math.min(...boundPoints.map((point) => point.y)),
    maxY: Math.max(...boundPoints.map((point) => point.y)),
  };
}

function flattenHierarchy(node, nodes = []) {
  nodes.push(node);
  for (const child of node.children || []) {
    flattenHierarchy(child, nodes);
  }
  return nodes;
}

export function buildRadialGraph(dataset, rootId) {
  const maxGeneration = Math.max(1, collectKnownDepth(dataset, rootId));
  const hierarchyData = buildRadialHierarchy(dataset, rootId, 0, maxGeneration);
  const flatHierarchy = flattenHierarchy(hierarchyData);
  const nodes = flatHierarchy.map((entry) => createRadialNode(dataset, entry));
  const rawBounds = computeBounds(nodes);
  const bounds = {
    minX: rawBounds.minX - RADIAL_LAYOUT.outerPadding,
    minY: rawBounds.minY - RADIAL_LAYOUT.outerPadding,
    maxX: rawBounds.maxX + RADIAL_LAYOUT.outerPadding,
    maxY: rawBounds.maxY + RADIAL_LAYOUT.outerPadding,
  };

  bounds.width = Math.max(1, bounds.maxX - bounds.minX);
  bounds.height = Math.max(1, bounds.maxY - bounds.minY);

  return {
    visualization: 'radial',
    mode: 'ancestor',
    focusNodeId: rootId,
    rootNodeId: rootId,
    nodes,
    bounds,
  };
}

export class D3RadialNetwork extends BaseD3Network {
  draw() {
    const d3 = getD3();
    const rootNodes = this.graphData.nodes.filter((node) => node.isRoot);
    const sectorNodes = this.graphData.nodes.filter((node) => !node.isRoot);

    this.segmentLayer = this.viewport.append('g').attr('class', 'radial-segment-layer');
    this.labelLayer = this.viewport.append('g').attr('class', 'radial-label-layer');
    this.arcGenerator = d3.arc();

    this.rootSelection = this.segmentLayer
      .selectAll('circle')
      .data(rootNodes, (node) => node.id)
      .join('circle')
      .attr('class', (node) => `radial-root${node.isPlaceholder ? ' is-placeholder' : ''}`)
      .attr('cx', 0)
      .attr('cy', 0)
      .attr('r', (node) => node.outerRadius)
      .attr('fill', (node) => node.fill)
      .attr('stroke', (node) => node.stroke)
      .on('click', (event, node) => {
        event.stopPropagation();
        this.handlers.onSelect?.(node.id);
      });

    this.segmentSelection = this.segmentLayer
      .selectAll('path')
      .data(sectorNodes, (node) => node.id)
      .join('path')
      .attr('class', (node) => `radial-arc${node.isPlaceholder ? ' is-placeholder' : ''}`)
      .attr('d', (node) => this.arcGenerator({
        startAngle: node.startAngle,
        endAngle: node.endAngle,
        innerRadius: node.innerRadius,
        outerRadius: node.outerRadius,
      }))
      .attr('fill', (node) => node.fill)
      .attr('stroke', (node) => node.stroke)
      .on('click', (event, node) => {
        event.stopPropagation();
        this.handlers.onSelect?.(node.id);
      });

    this.labelSelection = this.labelLayer
      .selectAll('g')
      .data(this.graphData.nodes, (node) => node.id)
      .join('g')
      .attr('class', (node) => `radial-label${node.isRoot ? ' is-root' : ''}${node.isPlaceholder ? ' is-placeholder' : ''}`)
      .attr('transform', (node) => this.labelTransform(node))
      .style('pointer-events', 'none');

    this.labelSelection.each(function renderLabel(node) {
      const group = d3.select(this);
      const lines = node.labelLayout?.lines || [];
      const lineHeight = node.labelLayout?.lineHeight || 12;
      const totalHeight = Math.max(0, (lines.length - 1) * lineHeight);

      group.selectAll('*').remove();

      lines.forEach((line, index) => {
        group.append('text')
          .attr('class', line.kind === 'years' ? 'radial-label-years' : 'radial-label-line')
          .attr('y', (index * lineHeight) - (totalHeight / 2))
          .style('font-size', `${line.kind === 'years'
            ? Math.max(4, (node.labelLayout?.fontSize || 10) * 0.82)
            : (node.labelLayout?.fontSize || 10)}px`)
          .text(line.value);
      });
    });
  }

  labelTransform(node) {
    if (node.isRoot) {
      return 'translate(0 0)';
    }

    const radius = (node.innerRadius + node.outerRadius) / 2;
    const { x, y } = polarToCartesian(node.angle, radius);
    const angleDegrees = (node.angle * 180) / Math.PI;
    let rotation = angleDegrees - 90;
    const usesRootParallelRotation = shouldUseRootParallelRotation(node);

    if (rotation < -90) rotation += 180;
    if (rotation > 90) rotation -= 180;

    if (usesRootParallelRotation) {
      rotation = adjustRootParallelRotation(node, angleDegrees);
    }

    if (node.generation <= 1) {
      rotation = Math.max(-10, Math.min(10, rotation));
    } else if (node.generation === 2) {
      rotation = Math.max(-18, Math.min(18, rotation));
    } else if (node.generation === 3) {
      const limit = usesRootParallelRotation ? 40 : 28;
      rotation = Math.max(-limit, Math.min(limit, rotation));
    }

    return `translate(${x} ${y}) rotate(${rotation})`;
  }

  updateSelection() {
    this.rootSelection.classed('is-selected', (node) => this.selectedNodeIds.has(node.id));
    this.segmentSelection.classed('is-selected', (node) => this.selectedNodeIds.has(node.id));
    this.labelSelection.classed('is-selected', (node) => this.selectedNodeIds.has(node.id));
  }
}
