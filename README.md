# SpacetimeCake

A browser app that stacks a video's frames into a 3D *spatiotemporal volume*
and lets you slice through it interactively — like cutting a cake where the
two horizontal axes are space (the video frame) and the vertical axis is time.

It also detects objects with COCO-SSD, tracks each object across frames,
segments the track you pick pixel-perfectly with SAM (Segment Anything),
and masks the volume down to *just one object's trajectory* through
space-time.

## Quick start

```bash
npm run dev      # starts http://localhost:5173 (zero dependencies)
```

Open the URL, drop a short video onto the page, click **Detect Objects**,
and pick a track from the list. Detection is fast (COCO-SSD only); the
heavier SAM segmentation runs the first time you select a track and is
cached after that.

You can also click **Try the sample video** for a guided first run. Once a
video is loaded, use the timeline to scrub or play through time, click any
XY/XT/YT preview to reposition the slice, and collapse either inspector when
you want more canvas space. **Save PNG** exports the current 3D view and
**Save data** exports the compact view and tracking metadata as JSON.

The four-step indicator reflects the intended workflow:

1. Load a local video (processing stays in the browser).
2. Explore the volume and move the slice through time.
3. Detect stable object tracks.
4. Select a track to isolate its trajectory.

> Cross-origin isolation is enabled in the dev server (`COOP`/`COEP`)
> so that ONNX Runtime threads / `SharedArrayBuffer` work for the SAM
> model. If you serve this app yourself, replicate those headers.

## Project layout

```
.
├── index.html               # entry point — just CSS + main.js + UI markup
├── styles/main.css          # all the styles
├── src/
│   ├── main.js              # orchestrator: wires everything together
│   ├── state.js             # shared mutable app state
│   ├── shaders.js           # GLSL strings (cube / slice / ortho previews)
│   ├── scene.js             # Three.js renderer, camera, orbit controls
│   ├── cube.js              # builds the cube + slice plane after a video loads
│   ├── orthoPreviews.js     # XY / XT / YT corner-panel renderers
│   ├── interactions.js      # transform-gizmo + click-and-drag handling
│   ├── video.js             # extract evenly-spaced frames from a video
│   ├── detection.js         # COCO-SSD detection + SAM segmentation per frame
│   ├── tracker.js           # IoU-based object tracking across frames
│   ├── tracks.js            # tracks-panel UI (list, select, clear)
│   ├── mask.js              # builds the 3D voxel mask for a track
│   └── ui.js                # DOM wiring for the side panels
├── scripts/
│   ├── serve.mjs            # zero-dep static dev server
│   ├── diagnose-full.mjs    # full-pipeline check with real models
│   └── dump-masks.mjs       # dump SAM masks as PNGs for visual inspection
├── tests/
│   ├── unit/                # node --test (no browser needed)
│   └── e2e/                 # Playwright (drives a real browser)
└── playwright.config.js
```

## How it works

1. **Frame extraction** — `video.js` seeks the `<video>` element to N evenly
   spaced timestamps, draws each frame to a canvas (vertically flipped so it
   sits naturally in the volume's coordinate system), and packs the pixels
   into a single `Uint8Array` of shape `W × H × N × 4`.
2. **3D texture** — that array is uploaded to a `THREE.Data3DTexture`.
3. **Cube + slice plane** — `cube.js` builds a box geometry with size
   `(1, videoAspect, depth)` and a quad that slices through it. A custom
   shader samples the 3D texture and discards anything outside the cube /
   outside the mask.
4. **Render modes** — Opaque (cube faces only), Volume fog (alpha-blended
   ray-march), Path (MIP / soft-fog blend, controlled by a slider).
5. **Detection** — `detection.js` runs COCO-SSD per frame to get bounding
   boxes and classes. No segmentation happens yet, so this pass is fast.
6. **Tracking** — `tracker.js` matches detections between consecutive frames
   by IoU + same class, building tracks that span multiple frames.
7. **Segmentation** — when you select a track, `segmentTrack()` prompts SAM
   (SlimSAM-77 via `transformers.js`) with a grid of points inside each
   detection's bbox and gets back the pixel-accurate object mask. Masks are
   cached on the detections, so re-selecting a track is instant.
8. **Masking** — `mask.js` copies the track's per-frame masks into a 3D voxel
   texture; the shader uses it to discard everything that isn't the object.

## Tests

```bash
npm install                      # dev dependencies (Playwright)
npx playwright install chromium  # one-time browser download for E2E
npm run test:unit                # pure logic (Node 18+ built-in test runner)
npm run test:e2e                 # Playwright drives a real browser
npm test                         # both
```

E2E tests start a server on a random port, load the page, drive the UI,
and assert on rendered state.
