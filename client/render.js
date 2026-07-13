// WebGL(Three.js) 3D 렌더러 — 헥스 지형 인스턴싱, 3D 유닛/건물, 전장의 안개, 전투 연출
// 기존 2D 렌더러와 동일한 인터페이스: { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt, addBattleFx }
const Render = (() => {
  const canvas = document.getElementById('map');
  const cam = { x: 0, y: 0, zoom: 1 };   // 기존 2D 카메라 의미 유지 (input.js 호환)
  const HEX = 14;
  const SQRT3 = Math.sqrt(3);

  const TERRAIN_COLOR = { '~': 0x173a5e, g: 0x6aa84f, p: 0xc9b458, f: 0x38761d, m: 0x8d8d8d };
  const ELEV = { '~': 0, g: 3, p: 3, f: 4, m: 7 };   // 기둥 높이
  const FOG_COLOR = 0x0c1322;

  // ── three 기본 구성
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75);
  sun.position.set(0.4, 1, 0.35);
  scene.add(sun);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── 좌표: 헥스 → 평면(XZ)
  function worldPos(x, y) {
    return [HEX * SQRT3 * (x + 0.5 * (y & 1)) + HEX, HEX * 1.5 * y + HEX];
  }
  function hexCenter(x, y) { return worldPos(x, y); }
  const topY = (t) => ELEV[t] || 0;

  // ── 재질/지오메트리 캐시
  const mat = (color, opts) => new THREE.MeshLambertMaterial(Object.assign({ color }, opts || {}));
  const GEO = {
    hex1: new THREE.CylinderGeometry(HEX * 0.94, HEX * 0.94, 1, 6),
    overlay: new THREE.CylinderGeometry(HEX * 0.9, HEX * 0.9, 0.8, 6),
    fog: new THREE.CylinderGeometry(HEX * 0.985, HEX * 0.985, 26, 6),
    peak: new THREE.ConeGeometry(HEX * 0.62, 11, 6),
    tree: new THREE.ConeGeometry(HEX * 0.3, 7, 6),
    ring: new THREE.RingGeometry(HEX * 0.8, HEX * 0.97, 6),
  };

  // 텍스트 스프라이트 (라벨용)
  const textCache = new Map();
  function textSprite(text, color, worldH) {
    const key = text + '|' + color;
    let tex = textCache.get(key);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const g = c.getContext('2d');
      g.font = 'bold 40px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,.75)';
      g.strokeText(text, 128, 32);
      g.fillStyle = color;
      g.fillText(text, 128, 32);
      tex = new THREE.CanvasTexture(c);
      textCache.set(key, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(worldH * 4, worldH, 1);
    return sp;
  }

  // ── 3D 유닛 피규어 (군사 레벨별 장비)
  function makeFigure(colorHex, mil) {
    const g = new THREE.Group();
    const c = new THREE.Color(colorHex);
    const body = mat(c);
    const H = 9; // 키
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, H * 0.5, 8), body);
    torso.position.y = H * 0.45;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.7, 10, 8), body);
    head.position.y = H * 0.82;
    g.add(head);
    const legGeo = new THREE.CylinderGeometry(0.55, 0.55, H * 0.32, 6);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, body);
      leg.position.set(s * 0.9, H * 0.16, 0);
      g.add(leg);
    }
    const add = (mesh, x, y, z, rz) => {
      mesh.position.set(x, y, z);
      if (rz) mesh.rotation.z = rz;
      g.add(mesh);
    };
    if (mil <= 0) { // 돌도끼
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 5, 6), mat(0x8b5a2b)), 2.6, H * 0.55, 0, 0.5);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), mat(0x9aa0a6)), 3.9, H * 0.72, 0);
    } else if (mil === 1) { // 창
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12, 6), mat(0xa97142)), 2.6, H * 0.55, 0);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.7, 2, 6), mat(0xc9d1d9)), 2.6, H * 0.55 + 7, 0);
    } else if (mil === 2) { // 검 + 방패
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), mat(0xd7dde3)), 2.8, H * 0.62, 0, -0.5);
      add(new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.5, 10), mat(0xb08d57)), -2.6, H * 0.5, 0, Math.PI / 2);
    } else if (mil === 3) { // 철투구 + 검 + 방패
      add(new THREE.Mesh(new THREE.SphereGeometry(1.85, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xc9d1d9)), 0, H * 0.84, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), mat(0xe8edf2)), 2.9, H * 0.66, 0, -0.5);
      add(new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.5, 10), mat(0x8f98a3)), -2.7, H * 0.5, 0, Math.PI / 2);
    } else if (mil === 4) { // 챙모자 + 머스킷
      add(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 10), mat(0x2f3b4c)), 0, H * 0.9, 0);
      add(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.4, 10), mat(0x2f3b4c)), 0, H * 0.98, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 11, 0.55), mat(0x5b4636)), 2.7, H * 0.6, 0, 0.35);
    } else { // 현대군: 방탄모 + 방탄복 + 소총
      add(new THREE.Mesh(new THREE.SphereGeometry(1.95, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x4a5d3a)), 0, H * 0.82, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 4, 2.4), mat(0x3b4a33)), 0, H * 0.5, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(8, 0.7, 0.7), mat(0x1c1f24)), 0.8, H * 0.52, 1.6);
    }
    return g;
  }

  // ── 수도 건물 (채집+이동+방어 합산 6단계)
  function makeBuilding(civ) {
    const t = civ.tech || {};
    const tier = Math.min(5, Math.floor(((t.gather || 0) + (t.move || 0) + (t.defense || 0)) / 3));
    const g = new THREE.Group();
    const gray = mat(0xa8b0b8), dark = mat(0x6f767e);
    if (tier === 0) { // 스톤헨지
      for (const dx of [-4, 0, 4]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), gray);
        st.position.set(dx, 4, 0);
        g.add(st);
      }
      const lin = new THREE.Mesh(new THREE.BoxGeometry(11, 1.6, 2.4), dark);
      lin.position.y = 8.6;
      g.add(lin);
    } else if (tier === 1) { // 움집
      const hut = new THREE.Mesh(new THREE.ConeGeometry(6, 9, 8), mat(0x8b5a2b));
      hut.position.y = 4.5;
      g.add(hut);
    } else if (tier === 2) { // 석성 + 깃발
      const keep = new THREE.Mesh(new THREE.BoxGeometry(9, 8, 9), gray);
      keep.position.y = 4;
      g.add(keep);
      for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
        const tw = new THREE.Mesh(new THREE.BoxGeometry(2.4, 11, 2.4), dark);
        tw.position.set(dx, 5.5, dz);
        g.add(tw);
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 6), dark);
      pole.position.y = 13;
      g.add(pole);
      const flag = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2, 0.2), mat(new THREE.Color(civ.color)));
      flag.position.set(1.8, 15, 0);
      g.add(flag);
    } else if (tier === 3) { // 신전
      const base = new THREE.Mesh(new THREE.BoxGeometry(13, 1.6, 9), mat(0xe8e2d0));
      base.position.y = 0.8;
      g.add(base);
      for (const dx of [-5, -2.5, 0, 2.5, 5]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 7, 8), mat(0xefe9d8));
        col.position.set(dx, 5, 0);
        g.add(col);
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(8.6, 4, 4), mat(0xd9d2bd));
      roof.position.y = 10.4;
      roof.rotation.y = Math.PI / 4;
      g.add(roof);
    } else if (tier === 4) { // 공장
      const bld = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 8), mat(0x7d4438));
      bld.position.y = 4;
      g.add(bld);
      const chim = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 12, 8), mat(0x5f3129));
      chim.position.set(4, 9, -2);
      g.add(chim);
      const smoke = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 6),
        new THREE.MeshLambertMaterial({ color: 0xcccccc, transparent: true, opacity: 0.55 }));
      smoke.position.set(4.5, 17, -2);
      g.add(smoke);
    } else { // 마천루
      const glass = (w, h, d, x, z, color) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
        m.position.set(x, h / 2, z);
        g.add(m);
      };
      glass(4.5, 15, 4.5, -5, 1, 0x38506b);
      glass(4.5, 11, 4.5, 5, -1, 0x38506b);
      glass(5, 23, 5, 0, 0, 0x5fa8d3);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5, 6), mat(0x9aa0a6));
      ant.position.y = 25.5;
      g.add(ant);
    }
    return g;
  }

  // ── 전장의 안개 (기존 로직 그대로)
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

  // ── 씬 계층
  let inited = false;
  let terrainGroup = null;
  let fogMesh = null, territoryMesh = null;
  const dynamicGroup = new THREE.Group();  // 유닛·건물·경로·라벨 (재구축 대상)
  const fxGroup = new THREE.Group();       // 전투 연출
  scene.add(dynamicGroup, fxGroup);
  let selRing = null;
  const dummy = new THREE.Object3D();

  function initStatic(map) {
    terrainGroup = new THREE.Group();
    // 바다: 단일 평면
    const seaW = HEX * SQRT3 * (map.w + 1), seaH = HEX * 1.5 * (map.h + 1);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(seaW * 1.6, seaH * 1.6), mat(TERRAIN_COLOR['~']));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(seaW / 2, -0.6, seaH / 2);
    terrainGroup.add(sea);

    // 지형별 인스턴싱
    const byType = { g: [], p: [], f: [], m: [] };
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const t = map.rows[y][x];
        if (t !== '~') byType[t].push([x, y]);
      }
    for (const t of ['g', 'p', 'f', 'm']) {
      const list = byType[t];
      const im = new THREE.InstancedMesh(GEO.hex1, mat(TERRAIN_COLOR[t]), list.length);
      list.forEach(([x, y], i) => {
        const [wx, wz] = worldPos(x, y);
        const h = ELEV[t];
        dummy.position.set(wx, h / 2, wz);
        dummy.scale.set(1, h, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      terrainGroup.add(im);
      // 산봉우리 / 숲 나무
      if (t === 'm' || t === 'f') {
        const deco = new THREE.InstancedMesh(
          t === 'm' ? GEO.peak : GEO.tree,
          mat(t === 'm' ? 0x7a828b : 0x1c4a12), list.length);
        list.forEach(([x, y], i) => {
          const [wx, wz] = worldPos(x, y);
          dummy.position.set(wx, ELEV[t] + (t === 'm' ? 5.5 : 3.5), wz);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          deco.setMatrixAt(i, dummy.matrix);
        });
        terrainGroup.add(deco);
      }
    }
    scene.add(terrainGroup);

    // 영토 오버레이 (인스턴스 색)
    const landCount = byType.g.length + byType.p.length + byType.f.length + byType.m.length;
    territoryMesh = new THREE.InstancedMesh(GEO.overlay,
      new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.5 }), landCount);
    territoryMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(landCount * 3), 3);
    scene.add(territoryMesh);

    // 안개
    fogMesh = new THREE.InstancedMesh(GEO.fog, new THREE.MeshBasicMaterial({ color: FOG_COLOR }), map.w * map.h);
    scene.add(fogMesh);

    // 선택 링
    selRing = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    selRing.rotation.x = -Math.PI / 2;
    selRing.visible = false;
    scene.add(selRing);
    inited = true;
  }

  // ── 동적 재구축 (상태 시그니처 변경 시)
  let lastSig = '';
  let visionCache = null, visionAt = 0, fxDirty = false;

  function stateSig(state, vision) {
    let s = state.you + '|' + state.selected + '|' + (vision ? vision.size : -1) + '|' + state.territory.size + '|' + state.gameState;
    for (const u of state.units.values()) s += ';' + u.id + ',' + u.x + ',' + u.y + ',' + u.stunned + ',' + (u.controller || 0) + ',' + u.civ;
    for (const c of state.civs.values()) {
      const t = c.tech || {};
      s += ';' + c.id + ',' + (c.alive ? 1 : 0) + ',' + c.capitalHp + ',' + ((t.military || 0) + '' + (t.defense || 0) + (t.gather || 0) + (t.move || 0));
    }
    for (const [uid, p] of state.myOrders) s += ';' + uid + ':' + p.length;
    return s;
  }

  function disposeGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse?.((o) => {
        if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
        if (o.material) o.material.dispose?.(); // 텍스처는 캐시 공유라 유지됨
      });
    }
  }

  function rebuild(state, vision) {
    const map = state.map;
    const isVis = (x, y) => !vision || vision.has(x + ',' + y);

    // 안개 인스턴스
    let fi = 0;
    if (vision) {
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) {
          if (vision.has(x + ',' + y)) continue;
          const [wx, wz] = worldPos(x, y);
          dummy.position.set(wx, -12.5, wz); // 윗면이 y=0.5
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          fogMesh.setMatrixAt(fi++, dummy.matrix);
        }
    }
    fogMesh.count = fi;
    fogMesh.instanceMatrix.needsUpdate = true;

    // 영토 오버레이
    let ti = 0;
    const col = new THREE.Color();
    for (const [k, owner] of state.territory) {
      const [x, y] = k.split(',').map(Number);
      if (!isVis(x, y)) continue;
      const civ = state.civs.get(owner);
      if (!civ) continue;
      const [wx, wz] = worldPos(x, y);
      dummy.position.set(wx, topY(map.rows[y][x]) + 0.5, wz);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      territoryMesh.setMatrixAt(ti, dummy.matrix);
      col.set(civ.color);
      territoryMesh.setColorAt(ti, col);
      ti++;
    }
    territoryMesh.count = ti;
    territoryMesh.instanceMatrix.needsUpdate = true;
    if (territoryMesh.instanceColor) territoryMesh.instanceColor.needsUpdate = true;

    // 유닛·건물·경로·라벨
    disposeGroup(dynamicGroup);

    // 수도 (링 + 건물 + HP바)
    for (const civ of state.civs.values()) {
      const [kx, ky] = civ.capital;
      if (!isVis(kx, ky)) continue;
      const [wx, wz] = worldPos(kx, ky);
      const ty = topY(map.rows[ky][kx]);
      const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(civ.color), side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(wx, ty + 0.6, wz);
      dynamicGroup.add(ring);
      if (!civ.alive) continue;
      const b = makeBuilding(civ);
      b.position.set(wx, ty, wz);
      dynamicGroup.add(b);
      if (civ.capitalMaxHp && civ.capitalHp < civ.capitalMaxHp) {
        const ratio = Math.max(0, civ.capitalHp / civ.capitalMaxHp);
        const bg = new THREE.Mesh(new THREE.BoxGeometry(HEX * 1.6, 1.2, 1.2), mat(0x000000));
        bg.position.set(wx, ty + 30, wz);
        const fg = new THREE.Mesh(new THREE.BoxGeometry(HEX * 1.6 * ratio, 1.4, 1.4), mat(ratio > 0.4 ? 0x4ade80 : 0xf87171));
        fg.position.set(wx - HEX * 0.8 * (1 - ratio), ty + 30, wz);
        dynamicGroup.add(bg, fg);
      }
    }

    // 내 유닛 경로 (점선)
    if (state.you != null) {
      for (const [unitId, path] of state.myOrders) {
        const u = state.units.get(unitId);
        if (!u || !path.length) continue;
        const me = state.civs.get(state.you);
        const pts = [[u.x, u.y], ...path].map(([hx, hy]) => {
          const [wx, wz] = worldPos(hx, hy);
          return new THREE.Vector3(wx, topY(map.rows[hy][hx]) + 1.5, wz);
        });
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: new THREE.Color(me.color), dashSize: 4, gapSize: 3 }));
        line.computeLineDistances();
        dynamicGroup.add(line);
      }
    }

    // 유닛 스택
    const byHex = new Map();
    for (const u of state.units.values()) {
      const k = u.x + ',' + u.y;
      if (!byHex.has(k)) byHex.set(k, []);
      byHex.get(k).push(u);
    }
    for (const [k, units] of byHex) {
      if (fxHexes.has(k)) continue;
      const [x, y] = k.split(',').map(Number);
      if (!isVis(x, y)) continue;
      const [wx, wz] = worldPos(x, y);
      const ty = topY(map.rows[y][x]);
      const byCiv = new Map();
      for (const u of units) {
        if (!byCiv.has(u.civ)) byCiv.set(u.civ, []);
        byCiv.get(u.civ).push(u);
      }
      let gi = 0;
      const n = byCiv.size;
      for (const [civId, group] of byCiv) {
        const civ = state.civs.get(civId);
        if (!civ) { gi++; continue; }
        const gx = wx + (gi - (n - 1) / 2) * HEX * 0.75;
        const fig = makeFigure(civ.color, (civ.tech && civ.tech.military) || 0);
        fig.position.set(gx, ty, wz);
        const allStunned = group.every(u => u.stunned > 0);
        if (allStunned) fig.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; } });
        dynamicGroup.add(fig);
        const code = textSprite(civ.code + (group.length > 1 ? ' ×' + group.length : ''), '#e2e8f0', 5);
        code.position.set(gx, ty + 14, wz);
        dynamicGroup.add(code);
        gi++;
      }
    }
  }

  // ── 전투 연출
  const FX_MS = 3000;
  let battleFx = [];
  const fxHexes = new Set();
  function addBattleFx(fx) {
    fx.start = Date.now();
    fx.built = null;
    battleFx.push(fx);
    fxHexes.add(fx.hex[0] + ',' + fx.hex[1]);
    fxDirty = true;
  }

  function buildFx(fx, state) {
    const g = new THREE.Group();
    const info = (id) => {
      const c = state.civs.get(id);
      return { color: c ? c.color : '#94a3b8', mil: (c && c.tech && c.tech.military) || 0 };
    };
    const L = info(fx.winners[0]);
    const R = info(fx.draw ? (fx.winners[1] != null ? fx.winners[1] : fx.winners[0]) : fx.losers[0]);
    fx.figL = makeFigure(L.color, L.mil);
    fx.figR = makeFigure(R.color, R.mil);
    fx.figR.rotation.y = Math.PI;
    g.add(fx.figL, fx.figR);
    fx.spark = textSprite('✦', '#ffe066', 10);
    fx.spark.visible = false;
    g.add(fx.spark);
    const [wx, wz] = worldPos(fx.hex[0], fx.hex[1]);
    const map = state.map;
    g.position.set(wx, topY(map.rows[fx.hex[1]][fx.hex[0]]), wz);
    fxGroup.add(g);
    fx.built = g;
  }

  function animateFx(state, vision) {
    const now = Date.now();
    let removed = false;
    battleFx = battleFx.filter(fx => {
      if (now - fx.start >= FX_MS) {
        if (fx.built) fxGroup.remove(fx.built);
        fxHexes.delete(fx.hex[0] + ',' + fx.hex[1]);
        removed = true;
        return false;
      }
      return true;
    });
    if (removed) fxDirty = true;
    for (const fx of battleFx) {
      const visible = !vision || vision.has(fx.hex[0] + ',' + fx.hex[1]);
      if (!fx.built) buildFx(fx, state);
      fx.built.visible = visible;
      if (!visible) continue;
      const t = (now - fx.start) / 1000;
      if (t < 1.6) { // 격돌
        const bounce = Math.abs(Math.sin(t * 7));
        const gap = HEX * (0.25 + 0.55 * bounce);
        fx.figL.position.set(-gap, 0, 0);
        fx.figR.position.set(gap, 0, 0);
        fx.figL.rotation.z = 0;
        fx.figR.rotation.z = 0;
        fx.spark.visible = bounce < 0.4;
        fx.spark.position.set(0, 8, 0);
        if (!fx.label) { /* 결과 전 */ }
      } else { // 결과
        fx.spark.visible = false;
        if (fx.draw) {
          fx.figL.position.set(-HEX * 0.5, 0, 0);
          fx.figR.position.set(HEX * 0.5, 0, 0);
          fx.figL.rotation.z = 0.35;
          fx.figR.rotation.z = -0.35;
          if (!fx.label) {
            fx.label = textSprite('무승부', '#cbd5e1', 7);
            fx.label.position.set(0, 22, 0);
            fx.built.add(fx.label);
          }
        } else {
          fx.figL.position.set(-HEX * 0.35, Math.abs(Math.sin(t * 6)) * 1.2, 0);
          fx.figR.position.set(HEX * 0.55, 1, 0);
          fx.figR.rotation.z = Math.PI / 2 * 0.9;
          if (!fx.label) {
            const c = state.civs.get(fx.winners[0]);
            fx.label = textSprite('승리!', c ? c.color : '#fff', 7);
            fx.label.position.set(-HEX * 0.35, 22, 0);
            fx.built.add(fx.label);
            const lose = textSprite('패배', '#94a3b8', 5);
            lose.position.set(HEX * 0.55, 12, 0);
            fx.built.add(lose);
          }
        }
      }
    }
  }

  // ── 카메라
  function updateCamera() {
    const w = window.innerWidth, h = window.innerHeight;
    const tx = (cam.x + w / 2) / cam.zoom;
    const tz = (cam.y + h / 2) / cam.zoom;
    const D = 620 / cam.zoom;
    camera.position.set(tx, D * 0.86, tz + D * 0.55);
    camera.lookAt(tx, 0, tz);
  }

  // ── 피킹 (레이캐스트 → 평면 → 헥스)
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  function hexAt(screenX, screenY, map) {
    raycaster.setFromCamera(
      { x: (screenX / window.innerWidth) * 2 - 1, y: -(screenY / window.innerHeight) * 2 + 1 }, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
    const wx = hitPoint.x, wz = hitPoint.z;
    const yGuess = Math.round((wz - HEX) / (1.5 * HEX));
    let best = null, bestD = Infinity;
    for (let y = yGuess - 1; y <= yGuess + 1; y++) {
      if (y < 0 || y >= map.h) continue;
      const xGuess = Math.round((wx - HEX) / (SQRT3 * HEX) - 0.5 * (y & 1));
      for (let x = xGuess - 1; x <= xGuess + 1; x++) {
        if (x < 0 || x >= map.w) continue;
        const [cx2, cz2] = worldPos(x, y);
        const d = (cx2 - wx) ** 2 + (cz2 - wz) ** 2;
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return bestD <= (HEX * 1.2) ** 2 ? best : null;
  }

  function centerOn(hexX, hexY) {
    cam.zoom = 2.2;
    const [wx, wz] = worldPos(hexX, hexY);
    cam.x = wx * cam.zoom - window.innerWidth / 2;
    cam.y = wz * cam.zoom - window.innerHeight / 2;
  }

  // ── 메인 렌더 루프 (main.js가 매 프레임 호출)
  function draw(state) {
    if (!state.map) return;
    if (!inited) initStatic(state.map);

    // 시야 캐시 (200ms)
    const now = Date.now();
    if (now - visionAt > 200) {
      visionCache = computeVision(state);
      visionAt = now;
    }

    const sig = stateSig(state, visionCache);
    if (sig !== lastSig || fxDirty) {
      lastSig = sig;
      fxDirty = false;
      rebuild(state, visionCache);
    }

    // 선택 링
    if (state.selected != null) {
      const u = state.units.get(state.selected);
      if (u) {
        const [wx, wz] = worldPos(u.x, u.y);
        selRing.position.set(wx, topY(state.map.rows[u.y][u.x]) + 0.8, wz);
        const p = 1 + Math.sin(now / 180) * 0.06;
        selRing.scale.set(p, p, 1);
        selRing.visible = true;
      } else selRing.visible = false;
    } else selRing.visible = false;

    animateFx(state, visionCache);
    updateCamera();
    renderer.render(scene, camera);
  }

  return { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt, addBattleFx };
})();
