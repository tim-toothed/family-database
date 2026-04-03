import {
  BaseD3Network,
  computeBounds,
  getD3,
  getParentPair,
  isPlaceholderId,
  makePersonGraphNode,
} from './graph-shared.js';

const TREE_LAYOUT = {
  generationGapY: 200,
  horizontalNodeStep: 196 + 34,
  sameCoupleSeparation: 0.98,
  branchSeparation: 1.08,
};

function buildTreeHierarchy(dataset, personId, generation, trail = new Set()) {
  const node = {
    kind: 'person',
    id: personId,
    generation,
    children: [],
  };

  if (isPlaceholderId(personId) || trail.has(personId)) {
    return node;
  }

  const nextTrail = new Set(trail);
  nextTrail.add(personId);

  const parents = getParentPair(dataset, personId, generation);
  if (parents.length !== 2) {
    return node;
  }

  node.children = [
    {
      kind: 'couple',
      id: `couple:${personId}:${generation + 1}`,
      childId: personId,
      generation: generation + 1,
      parentIds: parents.map((parent) => parent.person_id),
      children: parents.map((parent) => (
        buildTreeHierarchy(dataset, parent.person_id, generation + 1, nextTrail)
      )),
    },
  ];

  return node;
}

export function buildAncestralGraph(dataset, rootId) {
  const d3 = getD3();
  const hierarchyData = buildTreeHierarchy(dataset, rootId, 0);
  const hierarchyRoot = d3.hierarchy(hierarchyData, (node) => node.children);
  const layoutRoot = d3.tree()
    .nodeSize([TREE_LAYOUT.horizontalNodeStep, 1])
    .separation((left, right) => (
      left.parent === right.parent
        ? TREE_LAYOUT.sameCoupleSeparation
        : TREE_LAYOUT.branchSeparation
    ))(hierarchyRoot);

  const nodes = [];
  const couples = [];

  for (const entry of layoutRoot.descendants()) {
    const { data } = entry;
    if (data.kind === 'person') {
      const x = entry.x - layoutRoot.x;
      const y = -(data.generation * TREE_LAYOUT.generationGapY);
      const node = makePersonGraphNode(dataset, data.id, x, y);
      nodes.push({
        ...node,
        minX: node.x - (node.width / 2),
        maxX: node.x + (node.width / 2),
        minY: node.y - (node.height / 2),
        maxY: node.y + (node.height / 2),
      });
      continue;
    }

    couples.push({
      childId: data.childId,
      parentIds: data.parentIds,
    });
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const links = [];

  for (const couple of couples) {
    const [firstParentId, secondParentId] = couple.parentIds;
    const firstParent = nodesById.get(firstParentId);
    const secondParent = nodesById.get(secondParentId);
    const child = nodesById.get(couple.childId);

    if (!child) continue;

    if (firstParent && secondParent) {
      const leftParent = firstParent.x <= secondParent.x ? firstParent : secondParent;
      const rightParent = leftParent === firstParent ? secondParent : firstParent;
      const spouseY = leftParent.y;
      const leftX = leftParent.x + (leftParent.width / 2);
      const rightX = rightParent.x - (rightParent.width / 2);
      const midX = (leftParent.x + rightParent.x) / 2;
      const childTopY = child.y - (child.height / 2);

      links.push({
        id: `link:${couple.childId}`,
        type: 'couple',
        leftX,
        rightX,
        midX,
        spouseY,
        childTopY,
        minX: Math.min(leftX, rightX, midX),
        maxX: Math.max(leftX, rightX, midX),
        minY: Math.min(spouseY, childTopY),
        maxY: Math.max(spouseY, childTopY),
      });
      continue;
    }

    const parent = firstParent || secondParent;
    if (!parent) continue;

    const parentBottomY = parent.y + (parent.height / 2);
    const childTopY = child.y - (child.height / 2);
    links.push({
      id: `link:${couple.childId}:single`,
      type: 'single',
      x: parent.x,
      parentBottomY,
      childTopY,
      minX: parent.x,
      maxX: parent.x,
      minY: Math.min(parentBottomY, childTopY),
      maxY: Math.max(parentBottomY, childTopY),
    });
  }

  return {
    visualization: 'tree',
    mode: 'ancestor',
    focusNodeId: rootId,
    rootNodeId: rootId,
    nodes,
    links,
    bounds: computeBounds(nodes, links),
  };
}

export class D3TreeNetwork extends BaseD3Network {
  draw() {
    const d3 = getD3();

    this.linkLayer = this.viewport.append('g').attr('class', 'tree-link-layer');
    this.nodeLayer = this.viewport.append('g').attr('class', 'tree-node-layer');

    for (const link of this.graphData.links) {
      if (link.type === 'couple') {
        this.linkLayer.append('line')
          .attr('class', 'tree-link')
          .attr('x1', link.leftX)
          .attr('y1', link.spouseY)
          .attr('x2', link.rightX)
          .attr('y2', link.spouseY);

        this.linkLayer.append('line')
          .attr('class', 'tree-link')
          .attr('x1', link.midX)
          .attr('y1', link.spouseY)
          .attr('x2', link.midX)
          .attr('y2', link.childTopY);
        continue;
      }

      this.linkLayer.append('line')
        .attr('class', 'tree-link')
        .attr('x1', link.x)
        .attr('y1', link.parentBottomY)
        .attr('x2', link.x)
        .attr('y2', link.childTopY);
    }

    this.nodeSelection = this.nodeLayer
      .selectAll('foreignObject')
      .data(this.graphData.nodes, (node) => node.id)
      .join('foreignObject')
      .attr('class', 'tree-node')
      .attr('x', (node) => node.x - (node.width / 2))
      .attr('y', (node) => node.y - (node.height / 2))
      .attr('width', (node) => node.width)
      .attr('height', (node) => node.height)
      .style('overflow', 'visible')
      .on('click', (event, node) => {
        event.stopPropagation();
        this.handlers.onSelect?.(node.id);
      });

    this.nodeSelection.each(function renderNode(node) {
      const foreignObject = d3.select(this);
      const content = foreignObject.append('xhtml:div')
        .attr('class', `tree-card${node.isPlaceholder ? ' is-placeholder' : ''}`)
        .style('background', node.color.background)
        .style('border-color', node.color.border)
        .style('color', node.isPlaceholder ? '#64748b' : '#334155')
        .style('font-size', `${node.fontSize}px`)
        .attr('title', node.title);

      const name = content.append('xhtml:div').attr('class', 'tree-card-name');
      for (const line of node.nameLines) {
        name.append('xhtml:div').text(line);
      }

      if (node.subtitle) {
        content.append('xhtml:div')
          .attr('class', 'tree-card-years')
          .text(node.subtitle);
      }
    });
  }

  updateSelection() {
    this.nodeSelection
      .select('.tree-card')
      .classed('is-selected', (node) => this.selectedNodeIds.has(node.id));
  }
}
