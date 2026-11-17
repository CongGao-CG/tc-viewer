export function createBasemap({ onStatus = () => {} } = {}) {
  let map;
  let name = 'streets';
  let english = null;
  let terrainDemSource;
  let fallback = false;
  let status = { message: '', retrying: false, failed: false };
  const failures = new Map();
  const retryDelays = [1000, 3000];
  const tileStates = { loading: 1, loaded: 2, error: 3, empty: 4 };

  try {
    english = new window.EnglishBasemap({
      onRecoveryChange: updateStatus,
      prepareStyle(style, selectedName) {
        if (selectedName !== 'terrain') return style;
        if (!terrainDemSource) {
          terrainDemSource = new mlcontour.DemSource({
            url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
            encoding: 'terrarium', maxzoom: 15, worker: true,
            cacheSize: 100, timeoutMs: 10000
          });
          terrainDemSource.setupMaplibre(maplibregl);
        }
        style.sources.dem.tiles = [terrainDemSource.sharedDemProtocolUrl];
        style.sources['contour-source'].tiles = [terrainDemSource.contourProtocolUrl({
          multiplier: 1,
          thresholds: { 10: [50, 1000], 11: [20, 500], 12: [10, 100], 13: [10, 100], 14: [10, 100], 15: [10, 50] },
          contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level',
          extent: 4096, buffer: 1
        })];
        return style;
      }
    });
  } catch (error) {
    console.warn('Using raster basemap because WebGL initialization failed:', error);
    fallback = true;
  }

  const baseLayer = english?.layer || new ol.layer.Tile({ source: new ol.source.OSM() });
  const colorSource = new ol.source.TileWMS({
    url: 'https://www.opendem.info/geoserver/opendem/wms',
    params: { LAYERS: 'opendem:gebco_2021', FORMAT: 'image/png', TRANSPARENT: true },
    serverType: 'geoserver', hidpi: false,
    tileGrid: ol.tilegrid.createXYZ({ maxZoom: 9, tileSize: 512 }),
    attributions: 'Depth colors: <a href="https://www.opendem.info/download_bathymetry.html">OpenDEM</a>, derived from GEBCO 2021 and <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
    attributionsCollapsible: false
  });
  const depthSource = new ol.source.XYZ({
    url: 'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_contours/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 10,
    attributions: [
      '<a href="https://www.gebco.net/">GEBCO</a>',
      '<a href="https://www.ncei.noaa.gov/">NOAA NCEI</a>'
    ],
    attributionsCollapsible: false
  });
  const colorLayer = new ol.layer.Tile({ source: colorSource, visible: false });
  const depthLayer = new ol.layer.Tile({ source: depthSource, visible: false });

  function tileIsInView(tile, source) {
    if (!map || name === 'none' || (source !== baseLayer.getSource() && name !== 'terrain')) return false;
    const view = map.getView();
    const grid = source.getTileGridForProjection(view.getProjection());
    const coord = tile.getTileCoord();
    if (coord[0] !== grid.getZForResolution(view.getResolution(), source.zDirection)) return false;
    return ol.extent.intersects(view.calculateExtent(map.getSize()), grid.getTileCoordExtent(coord));
  }

  function updateStatus() {
    const visibleFailures = [];
    for (const [tile, failure] of failures) {
      const state = tile.getState();
      if (tile.disposed || state === tileStates.loaded || state === tileStates.empty) {
        clearTimeout(failure.timer);
        failures.delete(tile);
        continue;
      }
      if (!tileIsInView(tile, failure.source)) {
        clearTimeout(failure.timer);
        failure.timer = null;
        continue;
      }
      visibleFailures.push(failure);
      if (state === tileStates.error && !failure.timer && failure.attempts < retryDelays.length) {
        failure.timer = setTimeout(() => {
          failure.timer = null;
          if (!tile.disposed && tileIsInView(tile, failure.source) && tile.getState() === tileStates.error) {
            failure.attempts += 1;
            tile.load();
          }
          updateStatus();
        }, retryDelays[failure.attempts]);
      }
    }
    const baseFailures = name === 'none' ? [] : english?.getFailures() || [];
    const retrying = visibleFailures.some(failure => failure.timer || failure.tile.getState() === tileStates.loading)
      || baseFailures.some(failure => failure.retrying);
    const failed = visibleFailures.some(failure => !failure.timer && failure.tile.getState() === tileStates.error)
      || baseFailures.some(failure => failure.stalled);
    const labels = [...new Set([...visibleFailures, ...baseFailures].map(failure => failure.label))];
    let message = labels.length
      ? `Some map tiles could not load (${labels.join(', ')}). ${retrying ? 'Retrying…' : 'Use Retry tiles to try again.'}`
      : '';
    if (fallback && name !== 'none') {
      message = `WebGL is unavailable; using the OpenStreetMap basemap${name === 'terrain' ? ' with ocean depth overlays' : ''}. ${message}`.trim();
    }
    const next = { message, retrying, failed };
    if (JSON.stringify(next) !== JSON.stringify(status)) {
      status = next;
      onStatus(status);
    }
  }

  const tileSources = [[colorSource, 'ocean depth colors'], [depthSource, 'ocean depth contours']];
  if (fallback) tileSources.push([baseLayer.getSource(), 'street map']);
  for (const [source, label] of tileSources) {
    source.on('tileloaderror', ({ tile }) => {
      if (!failures.has(tile)) failures.set(tile, { tile, source, label, attempts: 0, timer: null });
      updateStatus();
    });
    source.on('tileloadend', updateStatus);
  }

  async function setBasemap(selectedName) {
    if (!['streets', 'terrain', 'none'].includes(selectedName)) throw new Error('Unknown basemap');
    name = selectedName;
    baseLayer.setVisible(name !== 'none');
    colorLayer.setVisible(name === 'terrain');
    depthLayer.setVisible(name === 'terrain');
    const loaded = english ? await english.setBasemap(name) : true;
    updateStatus();
    return loaded;
  }

  return {
    layers: [baseLayer, colorLayer, depthLayer],
    attach(attachedMap) {
      map = attachedMap;
      map.on('moveend', updateStatus);
      return setBasemap(name);
    },
    setBasemap,
    retry() {
      if (name === 'none') return;
      english?.retry();
      for (const [tile, failure] of failures) {
        if (tileIsInView(tile, failure.source) && tile.getState() === tileStates.error && !failure.timer) failure.attempts = 0;
      }
      updateStatus();
    },
    getStatus: () => ({ ...status }),
    dispose() {
      map?.un('moveend', updateStatus);
      for (const failure of failures.values()) clearTimeout(failure.timer);
      failures.clear();
      english?.dispose();
    }
  };
}
