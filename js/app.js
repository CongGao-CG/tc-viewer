import { createBasemap } from './basemap.js';
import { filterTracks, trackSegments, unwrapLongitude } from './track-geometry.js';

const $ = id => document.getElementById(id);
const number = value => value.toLocaleString();
const date = value => Number.isFinite(value) ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
const pause = () => new Promise(resolve => requestAnimationFrame(resolve));
const PAGE_SIZE = 50;
let dataset = null;
let matches = [];
let page = 0;
let worker = null;
let map;
let basemap;
let layer = null;
let popup;
let renderId = 0;
let fileId = 0;
let selected = null;
let visibleExtent = null;
let searchTimer;

function reportError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function windLabel() {
  return dataset?.windUnits || 'units unspecified';
}

function windText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} (${windLabel()})` : '—';
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

function clearMap(message = 'Map cleared. Your dataset is still open.') {
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

function stopWorker() {
  worker?.terminate();
  worker = null;
  $('loading').hidden = true;
}

function closeFile() {
  fileId += 1;
  stopWorker();
  clearMap('Choose a file to explore its tracks');
  dataset = null;
  matches = [];
  page = 0;
  $('track-controls').disabled = true;
  $('dataset-info').hidden = true;
  $('welcome').hidden = false;
  $('file-input').value = '';
  $('track-list').replaceChildren();
  $('results-count').textContent = '';
  $('match-count').textContent = '';
  $('pagination').hidden = true;
  $('empty-results').hidden = false;
  $('empty-results').textContent = 'Open a file to browse its tracks.';
  reportError('');
}

function options(element, values, allLabel) {
  element.replaceChildren(new Option(allLabel, 'ALL'), ...values.map(value => new Option(value, value)));
}

function resetFilters() {
  $('search').value = '';
  $('basin').value = 'ALL';
  $('realization').value = 'ALL';
  $('year-start').value = dataset.stats.minYear;
  $('year-end').value = dataset.stats.maxYear;
  updateMatches();
}

function updateMatches() {
  if (!dataset) return;
  clearTimeout(searchTimer);
  matches = filterTracks(dataset.tracks, {
    query: $('search').value,
    basin: $('basin').value,
    realization: $('realization').value,
    startYear: $('year-start').value,
    endYear: $('year-end').value,
  });
  page = 0;
  $('match-count').textContent = `${number(matches.length)} of ${number(dataset.tracks.length)} tracks match. Use Plot to update the map.`;
  $('plot-tracks').disabled = matches.length === 0;
  renderList();
}

function renderList() {
  $('track-list').replaceChildren();
  $('results-count').textContent = number(matches.length);
  $('empty-results').hidden = matches.length > 0;
  $('empty-results').textContent = 'No tracks match these filters.';
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
    button.append(title, subtitle);
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
  return trackSegments(dataset, track).map(segment => segment.map(point => ol.proj.fromLonLat(point)));
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
  if (!dataset) return;
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
  const style = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(195, 48, 44, 0.45)', width: 1.25 }),
    image: new ol.style.Circle({ radius: 2, fill: new ol.style.Fill({ color: '#c3302c' }) }),
  });
  // Cache the aggregate as an image while panning; detail views keep vector point hit detection.
  layer = new ol.layer.VectorImage({ source, style, imageRatio: 1.3 });
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
  $('map-status').textContent = `${number(tracks.length)} tracks · click a line to inspect a storm`;
  fitTracks();
}

function selectTrack(track) {
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
  const lineStyle = new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#cb322e', width: 2.3 }) });
  const pointStyle = new ol.style.Style({ image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: '#cb322e' }), stroke: new ol.style.Stroke({ color: 'white', width: 1.2 }) }) });
  const labelStyle = new ol.style.Style({ text: new ol.style.Text({ text: track.id, font: '600 12px system-ui', offsetY: -17, fill: new ol.style.Fill({ color: '#172b36' }), stroke: new ol.style.Stroke({ color: 'white', width: 4 }) }) });
  if (lastPoint) source.addFeature(new ol.Feature({ geometry: new ol.geom.Point(lastPoint), isLabel: true }));
  layer = new ol.layer.Vector({ source, style: feature => feature.get('isLabel') ? labelStyle : feature.get('pointIndex') !== undefined ? pointStyle : lineStyle });
  map.addLayer(layer);
  visibleExtent = source.getExtent();
  $('fit-map').disabled = ol.extent.isEmpty(visibleExtent);
  $('selected-track').hidden = false;
  $('selected-name').textContent = track.id;
  detailList($('selected-details'), [
    ['Realization', track.realization], ['Start', date(track.startTime)], ['End', date(track.endTime)],
    ['Points', number(track.validCount)], ['Peak wind', windText(track.maxWind)],
  ]);
  $('map-status').textContent = `${track.id} · realization ${track.realization} · ${number(track.validCount)} points`;
  renderList();
  fitTracks();
}

function showPoint(feature, coordinate) {
  const index = feature.get('pointIndex');
  const track = feature.get('track');
  const title = document.createElement('strong');
  title.textContent = track.id;
  const list = document.createElement('dl');
  detailList(list, [
    ['Realization', track.realization], ['Time', date(dataset.time[index])],
    ['Latitude', `${dataset.lat[index].toFixed(3)}°`], ['Longitude', `${dataset.lon[index].toFixed(3)}°`],
    ['Wind', windText(dataset.wind[index])], ['State', dataset.states[dataset.stateCodes[index]] || '—'],
  ]);
  $('popup-content').replaceChildren(title, list);
  $('popup').hidden = false;
  popup.setPosition(coordinate);
}

function acceptDataset(data, file, elapsed) {
  dataset = data;
  $('filename').textContent = file.name;
  $('dataset-summary').textContent = `${number(data.stats.trackCount)} tracks · ${number(data.stats.pointCount)} points · ${number(data.stats.realizations.length)} realizations. ${(file.size / 1024 ** 2).toFixed(1)} MiB · read in ${elapsed.toFixed(1)} s.`;
  $('dataset-warnings').textContent = data.warnings.join(' ');
  $('dataset-warnings').hidden = data.warnings.length === 0;
  $('dataset-info').hidden = false;
  $('track-controls').disabled = false;
  $('welcome').hidden = true;
  options($('basin'), data.stats.basins, 'All basins');
  options($('realization'), data.stats.realizations, 'All realizations');
  for (const id of ['year-start', 'year-end']) {
    $(id).min = data.stats.minYear;
    $(id).max = data.stats.maxYear;
  }
  resetFilters();
  plotMatches().catch(error => reportError(`Could not draw tracks: ${error.message}`));
}

function openFile(file) {
  if (!file) return;
  closeFile();
  const id = fileId;
  const started = performance.now();
  $('welcome').hidden = true;
  $('loading').hidden = false;
  $('load-progress').value = 0;
  $('load-status').textContent = 'Opening the local file…';
  $('map-status').textContent = `Reading ${file.name}…`;
  try {
    worker = new Worker(new URL('./netcdf-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      if (id !== fileId) return;
      if (data.type === 'progress') {
        $('load-progress').value = data.progress;
        $('load-status').textContent = data.message;
      } else if (data.type === 'loaded') {
        stopWorker();
        acceptDataset(data.dataset, file, (performance.now() - started) / 1000);
      } else if (data.type === 'error') {
        closeFile();
        reportError(data.message);
      }
    };
    worker.onerror = event => {
      closeFile();
      reportError(`Could not start the NetCDF reader. Check your internet connection and use an HTTP preview or GitHub Pages. ${event.message || ''}`);
    };
    worker.postMessage({ file });
  } catch (error) {
    closeFile();
    reportError(`Could not open the file: ${error.message}`);
  }
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
  basemap.attach(map);
  popup = new ol.Overlay({ element: $('popup'), offset: [0, -12], positioning: 'bottom-center', autoPan: { animation: { duration: 200 } } });
  map.addOverlay(popup);
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
  $('file-input').addEventListener('change', event => openFile(event.target.files[0]));
  $('welcome-open').addEventListener('click', () => $('file-input').click());
  $('close-file').addEventListener('click', closeFile);
  $('cancel-load').addEventListener('click', closeFile);
  $('popup-close').addEventListener('click', closePopup);
  $('clear-map').addEventListener('click', () => { clearMap(); renderList(); });
  $('fit-map').addEventListener('click', fitTracks);
  $('plot-tracks').addEventListener('click', () => plotMatches().catch(error => reportError(error.message)));
  $('back-to-tracks').addEventListener('click', () => plotMatches().catch(error => reportError(error.message)));
  $('reset-filters').addEventListener('click', resetFilters);
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(updateMatches, 120); });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') plotMatches().catch(error => reportError(error.message)); });
  for (const id of ['basin', 'realization', 'year-start', 'year-end']) $(id).addEventListener('change', updateMatches);
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
    if (files?.length > 1) reportError('Open one NetCDF file at a time.');
    else if (files?.length) openFile(files[0]);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopup(); });
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { stopWorker(); basemap.dispose(); }
  });
}

if (document.readyState === 'complete') initialise();
else window.addEventListener('load', initialise, { once: true });
