---
name: my-stores-route-map
description: Builds route-map PDFs for the user's assigned Fred Meyer stores from the my-stores rule and SAS prod verified addresses. Use when the user asks for my stores, store addresses, north-to-south ordering, route alignment, map pins, map overlay, large PDF maps, or efficient store visit order.
---

# My Stores Route Map

## Scope

Use this for repeatable store-route artifacts in `eod-api`, especially requests like:

- Pull prod addresses for "my stores"
- Order assigned stores north-to-south or by efficient visit route
- Create a large PDF with a map overlay, route line, pins, and address list

## Store Source

Read `C:/Users/tgaut/OneDrive/Documents/GitHub/the-dump-bin/EOD/rules/my-stores.mdc`.

If the user says "all ten", use the D8 set from that file:

```text
19, 23, 28, 31, 53, 215, 391, 459, 658, 682
```

If the user says "my stores" without a count or district, note that the rule contains D6, D8, and D9 groups. Use the wording in the request to choose the group, or ask if it is ambiguous.

## Data Source

Use SAS prod, not hardcoded addresses:

1. Load auth with `C:/Users/tgaut/kompass-netcap/lib/sas-session`.
2. Resolve each store through `/api/v1/projects/store-numbers/` with `customer=2`, `program=1`, `project=1`, and `search=<store>`.
3. Fetch verified address and coordinates from `/api/v1/customers/stores/{store__id}/`.

Never print or commit SAS tokens/session files. It is fine to print sanitized store number, address, city, latitude, longitude, and route summary.

## Preferred Builder

Run the checked-in builder from the repo root:

```powershell
node "scripts/build-my-stores-route-map.js"
```

The builder writes versioned outputs under:

```text
output/my-stores-route-map/
```

It uses:

- SAS prod verified address/location fields
- OSRM driving distances for route optimization
- OSRM route geometry for the line overlay
- OpenStreetMap raster tiles for the map background
- `writeFileVersioned` so existing or locked PDFs do not fail the run

## Validation

After running, verify:

- The PDF path exists and is non-empty.
- The JSON route data exists and lists the expected stores.
- The first stop is the northernmost selected store and the last stop is the southernmost selected store.
- `ReadLints` reports no new diagnostics for `scripts/build-my-stores-route-map.js` after script edits.

Summarize the PDF path, JSON path, total route miles/duration, and ordered store list.
