const COLORS = ['#4f46e5', '#b45309', '#087f8c', '#9c3f72', '#5b7c2f', '#5672b9', '#81725c', '#7855a6'];

export class DatasetCollection {
  constructor() {
    this.sources = new Map();
    this.nextId = 1;
    this.tracks = [];
    this.stats = this.summarize();
  }

  add(file, dataset) {
    const sequence = this.nextId++;
    const id = `file-${sequence}`;
    const existingNames = new Set([...this.sources.values()].map(source => source.name));
    let name = file.name;
    for (let suffix = 2; existingNames.has(name); suffix++) name = `${file.name} (${suffix})`;
    const color = COLORS[(sequence - 1) % COLORS.length];
    // Keep point arrays in their original datasets; combining files must not copy all observations.
    const tracks = dataset.tracks.map(track => ({
      ...track, key: JSON.stringify([id, track.key]), sourceId: id, sourceName: name, color,
    }));
    const source = { id, name, color, size: file.size, dataset, tracks };
    this.sources.set(id, source);
    this.rebuild();
    return source;
  }

  remove(id) {
    this.sources.delete(id);
    this.rebuild();
  }

  clear() {
    this.sources.clear();
    this.rebuild();
  }

  dataFor(track) {
    return this.sources.get(track.sourceId)?.dataset;
  }

  rebuild() {
    this.tracks = [...this.sources.values()].flatMap(source => source.tracks);
    this.stats = this.summarize();
  }

  summarize() {
    let pointCount = 0, minYear = Infinity, maxYear = -Infinity;
    const basins = new Set(), realizations = new Set();
    for (const { dataset } of this.sources.values()) {
      pointCount += dataset.stats.pointCount;
      minYear = Math.min(minYear, dataset.stats.minYear);
      maxYear = Math.max(maxYear, dataset.stats.maxYear);
      for (const basin of dataset.stats.basins) basins.add(basin);
      for (const realization of dataset.stats.realizations) realizations.add(realization);
    }
    return {
      fileCount: this.sources.size, trackCount: this.tracks.length, pointCount,
      minYear: this.sources.size ? minYear : null, maxYear: this.sources.size ? maxYear : null,
      basins: [...basins].sort(),
      realizations: [...realizations].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
  }
}
