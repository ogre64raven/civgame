// 세계지도 육지 마스크 → 헥스 그리드 샘플링 → data/worldmask.json
// 실행: npm run buildmap  (world-atlas, topojson-client, d3-geo 필요 — devDependencies)
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains } = require('d3-geo');

const topo = require('world-atlas/land-110m.json');
const land = topojson.feature(topo, topo.objects.land);
const countries = require('../data/countries.json');

// 그리드 설정 (odd-r offset, pointy-top). 위도 85N ~ 60S (남극 제외)
const W = 90, H = 45, LAT_TOP = 85, LAT_SPAN = 145;

function hexToLonLat(x, y) {
  const lat = LAT_TOP - ((y + 0.5) / H) * LAT_SPAN;
  const off = (y % 2) ? 0.5 : 0;
  let lon = -180 + ((x + 0.5 + off) / W) * 360;
  if (lon > 180) lon -= 360;
  return [lon, lat];
}

function lonlatToHex(lat, lon) {
  let y = Math.round(((LAT_TOP - lat) / LAT_SPAN) * H - 0.5);
  y = Math.max(0, Math.min(H - 1, y));
  const off = (y % 2) ? 0.5 : 0;
  let x = Math.round(((lon + 180) / 360) * W - 0.5 - off);
  x = ((x % W) + W) % W;
  return [x, y];
}

// 결정적 해시 (지형 배치용)
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 헥스당 5점 샘플링, 2점 이상 육지면 육지
const dLon = 360 / W, dLat = LAT_SPAN / H;
function isLandHex(x, y) {
  const [lon, lat] = hexToLonLat(x, y);
  const pts = [
    [lon, lat],
    [lon - dLon / 3, lat], [lon + dLon / 3, lat],
    [lon, lat - dLat / 3], [lon, lat + dLat / 3],
  ];
  let hits = 0;
  for (const p of pts) {
    if (p[0] < -180) p[0] += 360;
    if (p[0] > 180) p[0] -= 360;
    if (geoContains(land, p)) hits++;
  }
  return hits >= 2;
}

// 지형: ~ 바다 / g 초원(곡식) / p 평원(고기) / f 숲(목재) / m 산(철)
function terrainFor(x, y) {
  const r = hash(x, y);
  if (r < 0.15) return 'm';
  if (r < 0.42) return 'f';
  if (r < 0.71) return 'g';
  return 'p';
}

const grid = [];
for (let y = 0; y < H; y++) {
  let row = '';
  for (let x = 0; x < W; x++) row += isLandHex(x, y) ? terrainFor(x, y) : '~';
  grid.push(row);
}

// 모든 수도가 육지가 되도록 보정 (작은 섬나라 → 1헥스 섬 생성)
let forced = 0;
for (const c of countries) {
  const [x, y] = lonlatToHex(c.cap[0], c.cap[1]);
  if (grid[y][x] === '~') {
    grid[y] = grid[y].slice(0, x) + terrainFor(x, y) + grid[y].slice(x + 1);
    forced++;
  }
}

const out = { w: W, h: H, latTop: LAT_TOP, latSpan: LAT_SPAN, rows: grid };
fs.writeFileSync(path.join(__dirname, '../data/worldmask.json'), JSON.stringify(out));

const landCount = grid.join('').replace(/~/g, '').length;
console.log(`worldmask.json 생성: ${W}x${H}, 육지 ${landCount}타일 (${(landCount / (W * H) * 100).toFixed(1)}%), 섬 보정 ${forced}개국`);
// 미리보기
for (let y = 0; y < H; y += 2) console.log(grid[y].replace(/~/g, '.').replace(/[gpfm]/g, '#'));
