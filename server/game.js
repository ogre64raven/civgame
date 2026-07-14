// 게임 상태 v2 — 영토전: 유닛 고정 3기(불사), 이동 경로 영토화, 영토 자동 채취,
// 전투 패자 수도 후퇴, 수도 함락 = 점령(예속), 동맹/흡수, 승리
const crypto = require('crypto');
const countries = require('../data/countries.json');

const MAX_PLAYERS = 30;
const START_UNITS = 3;                  // 시작 유닛 수
const SPAWN_COST = 10;                  // 유닛 생산 비용 (고기·곡식 각각)
const FORT_COST = 10;                   // 요새 건설 비용 (돌·목재 각각)
const RALLY_COST = 10;                  // 유닛 회복(사기 진작) 비용 (곡식)
const TECH_MAX = 5;
const TECH_RES = { military: 'iron', defense: 'grain', gather: 'wood', move: 'stone' };
const techCost = (targetLevel) => 20 * targetLevel;
const ALLY_MAX = 3;                     // 동맹 그룹 최대 인원
const ABSORB_RATIO = 0.8;               // 8:2 초과
const ABSORB_TURNS = 3;                 // 연속 유지 턴
const MIN_LANDMASS = 5;                 // 수도가 이보다 작은 섬이면 배정 제외

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function eligibleCountryIndices(world) {
  const sizes = world.componentSizes();
  const out = [];
  countries.forEach((c, i) => {
    const [x, y] = world.lonlatToHex(c.cap[0], c.cap[1]);
    const nl = world.nearestLand(x, y, null, 2);
    if (!nl) return;
    if ((sizes.get(nl[0] + ',' + nl[1]) || 0) < MIN_LANDMASS) return;
    out.push(i);
  });
  return out;
}

class Game {
  constructor(world, broadcast, settings = {}) {
    this.world = world;
    this.broadcast = broadcast;
    this.onExec = null;
    this.onMeeting = null;          // 회의 턴 시작 훅 (봇 구동)
    this.settings = {
      meetingMs: settings.meetingMs ?? parseInt(process.env.PHASE_MEETING_MS || '30000', 10),
      execMs: settings.execMs ?? parseInt(process.env.PHASE_EXEC_MS || '10000', 10),
      turnLimit: settings.turnLimit ?? parseInt(process.env.TURN_LIMIT || '120', 10),
    };
    this.state = 'LOBBY';               // LOBBY → RUNNING → ENDED
    this.civs = new Map();
    this.tokens = new Map();
    this.units = new Map();             // unitId -> { id, civ, x, y, stunned, controller? }
    this.orders = new Map();
    this.researchOrders = new Map();
    this.spawnOrders = new Set();       // 수도 유닛 생산 예약 (civId)
    this.territory = new Map();         // 'x,y' -> civId
    this.territoryByCiv = new Map();    // civId -> Set('x,y')
    this.allies = new Map();
    this.allyProposals = new Map();
    this.allyConsents = new Map();      // 'a:b' -> { a, b, approver } (제3국 동의 대기)
    this.leaveOrders = [];
    this.absorbCounters = new Map();
    this.contacts = new Set();          // 접촉한 문명 쌍 'a:b' (영구)
    this.treasures = new Map();         // 'x,y' -> { kind: 'res'|'tech' }
    this.neutrals = new Map();          // id -> { id, kind, x, y, stunned } (야생동물·원시 부족)
    this.nextNeutralId = 1;
    this.forts = new Map();             // 'x,y' -> { x, y, civ, hp, max } (요새/장성)
    this.fortOrders = new Map();        // 'x,y' -> civId (회의 턴 예약)
    this.pendingTechChoices = new Map(); // civId -> 남은 기술 선택 횟수
    this.ended = false;
    this.pool = shuffle(eligibleCountryIndices(world));
    this.nextCivId = 1;
    this.nextUnitId = 1;
    this.turn = 1;
    this.phase = 'LOBBY';
    this.phaseEnds = 0;
    this.timer = null;
    this._captures = new Map();
    this._delegations = [];
  }

  // ── 로비 → 게임 시작 (관리자)
  startGame() {
    if (this.state !== 'LOBBY') return { ok: false, reason: 'state' };
    if (this.civs.size < 1) return { ok: false, reason: 'noplayers' };
    for (const civ of this.civs.values()) this.enterWorld(civ);
    this.placeTreasures();
    this.placeNeutrals();
    this.state = 'RUNNING';
    this.phase = 'MEETING';
    this.armTimer();
    return { ok: true };
  }

  enterWorld(civ) {
    for (let i = 0; i < START_UNITS; i++) {
      const uid = this.nextUnitId++;
      this.units.set(uid, { id: uid, civ: civ.id, x: civ.capital[0], y: civ.capital[1], stunned: 0 });
    }
    this.setTile(civ.capital[0] + ',' + civ.capital[1], civ.id);
  }

  // ── 관리자: 강퇴
  kick(civId) {
    const civ = this.civs.get(civId);
    if (!civ) return false;
    for (const u of [...this.units.values()]) {
      if (u.civ === civId) { this.units.delete(u.id); this.orders.delete(u.id); }
      else if (u.controller === civId) u.controller = null;
    }
    const tiles = this.territoryByCiv.get(civId);
    if (tiles) {
      for (const k of [...tiles]) { this.territory.delete(k); this._captures.set(k, null); }
      this.territoryByCiv.delete(civId);
    }
    this.dissolveDiplomacyFor(civId);
    for (const [fk, f] of [...this.forts]) if (f.civ === civId) this.forts.delete(fk);
    for (const v of this.civs.values()) if (v.conqueredBy === civId) v.conqueredBy = null;
    this.researchOrders.delete(civId);
    this.spawnOrders.delete(civId);
    this.tokens.delete(civ.token);
    this.civs.delete(civId);
    return true;
  }

