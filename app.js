const defaultMapCenter = [37.7749, -122.4194];
const map = L.map('map').setView(defaultMapCenter, 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const ui = {
  fileA: document.getElementById('fileA'),
  fileB: document.getElementById('fileB'),
  drawLineBtn: document.getElementById('drawLineBtn'),
  clearBtn: document.getElementById('clearBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  speedGroup: document.getElementById('speedGroup'),
  speedRadios: [...document.querySelectorAll('input[name="speed"]')],
  timeline: document.getElementById('timeline'),
  timelineTitle: document.getElementById('timelineTitle'),
  statsRow: document.getElementById('statsRow'),
  fileNameA: document.getElementById('fileNameA'),
  fileNameB: document.getElementById('fileNameB'),
  fileListA: document.getElementById('fileListA'),
  fileListB: document.getElementById('fileListB'),
  errorMessage: document.getElementById('errorMessage'),
  fileTriggers: [...document.querySelectorAll('.file-trigger')]
};

const routeStyles = [
  {name: 'Route A', color: '#2563eb'},
  {name: 'Route B', color: '#a21caf'}
];

const state = {
  routes: routeStylesTemplate(),
  startLine: null,
  drawMode: false,
  drawPoints: [],
  isPlaying: false,
  currentSec: 0,
  maxSec: 0,
  rafId: null,
  lastFrameTs: null,
  speedBuckets: null,
  hasUserInteractedMap: false
};

ui.fileA.addEventListener('change', () => handleFileLoad(0, [...(ui.fileA.files ?? [])]));
ui.fileB.addEventListener('change', () => handleFileLoad(1, [...(ui.fileB.files ?? [])]));
ui.fileTriggers.forEach((trigger) => {
  trigger.addEventListener('click', () => {
    const target = document.getElementById(trigger.dataset.target);
    target?.click();
  });
});
ui.drawLineBtn.addEventListener('click', toggleDrawMode);
ui.clearBtn.addEventListener('click', clearAll);
ui.playPauseBtn.addEventListener('click', togglePlayback);
ui.timeline.addEventListener('input', () => {
  state.currentSec = Number(ui.timeline.value);
  renderAtTime(state.currentSec);
});
map.on('click', onMapClick);
registerMapInteractionTracking();
initializeMapCenterFromUserLocation();



function registerMapInteractionTracking() {
  const mapContainer = map.getContainer();
  const markInteracted = () => { state.hasUserInteractedMap = true; };
  mapContainer.addEventListener('pointerdown', markInteracted, {passive: true});
  mapContainer.addEventListener('wheel', markInteracted, {passive: true});
}

function hasLoadedSamples() {
  return state.routes.some((route) => route.samples.length > 0);
}
function initializeMapCenterFromUserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    ({coords}) => {
      if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return;
      if (hasLoadedSamples() || state.hasUserInteractedMap) return;
      map.setView([coords.latitude, coords.longitude], 12);
    },
    () => {},
    {enableHighAccuracy: false, maximumAge: 15 * 60 * 1000, timeout: 5000}
  );
}
function routeStylesTemplate() {
  return routeStyles.map((style, idx) => ({id: idx, ...style, samples: []}));
}

function clearAll() {
  clearError();
  stopPlayback();
  for (const route of state.routes) {
    for (const sample of route.samples) {
      sample.layerGroup?.remove();
      sample.marker?.remove();
    }
  }
  state.routes = routeStylesTemplate();

  if (state.startLine) {
    state.startLine.remove();
    state.startLine = null;
  }

  state.drawMode = false;
  state.drawPoints = [];
  state.currentSec = 0;
  state.maxSec = 0;
  state.speedBuckets = null;
  ui.fileA.value = '';
  ui.fileB.value = '';
  ui.fileNameA.textContent = 'No files selected';
  ui.fileNameB.textContent = 'No files selected';
  renderFileLists();
  ui.timeline.value = 0;
  ui.timeline.max = 0;
  ui.timeline.disabled = true;
  ui.timelineTitle.textContent = 'Timeline · 00:00';
  ui.statsRow.innerHTML = '';
  ui.speedGroup.disabled = true;
  ui.playPauseBtn.disabled = true;
  ui.playPauseBtn.textContent = 'Play';
  ui.drawLineBtn.textContent = 'Set starting line';
}

