import assert from 'node:assert/strict';
import test from 'node:test';
import { FileLoader } from '../js/file-loader.js';

const tick = () => new Promise(resolve => queueMicrotask(resolve));

class FakeWorker {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  send(data) { this.onmessage?.({ data }); }
}

function setup(overrides = {}) {
  const workers = [], loaded = [], errors = [], progress = [], changes = [], idle = [];
  const loader = new FileLoader({
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    onLoaded: value => loaded.push(value),
    onError: value => errors.push(value),
    onProgress: value => progress.push(value),
    onQueueChange: value => changes.push(value),
    onIdle: () => idle.push(true),
    ...overrides,
  });
  return { loader, workers, loaded, errors, progress, changes, idle };
}

test('reads files serially and reports progress with the active file included in the queue count', async () => {
  const state = setup();
  const first = { name: 'first.nc' }, second = { name: 'second.nc' };
  state.loader.add([first, second]);
  assert.equal(state.loader.pendingCount, 2);
  assert.equal(state.loader.busy, true);
  await tick();
  assert.equal(state.workers.length, 1);
  assert.deepEqual(state.workers[0].messages, [{ file: first }]);
  assert.deepEqual(state.progress[0], { file: first, message: 'Starting the file reader…', progress: 0, pendingCount: 2 });
  state.workers[0].send({ type: 'progress', message: 'Reading', progress: 25 });
  assert.deepEqual(state.progress.at(-1), { file: first, message: 'Reading', progress: 25, pendingCount: 2 });
  const dataset = { tracks: ['one'] };
  state.workers[0].send({ type: 'loaded', dataset });
  assert.equal(state.workers[0].terminated, true);
  assert.equal(state.loaded[0].file, first);
  assert.equal(state.loaded[0].dataset, dataset);
  assert.ok(state.loaded[0].elapsedSeconds >= 0);
  assert.equal(state.loader.pendingCount, 1);
  await tick();
  assert.deepEqual(state.workers[1].messages, [{ file: second }]);
  state.workers[1].send({ type: 'loaded', dataset: {} });
  await tick();
  assert.equal(state.loader.busy, false);
  assert.equal(state.loader.pendingCount, 0);
  assert.equal(state.idle.length, 1);
  assert.deepEqual(state.changes.at(-1), { busy: false, pendingCount: 0 });
});

test('appends another selection while reading without replacing existing queued files', async () => {
  const state = setup();
  const files = ['a.nc', 'b.nc', 'c.nc'].map(name => ({ name }));
  state.loader.add(files.slice(0, 2));
  await tick();
  state.loader.add(files.slice(2));
  assert.equal(state.loader.pendingCount, 3);
  for (let index = 0; index < files.length; index++) {
    assert.equal(state.workers[index].messages[0].file, files[index]);
    state.workers[index].send({ type: 'loaded', dataset: {} });
    await tick();
  }
  assert.deepEqual(state.loaded.map(item => item.file), files);
  assert.equal(state.idle.length, 1);
});

test('a bad file or worker failure does not discard other files', async () => {
  const state = setup();
  const files = ['bad.nc', 'crashed.nc', 'good.nc'].map(name => ({ name }));
  state.loader.add(files);
  await tick();
  state.workers[0].send({ type: 'error', message: 'Missing longitude' });
  await tick();
  state.workers[1].onerror({ message: 'Worker failed' });
  await tick();
  state.workers[2].send({ type: 'loaded', dataset: {} });
  await tick();
  assert.deepEqual(state.errors, [
    { file: files[0], message: 'Missing longitude' },
    { file: files[1], message: 'Worker failed' },
  ]);
  assert.deepEqual(state.loaded.map(item => item.file), [files[2]]);
  assert.ok(state.workers.every(worker => worker.terminated));
  assert.equal(state.idle.length, 1);
});

