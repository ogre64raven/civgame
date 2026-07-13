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

  // ── 전장의 안개: 내 세력(유닛·영토·수도) + 동맹 기준 3헥스 시야
  const VISION_RANGE = 3;
  function hexNeighbors(map, x, y) {
    const even = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
    const odd = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
    const dirs = (y % 2) ? odd : even;
    const out = [];
    for (const [dx, dy] of dirs) {
      const ny = y + dy;
      if (ny >= 0 && ny < map.h) out.push([((x + dx) % map.w + map.w) % map.w, ny]);
    }
    return out;
  }
  function computeVision(state) {
    // 관전자·게임 종료 시엔 전체 공개
    if (state.spectator || state.ended || state.you == null) return null;
    const map = state.map;
    const pk = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
    const allies = new Set();
    for (const c of state.civs.values()) {
      if (c.id !== state.you && state.alliances.has(pk(state.you, c.id))) allies.add(c.id);
    }
    const seen = new Set();
    let frontier = [];
    const addSource = (x, y) => {
      const k = x + ',' + y;
      if (!seen.has(k)) { seen.add(k); frontier.push([x, y]); }
    };
    for (const u of state.units.values()) {
      if (u.civ === state.you || u.controller === state.you || allies.has(u.civ)) addSource(u.x, u.y);
    }
    for (const [k, owner] of state.territory) {
      if (owner === state.you || allies.has(owner)) {
        const [x, y] = k.split(',').map(Number);
        addSource(x, y);
      }
    }
    const me = state.civs.get(state.you);
    if (me) addSource(me.capital[0], me.capital[1]);
    for (let d = 0; d < VISION_RANGE; d++) {
      const next = [];
      for (const [cx, cy] of frontier) {
        for (const [nx, ny] of hexNeighbors(map, cx, cy)) {
          const k = nx + ',' + ny;
          if (!seen.has(k)) { seen.add(k); next.push([nx, ny]); }
        }
      }
      frontier = next;
    }
    return seen;
  }

  // 사람 모양 유닛 (군사 기술 레벨에 따라 무기·갑옷 발전: 석기 → 현대군)
  function drawUnitFigure(cx, cy, s, color, mil) {
    const headR = s * 0.3;
    const headY = cy - s * 0.62;
    const bodyY0 = headY + headR * 0.95;
    const bodyY1 = cy + s * 0.32;
    const legY = cy + s * 0.95;
    const armY = bodyY0 + s * 0.22;
    const wx = cx + s * 0.45, wy = armY + s * 0.28; // 오른손
    ctx.lineCap = 'round';

    // 다리·몸통·팔 (문명 색)
    ctx.strokeStyle = color;
    ctx.lineWidth = s * 0.2;
    ctx.beginPath();
    ctx.moveTo(cx, bodyY1); ctx.lineTo(cx - s * 0.3, legY);
    ctx.moveTo(cx, bodyY1); ctx.lineTo(cx + s * 0.3, legY);
    ctx.moveTo(cx, bodyY0); ctx.lineTo(cx, bodyY1);
    ctx.moveTo(cx, armY); ctx.lineTo(cx - s * 0.45, armY + s * 0.3);
    ctx.moveTo(cx, armY); ctx.lineTo(wx, wy);
    ctx.stroke();
    // 머리
    ctx.beginPath();
    ctx.arc(cx, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 장비 (군사 레벨)
    if (mil <= 0) {
      // 돌도끼
      ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = s * 0.14;
      ctx.beginPath(); ctx.moveTo(wx, wy + s * 0.2); ctx.lineTo(wx + s * 0.12, wy - s * 0.6); ctx.stroke();
      ctx.fillStyle = '#9aa0a6';
      ctx.beginPath(); ctx.arc(wx + s * 0.14, wy - s * 0.66, s * 0.16, 0, Math.PI * 2); ctx.fill();
    } else if (mil === 1) {
      // 창
      ctx.strokeStyle = '#a97142'; ctx.lineWidth = s * 0.11;
      ctx.beginPath(); ctx.moveTo(wx, wy + s * 0.45); ctx.lineTo(wx, wy - s * 1.0); ctx.stroke();
      ctx.fillStyle = '#c9d1d9';
      ctx.beginPath();
      ctx.moveTo(wx, wy - s * 1.3); ctx.lineTo(wx - s * 0.12, wy - s * 0.95); ctx.lineTo(wx + s * 0.12, wy - s * 0.95);
      ctx.closePath(); ctx.fill();
    } else if (mil === 2) {
      // 검 + 원형 방패
      ctx.strokeStyle = '#d7dde3'; ctx.lineWidth = s * 0.11;
      ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx + s * 0.38, wy - s * 0.72); ctx.stroke();
      ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = s * 0.1;
      ctx.beginPath(); ctx.moveTo(wx - s * 0.1, wy - s * 0.12); ctx.lineTo(wx + s * 0.16, wy + s * 0.02); ctx.stroke();
      ctx.fillStyle = '#b08d57';
      ctx.beginPath(); ctx.arc(cx - s * 0.5, armY + s * 0.32, s * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1; ctx.stroke();
    } else if (mil === 3) {
      // 철투구 + 검 + 카이트 방패
      ctx.fillStyle = '#c9d1d9';
      ctx.beginPath(); ctx.arc(cx, headY - headR * 0.12, headR * 1.06, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - headR * 1.06, headY - headR * 0.15, headR * 2.12, headR * 0.28);
      ctx.strokeStyle = '#e8edf2'; ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx + s * 0.42, wy - s * 0.82); ctx.stroke();
      ctx.fillStyle = '#8f98a3';
      const sx0 = cx - s * 0.52, sy0 = armY + s * 0.02;
      ctx.beginPath();
      ctx.moveTo(sx0, sy0); ctx.lineTo(sx0 + s * 0.32, sy0 + s * 0.14);
      ctx.lineTo(sx0 + s * 0.16, sy0 + s * 0.75); ctx.lineTo(sx0 - s * 0.14, sy0 + s * 0.4);
      ctx.closePath(); ctx.fill();
    } else if (mil === 4) {
      // 챙모자 + 머스킷 장총
      ctx.fillStyle = '#2f3b4c';
      ctx.fillRect(cx - headR * 1.25, headY - headR * 1.05, headR * 2.5, headR * 0.42);
      ctx.fillRect(cx - headR * 0.7, headY - headR * 1.5, headR * 1.4, headR * 0.55);
      ctx.strokeStyle = '#5b4636'; ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.moveTo(wx - s * 0.18, wy + s * 0.32); ctx.lineTo(wx + s * 0.34, wy - s * 0.85); ctx.stroke();
      ctx.strokeStyle = '#9aa0a6'; ctx.lineWidth = s * 0.07;
      ctx.beginPath(); ctx.moveTo(wx + s * 0.16, wy - s * 0.42); ctx.lineTo(wx + s * 0.34, wy - s * 0.85); ctx.stroke();
    } else {
      // 현대군: 방탄모 + 방탄복 + 수평 소총
      ctx.fillStyle = '#4a5d3a';
      ctx.beginPath(); ctx.arc(cx, headY, headR * 1.12, Math.PI * 0.92, Math.PI * 2.08); ctx.fill();
      ctx.fillStyle = '#3b4a33';
      ctx.fillRect(cx - s * 0.24, bodyY0 + s * 0.05, s * 0.48, s * 0.52);
      ctx.strokeStyle = '#1c1f24'; ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.moveTo(cx - s * 0.55, armY + s * 0.32); ctx.lineTo(cx + s * 0.62, armY + s * 0.2); ctx.stroke();
      ctx.fillStyle = '#1c1f24';
      ctx.fillRect(cx + s * 0.08, armY + s * 0.26, s * 0.14, s * 0.28);
    }
  }

  function draw(state) {
    if (!state.map) return;
    const map = state.map;
    const vision = computeVision(state);
    const isVis = (x, y) => !vision || vision.has(x + ',' + y);
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
        if (!isVis(x, y)) {
          drawHex(cx, cy, HEX - 0.3, '#0c1322', 'rgba(148,163,184,.05)');
          continue;
        }
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
      if (!isVis(civ.capital[0], civ.capital[1])) continue;
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
      if (!isVis(x, y)) continue;
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
        const gx = cx + (gi - (n - 1) / 2) * HEX * 0.6;
        const allStunned = group.every(u => u.stunned > 0);
        ctx.globalAlpha = allStunned ? 0.5 : 1;
        const mil = (civ.tech && civ.tech.military) || 0;
        drawUnitFigure(gx, cy, HEX * 0.5, civ.color, mil);
        // 유닛 수 배지 (2기 이상)
        if (group.length > 1) {
          const bx = gx + HEX * 0.42, by = cy + HEX * 0.42;
          ctx.beginPath();
          ctx.arc(bx, by, HEX * 0.24, 0, Math.PI * 2);
          ctx.fillStyle = '#0b1220';
          ctx.fill();
          ctx.strokeStyle = civ.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.fillStyle = '#e2e8f0';
          ctx.font = `bold ${HEX * 0.32}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(group.length), bx, by + 0.5);
        }
        if (z > 1.4) {
          ctx.fillStyle = '#e2e8f0';
          ctx.font = `bold ${HEX * 0.4}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(civ.code, gx, cy - HEX * 1.05);
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
        ctx.ellipse(cx, cy + HEX * 0.02, HEX * 0.68, HEX * 0.8, 0, 0, Math.PI * 2);
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