async function handleFileLoad(routeIdx, files) {
  if (!files.length) return;
  clearError();
  const route = state.routes[routeIdx];

  try {
    const nextSamples = [];
    for (const [sampleIdx, file] of files.entries()) {
      const text = await file.text();
      const points = parseGpx(text);
      if (points.length < 2) throw new Error(`${file.name} has fewer than two points.`);
      nextSamples.push({
        id: `${routeIdx}-${sampleIdx}`,
        fileName: file.name,
        points,
        layerGroup: null,
        marker: null,
        syncStartIdx: null,
        syncTimeline: null
      });
    }

    for (const sample of route.samples) {
      sample.layerGroup?.remove();
      sample.marker?.remove();
    }
    route.samples = nextSamples.map((sample) => ({
      ...sample,
      layerGroup: L.layerGroup().addTo(map)
    }));

    updateFileName(routeIdx, route.samples.map((sample) => sample.fileName));
    ui[routeIdx === 0 ? 'fileA' : 'fileB'].value = '';
    recalculateSpeedDomain();
    redrawAllRoutes();
    fitRoutes();
    attemptSyncAndPreparePlayback();
  } catch (err) {
    showError(`Could not load files for ${route.name}: ${err.message}`);
  }
}

function showError(message) { ui.errorMessage.textContent = message; ui.errorMessage.hidden = false; }
function clearError() { ui.errorMessage.textContent = ''; ui.errorMessage.hidden = true; }
function updateFileName(routeIdx, names) {
  const txt = !names.length ? 'No files selected' : `${names.length} file(s): ${names.join(', ')}`;
  if (routeIdx === 0) ui.fileNameA.textContent = txt;
  if (routeIdx === 1) ui.fileNameB.textContent = txt;
  renderFileLists();
}

function renderFileLists() {
  renderFileListForRoute(0);
  renderFileListForRoute(1);
}

function renderFileListForRoute(routeIdx) {
  const route = state.routes[routeIdx];
  const listEl = ui[routeIdx === 0 ? 'fileListA' : 'fileListB'];
  if (!listEl) return;
  listEl.innerHTML = '';
  route.samples.forEach((sample, sampleIdx) => {
    const row = document.createElement('div');
    row.className = 'file-list-row';

    const name = document.createElement('span');
    name.className = 'file-list-name';
    name.textContent = sample.fileName;
    name.title = sample.fileName;

    const swapButton = document.createElement('button');
    swapButton.type = 'button';
    swapButton.className = 'swap-button';
    swapButton.textContent = routeIdx === 0 ? '→' : '←';
    swapButton.setAttribute('aria-label', `Move ${sample.fileName} to ${state.routes[1 - routeIdx].name}`);
    swapButton.addEventListener('click', () => swapSample(routeIdx, sampleIdx));

    row.append(name, swapButton);
    listEl.append(row);
  });
}

function clearAllSampleSyncState() {
  for (const route of state.routes) {
    for (const sample of route.samples) {
      sample.syncStartIdx = null;
      sample.syncTimeline = null;
    }
  }
}

