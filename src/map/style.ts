/** Map style: bundled globe base map + layers fed by the on-phone tile generators. */
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from 'maplibre-gl';
import world from '../assets/world.json';

// Text is drawn on the phone from its own system font (no glyph files).  MapLibre
// picks weight/style from the first family name; unknown names fall back to sans-serif.
export const FONT = ['Roboto'];
export const FONT_BOLD = ['Roboto-Bold'];
export const FONT_ITALIC = ['Roboto-Italic'];

export interface StyleOptions {
  bounds: [number, number, number, number] | null; // union of loaded regions
}

const z = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'], ...stops.flat()] as unknown as ExpressionSpecification;

const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

export function buildStyle(o: StyleOptions): StyleSpecification {
  const b = o.bounds ?? [140, -40, 150, -33];
  const tiled = !!o.bounds;
  const sources: StyleSpecification['sources'] = {
    world: { type: 'geojson', data: world as GeoJSON.FeatureCollection, maxzoom: 10, tolerance: 0.6 },
    regions: { type: 'geojson', data: empty },
    gps: { type: 'geojson', data: empty },
    waypoints: { type: 'geojson', data: empty },
    measure: { type: 'geojson', data: empty },
    route: { type: 'geojson', data: empty },
    focus: { type: 'geojson', data: empty },
  };
  if (tiled) {
    sources.dem = { type: 'raster-dem', tiles: ['topo-dem://{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', minzoom: 5, maxzoom: 12, bounds: b };
    sources.slope = { type: 'raster', tiles: ['topo-slope://{z}/{x}/{y}'], tileSize: 256, minzoom: 10, maxzoom: 14, bounds: b };
    sources.contours = { type: 'vector', tiles: ['topo-contour://{z}/{x}/{y}'], minzoom: 10, maxzoom: 15, bounds: b };
    sources.vec = { type: 'vector', tiles: ['topo-vec://{z}/{x}/{y}'], minzoom: 6, maxzoom: 14, bounds: b };
  }
  const layers: LayerSpecification[] = [
    { id: 'sea', type: 'background', paint: { 'background-color': '#9fcbe8' } },
    { id: 'land', type: 'fill', source: 'world', filter: ['==', ['get', 'k'], 'land'], paint: { 'fill-color': '#f2eee3' } },
    { id: 'ne-lakes', type: 'fill', source: 'world', filter: ['==', ['get', 'k'], 'lake'], maxzoom: 10, paint: { 'fill-color': '#9fcbe8' } },
  ];
  if (tiled) {
    layers.push(
      { id: 'hillshade', type: 'hillshade', source: 'dem', minzoom: 5, paint: {
        'hillshade-exaggeration': z([[6, 0.35], [10, 0.5], [14, 0.6]]),
        'hillshade-shadow-color': '#2f3a40', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#3a3a3a',
        'hillshade-illumination-direction': 315, 'hillshade-illumination-anchor': 'map',
        'hillshade-method': 'multidirectional',
      } },
      { id: 'slope', type: 'raster', source: 'slope', minzoom: 10, paint: { 'raster-opacity': z([[10, 0], [11, 0.85]]), 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      { id: 'water-area', type: 'fill', source: 'vec', 'source-layer': 'water_areas', paint: {
        'fill-color': ['match', ['get', 'cls'], 3, '#b5dbe6', '#89c2ea'],
        'fill-outline-color': '#2f7fc8',
      } },
      { id: 'water-line', type: 'line', source: 'vec', 'source-layer': 'water_lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ['match', ['get', 'cls'], 2, '#4a90d9', '#1f73c8'],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          8, ['match', ['get', 'cls'], 0, 1.2, 3, 1.2, 0.4],
          12, ['match', ['get', 'cls'], 0, 2.2, 3, 2.2, 0.8],
          14, ['match', ['get', 'cls'], 0, 3, 3, 3, 1.3],
          17, ['match', ['get', 'cls'], 0, 5, 3, 5, 2.4]],
        'line-dasharray': ['match', ['get', 'cls'], 2, ['literal', [3, 1.5]], ['literal', [1, 0]]],
      } },
      { id: 'contour-minor', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['==', ['get', 'idx'], 0], paint: {
        'line-color': '#a8662e', 'line-opacity': 0.75, 'line-width': z([[10, 0.4], [14, 0.7], [17, 1.1]]),
      } },
      { id: 'contour-index', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['==', ['get', 'idx'], 1], paint: {
        'line-color': '#8a4511', 'line-opacity': 0.9, 'line-width': z([[10, 0.9], [14, 1.4], [17, 2]]),
      } },
      // roads, tracks, paths
      { id: 'road-casing', type: 'line', source: 'vec', 'source-layer': 'roads', filter: ['<=', ['get', 'cls'], 6], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': '#5f5f5f',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['match', ['get', 'cls'], [0, 1], 2.4, 2, 2, 1.2], 13, ['match', ['get', 'cls'], [0, 1, 2], 6, [3, 4], 5, 3.4], 17, ['match', ['get', 'cls'], [0, 1, 2], 13, [3, 4], 11, 8]],
      } },
      { id: 'road-fill', type: 'line', source: 'vec', 'source-layer': 'roads', filter: ['<=', ['get', 'cls'], 6], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ['match', ['get', 'cls'], [0, 1], '#f07b1b', 2, '#f5a623', 3, '#f8cc5a', 4, '#fff1a8', '#ffffff'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['match', ['get', 'cls'], [0, 1], 1.6, 2, 1.2, 0.6], 13, ['match', ['get', 'cls'], [0, 1, 2], 4.4, [3, 4], 3.6, 2.2], 17, ['match', ['get', 'cls'], [0, 1, 2], 10.5, [3, 4], 9, 6]],
      } },
      { id: 'track', type: 'line', source: 'vec', 'source-layer': 'roads', filter: ['==', ['get', 'cls'], 7], layout: { 'line-join': 'round' }, paint: {
        'line-color': '#5b3a10', 'line-width': z([[10, 1], [14, 1.8], [17, 3]]), 'line-dasharray': [3, 1.6],
      } },
      { id: 'path', type: 'line', source: 'vec', 'source-layer': 'roads', filter: ['>=', ['get', 'cls'], 8], layout: { 'line-join': 'round' }, paint: {
        'line-color': ['match', ['get', 'cls'], 10, '#1565c0', '#c4161c'],
        'line-width': z([[12, 1.2], [14, 1.8], [17, 3]]),
        'line-dasharray': ['match', ['get', 'cls'], 12, ['literal', [0.6, 0.8]], ['literal', [2.2, 1.4]]],
      } },
      { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['==', ['get', 'idx'], 1], minzoom: 12, layout: {
        'symbol-placement': 'line', 'text-field': ['to-string', ['get', 'ele']], 'text-font': FONT,
        'text-size': z([[12, 10], [16, 13]]), 'symbol-spacing': 320, 'text-max-angle': 25, 'text-padding': 2,
      }, paint: { 'text-color': '#7a3a0c', 'text-halo-color': '#f6f1e6', 'text-halo-width': 2 } },
      { id: 'water-label', type: 'symbol', source: 'vec', 'source-layer': 'water_lines', filter: ['has', 'name'], minzoom: 12, layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT_ITALIC, 'text-size': z([[12, 11], [16, 14]]),
        'symbol-spacing': 400, 'text-max-angle': 30,
      }, paint: { 'text-color': '#124f99', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 } },
      { id: 'road-label', type: 'symbol', source: 'vec', 'source-layer': 'roads', filter: ['has', 'name'], minzoom: 13, layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': z([[13, 11], [17, 14]]),
        'symbol-spacing': 350, 'text-max-angle': 30,
      }, paint: { 'text-color': '#1d1d1d', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
      { id: 'poi', type: 'symbol', source: 'vec', 'source-layer': 'pois', layout: {
        'text-field': ['concat',
          ['match', ['get', 't'], 1, '▲', 2, '⋈', 3, '◖', 4, '⌂', 5, '⌂', 6, '△', 7, '◉', 8, '✱', 9, 'WC', 10, '≋', 11, '≈', 12, '◍', '•'],
          ['case', ['has', 'name'], ['concat', ' ', ['get', 'name']], ''],
          ['case', ['has', 'ele'], ['concat', '\n', ['to-string', ['get', 'ele']], ' m'], ''],
        ],
        'text-font': FONT_BOLD, 'text-size': z([[11, 11], [16, 14]]), 'text-anchor': 'left', 'text-justify': 'left', 'text-offset': [-0.4, 0],
        'text-padding': 4, 'symbol-sort-key': ['match', ['get', 't'], 1, 0, 4, 1, 10, 2, 5],
      }, paint: {
        'text-color': ['match', ['get', 't'], [7, 10, 11, 12], '#0d4f9e', 1, '#3b2414', '#3b2414'],
        'text-halo-color': '#ffffff', 'text-halo-width': 2,
      } },
    );
  }
  layers.push(
    { id: 'vic-fill', type: 'fill', source: 'regions', filter: ['==', ['get', 'k'], 'vic'], maxzoom: 9, paint: { 'fill-color': '#ffd56b', 'fill-opacity': z([[2, 0.55], [8, 0.15], [9, 0]]) } },
    { id: 'state-border', type: 'line', source: 'world', filter: ['==', ['get', 'k'], 'state'], paint: { 'line-color': '#6d4c8d', 'line-width': z([[3, 0.6], [9, 1.6], [14, 2.2]]), 'line-dasharray': [4, 2] } },
    { id: 'country-border', type: 'line', source: 'world', filter: ['==', ['get', 'k'], 'border'], maxzoom: 8, paint: { 'line-color': '#7d7d7d', 'line-width': 0.8 } },
    { id: 'cell-outline', type: 'line', source: 'regions', filter: ['==', ['get', 'k'], 'cell'], minzoom: 4, maxzoom: 11, paint: { 'line-color': '#4a5b6d', 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': z([[4, 0], [5, 0.7], [10, 0.7], [11, 0]]) } },
    { id: 'loaded-fill', type: 'fill', source: 'regions', filter: ['==', ['get', 'k'], 'loaded'], paint: { 'fill-color': '#ff8f00', 'fill-opacity': z([[1, 0.55], [7, 0.3], [9, 0]]) } },
    { id: 'loaded-outline', type: 'line', source: 'regions', filter: ['==', ['get', 'k'], 'loaded'], paint: { 'line-color': '#c43e00', 'line-width': z([[1, 2], [8, 2.5], [12, 2]]), 'line-opacity': z([[10, 1], [13, 0.5]]) } },
    { id: 'cell-label', type: 'symbol', source: 'regions', filter: ['any', ['==', ['get', 'k'], 'cell'], ['==', ['get', 'k'], 'loaded']], minzoom: 5.5, maxzoom: 9.5, layout: {
      'text-field': ['concat', ['get', 'id'], '\n', ['get', 'name']], 'text-font': FONT_BOLD, 'text-size': 12, 'text-max-width': 9, 'text-allow-overlap': false,
    }, paint: { 'text-color': ['case', ['==', ['get', 'k'], 'loaded'], '#7a2400', '#334455'], 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
    { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#003d1f', 'line-width': z([[8, 4], [14, 8], [17, 12]]) } },
    { id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00c060', 'line-width': z([[8, 2.4], [14, 5], [17, 8]]) } },
    { id: 'measure-line', type: 'line', source: 'measure', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5b0f8a', 'line-width': z([[8, 2.5], [14, 4]]) } },
    { id: 'measure-area', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#7b1fa2', 'fill-opacity': 0.18 } },
    { id: 'measure-pts', type: 'circle', source: 'measure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#5b0f8a', 'circle-stroke-width': 3 } },
    { id: 'focus', type: 'circle', source: 'focus', paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#111111', 'circle-stroke-width': 3 } },
    { id: 'wpt', type: 'circle', source: 'waypoints', paint: { 'circle-radius': z([[5, 5], [14, 8]]), 'circle-color': '#d0105a', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
    { id: 'wpt-label', type: 'symbol', source: 'waypoints', minzoom: 9, layout: { 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 14, 'text-offset': [0, 1.3], 'text-anchor': 'top' }, paint: { 'text-color': '#8a0038', 'text-halo-color': '#ffffff', 'text-halo-width': 2.2 } },
    { id: 'gps-acc', type: 'fill', source: 'gps', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#1e88e5', 'fill-opacity': 0.16 } },
    { id: 'gps-acc-line', type: 'line', source: 'gps', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#1565c0', 'line-width': 1.5 } },
    { id: 'gps-dot', type: 'circle', source: 'gps', filter: ['==', ['geometry-type'], 'Point'], paint: {
      'circle-radius': 9, 'circle-color': ['case', ['get', 'stale'], '#90a4ae', '#1565c0'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3.5,
    } },
  );
  return {
    version: 8,
    name: 'Topo Globe',
    projection: { type: 'globe' },
    sky: { 'sky-color': '#b9dcff', 'horizon-color': '#eaf4ff', 'fog-color': '#eaf4ff', 'atmosphere-blend': z([[0, 1], [5, 1], [8, 0]]) } as StyleSpecification['sky'],
    sources,
    layers,
  };
}
