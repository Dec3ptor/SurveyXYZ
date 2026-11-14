# SurveyXYZ

A phone/tablet web app for walked field surveys (built around landfill surface gas monitoring):
plan a walk pattern, stay on it, record a cleaned-up GPS track, drop geotagged notes and photos,
then merge the gas monitor's own log onto the track by time and take it all into QGIS.

No install, no account, no server: it is a static site that runs from GitHub Pages and keeps
working offline once opened. All data stays on the device until you export it.

## Putting it on GitHub Pages

1. Repo **Settings → Pages**.
2. **Source:** "Deploy from a branch". Pick the branch holding this code, folder `/ (root)`. Save.
3. After a minute the app is at `https://<user>.github.io/SurveyXYZ/`.
4. On the phone open that address, then **Add to Home Screen** (Safari share menu / Chrome menu → Install).

Pages on a private repository needs a paid GitHub plan; on a public repo it is free.
HTTPS is required for GPS and offline use, and Pages provides it.

## In the field

| Step | Where | What it does |
|---|---|---|
| Plan | **Plan** | Tap boundary corners (or walk the edge with **+ Here**), choose spacing and bearing, **Fill with transects**. Or tap out any route, or import GeoJSON / KML / GPX. |
| Clock | **Menu → Instrument clock sync** | Records how far the gas monitor's clock is from the phone's, so the merge lines up. |
| Walk | **Record** | The route is followed in order, start to finish. A compass arrow shows which way to face and walk, with the distance to the path (when off it) or to the next turn (when on it); beeps/vibrates when outside tolerance; walked sections turn green with a % complete. Tap the banner to continue from the nearest point, restart, or reverse the route. |
| Observe | **Mark** / **Note** | One-tap numbered pin, or a note with photos, category, manual reading and text. Position is taken when you press the button. |
| Offline map | **Menu → Settings** | Frame the site and **Save this map area** while you still have signal. |

Keep the app open with the screen on while recording. Browsers do not give web apps GPS in the
background or with the phone locked; the app holds a screen wake lock where the browser allows it.

## How the position filter works

Every raw fix is stored untouched. Next to it the app stores a filtered position from a Kalman
filter (`js/fusion.js`) that blends:

- **GPS**, weighted by its reported accuracy; fixes worse than a set accuracy are ignored.
- **Step detection** from the accelerometer. While you are still, the estimate is held and fixes
  are averaged, so GPS wander is not drawn as movement.
- **Compass heading**, calibrated continuously against GPS course so it works however the phone is
  carried. Each step advances the estimate, which carries it through short GPS dropouts.
- **Jump rejection**: a fix implausibly far from the estimate is ignored; if GPS keeps insisting
  for several fixes the filter re-locks to it.

This makes a phone behave noticeably better. It is still a phone: expect a few metres in the open,
worse beside structures or under trees. For sub-metre work pair the phone with an external GNSS
receiver (the app uses whatever position the phone reports).

## Exports

**Menu → Export → Everything (.zip)** contains:

- `track.csv` – one row per fix: UTC and local time, filtered and raw lat/lon, accuracy, speed, moving flag, source, off-path distance
- `track_line.geojson`, `track_points.geojson`, `observations.geojson`, `plan.geojson`
- `observations.csv`, `track.gpx`, `photos/`, `survey.json` (backup), `README.txt` (column and QGIS notes)

Everything is WGS84 / EPSG:4326. Drag the GeoJSON files into QGIS; load CSVs as delimited text
with X = `longitude`, Y = `latitude`.

## Merging instrument readings

**Menu → Merge instrument readings**, choose the monitor's CSV. The app finds the header row and
time columns, applies the clock offset, and interpolates each reading's position along the track.
Output is the original table plus `latitude`, `longitude`, `gps_accuracy_m`, `time_utc`,
`gps_match`, `gps_gap_s`, as CSV or GeoJSON, with a colour-by-value map preview. It works on a
desktop too: restore a `survey.json` backup there and merge.

## Development

No build step. `npm run serve` then open <http://localhost:8080>. `npm test` runs the unit tests
for the geometry, filter, merge and export code. Leaflet is vendored under `vendor/`.