  updateSettings(s) {
    const clamp = (v, lo, hi, cur) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : cur;
    };
    this.settings.meetingMs = clamp(s.meetingMs, 5000, 300000, this.settings.meetingMs);
    this.settings.execMs = clamp(s.execMs, 2000, 120000, this.settings.execMs);
    this.settings.turnLimit = clamp(s.turnLimit, 10, 1000, this.settings.turnLimit);
    return this.settings;
  }

  nextPhase() {
    if (this.ended || this.state !== 'RUNNING') return;
    if (this.phase === 'MEETING') {
      this.phase = 'EXECUTION';
      this.armTimer();
      const result = this.resolveExecution();
      if (this.onExec) this.onExec(result);
    } else {
      this.phase = 'MEETING';
      this.turn++;
      this.armTimer();
    }
  }

  armTimer() {
    if (this.ended || this.state !== 'RUNNING') return;
    const ms = this.phase === 'MEETING' ? this.settings.meetingMs : this.settings.execMs;
    this.phaseEnds = Date.now() + ms;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.nextPhase(), ms);
    this.broadcast({ type: 'phase', phase: this.phase, turn: this.turn, endsAt: this.phaseEnds });
    if (this.phase === 'MEETING' && this.onMeeting) this.onMeeting();
  }

  controllerOf(u) { return u.controller != null ? u.controller : u.civ; }
  isAllied(a, b) { const s = this.allies.get(a); return !!s && s.has(b); }
  tileCountOf(civId) { return this.territoryByCiv.get(civId)?.size || 0; }
  score(civ) {
    const t = civ.tech;
    return (t.military + t.defense + t.gather + t.move) + this.tileCountOf(civ.id);
  }
  // 보물상자 배치: 시작 인원의 1/2개, 수도에서 먼 험지·외딴 섬 우선
  placeTreasures() {
    this.treasures.clear();
    const count = Math.floor(this.civs.size / 2);
    if (count < 1) return;
    // 모든 수도로부터의 BFS 거리
    const dist = new Map();
    let frontier = [];
    for (const c of this.civs.values()) {
      const k = c.capital[0] + ',' + c.capital[1];
      if (!dist.has(k)) { dist.set(k, 0); frontier.push(c.capital); }
    }
    while (frontier.length) {
      const next = [];
      for (const [cx, cy] of frontier) {
        const d = dist.get(cx + ',' + cy);
        for (const [nx, ny] of this.world.neighbors(cx, cy)) {
          const k = nx + ',' + ny;
          if (!dist.has(k)) { dist.set(k, d + 1); next.push([nx, ny]); }
        }
      }
      frontier = next;
    }
    const sizes = this.world.componentSizes();
    const cands = [];
    for (let y = 0; y < this.world.h; y++) {
      for (let x = 0; x < this.world.w; x++) {
        if (!this.world.isLand(x, y)) continue;
        const k = x + ',' + y;
        const d = dist.get(k) ?? 40;
        if (d < 8) continue; // 수도 근처 제외
        const t = this.world.terrain(x, y);
        let score = d;
        if (t === 'M') score += 8;
        else if (t === 'm') score += 4;
        else if (t === 'h') score += 2;
        if ((sizes.get(k) || 999) <= 12) score += 8; // 외딴 섬
        cands.push({ x, y, k, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const placed = [];
    for (const c of cands) {
      if (placed.length >= count) break;
      if (placed.some(p => Math.abs(p.x - c.x) < 8 && Math.abs(p.y - c.y) < 8)) continue;
      placed.push(c);
      this.treasures.set(c.k, { kind: placed.length % 2 === 1 ? 'res' : 'tech' });
    }
  }

  // ── 중립 유닛 (야생동물·원시 부족): 강함은 항상 초기 문명 유닛과 동일(군사 0), 성장 없음
  placeNeutrals(count) {
    this.neutrals.clear();
    if (count == null) {
      count = process.env.NEUTRAL_COUNT != null
        ? parseInt(process.env.NEUTRAL_COUNT, 10) : this.civs.size;
    }
    if (!count || count < 1) return;
    // 모든 수도로부터의 BFS 거리
    const dist = new Map();
    let frontier = [];
    for (const c of this.civs.values()) {
      const k = c.capital[0] + ',' + c.capital[1];
      if (!dist.has(k)) { dist.set(k, 0); frontier.push(c.capital); }
    }
    while (frontier.length) {
      const next = [];
      for (const [cx, cy] of frontier) {
        const d = dist.get(cx + ',' + cy);
        for (const [nx, ny] of this.world.neighbors(cx, cy)) {
          const k = nx + ',' + ny;
          if (!dist.has(k)) { dist.set(k, d + 1); next.push([nx, ny]); }
        }
      }
      frontier = next;
    }
    const cands = [];
    for (let y = 0; y < this.world.h; y++) {
      for (let x = 0; x < this.world.w; x++) {
        if (!this.world.isLand(x, y)) continue;
        const k = x + ',' + y;
        if ((dist.get(k) ?? 40) < 6) continue; // 수도 근처 제외
        if (this.treasures.has(k)) continue;
        cands.push([x, y]);
      }
    }
    // 무작위 순서로 서로 4칸 이상 떨어지게 선정
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const ANIMALS = ['wolf', 'bear', 'tiger', 'lion'];
    const placed = [];
    for (const [x, y] of cands) {
      if (placed.length >= count) break;
      const far = placed.every(([px, py]) => {
        const dx = Math.min(Math.abs(x - px), this.world.w - Math.abs(x - px));
        return dx + Math.abs(y - py) >= 4;
      });
      if (!far) continue;
      placed.push([x, y]);
      const id = this.nextNeutralId++;
      const kind = placed.length % 3 === 0
        ? 'tribe' : ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      this.neutrals.set(id, { id, kind, x, y, stunned: 0 });
    }
  }

  neutralsPublic() { return [...this.neutrals.values()]; }

  spawnNeutralAt(kind, x, y) { // 테스트용
    const id = this.nextNeutralId++;
    const n = { id, kind, x, y, stunned: 0 };
    this.neutrals.set(id, n);
    return n;
  }

  // 배회(1칸 무작위) → 밟은 영토 해제 → 같은 헥스 문명 유닛과 교전
  resolveNeutrals(stunnedNow) {
    const events = [], stuns = [];
    const stunnedNowN = new Set();
    for (const n of this.neutrals.values()) {
      if (n.stunned > 0) { stunnedNowN.add(n.id); n.stunned--; continue; }
      const opts = this.world.neighbors(n.x, n.y).filter(([x, y]) => {
        if (!this.world.isLand(x, y)) return false;
        if (this.forts.has(x + ',' + y)) return false; // 장성 통과 불가
        for (const c of this.civs.values())
          if (c.alive && c.capital[0] === x && c.capital[1] === y) return false;
        return true;
      });
      if (opts.length) {
        const [nx, ny] = opts[Math.floor(Math.random() * opts.length)];
        n.x = nx; n.y = ny;
        const k = nx + ',' + ny;
        const owner = this.territory.get(k);
        if (owner != null) {
          this.clearTile(k);
          events.push({ type: 'raid', kind: n.kind, civId: owner, x: nx, y: ny });
        }
      }
    }
    // 교전: 유닛 측 전투력 = 최고 군사 + 수 우위(2기 이상 +1) + 자기 영토 방어. 중립 = 0 고정.
    for (const n of [...this.neutrals.values()]) {
      const here = [...this.units.values()].filter(u => u.x === n.x && u.y === n.y);
      const active = here.filter(u => !stunnedNow.has(u.id) && u.stunned === 0);
      if (!active.length) continue; // 행동불능 유닛뿐이면 교전 없음
      if (stunnedNowN.has(n.id) || n.stunned > 0) { // 행동불능 중립 유닛은 처치됨
        this.neutrals.delete(n.id);
        events.push({ type: 'kill', kind: n.kind, civId: active[0].civ, x: n.x, y: n.y });
        continue;
      }
      const mil = Math.max(...active.map(u => (this.civs.get(u.civ)?.tech.military || 0)));
      const tileOwner = this.territory.get(n.x + ',' + n.y);
      const defense = (tileOwner != null && active.some(u => u.civ === tileOwner))
        ? (this.civs.get(tileOwner).tech.defense || 0) : 0;
      const power = mil + defense + (active.length >= 2 ? 1 : 0);
      if (power > 0) {
        this.neutrals.delete(n.id);
        const best = active.reduce((a, b) =>
          ((this.civs.get(a.civ)?.tech.military || 0) >= (this.civs.get(b.civ)?.tech.military || 0) ? a : b));
        events.push({ type: 'kill', kind: n.kind, civId: best.civ, x: n.x, y: n.y });
      } else { // 동률 → 양측 2턴 행동불능
        n.stunned = 2;
        for (const u of active) { u.stunned = 2; stuns.push({ unitId: u.id, turns: 2 }); }
        events.push({ type: 'clash', kind: n.kind, x: n.x, y: n.y });
      }
    }
    return { events, stuns };
  }

  treasuresPublic() {
    return [...this.treasures.keys()].map(k => k.split(',').map(Number));
  }

  // 보물 습득 처리
  grantTreasure(civId, tr, x, y) {
    const civ = this.civs.get(civId);
    const ev = { x, y, by: civId, kind: tr.kind };
    if (!civ) return ev;
    let kind = tr.kind;
    if (kind === 'tech') {
      const openBranch = ['military', 'defense', 'gather', 'move'].filter(b => civ.tech[b] < TECH_MAX);
      if (openBranch.length === 0) kind = 'res'; // 전부 만렙이면 자원으로 대체
      else if (civ.isBot) {
        let best = openBranch[0];
        for (const b of openBranch) if (civ.tech[b] < civ.tech[best]) best = b;
        civ.tech[best]++;
        if (best === 'military') this.resetFatigue(civId);
        ev.branch = best;
        ev.level = civ.tech[best];
      } else {
        this.pendingTechChoices.set(civId, (this.pendingTechChoices.get(civId) || 0) + 1);
        ev.choice = true;
      }
    }
    if (kind === 'res') {
      for (const r2 of ['stone', 'grain', 'wood', 'iron']) civ.resources[r2] += 20;
      ev.kind = 'res';
    }
    return ev;
  }

  // 기술 보물: 계통 선택
  chooseTreasureTech(civId, branch) {
    const n = this.pendingTechChoices.get(civId) || 0;
    if (n <= 0) return { ok: false, reason: 'notreasure' };
    const civ = this.civs.get(civId);
    if (!civ || !(branch in TECH_RES)) return { ok: false, reason: 'branch' };
    if (civ.tech[branch] >= TECH_MAX) return { ok: false, reason: 'max' };
    civ.tech[branch]++;
    if (branch === 'military') this.resetFatigue(civId);
    if (n === 1) this.pendingTechChoices.delete(civId);
    else this.pendingTechChoices.set(civId, n - 1);
    return { ok: true, branch, level: civ.tech[branch], remaining: n - 1 };
  }

  // 군사 기술 향상 → 전 유닛 패배 누적 리셋
  resetFatigue(civId) {
    for (const u of this.units.values()) if (u.civ === civId) u.fatigue = 0;
  }

  // 유닛 상한 = 시작 3기 + 인구(defense) 기술 레벨
  maxUnits(civ) { return START_UNITS + ((civ.tech && civ.tech.defense) || 0); }
  unitCountOf(civId) { let n = 0; for (const u of this.units.values()) if (u.civ === civId) n++; return n; }

  // 수도 최대 HP = 5 + 4계통 기술 총합
  maxCapitalHp(civ) {
    const t = civ.tech;
    return 5 + t.military + t.defense + t.gather + t.move;
  }
  scoresPublic() {
    return [...this.civs.values()].filter(c => c.alive).map(c => ({ civId: c.id, score: this.score(c) }));
  }

  // ── 영토
  setTile(k, civId) {
    const cur = this.territory.get(k);
    if (cur === civId) return;
    if (cur != null) this.territoryByCiv.get(cur)?.delete(k);
    this.territory.set(k, civId);
    if (!this.territoryByCiv.has(civId)) this.territoryByCiv.set(civId, new Set());
    this.territoryByCiv.get(civId).add(k);
    this._captures.set(k, civId);
  }

  // 영토 해제 (중립 유닛 침범)
  clearTile(k) {
    const cur = this.territory.get(k);
    if (cur == null) return;
    this.territoryByCiv.get(cur)?.delete(k);
    this.territory.delete(k);
    this._captures.set(k, null);
  }

  // 유닛이 밟은 헥스 점령 (동맹 영토는 존중)
  claim(x, y, civId) {
    if (!this.world.isLand(x, y)) return;
    for (const c of this.civs.values()) {
      if (c.alive && c.id !== civId && c.capital[0] === x && c.capital[1] === y) return; // 수도는 공성으로만
    }
    const k = x + ',' + y;
    const cur = this.territory.get(k);
    if (cur === civId) return;
    if (cur != null && this.isAllied(cur, civId)) return;
    this.setTile(k, civId);
  }

  territoryPublic() {
    return [...this.territory].map(([k, civId]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, civId];
    });
  }

  // ── 실행 턴: ⓪ 스턴 → ① 이동(영토화) → ② 전투(후퇴) → ③ 수도 함락 판정 → ④ 채취 → ⑤ 연구 → ⑥ 외교 → ⑦ 승리
  resolveExecution() {
    this._delegations = [];
    this._captures = new Map();

    const stunnedNow = new Set();
    for (const u of this.units.values()) {
      if (u.stunned > 0) { stunnedNow.add(u.id); u.stunned--; }
    }

    // ① 이동 + 경로 영토화 (+보물 습득)
    const treasureEvents = [];
    const moves = [];
    for (const [unitId, order] of this.orders) {
      const u = this.units.get(unitId);
      if (!u) { this.orders.delete(unitId); continue; }
      if (stunnedNow.has(unitId)) continue;
      const civ = this.civs.get(u.civ);
      // 이동력: 기본 3 (+이동 기술 3Lv마다 1). 평지 1, 산지 2, 바다 3 소모
      let budget = 3 + Math.floor((civ.tech.move || 0) / 3);
      const steps = []; // 이번 턴에 밟은 헥스 (클라이언트 이동 애니메이션용)
      while (order.idx < order.path.length) {
        const [nx, ny] = order.path[order.idx];
        const fortAt = this.forts.get(nx + ',' + ny);
        if (fortAt && fortAt.civ !== u.civ && !this.isAllied(fortAt.civ, u.civ)) break; // 장성에 막힘 (인접 대기)
        const cost = this.moveCost(nx, ny);
        if (cost > budget) break;
        budget -= cost;
        order.idx++;
        u.x = nx; u.y = ny;
        steps.push([nx, ny]);
        this.claim(nx, ny, u.civ); // 바다는 claim에서 무시됨
        const tr = this.treasures.get(nx + ',' + ny);
        if (tr) {
          this.treasures.delete(nx + ',' + ny);
          treasureEvents.push(this.grantTreasure(u.civ, tr, nx, ny));
        }
      }
      moves.push({ unitId, x: u.x, y: u.y, steps });
      if (order.idx >= order.path.length) this.orders.delete(unitId);
    }

    // ② 전투 (사망 없음 — 패자는 수도 후퇴 + 2턴 행동불능)
    const { battles, stuns, retreats } = this.resolveBattles(stunnedNow);
    for (const r of retreats) moves.push(r);

    // ②.3 중립 유닛: 배회 → 영토 해제 → 교전
    const neutralRes = this.resolveNeutrals(stunnedNow);
    stuns.push(...neutralRes.stuns);

    // ②.4 요새 건설 (예약분) — 자원 차감, 적 점유 시 실패
    const fortEvents = [], fortFails = [];
    for (const [fk, civId] of this.fortOrders) {
      const civ = this.civs.get(civId);
      if (!civ || !civ.alive) continue;
      if (this.territory.get(fk) !== civId || this.forts.has(fk)) { fortFails.push({ civId, reason: 'tile' }); continue; }
      if (civ.resources.stone < FORT_COST || civ.resources.wood < FORT_COST) { fortFails.push({ civId, reason: 'cost' }); continue; }
      const [fx2, fy2] = fk.split(',').map(Number);
      const enemyOn = [...this.units.values()].some(
        u2 => u2.x === fx2 && u2.y === fy2 && u2.civ !== civId && !this.isAllied(u2.civ, civId));
      if (enemyOn) { fortFails.push({ civId, reason: 'blocked' }); continue; }
      civ.resources.stone -= FORT_COST;
      civ.resources.wood -= FORT_COST;
      const fmax = Math.ceil(this.maxCapitalHp(civ) / 2); // 수도 HP의 절반
      this.forts.set(fk, { x: fx2, y: fy2, civ: civId, hp: fmax, max: fmax });
      fortEvents.push({ type: 'built', x: fx2, y: fy2, civId });
    }
    this.fortOrders.clear();

    // ②.45 요새 공성: 인접 적 유닛이 유닛당 (1+군사Lv) 피해. 없으면 턴당 1 회복
    for (const [fk, fort] of [...this.forts]) {
      let total = 0, by = null, best = -1;
      for (const [nx, ny] of this.world.neighbors(fort.x, fort.y)) {
        for (const u2 of this.units.values()) {
          if (u2.x !== nx || u2.y !== ny) continue;
          if (u2.civ === fort.civ || this.isAllied(u2.civ, fort.civ)) continue;
          if (u2.stunned > 0 || stunnedNow.has(u2.id)) continue;
          const atk = this.civs.get(u2.civ);
          const dmg = 1 + ((atk && atk.tech.military) || 0);
          total += dmg;
          if (dmg > best) { best = dmg; by = u2.civ; }
        }
      }
      if (total === 0) {
        if (fort.hp < fort.max) {
          fort.hp = Math.min(fort.max, fort.hp + 1);
          fortEvents.push({ type: 'hit', x: fort.x, y: fort.y, civId: fort.civ, hp: fort.hp, max: fort.max });
        }
        continue;
      }
      fort.hp = Math.max(0, fort.hp - total);
      if (fort.hp <= 0) {
        this.forts.delete(fk);
        fortEvents.push({ type: 'destroyed', x: fort.x, y: fort.y, civId: fort.civ, by });
      } else {
        fortEvents.push({ type: 'hit', x: fort.x, y: fort.y, civId: fort.civ, hp: fort.hp, max: fort.max, by });
      }
    }

    // ②.5 접촉 기록 (동맹 가능 조건)
    this.updateContacts();

    // ③ 수도 공성: 수도 위 적 유닛이 유닛당 (1+군사Lv) 피해, HP 0 → 함락.
    //    공격이 없으면 턴당 1 회복 (최대 5+기술총합)
    const conquests = [];
    const capitalHits = [];
    for (const civ of this.civs.values()) {
      if (!civ.alive) continue;
      const [kx, ky] = civ.capital;
      const attackers = new Map(); // civId -> 피해량
      for (const u of this.units.values()) {
        if (u.x !== kx || u.y !== ky) continue;
        if (u.civ === civ.id || this.isAllied(u.civ, civ.id)) continue;
        if (u.stunned > 0 || stunnedNow.has(u.id)) continue; // 행동불능 유닛은 공성 불가
        const atkCiv = this.civs.get(u.civ);
        const dmg = 1 + ((atkCiv && atkCiv.tech.military) || 0);
        attackers.set(u.civ, (attackers.get(u.civ) || 0) + dmg);
      }
      const max = this.maxCapitalHp(civ);
      if (attackers.size === 0) {
        if (civ.capitalHp < max) {
          // 회복량 = 기본 1 + 최대 레벨(5) 도달 계통 수
          const regen = 1 + Object.values(civ.tech).filter(l => l >= TECH_MAX).length;
          civ.capitalHp = Math.min(max, civ.capitalHp + regen);
          capitalHits.push({ civId: civ.id, hp: civ.capitalHp, max });
        }
        continue;
      }
      const total = [...attackers.values()].reduce((a, b) => a + b, 0);
      civ.capitalHp = Math.max(0, civ.capitalHp - total);
      let by = null, best = -1;
      for (const [cid, d] of attackers) if (d > best) { best = d; by = cid; }
      capitalHits.push({ civId: civ.id, hp: civ.capitalHp, max, by });
      if (civ.capitalHp <= 0) conquests.push(this.subjugate(civ, by));
    }

    // ④ 채취: 영토가 자동 생산. 동맹은 수입을 합산해 영토 수 비율로 배분
    const gains = this.resolveIncome();

    // ⑤ 연구
    const techUpdates = [], researchFails = [];
    for (const [civId, branch] of this.researchOrders) {
      const civ = this.civs.get(civId);
      if (!civ || !civ.alive) { researchFails.push({ civId, reason: 'dead' }); continue; }
      const lvl = civ.tech[branch];
      if (lvl >= TECH_MAX) { researchFails.push({ civId, reason: 'max' }); continue; }
      const res = TECH_RES[branch];
      const cost = techCost(lvl + 1);
      if (civ.resources[res] < cost) { researchFails.push({ civId, reason: 'cost' }); continue; }
      civ.resources[res] -= cost;
      civ.tech[branch] = lvl + 1;
      if (branch === 'military') this.resetFatigue(civId);
      techUpdates.push({ civId, branch, level: lvl + 1 });
    }
    this.researchOrders.clear();

    // ⑤.5 수도 유닛 생산
    const births = [], spawnFails = [];
    for (const civId of this.spawnOrders) {
      const civ = this.civs.get(civId);
      const fail = (reason) => spawnFails.push({ civId, reason });
      if (!civ || !civ.alive) { fail('dead'); continue; }
      if (this.unitCountOf(civId) >= this.maxUnits(civ)) { fail('cap'); continue; }
      if (civ.resources.stone < SPAWN_COST || civ.resources.grain < SPAWN_COST) { fail('cost'); continue; }
      civ.resources.stone -= SPAWN_COST;
      civ.resources.grain -= SPAWN_COST;
      const uid = this.nextUnitId++;
      const nu = { id: uid, civ: civId, x: civ.capital[0], y: civ.capital[1], stunned: 0 };
      this.units.set(uid, nu);
      births.push(nu);
    }
    this.spawnOrders.clear();

    // ⑥ 외교: 동맹 탈퇴 발효 → 흡수 판정
    const allyLeft = [], allyFees = [];
    for (const [from, to] of this.leaveOrders) {
      if (this.isAllied(from, to)) {
        // 위약금: 파기 신청측이 현재 자원의 10% 지급 (3국 동맹이면 다른 동맹국에 5%씩)
        const fromCiv = this.civs.get(from);
        if (fromCiv && fromCiv.alive) {
          const others = [...(this.allies.get(from) || new Set())];
          const recipients = others.length >= 2 ? others : [to];
          const pct = others.length >= 2 ? 0.05 : 0.10;
          const RES4 = ['stone', 'grain', 'wood', 'iron'];
          const fee = {};
          for (const r2 of RES4) fee[r2] = Math.floor(fromCiv.resources[r2] * pct);
          for (const rid of recipients) {
            const rc = this.civs.get(rid);
            if (!rc || !rc.alive) continue;
            for (const r2 of RES4) {
              fromCiv.resources[r2] -= fee[r2];
              rc.resources[r2] += fee[r2];
            }
            allyFees.push({ from, to: rid, res: { ...fee } });
          }
        }
        this.removeAlliance(from, to);
        allyLeft.push([from, to]);
      }
    }
    this.leaveOrders = [];

    const absorptions = [];
    const seen = new Set();
    for (const [aId, set] of this.allies) {
      for (const bId of set) {
        const key = Math.min(aId, bId) + ':' + Math.max(aId, bId);
        if (seen.has(key)) continue;
        seen.add(key);
        const a = this.civs.get(aId), b = this.civs.get(bId);
        if (!a || !b || !a.alive || !b.alive) continue;
        const sa = this.score(a), sb = this.score(b);
        const total = sa + sb;
        if (total === 0) { this.absorbCounters.delete(key); continue; }
        const strong = sa >= sb ? a : b;
        const weak = sa >= sb ? b : a;
        if (Math.max(sa, sb) / total > ABSORB_RATIO) {
          const n = (this.absorbCounters.get(key) || 0) + 1;
          if (n >= ABSORB_TURNS) {
            this.absorbCounters.delete(key);
            absorptions.push(this.subjugate(weak, strong.id));
          } else {
            this.absorbCounters.set(key, n);
          }
        } else {
          this.absorbCounters.delete(key);
        }
      }
    }

    // ⑦ 승리 판정
    const gameover = this.checkVictory();
    if (gameover) {
      this.ended = true;
      this.state = 'ENDED';
      this.phase = 'ENDED';
      clearTimeout(this.timer);
    }

    const captures = [...this._captures].map(([k, civId]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, civId];
    });

    return {
      moves, battles, stuns, captures, capitalHits, conquests, delegations: this._delegations,
      gains, births, spawnFails, techUpdates, researchFails, allyLeft, absorptions, gameover,
      treasures: treasureEvents,
      neutrals: this.neutralsPublic(), neutralEvents: neutralRes.events,
      forts: this.fortsPublic(), fortEvents, fortFails, allyFees,
      scores: this.scoresPublic(),
    };
  }

  // 같은 헥스의 적대 세력 간 전투 (동맹은 연합). 사망 없음.
  // 연합 전투력 = 최고 군사기술 + 수 우위(2배 이상 +1) + 자기 영토면 소유국 방어기술
  // 최고 단독 → 패자 전원 수도 후퇴 + 2턴 행동불능, 승자 1턴. 동률 → 전원 2턴 행동불능.
  resolveBattles(stunnedNow = new Set()) {
    const battles = [], stuns = [], retreats = [];
    const byHex = new Map();
    for (const u of this.units.values()) {
      const k = u.x + ',' + u.y;
      if (!byHex.has(k)) byHex.set(k, []);
      byHex.get(k).push(u);
    }
    for (const [k, list] of byHex) {
      const groups = new Map();
      for (const u of list) {
        if (!groups.has(u.civ)) groups.set(u.civ, []);
        groups.get(u.civ).push(u);
      }
      if (groups.size < 2) continue;
      if (!list.some(u => !stunnedNow.has(u.id))) continue;

      const ids = [...groups.keys()];
      const parent = new Map(ids.map(id => [id, id]));
      const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          if (this.isAllied(ids[i], ids[j])) parent.set(find(ids[i]), find(ids[j]));

      const coalitions = new Map();
      for (const id of ids) {
        const r = find(id);
        if (!coalitions.has(r)) coalitions.set(r, { civIds: [], units: [], mil: 0, count: 0 });
        const c = coalitions.get(r);
        c.civIds.push(id);
        c.units.push(...groups.get(id));
        c.mil = Math.max(c.mil, this.civs.get(id).tech.military || 0);
        c.count += groups.get(id).length;
      }
      if (coalitions.size < 2) continue;

      const tileOwner = this.territory.get(k);
      const entries = [...coalitions.values()];
      for (const e of entries) {
        const maxOther = Math.max(...entries.filter(o => o !== e).map(o => o.count));
        const defense = (tileOwner != null && e.civIds.includes(tileOwner))
          ? (this.civs.get(tileOwner).tech.defense || 0) : 0;
        e.power = e.mil + defense + (e.count >= 2 * maxOther ? 1 : 0);
      }
      const maxP = Math.max(...entries.map(e => e.power));
      const winners = entries.filter(e => e.power === maxP);
      const losers = entries.filter(e => e.power < maxP);
      const stunTurns = winners.length >= 2 ? 2 : 1;

      for (const w of winners) {
        for (const u of w.units) { u.stunned = stunTurns; stuns.push({ unitId: u.id, turns: stunTurns }); }
      }
      // 패자: 수도로 후퇴 + 2턴 행동불능
      for (const l of losers) {
        for (const u of l.units) {
          const home = this.civs.get(u.civ).capital;
          u.x = home[0]; u.y = home[1];
          u.fatigue = (u.fatigue || 0) + 1;      // 패배 누적 → 행동불능 증가
          u.stunned = 1 + u.fatigue;             // 1패 2턴, 2패 3턴 …
          stuns.push({ unitId: u.id, turns: u.stunned, fatigue: u.fatigue });
          retreats.push({ unitId: u.id, x: u.x, y: u.y });
        }
      }
      const [hx, hy] = k.split(',').map(Number);
      // 승자가 단독이면 전투 헥스 점령
      if (winners.length === 1) this.claim(hx, hy, winners[0].civIds[0]);
      battles.push({
        hex: [hx, hy],
        civs: entries.flatMap(e => e.civIds.map(civId => ({
          civId, power: e.power, count: groups.get(civId).length,
          lost: e.power < maxP ? groups.get(civId).length : 0, // lost = 후퇴한 유닛 수
        }))),
      });
    }
    return { battles, stuns, retreats };
  }

  // 채취 수입 계산. 동맹 그룹은 합산 후 영토 수 비율로 배분(최대 잉여법)
  resolveIncome() {
    const RES = ['stone', 'grain', 'wood', 'iron'];
    const income = new Map(); // civId -> {res} (자체 채집 기술 적용)
    for (const civ of this.civs.values()) {
      if (!civ.alive) continue;
      const tiles = this.territoryByCiv.get(civ.id);
      if (!tiles || tiles.size === 0) continue;
      const count = { stone: 0, grain: 0, wood: 0, iron: 0 };
      for (const k of tiles) {
        const [x, y] = k.split(',').map(Number);
        const res = this.world.resourceAt(x, y);
        if (res) count[res]++;
      }
      const mult = 1 + 0.2 * (civ.tech.gather || 0);
      const g = { stone: 0, grain: 0, wood: 0, iron: 0 };
      for (const res of RES) g[res] = Math.ceil(count[res] * mult);
      income.set(civ.id, g);
    }

    // 동맹 그룹(연결 요소)
    const aliveIds = [...this.civs.values()].filter(c => c.alive).map(c => c.id);
    const parent = new Map(aliveIds.map(id => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const [a, set] of this.allies)
      for (const b of set)
        if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
    const groups = new Map();
    for (const id of aliveIds) {
      const r = find(id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(id);
    }

    const gains = {};
    const apply = (civId, g) => {
      const civ = this.civs.get(civId);
      for (const res of RES) civ.resources[res] += g[res];
      if (RES.some(r => g[r] > 0)) gains[civId] = g;
    };

    for (const members of groups.values()) {
      if (members.length === 1) {
        const g = income.get(members[0]);
        if (g) apply(members[0], g);
        continue;
      }
      const pool = { stone: 0, grain: 0, wood: 0, iron: 0 };
      for (const id of members) {
        const g = income.get(id);
        if (g) for (const res of RES) pool[res] += g[res];
      }
      const tilesOf = members.map(id => this.tileCountOf(id));
      const totalTiles = tilesOf.reduce((a, b) => a + b, 0);
      if (totalTiles === 0) continue;
      const out = members.map(() => ({ stone: 0, grain: 0, wood: 0, iron: 0 }));
      for (const res of RES) {
        if (pool[res] === 0) continue;
        let assigned = 0;
        const rema = members.map((id, i) => {
          const exact = pool[res] * tilesOf[i] / totalTiles;
          const f = Math.floor(exact);
          out[i][res] = f;
          assigned += f;
          return { i, r: exact - f };
        });
        rema.sort((a, b) => b.r - a.r || tilesOf[b.i] - tilesOf[a.i] || members[a.i] - members[b.i]);
        for (let n = 0; n < pool[res] - assigned; n++) out[rema[n % rema.length].i][res]++;
      }
      members.forEach((id, i) => apply(id, out[i]));
    }
    return gains;
  }

  // 점령/흡수 공통: 유닛·영토를 승자 소속으로, 예속 상태 + 유닛 1기 위임
  subjugate(civ, byId) {
    for (const u of this.units.values()) {
      if (u.civ === civ.id) {
        u.civ = byId;
        this.orders.delete(u.id);
      }
    }
    const tiles = this.territoryByCiv.get(civ.id);
    if (tiles) for (const k of [...tiles]) this.setTile(k, byId);
    civ.alive = false;
    civ.conqueredBy = byId;
    for (const f of this.forts.values()) if (f.civ === civ.id) f.civ = byId; // 요새 편입
    this.researchOrders.delete(civ.id);
    this.spawnOrders.delete(civ.id);
    this.dissolveDiplomacyFor(civ.id);
    for (const v of this.civs.values()) {
      if (v.id !== civ.id && v.conqueredBy === civ.id) {
        v.conqueredBy = byId;
        this.delegateUnit(v.id);
      }
    }
    this.delegateUnit(civ.id);
    return { civId: civ.id, by: byId };
  }

  // 점령국이 예속국별 위임 유닛 수(1~3) 조정
  setDelegation(masterId, vassalId, count) {
    if (this.state !== 'RUNNING') return { ok: false, reason: 'phase' };
    const master = this.civs.get(masterId);
    const vassal = this.civs.get(vassalId);
    if (!master || !master.alive || !vassal || vassal.conqueredBy !== masterId) {
      return { ok: false, reason: 'civ' };
    }
    count = Math.max(1, Math.min(3, Math.trunc(count) || 1));
    const changes = [];
    const current = [...this.units.values()].filter(u => u.controller === vassalId);
    if (current.length > count) {
      for (const u of current.slice(count)) {
        u.controller = null;
        this.orders.delete(u.id);
        changes.push({ unitId: u.id, controller: null });
      }
    } else if (current.length < count) {
      const free = [...this.units.values()].filter(u => u.civ === masterId && u.controller == null);
      for (const u of free.slice(0, count - current.length)) {
        u.controller = vassalId;
        changes.push({ unitId: u.id, controller: vassalId });
      }
    }
    const actual = [...this.units.values()].filter(u => u.controller === vassalId).length;
    return { ok: true, count: actual, changes };
  }

  dissolveDiplomacyFor(civId) {
    const set = this.allies.get(civId);
    if (set) for (const other of [...set]) this.removeAlliance(civId, other);
    this.allyProposals.delete(civId);
    for (const s of this.allyProposals.values()) s.delete(civId);
    for (const [k, req] of [...this.allyConsents]) {
      if (req.a === civId || req.b === civId || req.approver === civId) this.allyConsents.delete(k);
    }
    for (const key of [...this.absorbCounters.keys()]) {
      const [a, b] = key.split(':').map(Number);
      if (a === civId || b === civId) this.absorbCounters.delete(key);
    }
  }

  delegateUnit(vassalId) {
    const vassal = this.civs.get(vassalId);
    if (!vassal || vassal.conqueredBy == null) return null;
    for (const u of this.units.values()) if (u.controller === vassalId) return u;
    for (const u of this.units.values()) {
      if (u.civ === vassal.conqueredBy && u.controller == null) {
        u.controller = vassalId;
        this._delegations.push({ unitId: u.id, controller: vassalId });
        return u;
      }
    }
    return null;
  }

  checkVictory() {
    if (this.ended || this.state !== 'RUNNING') return null;
    const alive = [...this.civs.values()].filter(c => c.alive);
    const scores = this.scoresPublic();
    if (this.civs.size >= 2 && alive.length === 1) {
      return { reason: 'domination', winners: [alive[0].id], scores };
    }
    if (this.turn >= this.settings.turnLimit) {
      const max = Math.max(0, ...scores.map(s => s.score));
      const tops = scores.filter(s => s.score === max).map(s => s.civId);
      const winners = new Set(tops);
      for (const id of tops) {
        const set = this.allies.get(id);
        if (set) for (const ally of set) if (this.civs.get(ally)?.alive) winners.add(ally);
      }
      return { reason: 'score', winners: [...winners], scores };
    }
    return null;
  }

  // ── 명령 (진행 중 + 회의 턴에만)
  moveOrder(civId, unitId, target, append) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const u = this.units.get(unitId);
    if (!u || this.controllerOf(u) !== civId) return { ok: false, reason: 'unit' };
    if (!Array.isArray(target) || target.length !== 2) return { ok: false, reason: 'target' };
    const [tx, ty] = [this.world.wrapX(Math.trunc(target[0])), Math.trunc(target[1])];
    if (ty < 0 || ty >= this.world.h) return { ok: false, reason: 'target' };
    // 웨이포인트: append면 기존 경로의 끝에서 이어붙임
    let sx = u.x, sy = u.y, base = [];
    if (append) {
      const cur = this.orders.get(unitId);
      if (cur && cur.idx < cur.path.length) {
        base = cur.path.slice(cur.idx);
        [sx, sy] = base[base.length - 1];
      }
    }
    const path = this.findPath(sx, sy, tx, ty, u.civ);
    if (!path) return { ok: false, reason: 'path' };
    const full = base.concat(path);
    if (full.length === 0) { this.orders.delete(unitId); return { ok: true, path: [] }; }
    this.orders.set(unitId, { path: full, idx: 0 });
    return { ok: true, path: full };
  }

  cancelOrder(civId, unitId) {
    const u = this.units.get(unitId);
    if (!u || this.controllerOf(u) !== civId) return false;
    return this.orders.delete(unitId);
  }

  // 수도 유닛 생산 예약 (회의 턴) — 실행 턴에 수도에서 생성
  spawnOrder(civId) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    if (this.unitCountOf(civId) >= this.maxUnits(civ)) return { ok: false, reason: 'cap' };
    if (civ.resources.stone < SPAWN_COST || civ.resources.grain < SPAWN_COST) return { ok: false, reason: 'cost' };
    this.spawnOrders.add(civId);
    return { ok: true, cost: SPAWN_COST };
  }

  // 요새 건설 예약 (회의 턴) — 자기 유닛이 서 있는 자기 영토에
  fortOrder(civId, unitId) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    const u = this.units.get(unitId);
    if (!u || u.civ !== civId) return { ok: false, reason: 'unit' };
    if (u.stunned > 0) return { ok: false, reason: 'stunned' };
    const k = u.x + ',' + u.y;
    if (!this.world.isLand(u.x, u.y)) return { ok: false, reason: 'tile' };
    if (this.territory.get(k) !== civId) return { ok: false, reason: 'tile' };
    if (this.forts.has(k)) return { ok: false, reason: 'tile' };
    for (const c of this.civs.values()) {
      if (c.alive && c.capital[0] === u.x && c.capital[1] === u.y) return { ok: false, reason: 'tile' };
    }
    if (civ.resources.stone < FORT_COST || civ.resources.wood < FORT_COST) return { ok: false, reason: 'cost' };
    this.fortOrders.set(k, civId);
    return { ok: true, cost: FORT_COST };
  }

  fortsPublic() { return [...this.forts.values()]; }

  // 유닛 회복: 곡식을 소모해 현재 행동불능과 패배 누적을 즉시 리셋 (회의 턴)
  rallyOrder(civId, unitId) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    const u = this.units.get(unitId);
    if (!u || u.civ !== civId) return { ok: false, reason: 'unit' };
    if (u.stunned <= 0 && (u.fatigue || 0) <= 0) return { ok: false, reason: 'state' };
    if (civ.resources.grain < RALLY_COST) return { ok: false, reason: 'cost' };
    civ.resources.grain -= RALLY_COST;
    u.stunned = 0;
    u.fatigue = 0;
    return { ok: true, cost: RALLY_COST, resources: civ.resources };
  }

  researchOrder(civId, branch) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    if (!(branch in TECH_RES)) return { ok: false, reason: 'branch' };
    if (civ.tech[branch] >= TECH_MAX) return { ok: false, reason: 'max' };
    this.researchOrders.set(civId, branch);
    return { ok: true, branch, cost: techCost(civ.tech[branch] + 1), res: TECH_RES[branch] };
  }

  // ── 외교
  proposeAlly(fromId, toId) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const a = this.civs.get(fromId), b = this.civs.get(toId);
    if (!a || !b || fromId === toId) return { ok: false, reason: 'civ' };
    if (!a.alive || !b.alive) return { ok: false, reason: 'dead' };
    if (!this.hasContact(fromId, toId) && process.env.ALLY_NO_CONTACT_CHECK !== '1') return { ok: false, reason: 'nocontact' };
    if (this.isAllied(fromId, toId)) return { ok: false, reason: 'already' };
    if (new Set([...this.groupOf(fromId), ...this.groupOf(toId)]).size > ALLY_MAX) return { ok: false, reason: 'full' };
    if (this.allyProposals.get(fromId)?.has(toId)) return this.acceptAlly(fromId, toId);
    if (!this.allyProposals.has(toId)) this.allyProposals.set(toId, new Set());
    this.allyProposals.get(toId).add(fromId);
    return { ok: true, pending: true };
  }

  acceptAlly(whoId, fromId) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const a = this.civs.get(whoId), b = this.civs.get(fromId);
    if (!a || !b || !a.alive || !b.alive) return { ok: false, reason: 'dead' };
    if (!this.allyProposals.get(whoId)?.has(fromId)) return { ok: false, reason: 'noproposal' };
    const union = new Set([...this.groupOf(whoId), ...this.groupOf(fromId)]);
    if (union.size > ALLY_MAX) return { ok: false, reason: 'full' };
    this.allyProposals.get(whoId).delete(fromId);
    this.allyProposals.get(fromId)?.delete(whoId);
    // 기존 동맹국(제3국)이 있으면 동의 필요
    const approvers = [...union].filter(id => id !== whoId && id !== fromId);
    if (approvers.length > 0) {
      const key = Math.min(whoId, fromId) + ':' + Math.max(whoId, fromId);
      this.allyConsents.set(key, { a: whoId, b: fromId, approver: approvers[0] });
      return { ok: true, consentNeeded: approvers[0], pair: [whoId, fromId] };
    }
    return this.formAlliance(whoId, fromId);
  }

  formAlliance(a, b) {
    if (!this.allies.has(a)) this.allies.set(a, new Set());
    if (!this.allies.has(b)) this.allies.set(b, new Set());
    this.allies.get(a).add(b);
    this.allies.get(b).add(a);
    return { ok: true, formed: [a, b] };
  }

  // 유닛 기준 반경 2헥스 내 타 문명 유닛/영토와의 접촉 기록
  updateContacts() {
    const unitCivsByHex = new Map();
    for (const u of this.units.values()) {
      const k = u.x + ',' + u.y;
      if (!unitCivsByHex.has(k)) unitCivsByHex.set(k, new Set());
      unitCivsByHex.get(k).add(u.civ);
    }
    const mark = (a, b) => {
      if (a === b || !this.civs.has(a) || !this.civs.has(b)) return;
      this.contacts.add(Math.min(a, b) + ':' + Math.max(a, b));
    };
    for (const u of this.units.values()) {
      const seen = new Set([u.x + ',' + u.y]);
      let frontier = [[u.x, u.y]];
      for (let d = 0; d <= 2; d++) {
        const next = [];
        for (const [cx, cy] of frontier) {
          const k = cx + ',' + cy;
          const others = unitCivsByHex.get(k);
          if (others) for (const o of others) mark(u.civ, o);
          const owner = this.territory.get(k);
          if (owner != null) mark(u.civ, owner);
          if (d < 2) {
            for (const nb of this.world.neighbors(cx, cy)) {
              const nk = nb[0] + ',' + nb[1];
              if (!seen.has(nk)) { seen.add(nk); next.push(nb); }
            }
          }
        }
        frontier = next;
      }
    }
  }
  hasContact(a, b) { return this.contacts.has(Math.min(a, b) + ':' + Math.max(a, b)); }
  contactsOf(civId) {
    const out = [];
    for (const c of this.civs.values()) {
      if (c.id !== civId && this.hasContact(civId, c.id)) out.push(c.id);
    }
    return out;
  }

  // 동맹 그룹(연결 요소) — 자신 포함
  groupOf(id) {
    const out = new Set([id]);
    let frontier = [id];
    while (frontier.length) {
      const next = [];
      for (const cur of frontier) {
        for (const nb of this.allies.get(cur) || []) {
          if (!out.has(nb)) { out.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return out;
  }

  // 제3국의 동맹 확장 동의/거부
  consentAlly(approverId, pair, approve) {
    if (!Array.isArray(pair) || pair.length !== 2) return { ok: false, reason: 'civ' };
    const key = Math.min(pair[0], pair[1]) + ':' + Math.max(pair[0], pair[1]);
    const req = this.allyConsents.get(key);
    if (!req || req.approver !== approverId) return { ok: false, reason: 'noconsent' };
    this.allyConsents.delete(key);
    if (!approve) return { ok: true, vetoed: [req.a, req.b], by: approverId };
    const a = this.civs.get(req.a), b = this.civs.get(req.b);
    if (!a || !b || !a.alive || !b.alive) return { ok: false, reason: 'dead' };
    const union = new Set([...this.groupOf(req.a), ...this.groupOf(req.b)]);
    if (union.size > ALLY_MAX) return { ok: false, reason: 'full' };
    return this.formAlliance(req.a, req.b);
  }

  leaveAlly(fromId, toId) {
    if (!this.isAllied(fromId, toId)) return { ok: false, reason: 'notally' };
    this.leaveOrders.push([fromId, toId]);
    return { ok: true };
  }

  removeAlliance(a, b) {
    this.allies.get(a)?.delete(b);
    this.allies.get(b)?.delete(a);
    this.absorbCounters.delete(Math.min(a, b) + ':' + Math.max(a, b));
  }

  alliancesPublic() {
    const out = [];
    const seen = new Set();
    for (const [a, set] of this.allies) {
      for (const b of set) {
        const key = Math.min(a, b) + ':' + Math.max(a, b);
        if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
      }
    }
    return out;
  }

  // 지형별 이동 비용: 평지 1, 구릉 1.5, 산 2, 고산 3, 바다 3
  moveCost(x, y) {
    const t = this.world.terrain(x, y);
    if (t === '~' || t === 'M') return 3;
    if (t === 'm') return 2;
    if (t === 'h') return 1.5;
    return 1;
  }

  // 다익스트라 최단 경로 (지형별 이동 비용 적용). 시작 제외, 목표 포함.
  findPath(sx, sy, tx, ty, civId) {
    if (sx === tx && sy === ty) return [];
    const key = (x, y) => x + ',' + y;
    const startK = key(sx, sy);
    const dist = new Map([[startK, 0]]);
    const prev = new Map();
    const buckets = [[[sx, sy]]];
    for (let d = 0; d < buckets.length; d++) {
      const list = buckets[d];
      if (!list) continue;
      for (const [cx, cy] of list) {
        const ck = key(cx, cy);
        if (dist.get(ck) !== d) continue; // 더 짧은 경로로 이미 처리됨
        if (cx === tx && cy === ty) {
          const path = [];
          let cur = [cx, cy];
          while (cur && key(cur[0], cur[1]) !== startK) {
            path.push(cur);
            cur = prev.get(key(cur[0], cur[1]));
          }
          return path.reverse();
        }
        for (const [nx, ny] of this.world.neighbors(cx, cy)) {
          if (civId != null) {
            const f = this.forts.get(nx + ',' + ny);
            if (f && f.civ !== civId && !this.isAllied(f.civ, civId)) continue; // 적 장성 우회
          }
          const cost = Math.round(this.moveCost(nx, ny) * 2); // 정수 버킷용 2배 스케일
          const nd = d + cost;
          const nk = key(nx, ny);
          if (nd < (dist.get(nk) ?? Infinity)) {
            dist.set(nk, nd);
            prev.set(nk, [cx, cy]);
            if (!buckets[nd]) buckets[nd] = [];
            buckets[nd].push([nx, ny]);
          }
        }
      }
    }
    return null;
  }

  // ── 봇 추가 (관리자)
  addBot() {
    const r = this.join(undefined, '봇');
    if (r.spectator) return { ok: false, reason: 'full' };
    r.civ.isBot = true;
    return { ok: true, civ: r.civ };
  }

  // 국가 스폰 지점 (캐시)
  spawnOf(countryIdx) {
    if (!this._spawnCache) this._spawnCache = new Map();
    let sp = this._spawnCache.get(countryIdx);
    if (!sp) {
      const c = countries[countryIdx];
      const [cx, cy] = this.world.lonlatToHex(c.cap[0], c.cap[1]);
      sp = this.world.nearestLand(cx, cy) || [cx, cy];
      this._spawnCache.set(countryIdx, sp);
    }
    return sp;
  }

  // 신규 배정: 기존 플레이어 수도들과의 최소 거리가 가장 먼 나라 선택
  pickCountryIndex() {
    if (this.civs.size === 0) return this.pool.pop();
    let bestPos = this.pool.length - 1, bestScore = -1;
    for (let i = 0; i < this.pool.length; i++) {
      const [sx, sy] = this.spawnOf(this.pool[i]);
      let minD = Infinity;
      for (const c of this.civs.values()) {
        minD = Math.min(minD, this.world.hexDistance(sx, sy, c.capital[0], c.capital[1]));
      }
      if (minD > bestScore) { bestScore = minD; bestPos = i; }
    }
    return this.pool.splice(bestPos, 1)[0];
  }

  // ── 접속/재접속
  join(token, playerName) {
    if (token && this.tokens.has(token)) {
      const civ = this.civs.get(this.tokens.get(token));
      civ.connected = true;
      return { civ, isNew: false };
    }
    if (this.state === 'ENDED') return { spectator: true };
    if (this.civs.size >= MAX_PLAYERS || this.pool.length === 0) return { spectator: true };

    const countryIdx = this.pickCountryIndex();
    const country = countries[countryIdx];
    const id = this.nextCivId++;
    const newToken = crypto.randomBytes(16).toString('hex');
    const spawn = this.spawnOf(countryIdx);

    const civ = {
      id,
      token: newToken,
      code: country.code,
      name: country.ko,
      en: country.en,
      player: String(playerName || '').slice(0, 20) || '플레이어',
      color: `hsl(${(id * 137) % 360}, 70%, 55%)`,
      capital: spawn,
      connected: true,
      resources: { stone: 0, grain: 0, wood: 0, iron: 0 },
      tech: { military: 0, defense: 0, gather: 0, move: 0 },
      capitalHp: 5,
      alive: true,
      conqueredBy: null,
    };
    this.civs.set(id, civ);
    this.tokens.set(newToken, id);

    if (this.state === 'RUNNING') this.enterWorld(civ); // 늦은 참가자
    return { civ, isNew: true };
  }

  disconnect(civId) {
    const civ = this.civs.get(civId);
    if (civ) civ.connected = false;
  }

  civPublic(civ) {
    return {
      id: civ.id, code: civ.code, name: civ.name, en: civ.en,
      player: civ.player, color: civ.color, capital: civ.capital,
      connected: civ.connected, alive: civ.alive, conqueredBy: civ.conqueredBy,
      tech: civ.tech,
      capitalHp: civ.capitalHp, capitalMaxHp: this.maxCapitalHp(civ),
      isBot: !!civ.isBot,
    };
  }

  ordersOf(civId) {
    const out = [];
    for (const [unitId, o] of this.orders) {
      const u = this.units.get(unitId);
      if (u && this.controllerOf(u) === civId) out.push({ unitId, path: o.path.slice(o.idx) });
    }
    return out;
  }

  snapshot() {
    return {
      civs: [...this.civs.values()].map(c => this.civPublic(c)),
      units: [...this.units.values()],
      territory: this.territoryPublic(),
      treasures: this.treasuresPublic(),
      neutrals: this.neutralsPublic(),
      forts: this.fortsPublic(),
      alliances: this.alliancesPublic(),
      state: this.state,
      phase: this.phase, turn: this.turn, endsAt: this.phaseEnds,
      turnLimit: this.settings.turnLimit, ended: this.ended,
    };
  }
}

module.exports = { Game, MAX_PLAYERS, START_UNITS, TECH_MAX, MIN_LANDMASS };
