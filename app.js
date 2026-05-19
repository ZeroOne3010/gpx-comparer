const map = L.map('map').setView([37.7749, -122.4194], 12);
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
  errorMessage: document.getElementById('errorMessage')
};

const state = {
  routes: [],
  startLine: null,
  drawMode: false,
  drawPoints: [],
  isPlaying: false,
  currentSec: 0,
  maxSec: 0,
  rafId: null,
  lastFrameTs: null,
  speedDomain: null
};

const routeStyles = [
  {name: 'Route A', color: '#2563eb'},
  {name: 'Route B', color: '#a21caf'}
];

ui.fileA.addEventListener('change', () => handleFileLoad(0, ui.fileA.files?.[0]));
ui.fileB.addEventListener('change', () => handleFileLoad(1, ui.fileB.files?.[0]));
ui.drawLineBtn.addEventListener('click', toggleDrawMode);
ui.clearBtn.addEventListener('click', clearAll);
ui.playPauseBtn.addEventListener('click', togglePlayback);
ui.timeline.addEventListener('input', () => {
  state.currentSec = Number(ui.timeline.value);
  renderAtTime(state.currentSec);
});
map.on('click', onMapClick);

function clearAll() {
  clearError();
  stopPlayback();
  state.routes.forEach((route) => {
    route.layerGroup?.remove();
    route.marker?.remove();
  });
  state.routes = [];

  if (state.startLine) {
    state.startLine.remove();
    state.startLine = null;
  }

  state.drawMode = false;
  state.drawPoints = [];
  state.currentSec = 0;
  state.maxSec = 0;
  state.speedDomain = null;
  ui.fileA.value = '';
  ui.fileB.value = '';
  ui.fileNameA.textContent = 'No file selected';
  ui.fileNameB.textContent = 'No file selected';
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

async function handleFileLoad(routeIdx, file) {
  if (!file) return;
  clearError();
  try {
    const text = await file.text();
    const points = parseGpx(text);
    if (points.length < 2) throw new Error('GPX needs at least two points.');

    const style = routeStyles[routeIdx] || {name: `Route ${routeIdx + 1}`, color: '#111827'};

    if (state.routes[routeIdx]) {
      state.routes[routeIdx].layerGroup?.remove();
      state.routes[routeIdx].marker?.remove();
    }

    const route = {
      id: routeIdx,
      ...style,
      points,
      layerGroup: L.layerGroup().addTo(map),
      marker: null,
      syncStartIdx: null,
      syncTimeline: null
    };
    state.routes[routeIdx] = route;
    updateFileName(routeIdx, file.name);
    ui[routeIdx === 0 ? 'fileA' : 'fileB'].value = '';
    recalculateSpeedDomain();
    redrawAllRoutes();
    fitRoutes();
    attemptSyncAndPreparePlayback();
  } catch (err) {
    showError(`Could not load ${file.name}: ${err.message}`);
  }
}

function showError(message) {
  ui.errorMessage.textContent = message;
  ui.errorMessage.hidden = false;
}

function clearError() {
  ui.errorMessage.textContent = '';
  ui.errorMessage.hidden = true;
}
function updateFileName(routeIdx, name) {
  if (routeIdx === 0) ui.fileNameA.textContent = name;
  if (routeIdx === 1) ui.fileNameB.textContent = name;
}

function parseGpx(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) throw new Error('Invalid XML/GPX.');

  const trkpts = [...xml.querySelectorAll('trkpt')];
  return trkpts
    .map((pt) => {
      const lat = Number(pt.getAttribute('lat'));
      const lon = Number(pt.getAttribute('lon'));
      const ele = Number(pt.querySelector('ele')?.textContent ?? 0);
      const timeText = pt.querySelector('time')?.textContent;
      const time = timeText ? new Date(timeText).getTime() : NaN;
      return {lat, lon, ele, time};
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

function drawRoute(route) {
  const latLngs = route.points.map((p) => [p.lat, p.lon]);
  L.polyline(latLngs, {color: route.color, weight: 3, opacity: 0.45}).addTo(route.layerGroup);
  drawSpeedSegments(route);
  route.marker = L.circleMarker(latLngs[0], {
    radius: 6,
    color: '#111827',
    fillColor: route.color,
    fillOpacity: 1,
    weight: 2
  }).addTo(map);
}

function drawSpeedSegments(route) {
  if (!state.speedDomain) return;
  const {min, max} = state.speedDomain;
  const speeds = [];
  for (let i = 1; i < route.points.length; i += 1) {
    const p0 = route.points[i - 1];
    const p1 = route.points[i];
    const distM = haversineM(p0, p1);
    const dtSec = Number.isFinite(p1.time) && Number.isFinite(p0.time) ? (p1.time - p0.time) / 1000 : NaN;
    const speed = dtSec > 0 ? distM / dtSec : NaN;
    speeds.push(speed);
  }

  for (let i = 1; i < route.points.length; i += 1) {
    const speed = speeds[i - 1];
    if (!Number.isFinite(speed)) continue;
    const t = max > min ? (speed - min) / (max - min) : 0.5;
    const color = speedColor(t);
    L.polyline(
      [
        [route.points[i - 1].lat, route.points[i - 1].lon],
        [route.points[i].lat, route.points[i].lon]
      ],
      {color, weight: 5, opacity: 0.85}
    ).addTo(route.layerGroup);
  }
}

function speedColor(t) {
  const r = Math.round(255 * (1 - t));
  const g = Math.round(220 * t + 30);
  return `rgb(${r}, ${g}, 50)`;
}

function toggleDrawMode() {
  state.drawMode = !state.drawMode;
  state.drawPoints = [];
  ui.drawLineBtn.textContent = state.drawMode ? 'Click 2 points on map…' : 'Set starting line';
}

function onMapClick(e) {
  if (!state.drawMode) return;
  state.drawPoints.push(e.latlng);
  if (state.drawPoints.length < 2) return;

  if (state.startLine) state.startLine.remove();
  state.startLine = L.polyline(state.drawPoints.map((p) => [p.lat, p.lng]), {
    color: '#111827',
    dashArray: '8,6',
    weight: 4
  }).addTo(map);

  state.drawMode = false;
  state.drawPoints = [];
  ui.drawLineBtn.textContent = 'Set starting line';
  attemptSyncAndPreparePlayback();
}

function attemptSyncAndPreparePlayback() {
  if (!state.startLine) return;
  const requiredRoutes = [state.routes[0], state.routes[1]];
  if (requiredRoutes.some((route) => !route)) return;

  const [l0, l1] = state.startLine.getLatLngs();
  for (const route of requiredRoutes) {
    route.syncStartIdx = findCrossingIndex(route.points, l0, l1);
    if (route.syncStartIdx === -1) {
      stopPlayback();
      for (const resetRoute of requiredRoutes) {
        if (!resetRoute) continue;
        resetRoute.syncStartIdx = null;
        resetRoute.syncTimeline = null;
      }
      state.currentSec = 0;
      state.maxSec = 0;
      ui.timeline.value = '0';
      ui.timeline.max = '0';
      ui.timeline.disabled = true;
      ui.timelineTitle.textContent = 'Timeline · 00:00';
      ui.statsRow.innerHTML = '';
      ui.speedGroup.disabled = true;
      ui.playPauseBtn.disabled = true;
      return;
    }
    route.syncTimeline = buildSyncedTimeline(route.points, route.syncStartIdx);
  }

  state.maxSec = Math.ceil(Math.max(...requiredRoutes.map((r) => r.syncTimeline.at(-1).tSec)));
  state.currentSec = 0;
  ui.timeline.max = String(state.maxSec);
  ui.timeline.value = '0';
  ui.timeline.disabled = false;
  ui.speedGroup.disabled = false;
  ui.playPauseBtn.disabled = false;
  renderAtTime(0);
}

function findCrossingIndex(points, a, b) {
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (segmentsIntersect(prev, curr, a, b)) return i;
  }
  return -1;
}

function buildSyncedTimeline(points, startIdx) {
  const timeline = [{tSec: 0, point: points[startIdx]}];
  let elapsed = 0;
  for (let i = startIdx + 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const dtSec = Number.isFinite(prev.time) && Number.isFinite(curr.time) && curr.time > prev.time
      ? (curr.time - prev.time) / 1000
      : haversineM(prev, curr) / 4;
    elapsed += dtSec;
    timeline.push({tSec: elapsed, point: curr});
  }
  return timeline;
}

function togglePlayback() {
  if (!state.isPlaying) {
    state.isPlaying = true;
    ui.playPauseBtn.textContent = 'Pause';
    state.lastFrameTs = null;
    state.rafId = requestAnimationFrame(tick);
  } else {
    stopPlayback();
  }
}

function stopPlayback() {
  state.isPlaying = false;
  ui.playPauseBtn.textContent = 'Play';
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.lastFrameTs = null;
}

function tick(ts) {
  if (!state.isPlaying) return;
  if (!state.lastFrameTs) state.lastFrameTs = ts;
  const dt = (ts - state.lastFrameTs) / 1000;
  state.lastFrameTs = ts;
  state.currentSec += dt * getPlaybackSpeed();

  if (state.currentSec >= state.maxSec) {
    state.currentSec = state.maxSec;
    stopPlayback();
  }

  ui.timeline.value = String(Math.floor(state.currentSec));
  renderAtTime(state.currentSec);
  state.rafId = requestAnimationFrame(tick);
}
function getPlaybackSpeed() {
  return Number(ui.speedRadios.find((radio) => radio.checked)?.value ?? 1);
}

function renderAtTime(tSec) {
  const routeStats = [];
  for (const route of state.routes) {
    if (!route?.syncTimeline) continue;
    const pos = interpolatePoint(route.syncTimeline, tSec);
    route.marker.setLatLng([pos.lat, pos.lon]);
    routeStats.push({route, stats: computeStatsAtTime(route.syncTimeline, tSec)});
  }
  ui.timelineTitle.textContent = `Timeline · ${formatTime(tSec)}`;
  renderStats(routeStats);
}

function computeStatsAtTime(timeline, tSec) {
  if (!timeline?.length) return {distanceM: 0, speedMps: 0, avgMps: 0};
  const clamped = Math.max(0, Math.min(tSec, timeline.at(-1).tSec));
  if (clamped <= 0) return {distanceM: 0, speedMps: 0, avgMps: 0};

  let distanceM = 0;
  let speedMps = 0;

  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1];
    const curr = timeline[i];
    const segDt = curr.tSec - prev.tSec;
    if (segDt <= 0) continue;
    const segDist = haversineM(prev.point, curr.point);

    if (clamped >= curr.tSec) {
      distanceM += segDist;
      speedMps = segDist / segDt;
      continue;
    }

    if (clamped > prev.tSec) {
      const ratio = (clamped - prev.tSec) / segDt;
      distanceM += segDist * ratio;
      speedMps = segDist / segDt;
    }
    break;
  }

  return {distanceM, speedMps, avgMps: distanceM / clamped};
}

