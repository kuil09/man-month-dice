# Man-Month Dice PoC

A local-first software-estimation toy that models uncertainty as a TRPG dice pool.

## PoC behavior

- No login, backend, or database.
- Quest name, risk factors, parallelism, and roll history persist in browser `localStorage`.
- Five risk sliders create a dice pool from d4 through exploding d12.
- P50/P80/P95 are approximated in-browser with Monte Carlo simulation.
- A roll samples one possible project outcome; maximum d12 results explode and roll again.
- Three.js renders d4/d6/d8/d12 polyhedra in WebGL, with every value attached to the corresponding die face rather than drawn as a billboard overlay.
- cannon-es `0.20.0` performs rigid-body gravity, angular momentum, floor/wall contact, die-to-die collision, friction, restitution, and sleeping. The roll result is read from the final upward face.
- Three.js `0.185.1` and cannon-es `0.20.0` browser modules are vendored in `vendor/`; the deployed app has no CDN runtime dependency.
- Adding parallelism does not divide the effort roll. It is displayed as an independent coordination constraint.

## Run locally

Serve this directory with any static file server. ES modules cannot be opened reliably from `file://`, so use HTTP, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy

`.github/workflows/deploy-pages.yml` deploys the static site from `main` using GitHub Pages Actions.

The repository's Pages source must be configured to **GitHub Actions** once in repository settings if it is not already enabled.
