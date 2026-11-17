import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import test from 'node:test';
import { buildDataset } from '../js/track-data.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
let imports = 0;

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
  }
  emit(type, values = {}) {
    for (const callback of this.listeners.get(type) || []) callback({ target: this, preventDefault() {}, ...values });
  }
}

class Element extends Target {
  constructor(id = '', markup = '') {
    super();
    this.id = id;
    this.hidden = /\bhidden\b/.test(markup);
    this.disabled = /\bdisabled\b/.test(markup);
    this.textContent = '';
    this.children = [];
    this.files = [];
    this.style = { setProperty() {} };
    this._value = '';
  }
  set value(value) { this._value = String(value); if (this.id === 'file-input' && value === '') this.files = []; }
  get value() { return this._value; }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  click() { this.emit('click'); }
}

function harness({ mapError, missingLibrary = false } = {}) {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], new Element(match[1], match[0])]));
  const window = new Target();
  const document = Object.assign(new Target(), {
    readyState: 'loading', getElementById: id => elements.get(id),
    createElement: () => new Element(), createDocumentFragment: () => new Element(),
  });
  class Source extends Target {
    on() {}
    addFeatures() {}
    getExtent() { return [0, 0, 1, 1]; }
  }
  class Layer {
    constructor(options) { this.options = options; }
    setVisible() {}
    getSource() { return this.options.source; }
  }
  class Value { constructor(value) { this.value = value; } }
  class MouseWheelZoom {}
  class MapView extends Target {
    constructor(options) {
      super();
      if (mapError) throw new Error(mapError);
      this.view = options.view;
      this.interactions = [new MouseWheelZoom()];
    }
    on(type, fn) { this.addEventListener(type, fn); }
    un() {}
    addOverlay() {}
    addLayer() {}
    removeLayer() {}
    getView() { return this.view; }
    addInteraction(item) { this.interactions.push(item); }
    removeInteraction(item) { this.interactions = this.interactions.filter(value => value !== item); }
    getInteractions() { return { getArray: () => this.interactions, remove: item => this.removeInteraction(item), push: item => this.addInteraction(item) }; }
  }
  const ol = {
    Map: MapView, View: class { fit() {} }, Overlay: class { setPosition() {} },
    Feature: class { constructor(value) { this.value = value; } get(key) { return this.value[key]; } },
    interaction: { MouseWheelZoom },
    control: { Zoom: Value, Rotate: Value, Attribution: Value, ScaleLine: Value },
    source: { TileWMS: Source, XYZ: Source, Vector: Source }, layer: { Tile: Layer, VectorImage: Layer, Vector: Layer },
    style: { Style: Value, Stroke: Value, Fill: Value, Circle: Value, Text: Value },
    geom: { MultiLineString: Value, MultiPoint: Value, GeometryCollection: Value, Point: Value },
    tilegrid: { createXYZ: () => ({}) }, proj: { fromLonLat: value => value },
    color: { asArray: () => [0, 0, 0, 1] }, extent: { isEmpty: () => false },
  };
  window.ol = missingLibrary ? undefined : ol;
  window.EnglishBasemap = class {
    layer = new Layer({ source: new Source() });
    setBasemap() { return Promise.resolve(true); }
    getFailures() { return []; }
    dispose() {}
  };
  const workers = [];
  const globals = {
    window, document, ol: window.ol,
    Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    requestAnimationFrame: callback => queueMicrotask(callback),
    Worker: class {
      constructor(url) { this.url = url; this.messages = []; workers.push(this); }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated = true; }
      send(data) { this.onmessage?.({ data }); }
    },
  };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  return {
    elements, workers, window,
    async boot() {
      await import(`../js/app.js?startup-test=${++imports}`);
      window.emit('load');
      await tick();
    },
    cleanup() {
      window.emit('pagehide', { persisted: false });
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('actual app startup connects file selection, worker progress, and loaded catalogue', async () => {
  const state = harness();
  try {
    await state.boot();
    const input = state.elements.get('file-input');
    assert.equal(input.disabled, false);
    const file = new File(['sample'], 'sample.nc');
    input.files = [file];
    input.emit('change');
    await tick();
    assert.equal(state.workers.length, 1);
    assert.equal(state.workers[0].messages[0].file, file);
    assert.equal(input.files.length, 0);
    assert.equal(state.elements.get('loading').hidden, false);
    assert.equal(Number(state.elements.get('load-progress').value), 0);
    assert.match(state.elements.get('load-status').textContent, /sample.nc.*Starting the file reader/);
    state.workers[0].send({ type: 'progress', message: 'Reading longitude', progress: 40 });
    assert.match(state.elements.get('load-status').textContent, /sample.nc.*Reading longitude/);
    const variables = Object.fromEntries(Object.entries({ storm: ['AS001', 'AS001'], time: [0, 6], lon: [60, 61], lat: [10, 11], wind: [40, 50] }).map(([name, values]) => [name, { values, attributes: name === 'time' ? { units: 'hours since 2020-01-01' } : {} }]));
    state.workers[0].send({ type: 'loaded', dataset: buildDataset(variables) });
    await tick();
    assert.equal(state.elements.get('track-controls').disabled, false);
    assert.match(state.elements.get('dataset-summary').textContent, /1 file.*1 tracks.*2 points/);
    assert.equal(state.elements.get('file-list').children.length, 1);
    assert.equal(state.elements.get('error').hidden, true);
    assert.equal(state.workers[0].terminated, true);
  } finally { state.cleanup(); }
});

test('missing map library is visible and prevents an unhandled file selection', async () => {
  const state = harness({ missingLibrary: true });
  try {
    await state.boot();
    assert.equal(state.elements.get('file-input').disabled, true);
    assert.equal(state.elements.get('error').hidden, false);
    assert.match(state.elements.get('error').textContent, /library|load/i);
    assert.equal(state.workers.length, 0);
  } finally { state.cleanup(); }
});

test('a map startup exception is visible and leaves file selection disabled', async () => {
  const state = harness({ mapError: 'Map initialization failed' });
  try {
    await assert.doesNotReject(() => state.boot());
    assert.equal(state.elements.get('file-input').disabled, true);
    assert.equal(state.elements.get('error').hidden, false);
    assert.match(state.elements.get('error').textContent, /Map initialization failed/);
    assert.equal(state.workers.length, 0);
  } finally { state.cleanup(); }
});
