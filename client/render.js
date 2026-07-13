// Canvas 2D 헥스맵 렌더러 (pointy-top, odd-r offset) — 지형·자원 아이콘·영토·유닛
const Render = (() => {
  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');

  const TERRAIN_COLOR = {
    '~': '#173a5e', // 바다
    'g': '#6aa84f', // 초원(곡식)
    'p': '#c9b458', // 평원(고기)
    'f': '#38761d', // 숲(목재)
    'm': '#8d8d8d', // 산(철)
  };

  const cam = { x: 0, y: 0, zoom: 1 };
  const HEX = 14;
  const SQRT3 = Math.sqrt(3);

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  function hexCenter(x, y) {
    const s = HEX;
    return [s * SQRT3 * (x + 0.5 * (y & 1)) + s, s * 1.5 * y + s];
  }

  function hexAt(screenX, screenY, map) {
    const wx = (screenX + cam.x) / cam.zoom;
    const wy = (screenY + cam.y) / cam.zoom;
    const yGuess = Math.round((wy - HEX) / (1.5 * HEX));
    let best = null, bestD = Infinity;
    for (let y = yGuess - 1; y <= yGuess + 1; y++) {
      if (y < 0 || y >= map.h) continue;
      const xGuess = Math.round((wx - HEX) / (SQRT3 * HEX) - 0.5 * (y & 1));
      for (let x = xGuess - 1; x <= xGuess + 1; x++) {
        if (x < 0 || x >= map.w) continue;
        const [cx, cy] = hexCenter(x, y);
        const d = (cx - wx) ** 2 + (cy - wy) ** 2;
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return bestD <= (HEX * 1.1) ** 2 ? best : null;
  }

  function drawHexPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  function drawHex(cx, cy, r, fill, stroke, lineWidth) {
    drawHexPath(cx, cy, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || 1; ctx.stroke(); }
  }

  // 자원 아이콘 (헥스 상단에 작게)
  function drawResourceIcon(t, cx, cy) {
    const s = HEX * 0.22;
    const iy = cy - HEX * 0.5;
    switch (t) {
      case 'p': // 고기: 갈색 원
        ctx.beginPath();
        ctx.arc(cx, iy, s * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = '#7c3f10';
        ctx.fill();
        break;
      case 'g': // 곡식: 노란 이삭 (세로선 3개)
        ctx.strokeStyle = '#ffe066';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = -1; i <= 1; i++) {
          ctx.moveTo(cx + i * s * 0.7, iy + s);
          ctx.lineTo(cx + i * s * 0.7, iy - s);
        }
        ctx.stroke();
        break;
      case 'f': // 목재: 진한 초록 삼각형 (나무)
        ctx.beginPath();
        ctx.moveTo(cx, iy - s);
        ctx.lineTo(cx - s, iy + s);
        ctx.lineTo(cx + s, iy + s);
        ctx.closePath();
        ctx.fillStyle = '#1c4a12';
        ctx.fill();
        break;
      case 'm': // 철: 회백색 다이아몬드
        ctx.beginPath();
        ctx.moveTo(cx, iy - s);
        ctx.lineTo(cx + s, iy);
        ctx.lineTo(cx, iy + s);
        ctx.lineTo(cx - s, iy);
        ctx.closePath();
        ctx.fillStyle = '#dfe4ea';
        ctx.fill();
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        break;
    }
  }

  function draw(state) {
    if (!state.map) return;
    const map = state.map;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.translate(-cam.x, -cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    const z = cam.zoom;
    const viewL = cam.x / z, viewT = cam.y / z;
    const viewR = viewL + window.innerWidth / z, viewB = viewT + window.innerHeight / z;
    const inView = (cx, cy) =>
      cx > viewL - HEX * 2 && cx < viewR + HEX * 2 && cy > viewT - HEX * 2 && cy < viewB + HEX * 2;

    // 타일 + 영토 + 자원 아이콘
    for (let y = 0; y < map.h; y++) {
      const [, cy] = hexCenter(0, y);
      if (cy < viewT - HEX * 2 || cy > viewB + HEX * 2) continue;
      const row = map.rows[y];
      for (let x = 0; x < map.w; x++) {
        const [cx] = hexCenter(x, y);
        if (cx < viewL - HEX * 2 || cx > viewR + HEX * 2) continue;
        const t = row[x];
        drawHex(cx, cy, HEX - 0.5, TERRAIN_COLOR[t], t === '~' ? null : 'rgba(0,0,0,.25)');
        if (t === '~') continue;

        // 영토 색칠
        const owner = state.territory.get(x + ',' + y);
        if (owner != null) {
          const civ = state.civs.get(owner);
          if (civ) {
            ctx.globalAlpha = 0.45;
            drawHex(cx, cy, HEX - 0.5, civ.color);
            ctx.globalAlpha = 1;
            drawHex(cx, cy, HEX - 1.2, null, civ.color, 1.2);
          }
        }
        // 자원 아이콘 (확대 시)
        if (z > 1.1) drawResourceIcon(t, cx, cy);
      }
    }

    // 수도 마커 (별 표시 링)
    for (const civ of state.civs.values()) {
      const [cx, cy] = hexCenter(civ.capital[0], civ.capital[1]);
      if (!inView(cx, cy)) continue;
      drawHex(cx, cy, HEX + 1, null, civ.color, 2.5);
      drawHex(cx, cy, HEX + 3, null, 'rgba(255,255,255,.35)', 1);
    }

    // 내 유닛 이동 경로
    if (state.you != null) {
      for (const [unitId, path] of state.myOrders) {
        const u = state.units.get(unitId);
        if (!u || !path.length) continue;
        const me = state.civs.get(state.you);
        ctx.beginPath();
        let [px, py] = hexCenter(u.x, u.y);
        ctx.moveTo(px, py);
        for (const [hx, hy] of path) {
          [px, py] = hexCenter(hx, hy);
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = me.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const [tx, ty] = path[path.length - 1];
        const [tcx, tcy] = hexCenter(tx, ty);
        drawHex(tcx, tcy, HEX * 0.55, null, me.color, 2);
      }
    }

    // 유닛
    const byHex = new Map();
    for (const u of state.units.values()) {
      const k = u.x + ',' + u.y;
      if (!byHex.has(k)) byHex.set(k, []);
      byHex.get(k).push(u);
    }
    for (const [k, units] of byHex) {
      const [x, y] = k.split(',').map(Number);
      const [cx, cy] = hexCenter(x, y);
      if (!inView(cx, cy)) continue;
      const byCiv = new Map();
      for (const u of units) {
        if (!byCiv.has(u.civ)) byCiv.set(u.civ, []);
        byCiv.get(u.civ).push(u);
      }
      const n = byCiv.size;
      let gi = 0;
      for (const [civId, group] of byCiv) {
        const civ = state.civs.get(civId);
        if (!civ) { gi++; continue; }
        const gx = cx + (gi - (n - 1) / 2) * HEX * 0.55;
        const allStunned = group.every(u => u.stunned > 0);
        ctx.globalAlpha = allStunned ? 0.5 : 1;
        ctx.beginPath();
        ctx.arc(gx, cy, HEX * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = civ.color;
        ctx.fill();
        ctx.strokeStyle = '#0b1220';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#0b1220';
        ctx.font = `bold ${HEX * 0.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(group.length), gx, cy + 0.5);
        if (z > 1.4) {
          ctx.fillStyle = '#e2e8f0';
          ctx.font = `bold ${HEX * 0.45}px sans-serif`;
          ctx.fillText(civ.code, gx, cy - HEX * 0.8);
        }
        ctx.globalAlpha = 1;
        gi++;
      }
    }

    // 선택 유닛 하이라이트
    if (state.selected != null) {
      const u = state.units.get(state.selected);
      if (u) {
        const [cx, cy] = hexCenter(u.x, u.y);
        ctx.beginPath();
        ctx.arc(cx, cy, HEX * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function centerOn(hexX, hexY) {
    const [cx, cy] = hexCenter(hexX, hexY);
    cam.zoom = 2.2;
    cam.x = cx * cam.zoom - window.innerWidth / 2;
    cam.y = cy * cam.zoom - window.innerHeight / 2;
  }

  return { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt };
})();