function swapSample(fromRouteIdx, sampleIdx) {
  clearError();
  stopPlayback();
  const fromRoute = state.routes[fromRouteIdx];
  const toRoute = state.routes[1 - fromRouteIdx];
  const [sample] = fromRoute.samples.splice(sampleIdx, 1);
  if (!sample) return;

  sample.layerGroup?.remove();
  sample.marker?.remove();
  sample.layerGroup = L.layerGroup().addTo(map);
  sample.marker = null;
  sample.syncStartIdx = null;
  sample.syncTimeline = null;
  sample.id = `${toRoute.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  toRoute.samples.push(sample);

  redrawAllRoutes();
  updateFileName(0, state.routes[0].samples.map((item) => item.fileName));
  updateFileName(1, state.routes[1].samples.map((item) => item.fileName));

  if (state.startLine && state.routes.every((route) => route.samples.length > 0)) {
    attemptSyncAndPreparePlayback();
  } else {
    clearAllSampleSyncState();
    resetPlaybackState();
    renderAtTime(0);
  }
}

function parseGpx(xmlText) { /* unchanged */
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) throw new Error('Invalid XML/GPX.');
  return [...xml.querySelectorAll('trkpt')].map((pt) => ({
    lat: Number(pt.getAttribute('lat')),
    lon: Number(pt.getAttribute('lon')),
    ele: Number(pt.querySelector('ele')?.textContent ?? 0),
    time: pt.querySelector('time')?.textContent ? new Date(pt.querySelector('time').textContent).getTime() : NaN
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

function drawRouteSample(route, sample) {
  const latLngs = sample.points.map((p) => [p.lat, p.lon]);
  L.polyline(latLngs, {color: route.color, weight: 3, opacity: 0.3}).addTo(sample.layerGroup);
  drawSpeedSegments(sample);
  sample.marker = L.circleMarker(latLngs[0], {radius: 5, color: '#111827', fillColor: route.color, fillOpacity: 1, weight: 1}).addTo(map);
}

function drawSpeedSegments(sample) {
  if (!state.speedBuckets) return;
  const {lowMax, midMax} = state.speedBuckets;
  for (let i = 1; i < sample.points.length; i += 1) {
    const p0 = sample.points[i - 1];
    const p1 = sample.points[i];
    const dtSec = Number.isFinite(p1.time) && Number.isFinite(p0.time) ? (p1.time - p0.time) / 1000 : NaN;
    const speed = dtSec > 0 ? haversineM(p0, p1) / dtSec : NaN;
    if (!Number.isFinite(speed)) continue;
    const color = speed <= lowMax ? '#dc2626' : speed <= midMax ? '#eab308' : '#16a34a';
    L.polyline([[p0.lat, p0.lon], [p1.lat, p1.lon]], {color, weight: 5, opacity: 0.85}).addTo(sample.layerGroup);
  }
}

function toggleDrawMode() { state.drawMode = !state.drawMode; state.drawPoints = []; if (state.drawMode) stopPlayback(); ui.drawLineBtn.textContent = state.drawMode ? 'Click 2 points on map…' : 'Set starting line'; }
function onMapClick(e) { if (!state.drawMode) return; state.drawPoints.push(e.latlng); if (state.drawPoints.length < 2) return; stopPlayback(); if (state.startLine) state.startLine.remove(); state.startLine = L.polyline(state.drawPoints.map((p) => [p.lat, p.lng]), {color: '#111827', dashArray: '8,6', weight: 4}).addTo(map); state.drawMode = false; state.drawPoints = []; ui.drawLineBtn.textContent = 'Set starting line'; attemptSyncAndPreparePlayback(); }

function attemptSyncAndPreparePlayback() {
  if (!state.startLine) return;
  if (state.routes.some((route) => route.samples.length === 0)) return;
  const [l0, l1] = state.startLine.getLatLngs();
  for (const route of state.routes) {
    for (const sample of route.samples) {
      sample.syncStartIdx = findCrossingIndex(sample.points, l0, l1);
      if (sample.syncStartIdx === -1) {
        resetPlaybackState();
        return;
      }
      sample.syncTimeline = buildSyncedTimeline(sample.points, sample.syncStartIdx);
    }
  }
  state.maxSec = Math.ceil(Math.max(...state.routes.flatMap((route) => route.samples.map((sample) => sample.syncTimeline.at(-1).tSec))));
  state.currentSec = 0;
  ui.timeline.max = String(state.maxSec);
  ui.timeline.value = '0';
  ui.timeline.disabled = false;
  ui.speedGroup.disabled = false;
  ui.playPauseBtn.disabled = false;
  renderAtTime(0);
}

function resetPlaybackState() {
  stopPlayback();
  state.currentSec = 0;
  state.maxSec = 0;
  ui.timeline.value = '0'; ui.timeline.max = '0'; ui.timeline.disabled = true;
  ui.timelineTitle.textContent = 'Timeline · 00:00';
  ui.statsRow.innerHTML = '';
  ui.speedGroup.disabled = true;
  ui.playPauseBtn.disabled = true;
}

const findCrossingIndex = (points, a, b) => { for (let i = 1; i < points.length; i += 1) if (segmentsIntersect(points[i - 1], points[i], a, b)) return i; return -1; };
function buildSyncedTimeline(points, startIdx) { const timeline = [{tSec: 0, point: points[startIdx]}]; let elapsed = 0; for (let i = startIdx + 1; i < points.length; i += 1) { const prev = points[i - 1]; const curr = points[i]; const dtSec = Number.isFinite(prev.time) && Number.isFinite(curr.time) && curr.time > prev.time ? (curr.time - prev.time) / 1000 : haversineM(prev, curr) / 4; elapsed += dtSec; timeline.push({tSec: elapsed, point: curr}); } return timeline; }
function togglePlayback() { if (!state.isPlaying) { state.isPlaying = true; ui.playPauseBtn.textContent = 'Pause'; state.lastFrameTs = null; state.rafId = requestAnimationFrame(tick); } else stopPlayback(); }
function stopPlayback() { state.isPlaying = false; ui.playPauseBtn.textContent = 'Play'; if (state.rafId) cancelAnimationFrame(state.rafId); state.rafId = null; state.lastFrameTs = null; }
function tick(ts) { if (!state.isPlaying) return; if (!state.lastFrameTs) state.lastFrameTs = ts; const dt = (ts - state.lastFrameTs) / 1000; state.lastFrameTs = ts; state.currentSec += dt * getPlaybackSpeed(); if (state.currentSec >= state.maxSec) { state.currentSec = state.maxSec; stopPlayback(); } ui.timeline.value = String(Math.floor(state.currentSec)); renderAtTime(state.currentSec); state.rafId = requestAnimationFrame(tick); }
const getPlaybackSpeed = () => Number(ui.speedRadios.find((radio) => radio.checked)?.value ?? 1);

function renderAtTime(tSec) {
  const routeStats = [];
  for (const route of state.routes) {
    const sampleStats = [];
    for (const sample of route.samples) {
      if (!sample.syncTimeline) continue;
      const pos = interpolatePoint(sample.syncTimeline, tSec);
      sample.marker?.setLatLng([pos.lat, pos.lon]);
      sampleStats.push(computeStatsAtTime(sample.syncTimeline, tSec));
    }
    if (!sampleStats.length) continue;
    const avg = sampleStats.reduce((acc, cur) => ({
      speedMps: acc.speedMps + cur.speedMps,
      avgMps: acc.avgMps + cur.avgMps,
      distanceM: acc.distanceM + cur.distanceM
    }), {speedMps: 0, avgMps: 0, distanceM: 0});
    routeStats.push({route, stats: {speedMps: avg.speedMps / sampleStats.length, avgMps: avg.avgMps / sampleStats.length, distanceM: avg.distanceM / sampleStats.length}, sampleCount: sampleStats.length});
  }
  ui.timelineTitle.textContent = `Timeline · ${formatTime(tSec)}`;
  renderStats(routeStats);
}

function computeStatsAtTime(timeline, tSec) { if (!timeline?.length) return {distanceM: 0, speedMps: 0, avgMps: 0}; const clamped = Math.max(0, Math.min(tSec, timeline.at(-1).tSec)); if (clamped <= 0) return {distanceM: 0, speedMps: 0, avgMps: 0}; let distanceM = 0; let speedMps = 0; for (let i = 1; i < timeline.length; i += 1) { const prev = timeline[i - 1]; const curr = timeline[i]; const segDt = curr.tSec - prev.tSec; if (segDt <= 0) continue; const segDist = haversineM(prev.point, curr.point); if (clamped >= curr.tSec) { distanceM += segDist; speedMps = segDist / segDt; continue; } if (clamped > prev.tSec) { const ratio = (clamped - prev.tSec) / segDt; distanceM += segDist * ratio; speedMps = segDist / segDt; } break; } return {distanceM, speedMps, avgMps: distanceM / clamped}; }
function renderStats(routeStats) { if (!routeStats.length) return (ui.statsRow.innerHTML = ''); ui.statsRow.innerHTML = routeStats.map(({route, stats, sampleCount}) => { const speed = `${(stats.speedMps * 3.6).toFixed(1)} km/h`; const avg = `${(stats.avgMps * 3.6).toFixed(1)} km/h`; const dist = stats.distanceM >= 1000 ? `${(stats.distanceM / 1000).toFixed(2)} km` : `${Math.round(stats.distanceM)} m`; return `<span class="route-stats"><span class="route-dot ${route.id === 0 ? 'route-a' : 'route-b'}"></span>${route.name} (${sampleCount}): Spd: ${speed} Avg: ${avg} Dst: ${dist}</span>`; }).join(''); }
function interpolatePoint(timeline, tSec) { if (tSec <= 0) return timeline[0].point; if (tSec >= timeline.at(-1).tSec) return timeline.at(-1).point; let i = 1; while (i < timeline.length && timeline[i].tSec < tSec) i += 1; const p0 = timeline[i - 1]; const p1 = timeline[i]; const span = p1.tSec - p0.tSec || 1; const ratio = (tSec - p0.tSec) / span; return {lat: p0.point.lat + (p1.point.lat - p0.point.lat) * ratio, lon: p0.point.lon + (p1.point.lon - p0.point.lon) * ratio}; }
const formatTime = (sec) => `${String(Math.floor(Math.max(0, sec) / 60)).padStart(2, '0')}:${String(Math.max(0, Math.floor(sec)) % 60).padStart(2, '0')}`;
function fitRoutes() { const bounds = []; for (const route of state.routes) for (const sample of route.samples) sample.points.forEach((p) => bounds.push([p.lat, p.lon])); if (bounds.length) map.fitBounds(bounds, {padding: [30, 30]}); }
function recalculateSpeedDomain() { const speeds = []; for (const route of state.routes) for (const sample of route.samples) for (let i = 1; i < sample.points.length; i += 1) { const p0 = sample.points[i - 1]; const p1 = sample.points[i]; const dtSec = Number.isFinite(p1.time) && Number.isFinite(p0.time) ? (p1.time - p0.time) / 1000 : NaN; const speed = dtSec > 0 ? haversineM(p0, p1) / dtSec : NaN; if (Number.isFinite(speed)) speeds.push(speed); } if (!speeds.length) return (state.speedBuckets = null); speeds.sort((a, b) => a - b); const q = (f) => speeds[Math.min(speeds.length - 1, Math.max(0, Math.floor((speeds.length - 1) * f)))]; state.speedBuckets = {lowMax: q(1 / 3), midMax: q(2 / 3)}; }
function redrawAllRoutes() { for (const route of state.routes) for (const sample of route.samples) { sample.layerGroup?.remove(); sample.marker?.remove(); sample.layerGroup = L.layerGroup().addTo(map); sample.marker = null; drawRouteSample(route, sample); } }
function segmentsIntersect(p1, q1, p2, q2) { const o1 = orientation(p1, q1, p2); const o2 = orientation(p1, q1, q2); const o3 = orientation(p2, q2, p1); const o4 = orientation(p2, q2, q1); return o1 !== o2 && o3 !== o4; }
function orientation(p, q, r) { const val = (q.lon ?? q.lng) - (p.lon ?? p.lng); const cross = val * ((r.lat ?? r[0]) - (q.lat ?? q[0])) - ((q.lat ?? q[0]) - (p.lat ?? p[0])) * ((r.lon ?? r.lng ?? r[1]) - (q.lon ?? q.lng)); return cross > 0; }
function haversineM(a, b) { const R = 6371000; const toRad = (deg) => (deg * Math.PI) / 180; const dLat = toRad(b.lat - a.lat); const dLon = toRad(b.lon - a.lon); const lat1 = toRad(a.lat); const lat2 = toRad(b.lat); const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
