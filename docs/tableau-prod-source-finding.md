# Finding: SAS Tableau as a candidate PROD data source

**Date:** 2026-06-12  
**Status:** Candidate — NOT yet proven, NOT yet built. Read-only proof required before any pipeline work.  
**Source of finding:** HAR capture of the SAS analytics portal while browsing the "Category Data Validation" dashboard.

---

## What it is

SAS hosts a **Tableau Server** that already contains the full PROD category-reset dataset,
pre-joined, including before/after photos associated per category row.

| Field | Value |
|---|---|
| Server host | `analytics.demosystem.net` |
| Site | `/t/sas/` |
| Site LUID | `8df1b2af-4c64-4ed4-bf1d-70b9d7acf070` |
| Account | `tyson.gauthier@retailodyssey.com` (site role **Viewer**) |
| PAT available? | **Yes** — account can mint Personal Access Tokens |

**Workbooks / views of interest**

| Workbook | View | View LUID | Workbook LUID |
|---|---|---|---|
| `CategoryDataValidationv1_1_RU_0` | Main Dashboard | `48e8ac5a-fb07-46b0-857c-fb0874ace150` | `1c6ffcb2-2908-44c1-aaf3-ae8f93a4add7` |
| `RetailLogicReports` | Retail Logic Reports | `fd26c238-5fa1-4881-a454-c132057cfd77` | `9eb20e07-580d-4c66-853f-28301349a89f` |

Viz path (browser): `/t/sas/w/CategoryDataValidationv1_1_RU_0/v/MainDashboard`

---

## Why it matters

The datasource schema is essentially the entire PROD reset dataset already joined:

- **Done-status:** `Category Completion Status`, `Category Completion`, `Category Exception`, `Visit Current Status`
- **Set type / keys:** `Category Reset Type`, `Category Number`, `Department Number`, `Department Name`,
  `Planogram Id`, `New Pog Id` / `Name` / `Issue`, `Sub Category` / `Id`
- **Scope:** `Store Number` / `Name` / `City` / `State` / `Region`, `Visit Id`,
  `Visit Scheduled Start Date`, `Original Cycle Name` (carries period-week, e.g. P5W3),
  `Project Id` / `Name` / `Cycle Name`, `Ext Project Id`, `Is Before`, `Is Rolled Over`,
  `Last Reported Date`, `Team Name`, `Employee Names`
- **Images:** `Photo URL` — **before/after photos are already associated per category row and captioned**
  (displayed image embeds Store / Category / timestamp).

Dashboard filters (map to REST `vf_<field>=<value>` params): Store Region, Store Number,
M/Y of Scheduled Date, Scheduled Date, Category Name, Team Name, Original Cycle, Store Supervisor.

### Strategic implications
1. Could replace the slow per-store SAS category-reset pagination (the path the
   parallelization work optimized to ~3 min) with one supported query.
2. Could be a **cleaner image source** than raw PROD CloudFront: PROD gives an unordered
   bag of images with no bay/category label (the alignment problem). Tableau already groups
   photos by category and by before/after.

---

## Hard constraint on HOW to extract

There are two ways to get data out of Tableau. The difference is the whole decision.

- **DO NOT** scrape the vizql interactive-session protocol (`bootstrapSession`,
  `render-tooltip-server`, `hit-test-scene`). That is what the HAR captured because it is a
  browser rendering the dashboard. It is tied to session/layout/tuple IDs and breaks on any
  workbook edit. Fragility trap — do not build on it.
- **DO** use the supported data API:
  - REST view-data CSV export: `GET /api/<ver>/sites/{siteLuid}/views/{viewLuid}/data`
    with `vf_<field>=<value>` filters, after `POST /api/<ver>/auth/signin` with the PAT.
  - or VizQL Data Service (`/api/v1/vizql-data-service`) to query the published datasource
    directly as JSON — cleaner if the server version supports it.

---

## Unproven — must verify before promote

1. **REST view-data export returns `Photo URL` at row granularity.** The dots in the dashboard
   are a viz encoding; the export may surface the URL as a detail field or may not. Prove it.
2. **Freshness / refresh cadence.** A fast-but-stale source is worse than slow-but-fresh.
   Confirm how often the extract refreshes.
3. **Viewer role + PAT can download view data.** Requires the "Download Summary Data"
   permission on the view; orgs can restrict it.
4. **Whether the Photo URLs are the same CloudFront images** as the current PROD path (affects
   whether existing dedup/alignment logic still applies).

---

## Recommended next step (read-only proof — measure before refactor)

1. Mint a PAT (Account Settings -> Personal Access Tokens).
2. `POST /api/<ver>/auth/signin` with the PAT -> get `X-Tableau-Auth` token + site id.
3. One `GET /views/48e8ac5a-fb07-46b0-857c-fb0874ace150/data` with a tight `vf_` filter
   (one store, one scheduled date) -> inspect the returned CSV columns.
4. Confirm: done-status present, department number present, **Photo URL present at row level**,
   data fresh. Only then consider lifting into the pipeline.

Do **not** build the pipeline on the projection alone.

---

## Scope boundaries

- This does **not** address the SI/Rebotics side.
- The **live false `missing_in_si` bug is still unfixed** (run completes "green" reporting all
  sets missing when a Rebotics pagination page times out and partial SI rows are discarded).
  That safety bug is independent and still open.