function renderStats(routeStats) {
  if (!routeStats.length) {
    ui.statsRow.innerHTML = '';
    return;
  }

  ui.statsRow.innerHTML = routeStats
    .map(({route, stats}) => {
      const speed = `${(stats.speedMps * 3.6).toFixed(1)}km/h`;
      const avg = `${(stats.avgMps * 3.6).toFixed(1)}km/h`;
      const dist = stats.distanceM >= 1000 ? `${(stats.distanceM / 1000).toFixed(2)}km` : `${Math.round(stats.distanceM)}m`;
      return `<span class="route-stats"><span class="route-dot ${route.id === 0 ? 'route-a' : 'route-b'}"></span>S:${speed} Avg:${avg} D:${dist}</span>`;
    })
    .join('');
}

function interpolatePoint(timeline, tSec) {
  if (tSec <= 0) return timeline[0].point;
  if (tSec >= timeline.at(-1).tSec) return timeline.at(-1).point;

  let i = 1;
  while (i < timeline.length && timeline[i].tSec < tSec) i += 1;
  const p0 = timeline[i - 1];
  const p1 = timeline[i];
  const span = p1.tSec - p0.tSec || 1;
  const ratio = (tSec - p0.tSec) / span;

  return {
    lat: p0.point.lat + (p1.point.lat - p0.point.lat) * ratio,
    lon: p0.point.lon + (p1.point.lon - p0.point.lon) * ratio
  };
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function fitRoutes() {
  const bounds = [];
  for (const route of state.routes) {
    if (!route) continue;
    route.points.forEach((p) => bounds.push([p.lat, p.lon]));
  }
  if (bounds.length) map.fitBounds(bounds, {padding: [30, 30]});
}
function recalculateSpeedDomain() {
  const speeds = [];
  for (const route of state.routes) {
    if (!route) continue;
    for (let i = 1; i < route.points.length; i += 1) {
      const p0 = route.points[i - 1];
      const p1 = route.points[i];
      const dtSec = Number.isFinite(p1.time) && Number.isFinite(p0.time) ? (p1.time - p0.time) / 1000 : NaN;
      const speed = dtSec > 0 ? haversineM(p0, p1) / dtSec : NaN;
      if (Number.isFinite(speed)) speeds.push(speed);
    }
  }
  if (!speeds.length) {
    state.speedDomain = null;
    return;
  }
  state.speedDomain = {min: Math.min(...speeds), max: Math.max(...speeds)};
}

function redrawAllRoutes() {
  for (const route of state.routes) {
    if (!route) continue;
    route.layerGroup?.remove();
    route.marker?.remove();
    route.layerGroup = L.layerGroup().addTo(map);
    route.marker = null;
    drawRoute(route);
  }
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  return o1 !== o2 && o3 !== o4;
}

function orientation(p, q, r) {
  const val = (q.lon ?? q.lng) - (p.lon ?? p.lng);
  const cross = val * ((r.lat ?? r[0]) - (q.lat ?? q[0])) - ((q.lat ?? q[0]) - (p.lat ?? p[0])) * ((r.lon ?? r.lng ?? r[1]) - (q.lon ?? q.lng));
  return cross > 0;
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
