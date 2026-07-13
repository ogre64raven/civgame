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

  // ── 2.5D 입체 렌더링: 타일을 육각 기둥으로 돌출
  const ISO = 0.62;                                       // 시점 기울기 (y 압축)
  const ELEV_K = { '~': 0, g: 0.28, p: 0.28, f: 0.34, m: 0.9 }; // 지형 높이 (HEX 배수)
  const elevOf = (t) => HEX * (ELEV_K[t] || 0);
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
  }
  // 옆면(스커트): 아랫변 꼭짓점 3개를 바닥까지 내림
  function drawSkirt(cx, groundY, topY, r, color) {
    const pts = [150, 90, 30].map(deg => {
      const a = Math.PI / 180 * deg;
      return [cx + r * Math.cos(a), r * Math.sin(a) * ISO];
    });
    ctx.beginPath();
    ctx.moveTo(pts[0][0], topY + pts[0][1]);
    ctx.lineTo(pts[1][0], topY + pts[1][1]);
    ctx.lineTo(pts[2][0], topY + pts[2][1]);
    ctx.lineTo(pts[2][0], groundY + pts[2][1]);
    ctx.lineTo(pts[1][0], groundY + pts[1][1]);
    ctx.lineTo(pts[0][0], groundY + pts[0][1]);
    ctx.closePath();
    ctx.fillStyle = shade(color, 0.55);
    ctx.fill();
  }
  // 산봉우리 (설산 투톤)
  function drawPeak(cx, ey) {
    const r = HEX * 0.55;
    const top = ey - HEX * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - r, ey + HEX * 0.15 * ISO);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + r, ey + HEX * 0.15 * ISO);
    ctx.closePath();
    ctx.fillStyle = '#6f767e';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.35, top + HEX * 0.19);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + r * 0.35, top + HEX * 0.19);
    ctx.closePath();
    ctx.fillStyle = '#e8edf2';
    ctx.fill();
  }

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
    return [s * SQRT3 * (x + 0.5 * (y & 1)) + s, s * 1.5 * y * ISO + s];
  }

  function hexAt(screenX, screenY, map) {
    const wx = (screenX + cam.x) / cam.zoom;
    const wy = (screenY + cam.y) / cam.zoom;
    const yGuess = Math.round((wy - HEX) / (1.5 * HEX * ISO));
    let best = null, bestD = Infinity;
    for (let y = yGuess - 1; y <= yGuess + 1; y++) {
      if (y < 0 || y >= map.h) continue;
      const xGuess = Math.round((wx - HEX) / (SQRT3 * HEX) - 0.5 * (y & 1));
      for (let x = xGuess - 1; x <= xGuess + 1; x++) {
        if (x < 0 || x >= map.w) continue;
        const [cx, cy] = hexCenter(x, y);
        const d = (cx - wx) ** 2 + ((cy - wy) / ISO) ** 2;
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return bestD <= (HEX * 1.1) ** 2 ? best : null;
  }

  function drawHexPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a) * ISO;
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

  // 수도 건물: 채집+이동+방어 레벨 합(0~15)에 따라 6단계 발전 (스톤헨지 → 마천루)
  function drawCapitalBuilding(cx, cy, civ) {
    const t = civ.tech || {};
    const sum = (t.gather || 0) + (t.move || 0) + (t.defense || 0);
    const tier = Math.min(5, Math.floor(sum / 3));
    const s = HEX;
    const base = cy + s * 0.45;
    ctx.lineCap = 'butt';
    if (tier === 0) {
      // 스톤헨지
      ctx.fillStyle = '#a8b0b8';
      const w = s * 0.18, h = s * 0.6;
      ctx.fillRect(cx - s * 0.42, base - h, w, h);
      ctx.fillRect(cx - w / 2, base - h, w, h);
      ctx.fillRect(cx + s * 0.42 - w, base - h, w, h);
      ctx.fillStyle = '#8d949c';
      ctx.fillRect(cx - s * 0.5, base - h - s * 0.14, s, s * 0.14);
    } else if (tier === 1) {
      // 움집
      ctx.fillStyle = '#8b5a2b';
      ctx.beginPath();
      ctx.moveTo(cx, base - s * 0.78);
      ctx.lineTo(cx - s * 0.5, base);
      ctx.lineTo(cx + s * 0.5, base);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#5b3a1a';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#4a2e14';
      ctx.fillRect(cx - s * 0.09, base - s * 0.26, s * 0.18, s * 0.26);
    } else if (tier === 2) {
      // 석성 (흉벽 + 깃발)
      ctx.fillStyle = '#9aa4ae';
      ctx.fillRect(cx - s * 0.4, base - s * 0.55, s * 0.8, s * 0.55);
      for (let i = -1; i <= 1; i++) ctx.fillRect(cx + i * s * 0.3 - s * 0.07, base - s * 0.68, s * 0.14, s * 0.13);
      ctx.fillStyle = '#4a3324';
      ctx.fillRect(cx - s * 0.1, base - s * 0.24, s * 0.2, s * 0.24);
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, base - s * 0.68); ctx.lineTo(cx, base - s * 0.95); ctx.stroke();
      ctx.fillStyle = civ.color;
      ctx.beginPath();
      ctx.moveTo(cx, base - s * 0.95);
      ctx.lineTo(cx + s * 0.24, base - s * 0.88);
      ctx.lineTo(cx, base - s * 0.81);
      ctx.closePath();
      ctx.fill();
    } else if (tier === 3) {
      // 신전·궁전 (기둥 + 페디먼트)
      ctx.fillStyle = '#e8e2d0';
      ctx.fillRect(cx - s * 0.52, base - s * 0.12, s * 1.04, s * 0.12);
      for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * s * 0.22 - s * 0.045, base - s * 0.55, s * 0.09, s * 0.43);
      ctx.fillRect(cx - s * 0.52, base - s * 0.66, s * 1.04, s * 0.11);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.55, base - s * 0.66);
      ctx.lineTo(cx, base - s * 0.95);
      ctx.lineTo(cx + s * 0.55, base - s * 0.66);
      ctx.closePath();
      ctx.fill();
    } else if (tier === 4) {
      // 산업시대 공장 (벽돌 + 굴뚝 + 연기)
      ctx.fillStyle = '#7d4438';
      ctx.fillRect(cx - s * 0.5, base - s * 0.6, s * 0.85, s * 0.6);
      ctx.fillStyle = '#5f3129';
      ctx.fillRect(cx + s * 0.28, base - s * 0.95, s * 0.16, s * 0.95);
      ctx.fillStyle = '#ffd76a';
      for (let r = 0; r < 2; r++)
        for (let c2 = 0; c2 < 3; c2++)
          ctx.fillRect(cx - s * 0.42 + c2 * s * 0.26, base - s * 0.5 + r * s * 0.28, s * 0.13, s * 0.15);
      ctx.fillStyle = 'rgba(210,210,210,.55)';
      ctx.beginPath(); ctx.arc(cx + s * 0.36, base - s * 1.05, s * 0.11, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + s * 0.48, base - s * 1.18, s * 0.08, 0, Math.PI * 2); ctx.fill();
    } else {
      // 마천루 (유리 타워 3동 + 안테나)
      ctx.fillStyle = '#38506b';
      ctx.fillRect(cx - s * 0.55, base - s * 0.75, s * 0.3, s * 0.75);
      ctx.fillRect(cx + s * 0.25, base - s * 0.6, s * 0.3, s * 0.6);
      ctx.fillStyle = '#5fa8d3';
      ctx.fillRect(cx - s * 0.14, base - s * 1.15, s * 0.28, s * 1.15);
      ctx.fillStyle = '#dbeafe';
      for (let r = 0; r < 5; r++) ctx.fillRect(cx - s * 0.08, base - s * 1.05 + r * s * 0.22, s * 0.16, s * 0.07);
      for (let r = 0; r < 3; r++) {
        ctx.fillRect(cx - s * 0.49, base - s * 0.65 + r * s * 0.22, s * 0.18, s * 0.06);
        ctx.fillRect(cx + s * 0.31, base - s * 0.5 + r * s * 0.18, s * 0.18, s * 0.06);
      }
      ctx.strokeStyle = '#9aa0a6';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, base - s * 1.15); ctx.lineTo(cx, base - s * 1.38); ctx.stroke();
    }
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

  // ── 전투 연출 (격돌 → 타격 스파크 → 승패/무승부 결과)
  const FX_MS = 3000;
  let battleFx = [];
  function addBattleFx(fx) {
    fx.start = Date.now();
    battleFx.push(fx);
  }

  function drawSpark(cx, cy, r, seed) {
    ctx.strokeStyle = '#ffe066';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + seed;
      const len = r * (0.45 + 0.3 * Math.abs(Math.sin(seed * 9 + i * 2)));
      ctx.moveTo(cx + Math.cos(a) * r * 0.18, cy + Math.sin(a) * r * 0.18);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    }
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBattleFx(fx, nowMs, isVis, state) {
    const [hx, hy] = fx.hex;
    if (!isVis(hx, hy)) return;
    const [cx, cyRaw] = hexCenter(hx, hy);
    const cy = cyRaw - ((state.map && state.map.rows[hy]) ? elevOf(state.map.rows[hy][hx]) : 0);
    const t = (nowMs - fx.start) / 1000;
    const s = HEX * 0.5;
    const info = (id) => {
      const c = state.civs.get(id);
      return { color: c ? c.color : '#94a3b8', mil: (c && c.tech && c.tech.military) || 0 };
    };
    const L = info(fx.winners[0]);
    const R = info(fx.draw ? (fx.winners[1] != null ? fx.winners[1] : fx.winners[0]) : fx.losers[0]);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (t < 1.6) {
      // ① 격돌: 서로 부딪히며 타격
      const bounce = Math.abs(Math.sin(t * 7));
      const gap = HEX * (0.28 + 0.5 * bounce);
      drawUnitFigure(cx - gap, cy, s, L.color, L.mil);
      ctx.save();
      ctx.translate(cx + gap, cy);
      ctx.scale(-1, 1); // 오른쪽은 왼쪽을 향하도록 반전
      drawUnitFigure(0, 0, s, R.color, R.mil);
      ctx.restore();
      if (bounce < 0.4) drawSpark(cx, cy - s * 0.25, HEX * 0.6, t * 5);
      // 흙먼지
      ctx.fillStyle = 'rgba(200,190,160,.35)';
      for (let i = 0; i < 3; i++) {
        const a = t * 3 + i * 2.1;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * HEX * 0.7, cy + s * 0.8, s * (0.12 + 0.06 * Math.sin(a * 2)), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // ② 결과
      const p = Math.min(1, (t - 1.6) / 0.4);
      if (fx.draw) {
        // 무승부: 양쪽 모두 주저앉아 어질어질
        for (const side of [-1, 1]) {
          const bx = cx + side * HEX * 0.5;
          const c = side < 0 ? L : R;
          ctx.save();
          ctx.translate(bx, cy + s * 0.3);
          ctx.rotate(side * 0.3);
          ctx.globalAlpha = 0.8;
          drawUnitFigure(0, 0, s * 0.9, c.color, c.mil);
          ctx.restore();
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#ffe066';
          for (let i = 0; i < 3; i++) {
            const a = t * 4 + i * 2.09;
            ctx.beginPath();
            ctx.arc(bx + Math.cos(a) * s * 0.55, cy - s * 0.9 + Math.sin(a) * s * 0.18, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = p;
        ctx.fillStyle = '#cbd5e1';
        ctx.font = `bold ${HEX * 0.55}px sans-serif`;
        ctx.fillText('무승부', cx, cy - HEX * 1.25);
        ctx.globalAlpha = 1;
      } else {
        // 승자: 무기 치켜들고 환호
        const cheer = Math.sin(t * 6) * s * 0.08;
        drawUnitFigure(cx - HEX * 0.35, cy + cheer, s, L.color, L.mil);
        ctx.strokeStyle = L.color;
        ctx.lineWidth = s * 0.18;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - HEX * 0.35, cy + cheer - s * 0.1);
        ctx.lineTo(cx - HEX * 0.35 - s * 0.55, cy + cheer - s * 0.85);
        ctx.stroke();
        // 패자: 쓰러짐
        ctx.save();
        ctx.translate(cx + HEX * 0.55, cy + s * 0.65);
        ctx.rotate(1.35);
        ctx.globalAlpha = Math.max(0.25, 0.7 - p * 0.3);
        drawUnitFigure(0, 0, s * 0.85, R.color, R.mil);
        ctx.restore();
        ctx.globalAlpha = p;
        ctx.fillStyle = L.color;
        ctx.font = `bold ${HEX * 0.55}px sans-serif`;
        ctx.fillText('승리!', cx - HEX * 0.35, cy - HEX * 1.25);
        ctx.fillStyle = '#94a3b8';
        ctx.font = `bold ${HEX * 0.4}px sans-serif`;
        ctx.fillText('패배', cx + HEX * 0.55, cy - HEX * 0.7);
        ctx.globalAlpha = 1;
      }
    }
  }

  function draw(state) {
    if (!state.map) return;
    const map = state.map;
    const vision = computeVision(state);
    const isVis = (x, y) => !vision || vision.has(x + ',' + y);
    const nowMs = Date.now();
    battleFx = battleFx.filter(f => nowMs - f.start < FX_MS);
    const fxHexes = new Set(battleFx.map(f => f.hex[0] + ',' + f.hex[1]));
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
      if (cy < viewT - HEX * 3 || cy > viewB + HEX * 3) continue;
      const row = map.rows[y];
      for (let x = 0; x < map.w; x++) {
        const [cx] = hexCenter(x, y);
        if (cx < viewL - HEX * 2 || cx > viewR + HEX * 2) continue;
        const t = row[x];
        if (!isVis(x, y)) {
          drawHex(cx, cy, HEX - 0.3, '#0c1322', 'rgba(148,163,184,.05)');
          continue;
        }
        const elev = elevOf(t);
        const ey = cy - elev;
        if (elev > 0) drawSkirt(cx, cy, ey, HEX - 0.5, TERRAIN_COLOR[t]);
        drawHex(cx, ey, HEX - 0.5, TERRAIN_COLOR[t], t === '~' ? null : 'rgba(0,0,0,.28)');
        if (t === '~') continue;
        if (t === 'm') drawPeak(cx, ey);

        // 영토 색칠 (윗면)
        const owner = state.territory.get(x + ',' + y);
        if (owner != null) {
          const civ = state.civs.get(owner);
          if (civ) {
            ctx.globalAlpha = 0.4;
            drawHex(cx, ey, HEX - 0.5, civ.color);
            ctx.globalAlpha = 1;
            drawHex(cx, ey, HEX - 1.2, null, civ.color, 1.2);
          }
        }
        // 자원 아이콘 (확대 시, 산은 봉우리가 대신함)
        if (z > 1.1 && t !== 'm') drawResourceIcon(t, cx, ey);
      }
    }

    // 수도 마커 (별 표시 링)
    for (const civ of state.civs.values()) {
      if (!isVis(civ.capital[0], civ.capital[1])) continue;
      const [cx, cyRaw] = hexCenter(civ.capital[0], civ.capital[1]);
      const cy = cyRaw - elevOf(map.rows[civ.capital[1]][civ.capital[0]]);
      if (!inView(cx, cyRaw)) continue;
      drawHex(cx, cy, HEX + 1, null, civ.color, 2.5);
      drawHex(cx, cy, HEX + 3, null, 'rgba(255,255,255,.35)', 1);
      if (civ.alive) {
        drawCapitalBuilding(cx, cy, civ);
        // 수도 HP 바 (피해 시에만 표시)
        if (civ.capitalMaxHp && civ.capitalHp < civ.capitalMaxHp) {
          const bw = HEX * 1.6, bh = 3.2;
          const bx = cx - bw / 2, by2 = cy - HEX * 1.55;
          ctx.fillStyle = 'rgba(0,0,0,.65)';
          ctx.fillRect(bx - 0.5, by2 - 0.5, bw + 1, bh + 1);
          const ratio = Math.max(0, civ.capitalHp / civ.capitalMaxHp);
          ctx.fillStyle = ratio > 0.4 ? '#4ade80' : '#f87171';
          ctx.fillRect(bx, by2, bw * ratio, bh);
        }
      }
    }

    // 내 유닛 이동 경로
    if (state.you != null) {
      for (const [unitId, path] of state.myOrders) {
        const u = state.units.get(unitId);
        if (!u || !path.length) continue;
        const me = state.civs.get(state.you);
        const topOf = (tx2, ty2) => {
          const [ax, ay] = hexCenter(tx2, ty2);
          return [ax, ay - elevOf(map.rows[ty2][tx2])];
        };
        ctx.beginPath();
        let [px, py] = topOf(u.x, u.y);
        ctx.moveTo(px, py);
        for (const [hx, hy] of path) {
          [px, py] = topOf(hx, hy);
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = me.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const [tx, ty] = path[path.length - 1];
        const [tcx, tcy] = topOf(tx, ty);
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
    const sortedHexKeys = [...byHex.keys()].sort(
      (a, b) => Number(a.split(',')[1]) - Number(b.split(',')[1]));
    for (const k of sortedHexKeys) {
      const units = byHex.get(k);
      if (fxHexes.has(k)) continue; // 전투 연출 중
      const [x, y] = k.split(',').map(Number);
      if (!isVis(x, y)) continue;
      const [cx, cyRaw] = hexCenter(x, y);
      const cy = cyRaw - elevOf(map.rows[y][x]); // 지형 위에 서기
      if (!inView(cx, cyRaw)) continue;
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
        // 그림자
        ctx.globalAlpha = (allStunned ? 0.5 : 1) * 0.3;
        ctx.beginPath();
        ctx.ellipse(gx, cy + HEX * 0.48, HEX * 0.34, HEX * 0.12, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
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
        const [cx, cyRaw] = hexCenter(u.x, u.y);
        const cy = cyRaw - elevOf(map.rows[u.y] ? map.rows[u.y][u.x] : '~');
        ctx.beginPath();
        ctx.ellipse(cx, cy + HEX * 0.02, HEX * 0.68, HEX * 0.8, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 전투 연출
    for (const fx of battleFx) drawBattleFx(fx, nowMs, isVis, state);
  }

  function centerOn(hexX, hexY) {
    const [cx, cy] = hexCenter(hexX, hexY);
    cam.zoom = 2.2;
    cam.x = cx * cam.zoom - window.innerWidth / 2;
    cam.y = cy * cam.zoom - window.innerHeight / 2;
  }

  return { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt, addBattleFx };
})();
