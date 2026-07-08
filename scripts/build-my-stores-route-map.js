#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');
const { loadSasSession } = require('C:/Users/tgaut/kompass-netcap/lib/sas-session');
const { writeFileVersioned } = require('../src/lib/file-utils');

const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const STORES = ['19', '23', '28', '31', '53', '215', '391', '459', '658', '682'];
const CUSTOMER = 2;
const PROGRAM = 1;
const PROJECT = 1;
const OUT_DIR = path.resolve('output', 'my-stores-route-map');
const PDF_NAME = 'D8_my_stores_north_to_south_route_map.pdf';
const JSON_NAME = 'D8_my_stores_north_to_south_route_data.json';
const USER_AGENT = 'eod-api my-stores-route-map/1.0 (one-off route artifact)';

const log = {
  info(meta, message) {
    if (typeof meta === 'string') {
      console.log(meta);
      return;
    }
    console.log(`${message}: ${JSON.stringify(meta)}`);
  },
  warn(meta, message) {
    if (typeof meta === 'string') {
      console.warn(meta);
      return;
    }
    console.warn(`${message}: ${JSON.stringify(meta)}`);
  },
};

function listFromResponse(data) {
  if (Array.isArray(data)) return data;
  return data?.results || data?.data || [];
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${url} ${res.status}: ${String(text).slice(0, 300)}`);
  }
  return body;
}

async function sasGet(token, apiPath, query = {}) {
  const qs = new URLSearchParams(query).toString();
  return fetchJson(`${SAS_BASE}${apiPath}${qs ? `?${qs}` : ''}`, {
    headers: {
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
}

async function fetchStoreRows(token) {
  const stores = [];
  for (const store of STORES) {
    const data = await sasGet(token, '/projects/store-numbers/', {
      customer: CUSTOMER,
      program: PROGRAM,
      project: PROJECT,
      search: store,
      page: 1,
      page_size: 20,
    });
    const exact = listFromResponse(data).find((row) => String(row.store__number || row.store?.number || row.number) === store);
    if (!exact?.store__id) throw new Error(`Could not resolve prod store id for store ${store}`);
    const detail = await sasGet(token, `/customers/stores/${exact.store__id}/`);
    const address = detail.address || {};
    const city = address.city || {};
    const coordinates = address.location?.coordinates || [];
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Store ${store} is missing usable prod coordinates`);
    }
    stores.push({
      store,
      projectStoreId: exact.id,
      prodStoreId: exact.store__id,
      name: detail.name || exact.store__name || 'Fred Meyer',
      phone: detail.phone || '',
      addressLine: address.line || '',
      city: city.name || '',
      state: city.state_abbr || city.state_name || '',
      postalCode: address.postal_code || '',
      verified: Boolean(address.verified),
      tdLinxID: detail.tdLinxID || '',
      lat,
      lon,
    });
  }
  return stores;
}

