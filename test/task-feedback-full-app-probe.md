# Full application checkbox feedback probe

This opt-in probe runs the real application, CSS, authentication, database, schedulers, API routes and live events. It uses a fresh synthetic database and six synthetic household members. Each routine has nine required actions, one optional action, two points, expiration and weekday recurrence. Supervision cases also include five skills and the normal supervision/delegation projection. Windows are open during the test rather than depending on the time of day at which it runs.

Run it in a disposable, network-isolated runtime with application dependencies, Puppeteer and Chromium installed. Do not mount a production data directory, credentials, or configuration. The probe overwrites `DB_PATH`, uses an isolated synthetic session secret, and logs in through the normal login endpoint. `OUTPUT_DIR` is mandatory. `APP_ROOT` selects the source under test, independently of the test script, so an archived baseline and a candidate can use exactly the same probe.

For example, from a runtime containing the application in `/app` and a writable evidence directory `/evidence`:

```sh
APP_ROOT=/app OUTPUT_DIR=/evidence PHASE=native LIGHT=1 HOLD_MS=0 \
  SURFACES=modal,card,kanban node scripts/task-feedback-full-app-probe.mjs

APP_ROOT=/app OUTPUT_DIR=/evidence PHASE=held-raster HOLD_MS=500 \
  CASES=required-middle SURFACES=modal,card,kanban \
  node scripts/task-feedback-full-app-probe.mjs
```

Use `--help` for case selection, repetitions and provenance labels. `HOLD_MS` explicitly delays the status request before it enters the network. It tests whether local feedback is independent of both the HTTP acknowledgement and subsequent live delivery. It is not a production/network measurement. `HOLD_MS=0` measures the real local test server without this delay. All HTTP acknowledgements must succeed, and final required-step cases assert one parent earn and one recurrence successor.

The light run records pointerdown, pointerup, click, handler entry/return, pending-map updates, check-path mutation, first/second animation frames, response headers/JSON, DOM reconciliation, list replacement/refetch, live invalidation and long tasks. It has no screenshot or DevTools tracing overhead during the sample. Desired state is checked separately for completion and reopening. A completed parent leaving the Active list is represented by row removal, not mislabeled as a painted checkmark.

The raster run additionally captures whole-viewport PNGs before the action, while the request is held, and after acknowledgement, plus a DevTools trace with style/layout/paint/raster events. Inspect the actual target checkbox in these images. Avoid clipping the screenshot with a changing viewport: an earlier probe iteration moved the layout during capture and produced invalid crops. Raster evidence establishes what Chromium captured between the recorded screenshot begin/end times. It does not prove physical compositor/display presentation.

For a separate raster-frame run, combine `LIGHT=1 FRAMES=1 HOLD_MS=500`. DevTools screencast JPEG frames carry a wall-clock timestamp; the output aligns it with the pointer event using the browser's `performance.timeOrigin`. Inspect successive frames to identify the first containing the changed checkbox. This is a browser raster capture, not a physical display measurement, and its overhead is separate from the light run. PNG screencast recording proved expensive and was replaced by JPEG80; even JPEG capture timings must be distinguished from the light run.

Neither SVG existence nor an animation callback alone proves visible paint. The probe requires the intended check-path state, reports both animation frames, and uses separate raster evidence to establish that the pending checkmark really renders and remains visible. Tracing/screenshots can substantially delay frames; their timings must not be mixed with light-run timings. Use matched fixture order and runtime for baseline/candidate comparisons; fixtures accumulate deliberately, so later list reads include a larger household task tree.
