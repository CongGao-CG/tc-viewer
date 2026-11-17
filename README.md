# TC Viewer

Explore tropical cyclone tracks from your own NetCDF file on the GitHub Pages website. Use a current desktop browser with an internet connection. No installation is required.

## Open a file

1. Open the project’s GitHub Pages website.
2. Click **Choose a NetCDF file** or drag a file onto the page.
3. Wait for loading to finish. All tracks appear automatically on the map.

Your file is read locally in your browser. It is not uploaded or modified. Refreshing or closing the page clears the loaded data; select the file again to reopen it.

## Find and plot tracks

1. Search by **storm ID** or **start year**.
2. Optionally select a **basin**, **realization**, and **year range**. Years refer to when each track starts.
3. Click **Plot matching tracks** to update the map.

The catalogue displays 50 tracks per page. Use the arrow buttons to browse more results. Plotting includes all matching tracks, regardless of the catalogue page.

## Inspect one track

- Click a track in the catalogue or a line on the map.
- Click a point to see its time, coordinates, wind, and state.
- Click **All matches** to return to the filtered overview.

Wind values use the units recorded in the file. If units are missing, values are labeled **units unspecified** and are not converted.

## Map controls

| Control | Action |
| --- | --- |
| **Fit tracks** | Zoom to the displayed tracks. |
| **Clear** | Remove tracks from the map while keeping the file open. |
| **Reset** | Reset the search and filters; click **Plot matching tracks** to update the map. |
| **Basemap** | Switch between streets, terrain with ocean depth, and a blank background. |
| **Retry tiles** | Retry map tiles that failed to load. |
| **Close** | Release the loaded file. |

## Supported files

Use a NetCDF4 / HDF5 file with these root-level, one-dimensional variables, all sharing the same number of points:

| Variables | Requirement |
| --- | --- |
| `storm` | Required storm identifier. |
| `time` | Required numeric time with units such as `hours since 1980-11-05 00:00:00` and a Gregorian calendar. |
| `lon`, `lat` | Required coordinates in degrees. |
| `realization`, `wind`, `state` | Optional observation details. |

Tracks with the same storm ID in different realizations are treated separately. Classic NetCDF3 files and multidimensional track layouts are not supported.
