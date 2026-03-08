function addEdgeSafe(edges, seen, from, to, relation, dashes = false) {
  if (!from || !to || from === '???' || to === '???') return;
  const edgeId = [from, to].sort().join('::') + `::${relation}`;
  if (seen.has(edgeId)) return;
  seen.add(edgeId);
  edges.push({ from, to, label: relation, dashes, font: { align: 'top', size: 10 } });
}

export function buildGraph(dataset) {
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();

  for (const [id, name] of dataset.indexById.entries()) {
    const person = dataset.people.get(id);
    const subtitle = person?.birth?.date || id;

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
    });
  }

  for (const [id, person] of dataset.people.entries()) {
    for (const parent of person.parents || []) {
      addEdgeSafe(edges, seenEdges, parent.person_id, id, parent.relation_type || 'родитель');
    }

    for (const sibling of person.siblings || []) {
      addEdgeSafe(edges, seenEdges, id, sibling.person_id, sibling.relation_type || 'сиблинг', true);
    }

    for (const spouse of person.spouses || []) {
      addEdgeSafe(edges, seenEdges, id, spouse.person_id, 'брак');
    }

    for (const child of person.children || []) {
      addEdgeSafe(edges, seenEdges, id, child.person_id, child.relation_type || 'ребёнок');
      if (child.second_parent_id && child.second_parent_id !== '???') {
        addEdgeSafe(edges, seenEdges, child.second_parent_id, child.person_id, 'родитель');
      }
    }
  }

  return { nodes, edges };
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
      },
      layout: {
        improvedLayout: true,
      },
      physics: {
        stabilization: true,
        barnesHut: {
          gravitationalConstant: -7000,
          springLength: 150,
          springConstant: 0.03,
        },
      },
      edges: {
        color: '#95a2bd',
        smooth: {
          type: 'dynamic',
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
