import { createBasemap } from './basemap.js';
import { filterTracks, trackSegments, unwrapLongitude } from './track-geometry.js';
import { DatasetCollection } from './dataset-collection.js';
import { FileLoader } from './file-loader.js';

const $ = id => document.getElementById(id);
const number = value => value.toLocaleString();
const date = value => Number.isFinite(value) ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
const pause = () => new Promise(resolve => requestAnimationFrame(resolve));
const PAGE_SIZE = 50;
const datasets = new DatasetCollection();
let matches = [];
let page = 0;
let loader;
let batchAddedFiles = false;
let map;
let basemap;
let layer = null;
let popup;
let renderId = 0;
let selected = null;
let visibleExtent = null;
let searchTimer;

function reportError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function windText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} kt` : '—';
}

function detailList(element, entries) {
  element.replaceChildren();
  for (const [label, value] of entries) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    element.append(term, description);
  }
}

function closePopup() {
  popup?.setPosition(undefined);
  $('popup').hidden = true;
}

function clearMap(message = 'Map cleared. Your files are still open.') {
  renderId += 1;
  if (layer) map.removeLayer(layer);
  layer = null;
  visibleExtent = null;
  selected = null;
  closePopup();
  $('selected-track').hidden = true;
  $('fit-map').disabled = true;
  $('map-status').textContent = message;
}

function clearFiles() {
  clearMap('Add files to explore their tracks');
  datasets.clear();
  loader.cancel();
  refreshSources();
  $('file-input').value = '';
  reportError('');
}

function options(element, values, allLabel) {
  const previous = element.value;
  element.replaceChildren(new Option(allLabel, 'ALL'), ...values.map(value => new Option(value.label ?? value, value.id ?? value)));
  element.value = [...element.options].some(option => option.value === previous) ? previous : 'ALL';
}

function resetFilters() {
  $('search').value = '';
  $('basin').value = 'ALL';
  $('realization').value = 'ALL';
  $('source-file').value = 'ALL';
  $('year-start').value = datasets.stats.minYear ?? '';
  $('year-end').value = datasets.stats.maxYear ?? '';
  updateMatches();
}

function updateMatches() {
  clearTimeout(searchTimer);
  matches = filterTracks(datasets.tracks, {
    query: $('search').value,
    basin: $('basin').value,
    realization: $('realization').value,
    sourceId: $('source-file').value,
    startYear: $('year-start').value,
    endYear: $('year-end').value,
  });
  page = 0;
  $('match-count').textContent = datasets.sources.size ? `${number(matches.length)} of ${number(datasets.tracks.length)} tracks match. Use Plot to update the map.` : '';
  $('plot-tracks').disabled = matches.length === 0;
  renderList();
}

function renderList() {
  $('track-list').replaceChildren();
  $('results-count').textContent = number(matches.length);
  $('empty-results').hidden = matches.length > 0;
  $('empty-results').textContent = datasets.sources.size ? 'No tracks match these filters.' : 'Add files to browse their tracks.';
  const start = page * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (const track of matches.slice(start, start + PAGE_SIZE)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'track-button';
    button.setAttribute('aria-current', String(selected?.key === track.key));
    const title = document.createElement('strong');
    title.textContent = track.id;
    const subtitle = document.createElement('small');
    subtitle.textContent = `${track.year} · realization ${track.realization} · ${track.validCount} points`;
    const source = document.createElement('small');
    source.className = 'track-file';
    source.style.setProperty('--file-color', track.color);
    source.textContent = track.sourceName;
    source.title = track.sourceName;
    button.style.setProperty('--file-color', track.color);
    button.append(title, subtitle, source);
    button.addEventListener('click', () => selectTrack(track));
    item.append(button);
    fragment.append(item);
  }
  $('track-list').append(fragment);
  $('pagination').hidden = matches.length <= PAGE_SIZE;
  $('previous-page').disabled = page === 0;
  $('next-page').disabled = start + PAGE_SIZE >= matches.length;
  $('page-status').textContent = `${number(start + 1)}–${number(Math.min(start + PAGE_SIZE, matches.length))} of ${number(matches.length)}`;
}

function fitTracks() {
  if (!visibleExtent || ol.extent.isEmpty(visibleExtent)) return;
  map.getView().fit(visibleExtent, { padding: [85, 45, 45, 45], maxZoom: 8, duration: 400 });
}

function projectedSegments(track) {
  return trackSegments(datasets.dataFor(track), track).map(segment => segment.map(point => ol.proj.fromLonLat(point)));
}

function mapFeature(track) {
  const segments = projectedSegments(track);
  const lines = segments.filter(segment => segment.length > 1);
  const singletons = segments.filter(segment => segment.length === 1).map(segment => segment[0]);
  const geometries = [];
  if (lines.length) geometries.push(new ol.geom.MultiLineString(lines));
  if (singletons.length) geometries.push(new ol.geom.MultiPoint(singletons));
  if (!geometries.length) return null;
  return new ol.Feature({ geometry: new ol.geom.GeometryCollection(geometries), track });
}

async function plotMatches() {
  if (!datasets.sources.size) return;
  updateMatches();
  clearMap();
  renderList();
  const id = renderId;
  const tracks = matches.slice();
  if (!tracks.length) {
    $('map-status').textContent = 'No tracks match these filters.';
    return;
  }
  const source = new ol.source.Vector({ wrapX: true });
  const styles = new Map([...datasets.sources.values()].map(file => {
    const color = ol.color.asArray(file.color).slice();
    color[3] = 0.5;
    return [file.id, new ol.style.Style({
      stroke: new ol.style.Stroke({ color, width: 1.25 }),
      image: new ol.style.Circle({ radius: 2, fill: new ol.style.Fill({ color: file.color }) }),
    })];
  }));
  // Cache the aggregate as an image while panning; detail views keep vector point hit detection.
  layer = new ol.layer.VectorImage({ source, style: feature => styles.get(feature.get('track').sourceId), imageRatio: 1.3 });
  $('map-status').textContent = `Drawing ${number(tracks.length)} tracks…`;
  await pause();
  for (let start = 0; start < tracks.length; start += 400) {
    if (id !== renderId) return;
    const features = tracks.slice(start, start + 400).map(mapFeature).filter(Boolean);
    source.addFeatures(features);
    $('map-status').textContent = `Drawing ${number(Math.min(start + 400, tracks.length))} / ${number(tracks.length)} tracks…`;
    await pause();
  }
  if (id !== renderId) return;
  map.addLayer(layer);
  visibleExtent = source.getExtent();
  $('fit-map').disabled = ol.extent.isEmpty(visibleExtent);
  const fileCount = new Set(tracks.map(track => track.sourceId)).size;
  $('map-status').textContent = `${number(tracks.length)} tracks · ${fileCount} ${fileCount === 1 ? 'file' : 'files'} · click a line to inspect`;
  fitTracks();
}

function selectTrack(track) {
  const dataset = datasets.dataFor(track);
  if (!dataset) return;
  clearMap();
  selected = track;
  const source = new ol.source.Vector({ wrapX: true });
  const line = mapFeature(track);
  if (line) source.addFeature(line);
  let previousLongitude = null;
  let lastPoint;
  for (let index = track.offset; index < track.offset + track.count; index++) {
    let longitude = dataset.lon[index];
    const latitude = dataset.lat[index];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      previousLongitude = null;
      continue;
    }
    longitude = unwrapLongitude(longitude, previousLongitude);
    previousLongitude = longitude;
    const coordinate = ol.proj.fromLonLat([longitude, latitude]);
    lastPoint = coordinate;
    source.addFeature(new ol.Feature({ geometry: new ol.geom.Point(coordinate), track, pointIndex: index }));
  }
  const lineStyle = new ol.style.Style({ stroke: new ol.style.Stroke({ color: track.color, width: 2.3 }) });
  const pointStyle = new ol.style.Style({ image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: track.color }), stroke: new ol.style.Stroke({ color: 'white', width: 1.2 }) }) });
  const labelStyle = new ol.style.Style({ text: new ol.style.Text({ text: track.id, font: '600 12px system-ui', offsetY: -17, fill: new ol.style.Fill({ color: '#27272a' }), stroke: new ol.style.Stroke({ color: 'white', width: 4 }) }) });
  if (lastPoint) source.addFeature(new ol.Feature({ geometry: new ol.geom.Point(lastPoint), isLabel: true }));
  layer = new ol.layer.Vector({ source, style: feature => feature.get('isLabel') ? labelStyle : feature.get('pointIndex') !== undefined ? pointStyle : lineStyle });
  map.addLayer(layer);
  visibleExtent = source.getExtent();
  $('fit-map').disabled = ol.extent.isEmpty(visibleExtent);
  $('selected-track').hidden = false;
  $('selected-track').style.setProperty('--file-color', track.color);
  $('selected-name').textContent = track.id;
  detailList($('selected-details'), [
    ['File', track.sourceName], ['Realization', track.realization], ['Start', date(track.startTime)], ['End', date(track.endTime)],
    ['Points', number(track.validCount)], ['Peak wind', windText(track.maxWind)],
  ]);
  $('map-status').textContent = `${track.id} · realization ${track.realization} · ${number(track.validCount)} points`;
  renderList();
  fitTracks();
}

function showPoint(feature, coordinate) {
  const index = feature.get('pointIndex');
  const track = feature.get('track');
  const dataset = datasets.dataFor(track);
  if (!dataset) return;
  const title = document.createElement('strong');
  title.textContent = track.id;
  const list = document.createElement('dl');
  detailList(list, [
    ['File', track.sourceName], ['Realization', track.realization], ['Time', date(dataset.time[index])],
    ['Latitude', `${dataset.lat[index].toFixed(3)}°`], ['Longitude', `${dataset.lon[index].toFixed(3)}°`],
    ['Wind', windText(dataset.wind[index])],
  ]);
  $('popup-content').replaceChildren(title, list);
  $('popup').hidden = false;
  popup.setPosition(coordinate);
}

function refreshSources(reset = false) {
  const sources = [...datasets.sources.values()];
  const { stats } = datasets;
  $('dataset-summary').textContent = `${stats.fileCount} ${stats.fileCount === 1 ? 'file' : 'files'} · ${number(stats.trackCount)} tracks · ${number(stats.pointCount)} points`;
  const warnings = sources.flatMap(source => source.dataset.warnings.map(warning => `${source.name}: ${warning}`));
  $('dataset-warnings').textContent = warnings.join(' ');
  $('dataset-warnings').hidden = warnings.length === 0;
  $('dataset-info').hidden = sources.length === 0;
  $('clear-files').hidden = sources.length === 0 && !loader?.busy;
  $('track-controls').disabled = sources.length === 0;
  $('welcome').hidden = sources.length > 0 || loader?.busy;
  $('file-list').replaceChildren();
  for (const source of sources) {
    const item = document.createElement('li');
    item.className = 'file-row';
    const swatch = document.createElement('span');
    swatch.className = 'file-swatch';
    swatch.style.setProperty('--file-color', source.color);
    swatch.setAttribute('aria-hidden', 'true');
    const description = document.createElement('div');
    description.className = 'file-description';
    const name = document.createElement('strong');
    name.textContent = source.name;
    name.title = source.name;
    const summary = document.createElement('small');
    summary.textContent = `${number(source.dataset.stats.trackCount)} tracks · ${(source.size / 1024 ** 2).toFixed(1)} MiB`;
    description.append(name, summary);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${source.name}`);
    remove.title = `Remove ${source.name}`;
    remove.addEventListener('click', () => {
      clearMap('Add files to explore their tracks');
      datasets.remove(source.id);
      refreshSources();
      plotMatches().catch(error => reportError(error.message));
    });
    item.append(swatch, description, remove);
    $('file-list').append(item);
  }
  options($('source-file'), sources.map(source => ({ id: source.id, label: source.name })), 'All files');
  options($('basin'), stats.basins, 'All basins');
  options($('realization'), stats.realizations, 'All realizations');
  for (const id of ['year-start', 'year-end']) {
    $(id).min = stats.minYear ?? '';
    $(id).max = stats.maxYear ?? '';
  }
  if (reset || !sources.length || !$('year-start').value || !$('year-end').value) resetFilters();
  else updateMatches();
}

