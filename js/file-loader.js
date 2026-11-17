export class FileLoader {
  #queue = [];
  #current = null;
  #batchActive = false;
  #scheduled = false;

  constructor({ createWorker, onProgress, onLoaded, onError, onIdle, onQueueChange } = {}) {
    this.createWorker = createWorker || (() => new Worker(new URL('./netcdf-worker.js', import.meta.url)));
    this.callbacks = { onProgress, onLoaded, onError, onIdle, onQueueChange };
  }

  get busy() {
    return this.pendingCount > 0;
  }

  // Includes the file currently being read.
  get pendingCount() {
    return this.#queue.length + (this.#current ? 1 : 0);
  }

  add(files) {
    const additions = Array.from(files || []);
    if (!additions.length) return;
    this.#queue.push(...additions);
    this.#batchActive = true;
    this.#queueChanged();
    this.#schedule();
  }

  cancel() {
    this.#queue.length = 0;
    const current = this.#current;
    this.#current = null;
    this.#terminate(current);
    this.#queueChanged();
    this.#settle();
  }

  #emit(name, payload) {
    try {
      this.callbacks[name]?.(payload);
    } catch (error) {
      if (name === 'onLoaded') {
        this.#emit('onError', { file: payload.file, message: `Could not display the loaded file: ${error.message || error}` });
      } else {
        console.error(`FileLoader ${name} callback failed:`, error);
      }
    }
  }

  #queueChanged() {
    this.#emit('onQueueChange', { busy: this.busy, pendingCount: this.pendingCount });
  }

  #schedule() {
    if (this.#scheduled || this.#current) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#advance();
    });
  }

  #advance() {
    if (this.#current) return;
    if (!this.#queue.length) return this.#settle();
    const current = { file: this.#queue.shift(), started: performance.now(), worker: null, startupTimer: null };
    this.#current = current;
    this.#emit('onProgress', { file: current.file, message: 'Starting the file reader…', progress: 0, pendingCount: this.pendingCount });
    try {
      const worker = this.createWorker();
      current.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.#current !== current) return;
        clearTimeout(current.startupTimer);
        if (data.type === 'progress') {
          this.#emit('onProgress', { file: current.file, message: data.message, progress: data.progress, pendingCount: this.pendingCount });
        } else if (data.type === 'loaded') {
          this.#finish(current, { dataset: data.dataset });
        } else if (data.type === 'error') {
          this.#finish(current, { message: data.message || 'The NetCDF file could not be read.' });
        }
      };
      worker.onerror = event => {
        event.preventDefault?.();
        this.#finish(current, { message: event.message || 'The NetCDF reader could not start. Check your internet connection and try again.' });
      };
      worker.onmessageerror = () => this.#finish(current, { message: 'The NetCDF reader returned data that the browser could not receive.' });
      current.startupTimer = setTimeout(() => {
        this.#finish(current, { message: 'The browser did not start the file reader. Reload this page and select the file again.' });
      }, 15000);
      worker.postMessage({ file: current.file });
    } catch (error) {
      this.#finish(current, { message: error.message || String(error) });
    }
  }

  #terminate(current) {
    clearTimeout(current?.startupTimer);
    if (!current?.worker) return;
    current.worker.onmessage = null;
    current.worker.onerror = null;
    current.worker.onmessageerror = null;
    current.worker.terminate();
  }

  #finish(current, result) {
    if (this.#current !== current) return;
    this.#current = null;
    this.#terminate(current);
    if (Object.hasOwn(result, 'dataset')) {
      this.#emit('onLoaded', { file: current.file, dataset: result.dataset, elapsedSeconds: (performance.now() - current.started) / 1000 });
    } else {
      this.#emit('onError', { file: current.file, message: result.message });
    }
    this.#queueChanged();
    this.#settle();
    this.#schedule();
  }

  #settle() {
    if (this.busy || !this.#batchActive) return;
    this.#batchActive = false;
    this.#emit('onIdle');
  }
}
