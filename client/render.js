// WebGL(Three.js) 3D 렌더러 — 헥스 지형 인스턴싱, 3D 유닛/건물, 전장의 안개, 전투 연출
// 기존 2D 렌더러와 동일한 인터페이스: { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt, addBattleFx }
const Render = (() => {
  const canvas = document.getElementById('map');
  const cam = { x: 0, y: 0, zoom: 1 };   // 기존 2D 카메라 의미 유지 (input.js 호환)
  const HEX = 14;
  const SQRT3 = Math.sqrt(3);

  const TERRAIN_COLOR = { '~': 0x173a5e, g: 0x6aa84f, p: 0xc9b458, f: 0x38761d, h: 0x9aa06e, m: 0x8d8d8d, M: 0x6e747c };
  const ELEV = { '~': 0, g: 3, p: 3, f: 4, h: 5, m: 8, M: 12 };   // 기둥 높이
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
    overlay: new THREE.CylinderGeometry(HEX * 0.985, HEX * 0.985, 0.8, 6),
    fog: new THREE.CylinderGeometry(HEX * 0.985, HEX * 0.985, 34, 6),
    cloud: new THREE.SphereGeometry(HEX * 0.78, 6, 4),
    peak: new THREE.ConeGeometry(HEX * 0.62, 11, 6),
    peakBig: new THREE.ConeGeometry(HEX * 0.72, 15, 6),
    snow: new THREE.ConeGeometry(HEX * 0.3, 5.5, 6),
    tree: new THREE.ConeGeometry(HEX * 0.3, 7, 6),
    wheat: new THREE.ConeGeometry(HEX * 0.18, 5.5, 5),
    rock: new THREE.SphereGeometry(HEX * 0.24, 5, 4),
    ore: new THREE.BoxGeometry(3.2, 3.2, 3.2),
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
    sp.renderOrder = 999;
    return sp;
  }

  // 유닛 위치 핀 — 산/수도 건물에 가려져도 항상 보이는 문명색 표식
  const pinCache = new Map();
  function pinSprite(color) {
    let tex = pinCache.get(color);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.beginPath();
      g.moveTo(32, 58); g.lineTo(11, 18); g.lineTo(53, 18); g.closePath();
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.stroke();
      tex = new THREE.CanvasTexture(c);
      pinCache.set(color, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.renderOrder = 998;
    sp.scale.set(4.4, 4.4, 1);
    return sp;
  }

  // ── GLB 에셋 (CC0): 파일이 있으면 사용, 없으면(404) 코드 도형으로 폴백
  const ASSET_PATHS = {
    unit: 'assets/units/character.glb',
    wolf: 'assets/neutral/wolf.glb',
    bear: 'assets/neutral/bear.glb',
    tiger: 'assets/neutral/tiger.glb',
    lion: 'assets/neutral/lion.glb',
    tribe: 'assets/neutral/tribe.glb',
  };
  const ASSETS = {}; // key -> { scene, clips }
  if (THREE.GLTFLoader) {
    const gltfLoader = new THREE.GLTFLoader();
    for (const [key, path] of Object.entries(ASSET_PATHS)) {
      gltfLoader.load(path, (g) => {
        ASSETS[key] = { scene: g.scene, clips: g.animations || [] };
        lastSig = ''; // 다음 프레임에 재구축
      }, undefined, () => {}); // 없으면 조용히 폴백
    }
  }
  function cloneAsset(key, targetH) {
    const a = ASSETS[key];
    if (!a) return null;
    const root = THREE.SkeletonUtils ? THREE.SkeletonUtils.clone(a.scene) : a.scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const h = (box.max.y - box.min.y) || 1;
    root.scale.setScalar(targetH / h);
    const box2 = new THREE.Box3().setFromObject(root);
    root.position.y -= box2.min.y; // 발바닥을 지면에
    return { root, clips: a.clips };
  }
  function poseClip(root, clips, names) { // 정지 포즈 적용 (첫 프레임)
    for (const nm of names) {
      const clip = THREE.AnimationClip.findByName(clips, nm);
      if (clip) {
        const mx = new THREE.AnimationMixer(root);
        mx.clipAction(clip).play();
        mx.update(0);
        return;
      }
    }
  }

  // ── 야생동물 모형 (네발짐승)
  const BEAST_COLOR = { wolf: 0x8d99a6, bear: 0x5d3f27, tiger: 0xd97b29, lion: 0xc19a4b };
  function makeBeast(kind) {
    const g = new THREE.Group();
    const c = mat(BEAST_COLOR[kind] || 0x8d99a6);
    const body = new THREE.Mesh(new THREE.BoxGeometry(6.5, 3.2, 3), c);
    body.position.y = 3.4;
    g.add(body);
    if (kind === 'lion') { // 갈기
      const mane = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), mat(0x8a6420));
      mane.position.set(3.2, 5, 0);
      g.add(mane);
    }
    if (kind === 'tiger') { // 줄무늬
      for (const dx of [-1.6, 0, 1.6]) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.3, 3.1), mat(0x3a2a18));
        stripe.position.set(dx, 3.4, 0);
        g.add(stripe);
      }
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(kind === 'bear' ? 1.9 : 1.6, 8, 6), c);
    head.position.set(3.9, 5.1, 0);
    g.add(head);
    const legGeo = new THREE.CylinderGeometry(0.45, 0.45, 2.6, 5);
    for (const [dx, dz] of [[-2.3, -1], [-2.3, 1], [2.3, -1], [2.3, 1]]) {
      const leg = new THREE.Mesh(legGeo, c);
      leg.position.set(dx, 1.3, dz);
      g.add(leg);
    }
    return g;
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

  // GLB 유닛: 문명색 틴트 + 군사 레벨 무기는 도형으로 표시. 없으면 makeFigure 폴백
  function makeUnitFigure(colorHex, mil) {
    const a = cloneAsset('unit', 10);
    if (!a) return makeFigure(colorHex, mil);
    const g = new THREE.Group();
    const tint = new THREE.Color(colorHex);
    a.root.traverse(o => {
      if (o.isMesh && o.material) {
        o.material = o.material.clone();
        o.material.color = o.material.color.clone().lerp(tint, 0.6);
      }
    });
    poseClip(a.root, a.clips, ['idle', 'static']);
    g.add(a.root);
    g.userData.animRoot = a.root;
    g.userData.clips = a.clips;
    // 군사 레벨 무기 (기존 도형 재사용을 위해 미니 피규어에서 무기만 발췌)
    const gear = makeFigure(colorHex, mil);
    const keep = [];
    gear.traverse(o => { if (o.isMesh) keep.push(o); });
    // 몸통(앞 4+α개)을 제외한 무기·장비 메시만 부착: makeFigure는 몸통 4개 뒤에 장비 추가
    for (const m of keep.slice(4)) { g.add(m.clone()); }
    return g;
  }
  // 중립 유닛: GLB 있으면 사용 (부족/동물 공용)
  function makeNeutralFigure(kind) {
    const a = cloneAsset(kind, kind === 'tribe' ? 10 : 8);
    if (!a) return kind === 'tribe' ? makeFigure('#a1876b', 0) : makeBeast(kind);
    poseClip(a.root, a.clips, ['Idle', 'idle', 'static']);
    const g = new THREE.Group();
    g.add(a.root);
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
  let fogMesh = null, cloudMesh = null, territoryMesh = null;
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
    const byType = { g: [], p: [], f: [], h: [], m: [], M: [] };
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const t = map.rows[y][x];
        if (t !== '~') byType[t].push([x, y]);
      }
    for (const t of ['g', 'p', 'f', 'h', 'm', 'M']) {
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
      // 산봉우리 (중앙, 지형 특징) — 유닛 가림 최소화를 위해 약간 남쪽으로
      if (t === 'm' || t === 'M') {
        const big = t === 'M';
        const peak = new THREE.InstancedMesh(big ? GEO.peakBig : GEO.peak,
          mat(big ? 0x5f666f : 0x7a828b), list.length);
        list.forEach(([x, y], i) => {
          const [wx, wz] = worldPos(x, y);
          dummy.position.set(wx, ELEV[t] + (big ? 7.5 : 5.5), wz + HEX * 0.18);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          peak.setMatrixAt(i, dummy.matrix);
        });
        terrainGroup.add(peak);
        if (big) { // 설산 꼭대기
          const snow = new THREE.InstancedMesh(GEO.snow, mat(0xe8edf2), list.length);
          list.forEach(([x, y], i) => {
            const [wx, wz] = worldPos(x, y);
            dummy.position.set(wx, ELEV[t] + 12.5, wz + HEX * 0.18);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            snow.setMatrixAt(i, dummy.matrix);
          });
          terrainGroup.add(snow);
        }
      }
      // 자원 마커: 헥스 위쪽(북쪽) 배치, 가운데는 유닛 자리
      const RES_DECO = {
        g: { geo: GEO.wheat, color: 0xd8b944, dy: 2.6, sy: 1 },     // 곡식 다발
        p: { geo: GEO.rock, color: 0x9aa1a9, dy: 1.5, sy: 0.62 },   // 돌(바위)
        f: { geo: GEO.tree, color: 0x1c4a12, dy: 3.5, sy: 1 },      // 나무
        h: { geo: GEO.ore, color: 0x4a5560, dy: 1.8, sy: 0.8 },     // 철광석(구릉)
        m: { geo: GEO.ore, color: 0x3d4750, dy: 1.8, sy: 1 },       // 철광석(산)
        M: { geo: GEO.ore, color: 0x2f3944, dy: 1.8, sy: 1.15 },    // 철광석(고산)
      };
      const spec = RES_DECO[t];
      if (spec) {
        const marker = new THREE.InstancedMesh(spec.geo, mat(spec.color), list.length);
        list.forEach(([x, y], i) => {
          const [wx, wz] = worldPos(x, y);
          dummy.position.set(wx, ELEV[t] + spec.dy, wz - HEX * 0.55);
          dummy.scale.set(1, spec.sy, 1);
          dummy.rotation.set(0, t === 'm' ? 0.65 : 0, 0);
          dummy.updateMatrix();
          marker.setMatrixAt(i, dummy.matrix);
        });
        terrainGroup.add(marker);
      }
    }
    scene.add(terrainGroup);

    // 영토 오버레이 (인스턴스 색)
    const landCount = byType.g.length + byType.p.length + byType.f.length + byType.m.length;
    territoryMesh = new THREE.InstancedMesh(GEO.overlay,
      new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.5 }), landCount);
    territoryMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(landCount * 3), 3);
    scene.add(territoryMesh);

    // 안개: 하단 차단층(산보다 높게) + 상단 뭉게구름층
    fogMesh = new THREE.InstancedMesh(GEO.fog,
      new THREE.MeshLambertMaterial({ color: 0x323f55 }), map.w * map.h);
    scene.add(fogMesh);
    cloudMesh = new THREE.InstancedMesh(GEO.cloud,
      new THREE.MeshLambertMaterial({ color: 0xb9c3d4, transparent: true, opacity: 0.85 }), map.w * map.h);
    scene.add(cloudMesh);

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
    let s = state.you + '|' + state.selected + '|' + (vision ? vision.size : -1) + '|' + state.territory.size + '|' + state.gameState + '|' + state.alliances.size + '|' + (state.treasures ? state.treasures.size : 0);
    for (const u of state.units.values()) s += ';' + u.id + ',' + u.x + ',' + u.y + ',' + u.stunned + ',' + (u.controller || 0) + ',' + u.civ;
    for (const n of state.neutrals || []) s += ';N' + n.id + ',' + n.x + ',' + n.y + ',' + n.stunned;
    if (state.unitAnims) for (const uid of state.unitAnims.keys()) s += ';A' + uid;
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
          // 차단층: 윗면 y=28 (고산 설봉 ~26보다 높게)
          dummy.position.set(wx, 11, wz);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          fogMesh.setMatrixAt(fi, dummy.matrix);
          // 구름층: 타일별 결정적 지터로 뭉게뭉게
          const jr = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const r1 = (jr % 100) / 100, r2 = ((jr >> 7) % 100) / 100;
          dummy.position.set(wx + (r1 - 0.5) * 7, 29.5 + r2 * 2.5, wz + (r2 - 0.5) * 7);
          dummy.scale.set(1.25 + r1 * 0.8, 0.5 + r2 * 0.35, 1.25 + r2 * 0.8);
          dummy.rotation.set(0, r1 * 3.1, 0);
          dummy.updateMatrix();
          cloudMesh.setMatrixAt(fi, dummy.matrix);
          fi++;
        }
    }
    fogMesh.count = fi;
    fogMesh.instanceMatrix.needsUpdate = true;
    cloudMesh.count = fi;
    cloudMesh.instanceMatrix.needsUpdate = true;

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

    // 내 동맹 그룹 영토 외곽선 (이어진 다각형 테두리)
    if (state.you != null) {
      const me = state.civs.get(state.you);
      if (me) {
        const pk2 = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
        const groupIds = new Set([state.you]);
        for (const c of state.civs.values()) {
          if (c.id !== state.you && state.alliances.has(pk2(state.you, c.id))) groupIds.add(c.id);
        }
        const mine = new Set();
        for (const [k, owner] of state.territory) if (groupIds.has(owner)) mine.add(k);
        if (mine.size) {
          const borderMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(me.color) });
          const mapWW = HEX * SQRT3 * map.w;
          const UP2 = new THREE.Vector3(0, 1, 0);
          for (const k of mine) {
            const [x, y] = k.split(',').map(Number);
            const [wx, wz] = worldPos(x, y);
            const ty2 = topY(map.rows[y][x]) + 1.8;
            const corners = [];
            for (let ci = 0; ci < 6; ci++) {
              const a2 = Math.PI / 3 * ci;
              corners.push([wx + HEX * Math.sin(a2), wz + HEX * Math.cos(a2)]);
            }
            for (const [nx, ny] of hexNeighbors(map, x, y)) {
              if (mine.has(nx + ',' + ny)) continue; // 그룹 내부 경계는 생략
              let [nwx, nwz] = worldPos(nx, ny);
              if (nwx - wx > mapWW / 2) nwx -= mapWW;
              else if (wx - nwx > mapWW / 2) nwx += mapWW;
              const sorted = corners
                .map((c2, i2) => [i2, (c2[0] - nwx) ** 2 + (c2[1] - nwz) ** 2])
                .sort((p2, q2) => p2[1] - q2[1]);
              const A2 = corners[sorted[0][0]], B2 = corners[sorted[1][0]];
              const va = new THREE.Vector3(A2[0], ty2, A2[1]);
              const vb = new THREE.Vector3(B2[0], ty2, B2[1]);
              const dir = new THREE.Vector3().subVectors(vb, va);
              const len = dir.length();
              if (len < 0.01) continue;
              const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, len, 5), borderMat);
              seg.position.copy(va).add(vb).multiplyScalar(0.5);
              seg.quaternion.setFromUnitVectors(UP2, dir.normalize());
              dynamicGroup.add(seg);
            }
          }
        }
      }
    }

    // 보물상자
    if (state.treasures && state.treasures.size) {
      for (const k of state.treasures) {
        const [x, y] = k.split(',').map(Number);
        if (!isVis(x, y)) continue;
        const [wx, wz] = worldPos(x, y);
        const ty3 = topY(map.rows[y][x]);
        const chest = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 5), mat(0x7a4a1f));
        body.position.y = 2.25;
        chest.add(body);
        const lid = new THREE.Mesh(new THREE.BoxGeometry(7.4, 2, 5.4), mat(0x9c6a30));
        lid.position.y = 5;
        chest.add(lid);
        const band = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1, 1.4), mat(0xd4af37));
        band.position.y = 3.2;
        chest.add(band);
        const glow = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xd4af37, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.7;
        chest.add(glow);
        chest.position.set(wx, ty3, wz);
        dynamicGroup.add(chest);
      }
    }

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

    // 내 유닛 경로 (두꺼운 튜브 + 관절 + 목적지 마커)
    if (state.you != null) {
      const UP = new THREE.Vector3(0, 1, 0);
      for (const [unitId, path] of state.myOrders) {
        const u = state.units.get(unitId);
        if (!u || !path.length) continue;
        const me = state.civs.get(state.you);
        const pts = [[u.x, u.y], ...path].map(([hx, hy]) => {
          const [wx, wz] = worldPos(hx, hy);
          return new THREE.Vector3(wx, topY(map.rows[hy][hx]) + 2.4, wz);
        });
        const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(me.color) });
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const dir = new THREE.Vector3().subVectors(b, a);
          const len = dir.length();
          if (len < 0.01) continue;
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, len, 6), lineMat);
          seg.position.copy(a).add(b).multiplyScalar(0.5);
          seg.quaternion.setFromUnitVectors(UP, dir.normalize());
          dynamicGroup.add(seg);
          const joint = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 6), lineMat);
          joint.position.copy(b);
          dynamicGroup.add(joint);
        }
        // 목적지: 떠 있는 역삼각 마커
        const dest = pts[pts.length - 1];
        const cone = new THREE.Mesh(new THREE.ConeGeometry(3.6, 7, 8), lineMat);
        cone.rotation.x = Math.PI;
        cone.position.set(dest.x, dest.y + 12, dest.z);
        dynamicGroup.add(cone);
      }
    }

    // 중립 유닛 (야생동물·원시 부족)
    const NEUTRAL_LABEL = { wolf: '늑대', bear: '곰', tiger: '호랑이', lion: '사자', tribe: '부족' };
    for (const n of state.neutrals || []) {
      if (!isVis(n.x, n.y)) continue;
      const [wx, wz] = worldPos(n.x, n.y);
      const ty = topY(map.rows[n.y][n.x]);
      const fig = makeNeutralFigure(n.kind);
      fig.position.set(wx - HEX * 0.25, ty, wz - HEX * 0.2);
      if (n.stunned > 0) fig.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; } });
      dynamicGroup.add(fig);
      const lb = textSprite(NEUTRAL_LABEL[n.kind] || '?', '#fca5a5', 4.5);
      lb.position.set(wx - HEX * 0.25, ty + 11.5, wz - HEX * 0.2);
      dynamicGroup.add(lb);
    }

    // 이동 중인 유닛: 경로를 따라 걷는 개별 피규어 (위치는 draw에서 매 프레임 갱신)
    animMeshes.clear();
    const anims = state.unitAnims || new Map();
    for (const [uid, anim] of anims) {
      const u = state.units.get(uid);
      if (!u) continue;
      if (!isVis(u.x, u.y)) continue; // 도착 헥스 기준 가시성
      const civ = state.civs.get(u.civ);
      if (!civ) continue;
      const fig = makeUnitFigure(civ.color, (civ.tech && civ.tech.military) || 0);
      const pin = pinSprite(civ.color);
      const code = textSprite(civ.code, '#e2e8f0', 5);
      dynamicGroup.add(fig, pin, code);
      const [px, py, pz] = animWorldPos(map, anim.steps, 0);
      fig.position.set(px, py, pz);
      pin.position.set(px, py + 10.5, pz);
      code.position.set(px, py + 14, pz);
      // 걷기 클립이 있으면 재생 (GLB)
      let mixer = null;
      const clips = fig.userData.clips || [];
      const walk = THREE.AnimationClip.findByName(clips, 'walk') || THREE.AnimationClip.findByName(clips, 'Walk');
      if (walk) {
        mixer = new THREE.AnimationMixer(fig.userData.animRoot || fig);
        mixer.clipAction(walk).play();
      }
      animMeshes.set(uid, { fig, pin, code, mixer });
    }

    // 유닛 스택
    const byHex = new Map();
    for (const u of state.units.values()) {
      if (anims.has(u.id)) continue; // 이동 연출 중인 유닛은 위에서 개별 렌더
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
      const hasCapital = [...state.civs.values()].some(
        c => c.capital && c.capital[0] === x && c.capital[1] === y);
      const wzU = wz + (hasCapital ? HEX * 0.62 : 0);
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
        const fig = makeUnitFigure(civ.color, (civ.tech && civ.tech.military) || 0);
        fig.position.set(gx, ty, wzU);
        const allStunned = group.every(u => u.stunned > 0);
        if (allStunned) fig.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; } });
        dynamicGroup.add(fig);
        const pin = pinSprite(civ.color);
        pin.position.set(gx, ty + 10.5, wzU);
        dynamicGroup.add(pin);
        const code = textSprite(civ.code + (group.length > 1 ? ' ×' + group.length : ''), '#e2e8f0', 5);
        code.position.set(gx, ty + 14, wzU);
        dynamicGroup.add(code);
        gi++;
      }
    }
  }

  // ── 이동 애니메이션 (실행 턴 초반, 경로를 따라 걷기)
  const animMeshes = new Map(); // unitId -> { fig, pin, code }
  function animWorldPos(map, steps, f) {
    const total = steps.length - 1;
    const at = (i) => {
      const [x, y] = steps[i];
      const [wx, wz] = worldPos(x, y);
      return [wx, topY(map.rows[y][x]), wz];
    };
    if (total <= 0) return at(0);
    const ft = Math.min(0.9999, Math.max(0, f)) * total;
    const i = Math.floor(ft), r = ft - i;
    const a = at(i), b = at(i + 1);
    if (Math.abs(b[0] - a[0]) > HEX * SQRT3 * 4) return r < 0.5 ? a : b; // 맵 경계 랩 → 점프
    return [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r, a[2] + (b[2] - a[2]) * r];
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
    fx.figL = makeUnitFigure(L.color, L.mil);
    fx.figR = makeUnitFigure(R.color, R.mil);
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

    // 이동 애니메이션 갱신
    if (state.unitAnims && state.unitAnims.size) {
      const dt = Math.min(0.05, (now - (draw._t || now)) / 1000);
      for (const [uid, anim] of state.unitAnims) {
        if (now >= anim.end) { state.unitAnims.delete(uid); continue; } // 만료 → sig 변화로 rebuild
        const m = animMeshes.get(uid);
        if (!m) continue;
        if (m.mixer) m.mixer.update(dt);
        const f = (now - anim.start) / (anim.end - anim.start);
        const [px, py, pz] = animWorldPos(state.map, anim.steps, f);
        const bob = m.mixer ? 0 : Math.abs(Math.sin(now / 130)) * 0.9; // 걷는 들썩임(GLB는 자체 애니)
        m.fig.position.set(px, py + bob, pz);
        m.pin.position.set(px, py + 10.5, pz);
        m.code.position.set(px, py + 14, pz);
      }
    }

    draw._t = now;
    animateFx(state, visionCache);
    if (cloudMesh) cloudMesh.position.y = Math.sin(now / 1600) * 1.4;
    updateCamera();
    renderer.render(scene, camera);
  }

  return { canvas, cam, HEX, draw, centerOn, hexCenter, hexAt, addBattleFx };
})();