function openFiles(files) {
  if (!files?.length) return;
  reportError('');
  if (!loader.busy) {
    batchAddedFiles = false;
    $('load-progress').value = 0;
    $('load-status').textContent = 'Opening local files…';
  }
  loader.add(files);
  $('file-input').value = '';
}

function initialise() {
  if (!window.ol) {
    reportError('The map library could not load. Check your internet connection and reload this page.');
    $('file-input').disabled = true;
    $('welcome-open').disabled = true;
    return;
  }
  basemap = createBasemap({ onStatus: status => {
    $('basemap-status').hidden = !status.message;
    $('basemap-status').textContent = status.message;
    $('retry-tiles').hidden = !status.failed;
  } });
  map = new ol.Map({
    target: 'map', layers: basemap.layers,
    controls: [new ol.control.Zoom(), new ol.control.Rotate(), new ol.control.Attribution({ target: 'map-credits', collapsible: false }), new ol.control.ScaleLine()],
    view: new ol.View({ center: ol.proj.fromLonLat([65, 18]), zoom: 3 }),
  });
  // Keep the library's defaults; only wheel/trackpad zoom should ignore keyboard focus.
  const wheelZoom = map.getInteractions().getArray().find(interaction => interaction instanceof ol.interaction.MouseWheelZoom);
  if (wheelZoom) map.removeInteraction(wheelZoom);
  map.addInteraction(new ol.interaction.MouseWheelZoom({ onFocusOnly: false }));
  basemap.attach(map);
  popup = new ol.Overlay({ element: $('popup'), offset: [0, -12], positioning: 'bottom-center', autoPan: { animation: { duration: 200 } } });
  map.addOverlay(popup);
  loader = new FileLoader({
    onProgress: ({ file, message, progress, pendingCount }) => {
      $('load-progress').value = progress;
      $('load-status').textContent = `${file.name}: ${message} ${pendingCount > 1 ? `(${pendingCount - 1} queued)` : ''}`;
    },
    onLoaded: ({ file, dataset }) => {
      datasets.add(file, dataset);
      batchAddedFiles = true;
      refreshSources();
    },
    onError: ({ file, message }) => {
      const previous = $('error').textContent;
      reportError(`${previous ? previous + '\n' : ''}${file.name}: ${message}`);
    },
    onQueueChange: ({ busy }) => {
      $('loading').hidden = !busy;
      $('welcome').hidden = busy || datasets.sources.size > 0;
      $('clear-files').hidden = !busy && !datasets.sources.size;
    },
    onIdle: () => {
      refreshSources(batchAddedFiles);
      if (batchAddedFiles && datasets.sources.size) plotMatches().catch(error => reportError(`Could not draw tracks: ${error.message}`));
      else if (!datasets.sources.size) clearMap('Add files to explore their tracks');
      batchAddedFiles = false;
    },
  });
  map.on('singleclick', event => {
    const feature = map.forEachFeatureAtPixel(event.pixel, candidate => candidate.get('isLabel') ? undefined : candidate, { hitTolerance: 6, layerFilter: candidate => candidate === layer });
    if (!feature) return closePopup();
    if (feature.get('pointIndex') !== undefined) showPoint(feature, event.coordinate);
    else if (feature.get('track')) selectTrack(feature.get('track'));
  });
  map.on('pointermove', event => {
    if (event.dragging || !layer) return;
    map.getTargetElement().style.cursor = map.hasFeatureAtPixel(event.pixel, { hitTolerance: 4, layerFilter: candidate => candidate === layer }) ? 'pointer' : '';
  });
  $('file-input').addEventListener('change', event => {
    try { openFiles(Array.from(event.target.files)); }
    catch (error) { reportError(`Could not select the file: ${error.message}`); }
  });
  $('welcome-open').addEventListener('click', () => $('file-input').click());
  $('clear-files').addEventListener('click', clearFiles);
  $('cancel-load').addEventListener('click', () => loader.cancel());
  $('popup-close').addEventListener('click', closePopup);
  $('clear-map').addEventListener('click', () => { clearMap(); renderList(); });
  $('fit-map').addEventListener('click', fitTracks);
  $('plot-tracks').addEventListener('click', () => plotMatches().catch(error => reportError(error.message)));
  $('back-to-tracks').addEventListener('click', () => plotMatches().catch(error => reportError(error.message)));
  $('reset-filters').addEventListener('click', resetFilters);
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(updateMatches, 120); });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') plotMatches().catch(error => reportError(error.message)); });
  for (const id of ['source-file', 'basin', 'realization', 'year-start', 'year-end']) $(id).addEventListener('change', updateMatches);
  $('previous-page').addEventListener('click', () => { page -= 1; renderList(); });
  $('next-page').addEventListener('click', () => { page += 1; renderList(); });
  $('basemap').addEventListener('change', () => {
    basemap.setBasemap($('basemap').value);
    $('depth-legend').hidden = $('basemap').value !== 'terrain';
  });
  $('retry-tiles').addEventListener('click', () => basemap.retry());
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    $('drop-overlay').hidden = false;
  });
  document.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
  document.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    const files = event.dataTransfer?.files;
    if (files?.length) openFiles(Array.from(files));
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopup(); });
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      loader.callbacks = {};
      loader.cancel();
      basemap.dispose();
    }
  });
  $('file-input').disabled = false;
  $('welcome-open').disabled = false;
}

function start() {
  try { initialise(); }
  catch (error) {
    $('file-input').disabled = true;
    $('welcome-open').disabled = true;
    reportError(`The viewer could not start: ${error.message}. Reload the page to try again.`);
  }
}

if (document.readyState === 'complete') start();
else window.addEventListener('load', start, { once: true });
