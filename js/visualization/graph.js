import { GRAPH_VISUALIZATIONS, getGraphVisualizationLabel } from './graph-shared.js';
import { buildAncestralGraph, D3TreeNetwork } from './graph-ancestral.js';
import { buildPanoramaGraph, D3PanoramaNetwork } from './graph-panorama.js';
import { buildRadialGraph, D3RadialNetwork } from './graph-radial.js';

export { GRAPH_VISUALIZATIONS, getGraphVisualizationLabel };

export function buildGraph(dataset, options = {}) {
  const rootId = options.rootId || dataset.people.keys().next().value;
  const visualization = options.visualization || 'tree';

  if (visualization === 'radial') {
    return buildRadialGraph(dataset, rootId);
  }

  if (visualization === 'panorama') {
    return buildPanoramaGraph(dataset, rootId);
  }

  return buildAncestralGraph(dataset, rootId);
}

export function createNetwork(container, graphData, handlers = {}) {
  if (graphData.visualization === 'radial') {
    return new D3RadialNetwork(container, graphData, handlers);
  }

  if (graphData.visualization === 'panorama') {
    return new D3PanoramaNetwork(container, graphData, handlers);
  }

  return new D3TreeNetwork(container, graphData, handlers);
}