test('cancel clears pending work, preserves prior results, and ignores stale callbacks after restart', async () => {
  const state = setup();
  state.loader.add([{ name: 'done.nc' }, { name: 'cancelled.nc' }, { name: 'never.nc' }]);
  await tick();
  state.workers[0].send({ type: 'loaded', dataset: {} });
  await tick();
  const oldMessage = state.workers[1].onmessage;
  const oldError = state.workers[1].onerror;
  state.loader.cancel();
  assert.equal(state.loader.pendingCount, 0);
  assert.equal(state.workers[1].terminated, true);
  assert.equal(state.loaded.length, 1);
  state.loader.add([{ name: 'new.nc' }]);
  await tick();
  oldMessage({ data: { type: 'loaded', dataset: { stale: true } } });
  oldError({ message: 'Stale error' });
  assert.equal(state.loader.pendingCount, 1);
  assert.equal(state.loaded.length, 1);
  assert.equal(state.errors.length, 0);
  state.workers[2].send({ type: 'loaded', dataset: { new: true } });
  await tick();
  assert.equal(state.loaded.length, 2);
  assert.deepEqual(state.loaded[1].dataset, { new: true });
  assert.equal(state.idle.length, 2);
});

test('cancelling before startup creates no worker and duplicate cancellation emits no duplicate idle event', async () => {
  const state = setup();
  state.loader.add([{ name: 'cancelled.nc' }]);
  state.loader.cancel();
  state.loader.cancel();
  await tick();
  assert.equal(state.workers.length, 0);
  assert.equal(state.idle.length, 1);
  state.loader.add([]);
  await tick();
  assert.equal(state.idle.length, 1);
});

test('worker construction and file-cloning failures advance the queue', async () => {
  let attempts = 0;
  const worker = new FakeWorker();
  const state = setup({ createWorker: () => {
    attempts++;
    if (attempts === 1) throw new Error('Worker unavailable');
    if (attempts === 2) return { terminate() {}, postMessage() { throw new Error('File could not be cloned'); } };
    return worker;
  } });
  state.loader.add([{ name: 'first.nc' }, { name: 'second.nc' }, { name: 'third.nc' }]);
  await tick();
  await tick();
  await tick();
  worker.send({ type: 'loaded', dataset: {} });
  await tick();
  assert.deepEqual(state.errors.map(error => error.message), ['Worker unavailable', 'File could not be cloned']);
  assert.equal(state.loaded[0].file.name, 'third.nc');
  assert.equal(state.loader.busy, false);
});

test('a display callback failure reports the file and still starts the next file', async () => {
  let calls = 0;
  const state = setup({ onLoaded: () => { if (++calls === 1) throw new Error('Cannot display'); } });
  state.loader.add([{ name: 'first.nc' }, { name: 'second.nc' }]);
  await tick();
  state.workers[0].send({ type: 'loaded', dataset: {} });
  await tick();
  state.workers[1].send({ type: 'loaded', dataset: {} });
  await tick();
  assert.equal(calls, 2);
  assert.equal(state.errors[0].file.name, 'first.nc');
  assert.match(state.errors[0].message, /Cannot display/);
  assert.equal(state.loader.busy, false);
  assert.equal(state.idle.length, 1);
});

test('a silent worker times out and the next file continues without a stale deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const state = setup();
  try {
    const silent = { name: 'silent.nc' }, good = { name: 'good.nc' };
    state.loader.add([silent, good]);
    await tick();
    context.mock.timers.tick(14999);
    assert.equal(state.errors.length, 0);
    assert.equal(state.workers[0].terminated, false);
    context.mock.timers.tick(1);
    await tick();
    assert.equal(state.workers[0].terminated, true);
    assert.equal(state.errors[0].file, silent);
    assert.match(state.errors[0].message, /did not start the file reader/);
    assert.equal(state.workers[1].messages[0].file, good);
    state.workers[1].send({ type: 'loaded', dataset: {} });
    await tick();
    context.mock.timers.tick(30000);
    assert.equal(state.errors.length, 1);
    assert.equal(state.loaded[0].file, good);
    assert.equal(state.loader.busy, false);
    assert.equal(state.idle.length, 1);
  } finally { state.loader.cancel(); }
});

test('worker progress clears the startup deadline so a long decode is not interrupted', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const state = setup();
  try {
    state.loader.add([{ name: 'large.nc' }]);
    await tick();
    state.workers[0].send({ type: 'progress', message: 'Reading longitude', progress: 40 });
    context.mock.timers.tick(120000);
    assert.equal(state.errors.length, 0);
    assert.equal(state.workers[0].terminated, false);
    assert.equal(state.loader.busy, true);
    state.workers[0].send({ type: 'loaded', dataset: {} });
    await tick();
    assert.equal(state.loaded.length, 1);
    assert.equal(state.loader.busy, false);
  } finally { state.loader.cancel(); }
});