function haversineMeters(a, b) {
  const r = 6371000;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

async function osrmTable(stores) {
  const coordText = stores.map((s) => `${s.lon},${s.lat}`).join(';');
  const data = await fetchJson(
    `https://router.project-osrm.org/table/v1/driving/${coordText}?annotations=distance,duration`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (data.code !== 'Ok' || !Array.isArray(data.distances)) {
    throw new Error(`OSRM table returned ${data.code || 'unknown status'}`);
  }
  return { distances: data.distances, durations: data.durations };
}

function buildFallbackMatrix(stores) {
  return stores.map((from) => stores.map((to) => haversineMeters(from, to)));
}

function findShortestPath(distances, startIndex, endIndex) {
  const middle = distances
    .map((_, index) => index)
    .filter((index) => index !== startIndex && index !== endIndex);
  let bestOrder = null;
  let bestDistance = Infinity;

  function walk(prefix, remaining, distanceSoFar) {
    if (distanceSoFar >= bestDistance) return;
    if (!remaining.length) {
      const finalDistance = distanceSoFar + distances[prefix[prefix.length - 1]][endIndex];
      if (finalDistance < bestDistance) {
        bestDistance = finalDistance;
        bestOrder = [...prefix, endIndex];
      }
      return;
    }
    const last = prefix[prefix.length - 1];
    for (let i = 0; i < remaining.length; i += 1) {
      const next = remaining[i];
      const leg = distances[last][next];
      if (!Number.isFinite(leg)) continue;
      walk(
        [...prefix, next],
        [...remaining.slice(0, i), ...remaining.slice(i + 1)],
        distanceSoFar + leg,
      );
    }
  }

  walk([startIndex], middle, 0);
  if (!bestOrder) throw new Error('Could not compute a complete route order');
  return { order: bestOrder, distanceMeters: bestDistance };
}

async function fetchRouteGeometry(orderedStores) {
  const coordText = orderedStores.map((s) => `${s.lon},${s.lat}`).join(';');
  const data = await fetchJson(
    `https://router.project-osrm.org/route/v1/driving/${coordText}?overview=full&geometries=geojson&steps=false`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  const route = data.routes?.[0];
  if (!route?.geometry?.coordinates?.length) throw new Error('OSRM route response did not include geometry');
  return {
    coordinates: route.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}

function mercatorPixel(lon, lat, zoom) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  const n = 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * n * 256,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n * 256,
  };
}

function chooseMapProjection(points, width, height) {
  let best = null;
  for (let zoom = 13; zoom >= 6; zoom -= 1) {
    const projected = points.map((p) => mercatorPixel(p.lon, p.lat, zoom));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const rawMinX = Math.min(...xs);
    const rawMaxX = Math.max(...xs);
    const rawMinY = Math.min(...ys);
    const rawMaxY = Math.max(...ys);
    const padX = Math.max(80, (rawMaxX - rawMinX) * 0.12);
    const padY = Math.max(80, (rawMaxY - rawMinY) * 0.12);
    const minX = rawMinX - padX;
    const maxX = rawMaxX + padX;
    const minY = rawMinY - padY;
    const maxY = rawMaxY + padY;
    const tileMinX = Math.floor(minX / 256);
    const tileMaxX = Math.floor(maxX / 256);
    const tileMinY = Math.floor(minY / 256);
    const tileMaxY = Math.floor(maxY / 256);
    const tileCount = (tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1);
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    const candidate = { zoom, minX, maxX, minY, maxY, tileMinX, tileMaxX, tileMinY, tileMaxY, tileCount, scale };
    if (!best || (tileCount <= 48 && scale >= 0.35 && scale <= 2.2)) best = candidate;
    if (tileCount <= 48 && scale >= 0.55 && scale <= 1.7) return candidate;
  }
  return best;
}

async function fetchTile(zoom, x, y) {
  const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`tile ${zoom}/${x}/${y} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function drawMapTiles(doc, projection, mapBox) {
  const tiles = [];
  for (let tx = projection.tileMinX; tx <= projection.tileMaxX; tx += 1) {
    for (let ty = projection.tileMinY; ty <= projection.tileMaxY; ty += 1) {
      tiles.push({ tx, ty });
    }
  }
  await Promise.all(tiles.map(async (tile) => {
    try {
      tile.buffer = await fetchTile(projection.zoom, tile.tx, tile.ty);
    } catch (err) {
      tile.error = err.message;
    }
  }));

  doc.save()
    .rect(mapBox.x, mapBox.y, mapBox.width, mapBox.height)
    .clip();
  doc.rect(mapBox.x, mapBox.y, mapBox.width, mapBox.height).fill('#eef2f0');
  for (const tile of tiles) {
    if (!tile.buffer) continue;
    const x = mapBox.x + ((tile.tx * 256) - projection.minX) * projection.scale;
    const y = mapBox.y + ((tile.ty * 256) - projection.minY) * projection.scale;
    const size = 256 * projection.scale + 0.5;
    doc.image(tile.buffer, x, y, { width: size, height: size });
  }
  doc.restore();
  return tiles.filter((tile) => tile.error).map((tile) => tile.error);
}

function projectToMap(point, projection, mapBox) {
  const px = mercatorPixel(point.lon, point.lat, projection.zoom);
  return {
    x: mapBox.x + (px.x - projection.minX) * projection.scale,
    y: mapBox.y + (px.y - projection.minY) * projection.scale,
  };
}

function drawRouteLine(doc, points, projection, mapBox) {
  const projected = points.map((point) => projectToMap(point, projection, mapBox));
  if (projected.length < 2) return;
  doc.save()
    .rect(mapBox.x, mapBox.y, mapBox.width, mapBox.height)
    .clip();
  doc.lineWidth(5).strokeColor('#ffffff').opacity(0.78);
  doc.moveTo(projected[0].x, projected[0].y);
  for (const point of projected.slice(1)) doc.lineTo(point.x, point.y);
  doc.stroke();
  doc.lineWidth(2.5).strokeColor('#075985').opacity(0.95);
  doc.moveTo(projected[0].x, projected[0].y);
  for (const point of projected.slice(1)) doc.lineTo(point.x, point.y);
  doc.stroke();
  doc.opacity(1).restore();
}

function drawPins(doc, orderedStores, projection, mapBox) {
  doc.save()
    .rect(mapBox.x, mapBox.y, mapBox.width, mapBox.height)
    .clip();
  orderedStores.forEach((store, index) => {
    const p = projectToMap(store, projection, mapBox);
    const label = String(store.store);
    const r = label.length >= 3 ? 18 : 16;
    const fontSize = label.length >= 3 ? 8 : 9;

    doc.circle(p.x, p.y, r + 2).fill('#ffffff');
    doc.circle(p.x, p.y, r).fill('#b91c1c');

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fontSize);
    const storeTextHeight = doc.heightOfString(label, { width: r * 2 });
    doc.text(label, p.x - r, p.y - storeTextHeight / 2, { width: r * 2, align: 'center' });

    const orderLabel = String(index + 1);
    const orderR = 10;
    const orderFontSize = 9;
    const orderCy = p.y - r - 8 - orderR;

    doc.circle(p.x, orderCy, orderR + 1.5).fill('#ffffff');
    doc.circle(p.x, orderCy, orderR).fill('#15803d');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(orderFontSize);
    const orderTextHeight = doc.heightOfString(orderLabel, { width: orderR * 2 });
    doc.text(orderLabel, p.x - orderR, orderCy - orderTextHeight / 2, {
      width: orderR * 2,
      align: 'center',
    });
  });
  doc.restore();
}

function formatAddress(store) {
  return `${store.addressLine}, ${store.city}, ${store.state} ${store.postalCode}`;
}

function miles(meters) {
  return meters / 1609.344;
}

function durationText(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function drawRouteList(doc, orderedStores, listBox, routeMeta) {
  doc.roundedRect(listBox.x, listBox.y, listBox.width, listBox.height, 8)
    .fillAndStroke('#ffffff', '#d1d5db');
  let y = listBox.y + 16;
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16)
    .text('Visit Order', listBox.x + 16, y);
  y += 23;
  doc.fillColor('#374151').font('Helvetica').fontSize(9)
    .text(
      `North-to-south optimized route (${routeMeta.method}). ${routeMeta.routeDistanceMiles.toFixed(1)} route miles, about ${routeMeta.duration}.`,
      listBox.x + 16,
      y,
      { width: listBox.width - 32 },
    );
  y += 34;
  orderedStores.forEach((store, index) => {
    const rowHeight = 49;
    if (index > 0) {
      doc.strokeColor('#e5e7eb').lineWidth(0.5)
        .moveTo(listBox.x + 16, y - 7)
        .lineTo(listBox.x + listBox.width - 16, y - 7)
        .stroke();
    }
    doc.circle(listBox.x + 27, y + 8, 10).fill('#b91c1c');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
      .text(String(index + 1), listBox.x + 17, y + 4, { width: 20, align: 'center' });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10)
      .text(`FM ${store.store} - ${store.city}`, listBox.x + 45, y, { width: listBox.width - 62 });
    doc.fillColor('#374151').font('Helvetica').fontSize(8.5)
      .text(formatAddress(store), listBox.x + 45, y + 13, { width: listBox.width - 62 });
    doc.fillColor('#6b7280').font('Helvetica').fontSize(7.5)
      .text(`${store.lat.toFixed(5)}, ${store.lon.toFixed(5)}${store.verified ? ' - verified prod address' : ''}`, listBox.x + 45, y + 27, {
        width: listBox.width - 62,
      });
    y += rowHeight;
  });
}

async function renderPdf({ orderedStores, routeGeometry, routeMeta, outputJsonPath }) {
  const page = { width: 1224, height: 792 };
  const doc = new PDFDocument({ size: [page.width, page.height], margin: 0, bufferPages: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const mapBox = { x: 34, y: 84, width: 805, height: 655 };
  const listBox = { x: 862, y: 84, width: 328, height: 655 };
  const mapPoints = [
    ...orderedStores.map((s) => ({ lon: s.lon, lat: s.lat })),
    ...(routeGeometry?.coordinates || []),
  ];
  const projection = chooseMapProjection(mapPoints, mapBox.width, mapBox.height);

  doc.rect(0, 0, page.width, page.height).fill('#f8fafc');
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(25)
    .text('D8 My Stores Route Map', 34, 28);
  doc.fillColor('#374151').font('Helvetica').fontSize(10)
    .text('Source: SAS prod verified store addresses. Map tiles: OpenStreetMap. Route: OSRM driving table with northmost start and southmost finish.', 34, 58, {
      width: 980,
    });

  const tileErrors = await drawMapTiles(doc, projection, mapBox);
  doc.rect(mapBox.x, mapBox.y, mapBox.width, mapBox.height).lineWidth(1).strokeColor('#9ca3af').stroke();
  drawRouteLine(doc, routeGeometry?.coordinates || orderedStores, projection, mapBox);
  drawPins(doc, orderedStores, projection, mapBox);
  doc.fillColor('#111827').font('Helvetica').fontSize(7)
    .text('(c) OpenStreetMap contributors', mapBox.x + mapBox.width - 132, mapBox.y + mapBox.height - 14, {
      width: 124,
      align: 'right',
    });

  drawRouteList(doc, orderedStores, listBox, routeMeta);

  const footer = `Generated ${new Date().toLocaleString()} - Data file: ${path.basename(outputJsonPath)}${tileErrors.length ? ` - ${tileErrors.length} map tile(s) unavailable` : ''}`;
  doc.fillColor('#6b7280').font('Helvetica').fontSize(8)
    .text(footer, 34, 758, { width: page.width - 68 });

  doc.end();
  await new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  return Buffer.concat(chunks);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const session = await loadSasSession();
  const stores = await fetchStoreRows(session.token);
  const northIndex = stores.reduce((best, store, index) => (store.lat > stores[best].lat ? index : best), 0);
  const southIndex = stores.reduce((best, store, index) => (store.lat < stores[best].lat ? index : best), 0);

  let distances;
  let durations = null;
  let method = 'straight-line fallback';
  try {
    const table = await osrmTable(stores);
    distances = table.distances;
    durations = table.durations;
    method = 'OSRM driving distance';
  } catch (err) {
    distances = buildFallbackMatrix(stores);
    log.warn({ error: err.message }, 'OSRM table unavailable; using haversine fallback');
  }

  const shortest = findShortestPath(distances, northIndex, southIndex);
  const orderedStores = shortest.order.map((index) => stores[index]);
  let durationSeconds = durations
    ? shortest.order.slice(1).reduce((sum, index, routeIndex) => sum + durations[shortest.order[routeIndex]][index], 0)
    : null;
  let routeGeometry = { coordinates: orderedStores.map((s) => ({ lon: s.lon, lat: s.lat })), distanceMeters: shortest.distanceMeters, durationSeconds };

  if (method.startsWith('OSRM')) {
    try {
      routeGeometry = await fetchRouteGeometry(orderedStores);
      durationSeconds = routeGeometry.durationSeconds;
    } catch (err) {
      log.warn({ error: err.message }, 'OSRM route geometry unavailable; drawing waypoint line');
    }
  }

  const routeMeta = {
    method,
    startStore: orderedStores[0].store,
    endStore: orderedStores[orderedStores.length - 1].store,
    routeDistanceMiles: miles(routeGeometry.distanceMeters || shortest.distanceMeters),
    optimizedLegDistanceMiles: miles(shortest.distanceMeters),
    duration: durationText(durationSeconds),
  };

  const data = {
    generatedAt: new Date().toISOString(),
    source: {
      storesFile: 'C:/Users/tgaut/OneDrive/Documents/GitHub/the-dump-bin/EOD/rules/my-stores.mdc',
      prodEndpoint: '/api/v1/customers/stores/{store__id}/',
      selectedGroup: 'D8',
    },
    route: routeMeta,
    stores: orderedStores,
  };
  const jsonPath = await writeFileVersioned(path.join(OUT_DIR, JSON_NAME), `${JSON.stringify(data, null, 2)}\n`, log);
  const pdfBuffer = await renderPdf({ orderedStores, routeGeometry, routeMeta, outputJsonPath: jsonPath });
  const pdfPath = await writeFileVersioned(path.join(OUT_DIR, PDF_NAME), pdfBuffer, log);

  console.log(JSON.stringify({
    pdfPath,
    jsonPath,
    route: routeMeta,
    orderedStores: orderedStores.map((store, index) => ({
      order: index + 1,
      store: store.store,
      city: store.city,
      address: formatAddress(store),
      lat: store.lat,
      lon: store.lon,
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
