const READER_URL = 'https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js';
const VARIABLE_NAMES = ['storm', 'time', 'lon', 'lat', 'realization', 'wind', 'state'];
const ATTRIBUTE_NAMES = ['units', 'calendar', '_FillValue', 'missing_value', 'scale_factor', 'add_offset', '_Unsigned'];

function progress(message, value) {
  self.postMessage({type: 'progress', message, progress: value});
}

async function validateSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (bytes[0] === 67 && bytes[1] === 68 && bytes[2] === 70) {
    throw new Error('This is a classic NetCDF3 file. This viewer currently supports NetCDF4/HDF5 files.');
  }
  if (![137, 72, 68, 70, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
    throw new Error('This file is not a supported NetCDF4/HDF5 file. Select a .nc file with track variables.');
  }
}

self.onmessage = async ({data}) => {
  let handle, fs, mounted = false;
  try {
    const {file} = data;
    if (!(file instanceof File)) throw new Error('Select a local NetCDF file first.');
    progress('Checking NetCDF file…', 1);
    await validateSignature(file);
    progress('Loading the NetCDF reader…', 3);
    try {
      if (!self.h5wasm) importScripts(READER_URL);
      await self.h5wasm.ready;
    } catch {
      throw new Error('The NetCDF reader could not load. Check your internet connection and access to cdn.jsdelivr.net, then select the file again.');
    }
    const {buildDataset} = await import('./track-data.js');
    fs = (await self.h5wasm.ready).FS;
    fs.mkdirTree('/input');
    // WORKERFS reads the selected local file without copying it into the WASM filesystem.
    fs.mount(fs.filesystems.WORKERFS, {files: [file]}, '/input');
    mounted = true;
    handle = new self.h5wasm.File(`/input/${file.name}`, 'r');
    const keys = new Set(handle.keys());
    const variables = {};
    for (let i = 0; i < VARIABLE_NAMES.length; i++) {
      const name = VARIABLE_NAMES[i];
      if (!keys.has(name)) continue;
      progress(`Reading ${name}…`, 8 + i / VARIABLE_NAMES.length * 55);
      const variable = handle.get(name);
      if (!variable.shape || variable.shape.length !== 1) {
        throw new Error(`${name}: expected a one-dimensional variable with one value per track point.`);
      }
      const allowedTypes = ['time', 'lon', 'lat', 'wind'].includes(name) ? [0, 1] : [0, 1, 3];
      if (!allowedTypes.includes(variable.metadata.type)) {
        throw new Error(`${name}: expected a numeric or text variable; this HDF5 data type is not supported.`);
      }
      const attributes = {};
      const available = variable.attrs;
      for (const attribute of ATTRIBUTE_NAMES) {
        if (Object.hasOwn(available, attribute)) attributes[attribute] = available[attribute].value;
      }
      variables[name] = {values: variable.value, attributes};
      if (!Array.isArray(variables[name].values) && !ArrayBuffer.isView(variables[name].values)) {
        throw new Error(`${name}: this variable's data type is not supported.`);
      }
    }
    handle.close();
    handle = null;
    fs.unmount('/input');
    mounted = false;
    const dataset = buildDataset(variables, progress);
    const buffers = ['lon', 'lat', 'time', 'wind', 'stateCodes'].map(name => dataset[name].buffer);
    self.postMessage({type: 'loaded', dataset}, buffers);
  } catch (error) {
    self.postMessage({type: 'error', message: error instanceof Error ? error.message : 'The NetCDF file could not be read.'});
  } finally {
    try { handle?.close(); } catch {}
    try { if (mounted) fs.unmount('/input'); } catch {}
  }
};
