"""Export a temporary NetCDF4 reference for verify-sample.mjs; never commit the output."""

import argparse
from collections import defaultdict
from datetime import datetime
import json
import math
from pathlib import Path

import netCDF4
import numpy as np


def json_value(value):
    if isinstance(value, np.ndarray):
        return json_value(value.tolist())
    if isinstance(value, np.generic):
        return json_value(value.item())
    if isinstance(value, dict):
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return {"__nonfinite__": str(value)}
    return value


def export_reference(source, destination):
    names = ["storm", "realization", "time", "lon", "lat", "wind", "state"]
    attributes = {"units", "calendar", "_FillValue", "missing_value", "scale_factor", "add_offset", "_Unsigned"}
    with netCDF4.Dataset(source) as dataset:
        variables = {}
        for name in names:
            if name not in dataset.variables:
                continue
            variable = dataset[name]
            variable.set_auto_maskandscale(False)
            variables[name] = {
                "values": variable[:],
                "attributes": {key: variable.getncattr(key) for key in variable.ncattrs() if key in attributes},
            }
        dataset.set_auto_maskandscale(True)
        times = netCDF4.num2date(dataset["time"][:], dataset["time"].units,
                                getattr(dataset["time"], "calendar", "standard"),
                                only_use_cftime_datetimes=False, only_use_python_datetimes=True)
        milliseconds = np.array([(time - datetime(1970, 1, 1)).total_seconds() * 1000 for time in times])
        lon = np.asarray(dataset["lon"][:])
        lat = np.asarray(dataset["lat"][:])
        wind = np.asarray(dataset["wind"][:])
        storm = dataset["storm"][:]
        realization = dataset["realization"][:]
        state = dataset["state"][:]

    groups = defaultdict(list)
    for row, (real, identifier) in enumerate(zip(realization, storm)):
        groups[(str(real), str(identifier))].append(row)
    normalized_lon = (lon + 180) % 360 - 180
    summaries, samples = [], []
    sample_positions = {0, len(groups) // 2, len(groups) - 1}
    for index, ((real, identifier), rows) in enumerate(groups.items()):
        rows.sort(key=lambda row: (milliseconds[row], row))
        key = json.dumps([real, identifier], separators=(",", ":"))
        summaries.append({
            "key": key, "id": identifier, "realization": real, "count": len(rows),
            "year": times[rows[0]].year, "startTime": milliseconds[rows[0]], "endTime": milliseconds[rows[-1]],
            "maxWind": np.nanmax(wind[rows]),
        })
        if index in sample_positions:
            samples.append({"key": key, "lon": normalized_lon[rows], "lat": lat[rows],
                            "wind": wind[rows], "time": milliseconds[rows], "state": state[rows]})
    valid = np.isfinite(lon) & np.isfinite(lat) & (np.abs(lat) <= 90)
    expected = {
        "pointCount": int(valid.sum()), "trackCount": len(groups),
        "realizationCount": len(set(realization)),
        "bounds": [normalized_lon[valid].min(), lat[valid].min(), normalized_lon[valid].max(), lat[valid].max()],
        "tracks": summaries, "samples": samples,
    }
    destination.write_text(json.dumps(json_value({"variables": variables, "expected": expected}), allow_nan=False))
    print(f"Exported {len(storm):,} points / {len(groups):,} tracks to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    export_reference(args.source, args.destination)
