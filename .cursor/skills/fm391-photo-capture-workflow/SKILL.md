---
name: fm391-photo-capture-workflow
description: Build and operate mobile bay-photo capture apps from FM COM/ISE/Cut In load request spreadsheets using eod-api, Resend, and the flow-automation Gmail poller. Use when the user asks for FM391/P05W3 photo apps, bay photos, load request .xlsx files, mobile gallery/camera uploads, Resend photo routing, Gmail poller filing, Downloads/OneDrive photo folders, or related CORS/Railway deployment fixes.
---

# FM391 Photo Capture Workflow

## Core Workflow

1. Inspect the load request workbooks with `exceljs`.
   - Read the `LOAD` sheet.
   - Use `Store #`, `Category #`, `Category Name`, `Section size`, `POG ID`, `Set Type`, and `Department`.
   - One bay photo is needed per 4 ft: `Math.max(1, Math.ceil(sectionSizeFeet / 4))`.
   - Treat duplicate category rows as distinct sets by `POG ID` / POG short id.

2. Put the hosted app in `eod-api`.
   - Static app path: `src/public/<app-slug>/`.
   - Route it publicly in `src/index.js` with `/app-slug`, `/app-slug/assets/`, and `/api/<app-slug>/`.
   - Use absolute asset paths like `/fm391-p05w3/assets/app.js`; relative `./assets/...` breaks when a phone opens the no-slash route.
   - Keep app copy minimal: list what exists and what is needed; avoid explanatory requirements/limits unless user asks.
   - For mobile gallery support, use `<input type="file" accept="image/*">` without `capture="environment"`.
   - Use labels like `Add photo` and `Replace`, not camera-only language.

3. Send photos through `eod-api` and Resend.
   - API endpoint pattern: `POST /api/<app-slug>/photos`.
   - From: app-specific mailbox such as `FM391 Photos <fm391photos@retail-odyssey.com>`.
   - To default: `d6ewa.supervisor@gmail.com`, overridable by env when needed.
   - Subject prefix for FM391 P05W3: `[FM391 P05W3 photos]`.
   - Attachment filename pattern:
     `FM391_P05W3_C###_POG#######_Bay##of##_Category_Slug.jpg`.
   - Compress client-side and batch below the email budget, but do not surface size-limit copy in the field UI unless requested.

4. Route inbound photo emails in `flow-automation`.
   - Add a config root, e.g. `config.fm391P05W3Photos.root`, defaulting to `path.join(os.homedir(), 'Downloads', 'FM391_P05W3_Photos')`.
   - Add an email pattern like `/^\[FM391 P05W3 photos\]/i`.
   - Register the route near the top of `src/flows/router.js`, before broad/default routes.
   - Save raster attachments with `writeFileVersioned`.
   - For FM391 P05W3, save to:
     `Downloads/FM391_P05W3_Photos/C### Category - POG #######/Bay ## of ## - Category.jpg`.
   - Trust only the expected sender, e.g. `fm391photos@retail-odyssey.com`.

## UI Defaults

- Use high-contrast dark mode for field photo apps unless the user asks otherwise.
- Main progress text should be simple: `Captured X | Needed Y | Sent Z`.
- Set cards should show category name, source, set type, footage, POG, department, and captured/needed counts.
- Bay rows should show only `Needed`, `Captured`, or `Sent`.
- Keep status messages short: `Saving bay N...`, `Bay N captured.`, `Sending i/n...`, `Sent N.`, `No unsent photos.`
- Support at least two assignment paths: one bay at a time with automatic next-bay focus, and set-level bulk selection with a review panel where each image has a bay dropdown before saving.
- Optimize for mobile sizes: `viewport-fit=cover`, safe-area padding, no horizontal overflow, full-width touch targets under ~420px, wrapped long category names, and thumbnail/select layouts that shrink cleanly.

## CORS and Deployment Gotchas

- Browser uploads from `https://eod-api.the-dump-bin.com` send `Origin: https://eod-api.the-dump-bin.com`.
- If uploads return generic HTML `500 Internal Server Error`, check Railway logs for CORS errors before debugging Resend.
- `src/index.js` must always allow required origins even when `ALLOWED_ORIGINS` env is set:
  - `https://the-dump-bin.com`
  - `https://checklanes.the-dump-bin.com`
  - `https://eod-api.the-dump-bin.com`
  - `https://d6ewasupervisor-netizen.github.io`
- Verify the live origin behavior with a small route-level probe:

```bash
node -e "fetch('https://eod-api.the-dump-bin.com/api/fm391-p05w3/photos',{method:'POST',headers:{'content-type':'application/json','origin':'https://eod-api.the-dump-bin.com'},body:JSON.stringify({store:'FM391',periodWeek:'P05W3',workDate:'2026-06-05',photos:[]})}).then(async r=>{console.log(r.status,r.headers.get('content-type')); console.log(await r.text());})"
```

Expected after CORS is fixed: JSON from the route, e.g. `400 {"success":false,"error":"photos array is required."}` for an empty payload.

## Local Server Guardrail

- Do not start duplicate `flow-automation` or EOD emailer servers.
- If the user says their regular server is running, do not start an alternate local server.
- If terminal output shows `EADDRINUSE` on port `3001`, treat it as an existing server conflict and avoid launching another process. Inspect logs/status or ask the user to restart their regular server if needed.
- Use Railway logs/status to verify deployed `eod-api`; do not use local servers as proof that production works.

## Verification Checklist

- Run syntax checks on changed JS: `node --check <file>`.
- Use `ReadLints` on changed files.
- Validate manifest totals: set count and bay count.
- Validate filename parser against a sample attachment name.
- Verify both `/fm391-p05w3` and `/fm391-p05w3/` load styled HTML and app JS.
- Probe production with the browser `Origin` header after Railway deploys.
- Check `railway status --json` for the pushed commit reaching `SUCCESS` / `RUNNING`.
- Commit only related files; leave unrelated dirty workspace files unstaged.

## Commit Boundaries

- `eod-api`: app assets, API route, public mounting, CORS changes.
- `flow-automation`: config, router registration, Gmail inbox processor.
- Launcher repo (`FM391_P05W3_Photos`): keep as a simple GitHub Pages redirect/README unless the user asks for a standalone static app.
