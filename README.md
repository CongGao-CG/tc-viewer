# TC Viewer

Explore and compare tropical cyclone tracks from your own NetCDF files on the GitHub Pages website. Use a current desktop browser with an internet connection. No installation is required.

## Add files

1. Open the project’s GitHub Pages website.
2. Click **Add NetCDF files** and select one or more files, or drag them onto the page.
3. Wait for loading to finish. Files and tracks appear in the catalogue; loading does not draw tracks or move the map.
4. Choose your filters, then click **Plot matching tracks** to draw the overview, or select an individual track from the catalogue.

You can add more files at any time without changing the current map. The loaded-file list shows each file’s color and track count. Click **×** beside a file to remove it and clear the displayed tracks, or **Remove all** to start over. Files load one at a time; **Cancel** stops pending files and keeps files already loaded. A file that fails to load does not remove the others.

Your files are read locally in your browser. They are not uploaded or modified. Refreshing or closing the page clears the loaded data; select the files again to reopen them.

## Find and plot tracks

1. Search by **storm ID** or **start year**.
2. Choose **All files** to compare datasets, or select one **Source file**. Optionally select a **basin**, **realization**, and **year range**. Years refer to when each track starts.
3. Click **Plot matching tracks** to update the map.

The catalogue displays 50 tracks per page. Use the arrow buttons to browse more results. Plotting includes all matching tracks, regardless of the catalogue page.

## Inspect one track

- Click a track in the catalogue or a line on the map.
- Click a point to see its source file, realization, time, coordinates, and wind.
- Click **All matches** to return to the filtered overview.

Wind is displayed in **knots (kt)**. Files without wind units are treated as knots. Explicit m/s or km/h units are converted to knots. The `state` variable is ignored.

## Map controls

Move the pointer over the map and scroll with two fingers on your trackpad to zoom in or out. You do not need to click the map first. Click and drag to pan.

| Control | Action |
| --- | --- |
| **Fit tracks** | Zoom to the displayed tracks. |
| **Clear** | Remove tracks from the map while keeping the files open. |
| **Reset** | Reset the search and filters; click **Plot matching tracks** to update the map. |
| **Basemap** | Switch between light streets, terrain with ocean depth, and a blank background. |
| **Retry tiles** | Retry map tiles that failed to load. |
| **×** beside a file | Remove that file and its tracks. |
| **Remove all** | Release all files and cancel pending loads. |

## Supported files

Use a NetCDF4 / HDF5 file with these root-level, one-dimensional variables, all sharing the same number of points:

| Variables | Requirement |
| --- | --- |
| `storm` | Required storm identifier. |
| `time` | Required numeric time with units such as `hours since 1980-11-05 00:00:00` and a Gregorian calendar. |
| `lon`, `lat` | Required coordinates in degrees. |
| `realization`, `wind` | Optional observation details. |

Tracks with the same storm ID in different files or realizations are treated separately. Files with identical names receive numbered labels so you can distinguish them. Classic NetCDF3 files and multidimensional track layouts are not supported.
