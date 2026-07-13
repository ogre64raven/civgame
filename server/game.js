// 게임 상태 — 문명, 유닛, 턴 페이즈, 이동/전투/채취/연구/생산, 동맹/흡수, 점령·예속, 승리 (M1~M4)
const crypto = require('crypto');
const countries = require('../data/countries.json');

const MAX_PLAYERS = 30;
const START_UNITS = 3;
const UNIT_CAP = 12;
const SPAWN_COST_BASE = 5;              // 고기·곡식 각각
const TECH_MAX = 5;
const TECH_RES = { military: 'iron', gather: 'wood', move: 'grain', growth: 'meat' };
const techCost = (targetLevel) => 10 * targetLevel;
const ABSORB_RATIO = 0.8;               // 8:2 초과
const ABSORB_TURNS = 3;                 // 연속 유지 턴
const TURN_LIMIT = parseInt(process.env.TURN_LIMIT || '120', 10);
const PHASE_MS = {
  MEETING: parseInt(process.env.PHASE_MEETING_MS || '30000', 10),
  EXECUTION: parseInt(process.env.PHASE_EXEC_MS || '10000', 10),
};

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor(world, broadcast) {
    this.world = world;
    this.broadcast = broadcast;   // (msgObj) => void
    this.onExec = null;           // (result) => void — index.js가 설정
    this.civs = new Map();
    this.tokens = new Map();
    this.units = new Map();       // unitId -> { id, civ, x, y, stunned, controller? }
    this.orders = new Map();      // unitId -> { path, idx }
    this.spawnOrders = new Map(); // civId -> [x,y]
    this.researchOrders = new Map(); // civId -> branch
    this.allies = new Map();      // civId -> Set(civId)
    this.allyProposals = new Map(); // targetCivId -> Set(fromCivId)
    this.leaveOrders = [];        // [from, to] — 다음 실행 턴 발효
    this.absorbCounters = new Map(); // 'minId:maxId' -> 연속 턴 수
    this.ended = false;
    this.pool = shuffle(countries.map((_, i) => i));
    this.nextCivId = 1;
    this.nextUnitId = 1;
    this.turn = 1;
    this.phase = 'MEETING';
    this.phaseEnds = Date.now() + PHASE_MS.MEETING;
    this.timer = setTimeout(() => this.nextPhase(), PHASE_MS.MEETING);
  }

  nextPhase() {
    if (this.ended) return;
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
    if (this.ended) return;
    const ms = PHASE_MS[this.phase];
    this.phaseEnds = Date.now() + ms;
    this.timer = setTimeout(() => this.nextPhase(), ms);
    this.broadcast({ type: 'phase', phase: this.phase, turn: this.turn, endsAt: this.phaseEnds });
  }

  controllerOf(u) { return u.controller != null ? u.controller : u.civ; }
  unitCountOf(civId) { let n = 0; for (const u of this.units.values()) if (u.civ === civId) n++; return n; }
  isAllied(a, b) { const s = this.allies.get(a); return !!s && s.has(b); }
  score(civ) {
    const t = civ.tech;
    return (t.military + t.gather + t.move + t.growth) + this.unitCountOf(civ.id);
  }
  scoresPublic() {
    return [...this.civs.values()].filter(c => c.alive).map(c => ({ civId: c.id, score: this.score(c) }));
  }

  // ── 실행 턴: ⓪ 스턴 → ① 이동 → ② 전투 → ③ 채취 → ④ 연구 → ⑤ 생산 → ⑥ 외교(탈퇴·흡수) → ⑦ 승리 판정
  resolveExecution() {
    this._delegations = [];

    const stunnedNow = new Set();
    for (const u of this.units.values()) {
      if (u.stunned > 0) { stunnedNow.add(u.id); u.stunned--; }
    }

    // ① 이동
    const moves = [];
    for (const [unitId, order] of this.orders) {
      const u = this.units.get(unitId);
      if (!u) { this.orders.delete(unitId); continue; }
      if (stunnedNow.has(unitId)) continue;
      const civ = this.civs.get(u.civ);
      const speed = 1 + Math.floor((civ.tech.move || 0) / 3);
      for (let s = 0; s < speed && order.idx < order.path.length; s++) {
        const [nx, ny] = order.path[order.idx++];
        u.x = nx; u.y = ny;
      }
      moves.push({ unitId, x: u.x, y: u.y });
      if (order.idx >= order.path.length) this.orders.delete(unitId);
    }

    // ② 전투 (동맹은 연합으로 함께 싸움)
    const { battles, deaths, stuns, conquests } = this.resolveBattles(stunnedNow);

    // ③ 채취
    const gains = {};
    for (const u of this.units.values()) {
      if (stunnedNow.has(u.id) || u.stunned > 0) continue;
      const res = this.world.resourceAt(u.x, u.y);
      if (!res) continue;
      const civ = this.civs.get(u.civ);
      const amt = 1 + (civ.tech.gather || 0);
      civ.resources[res] += amt;
      if (!gains[u.civ]) gains[u.civ] = { meat: 0, grain: 0, wood: 0, iron: 0 };
      gains[u.civ][res] += amt;
    }

    // ④ 연구
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
      techUpdates.push({ civId, branch, level: lvl + 1 });
    }
    this.researchOrders.clear();

    // ⑤ 생산
    const births = [], spawnFails = [];
    for (const [civId, hex] of this.spawnOrders) {
      const civ = this.civs.get(civId);
      const fail = (reason) => spawnFails.push({ civId, reason });
      if (!civ || !civ.alive) { fail('dead'); continue; }
      if (this.unitCountOf(civId) >= UNIT_CAP) { fail('cap'); continue; }
      let hasUnit = false;
      for (const u of this.units.values()) if (u.civ === civId && u.x === hex[0] && u.y === hex[1]) { hasUnit = true; break; }
      if (!hasUnit) { fail('nounit'); continue; }
      const cost = Math.max(1, Math.ceil(SPAWN_COST_BASE * (1 - 0.1 * (civ.tech.growth || 0))));
      if (civ.resources.meat < cost || civ.resources.grain < cost) { fail('cost'); continue; }
      civ.resources.meat -= cost;
      civ.resources.grain -= cost;
      const uid = this.nextUnitId++;
      const nu = { id: uid, civ: civId, x: hex[0], y: hex[1], stunned: 0 };
      this.units.set(uid, nu);
      births.push(nu);
    }
    this.spawnOrders.clear();

    // ⑥ 외교: 동맹 탈퇴 발효 → 흡수 판정
    const allyLeft = [];
    for (const [from, to] of this.leaveOrders) {
      if (this.isAllied(from, to)) {
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
            absorptions.push(this.absorb(weak, strong.id));
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
      this.phase = 'ENDED';
      clearTimeout(this.timer);
    }

    return {
      moves, battles, deaths, stuns, conquests, delegations: this._delegations,
      gains, births, spawnFails, techUpdates, researchFails, allyLeft, absorptions, gameover,
      scores: this.scoresPublic(),
    };
  }

  // 같은 헥스의 적대 세력 간 전투. 동맹 문명은 연합으로 묶임.
  // 연합 전투력 = 최고 군사기술 + (상대 최대 병력의 2배 이상이면 +1)
  resolveBattles(stunnedNow = new Set()) {
    const battles = [], deaths = [], stuns = [], conquests = [];
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
      if (!list.some(u => !stunnedNow.has(u.id))) continue; // 전원 행동불능 → 전투 없음

      // 동맹 연합 구성 (union-find)
      const ids = [...groups.keys()];
      const parent = new Map(ids.map(id => [id, id]));
      const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          if (this.isAllied(ids[i], ids[j])) parent.set(find(ids[i]), find(ids[j]));

      const coalitions = new Map(); // root -> { civIds, units, mil, count }
      for (const id of ids) {
        const r = find(id);
        if (!coalitions.has(r)) coalitions.set(r, { civIds: [], units: [], mil: 0, count: 0 });
        const c = coalitions.get(r);
        c.civIds.push(id);
        c.units.push(...groups.get(id));
        c.mil = Math.max(c.mil, this.civs.get(id).tech.military || 0);
        c.count += groups.get(id).length;
      }
      if (coalitions.size < 2) continue; // 전원 동맹 → 전투 없음

      const entries = [...coalitions.values()];
      for (const e of entries) {
        const maxOther = Math.max(...entries.filter(o => o !== e).map(o => o.count));
        e.power = e.mil + (e.count >= 2 * maxOther ? 1 : 0);
      }
      const maxP = Math.max(...entries.map(e => e.power));
      const winners = entries.filter(e => e.power === maxP);
      const losers = entries.filter(e => e.power < maxP);
      const stunTurns = winners.length >= 2 ? 2 : 1;

      for (const w of winners) {
        for (const u of w.units) { u.stunned = stunTurns; stuns.push({ unitId: u.id, turns: stunTurns }); }
      }
      const [hx, hy] = k.split(',').map(Number);
      battles.push({
        hex: [hx, hy],
        civs: entries.flatMap(e => e.civIds.map(civId => ({
          civId, power: e.power, count: groups.get(civId).length,
          lost: e.power < maxP ? groups.get(civId).length : 0,
        }))),
      });

      const conquerorId = winners[0].civIds[0];
      for (const l of losers) {
        for (const u of l.units) { deaths.push(u.id); this.killUnit(u.id); }
        for (const civId of l.civIds) {
          const civ = this.civs.get(civId);
          if (civ.alive && this.unitCountOf(civId) === 0) conquests.push(this.conquer(civ, conquerorId));
        }
      }
    }
    return { battles, deaths, stuns, conquests };
  }

  killUnit(unitId) {
    const u = this.units.get(unitId);
    if (!u) return;
    this.units.delete(unitId);
    this.orders.delete(unitId);
    if (u.controller != null) this.delegateUnit(u.controller);
  }

  // 인구 0 → 점령. 예속국은 점령국 유닛 1기를 위임받아 계속 조작
  conquer(civ, conquerorId) {
    civ.alive = false;
    civ.conqueredBy = conquerorId;
    this.spawnOrders.delete(civ.id);
    this.researchOrders.delete(civ.id);
    this.dissolveDiplomacyFor(civ.id);
    for (const v of this.civs.values()) {
      if (v.id !== civ.id && v.conqueredBy === civ.id) {
        v.conqueredBy = conquerorId;
        this.delegateUnit(v.id);
      }
    }
    this.delegateUnit(civ.id);
    return { civId: civ.id, by: conquerorId };
  }

  // 동맹 세력비 8:2 초과 3턴 → 약자 흡수: 유닛은 강자 소속으로 편입, 예속 상태
  absorb(civ, strongId) {
    for (const u of this.units.values()) {
      if (u.civ === civ.id) {
        u.civ = strongId;
        this.orders.delete(u.id);
      }
    }
    civ.alive = false;
    civ.conqueredBy = strongId;
    this.spawnOrders.delete(civ.id);
    this.researchOrders.delete(civ.id);
    this.dissolveDiplomacyFor(civ.id);
    for (const v of this.civs.values()) {
      if (v.id !== civ.id && v.conqueredBy === civ.id) {
        v.conqueredBy = strongId;
        this.delegateUnit(v.id);
      }
    }
    this.delegateUnit(civ.id);
    return { civId: civ.id, by: strongId };
  }

  dissolveDiplomacyFor(civId) {
    const set = this.allies.get(civId);
    if (set) for (const other of [...set]) this.removeAlliance(civId, other);
    this.allyProposals.delete(civId);
    for (const s of this.allyProposals.values()) s.delete(civId);
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
    if (this.ended) return null;
    const alive = [...this.civs.values()].filter(c => c.alive);
    const scores = this.scoresPublic();
    if (this.civs.size >= 2 && alive.length === 1) {
      return { reason: 'domination', winners: [alive[0].id], scores };
    }
    if (this.turn >= TURN_LIMIT) {
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

  // ── 명령 (회의 턴에만)
  moveOrder(civId, unitId, target) {
    if (this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const u = this.units.get(unitId);
    if (!u || this.controllerOf(u) !== civId) return { ok: false, reason: 'unit' };
    if (!Array.isArray(target) || target.length !== 2) return { ok: false, reason: 'target' };
    const [tx, ty] = [this.world.wrapX(Math.trunc(target[0])), Math.trunc(target[1])];
    if (ty < 0 || ty >= this.world.h || !this.world.isLand(tx, ty)) return { ok: false, reason: 'target' };
    const path = this.findPath(u.x, u.y, tx, ty);
    if (!path) return { ok: false, reason: 'path' };
    if (path.length === 0) { this.orders.delete(unitId); return { ok: true, path: [] }; }
    this.orders.set(unitId, { path, idx: 0 });
    return { ok: true, path };
  }

  cancelOrder(civId, unitId) {
    const u = this.units.get(unitId);
    if (!u || this.controllerOf(u) !== civId) return false;
    return this.orders.delete(unitId);
  }

  spawnOrder(civId, hex) {
    if (this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    if (!Array.isArray(hex) || hex.length !== 2) return { ok: false, reason: 'target' };
    const [x, y] = [this.world.wrapX(Math.trunc(hex[0])), Math.trunc(hex[1])];
    if (y < 0 || y >= this.world.h || !this.world.isLand(x, y)) return { ok: false, reason: 'target' };
    if (this.unitCountOf(civId) >= UNIT_CAP) return { ok: false, reason: 'cap' };
    let hasUnit = false;
    for (const u of this.units.values()) if (u.civ === civId && u.x === x && u.y === y) { hasUnit = true; break; }
    if (!hasUnit) return { ok: false, reason: 'nounit' };
    this.spawnOrders.set(civId, [x, y]);
    return { ok: true };
  }

  researchOrder(civId, branch) {
    if (this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const civ = this.civs.get(civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'dead' };
    if (!(branch in TECH_RES)) return { ok: false, reason: 'branch' };
    if (civ.tech[branch] >= TECH_MAX) return { ok: false, reason: 'max' };
    this.researchOrders.set(civId, branch);
    return { ok: true, branch, cost: techCost(civ.tech[branch] + 1), res: TECH_RES[branch] };
  }

  // ── 외교
  proposeAlly(fromId, toId) {
    if (this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const a = this.civs.get(fromId), b = this.civs.get(toId);
    if (!a || !b || fromId === toId) return { ok: false, reason: 'civ' };
    if (!a.alive || !b.alive) return { ok: false, reason: 'dead' };
    if (this.isAllied(fromId, toId)) return { ok: false, reason: 'already' };
    // 상호 제안 → 즉시 성립
    if (this.allyProposals.get(fromId)?.has(toId)) return this.acceptAlly(fromId, toId);
    if (!this.allyProposals.has(toId)) this.allyProposals.set(toId, new Set());
    this.allyProposals.get(toId).add(fromId);
    return { ok: true, pending: true };
  }

  acceptAlly(whoId, fromId) {
    if (this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const a = this.civs.get(whoId), b = this.civs.get(fromId);
    if (!a || !b || !a.alive || !b.alive) return { ok: false, reason: 'dead' };
    if (!this.allyProposals.get(whoId)?.has(fromId)) return { ok: false, reason: 'noproposal' };
    this.allyProposals.get(whoId).delete(fromId);
    this.allyProposals.get(fromId)?.delete(whoId);
    if (!this.allies.has(whoId)) this.allies.set(whoId, new Set());
    if (!this.allies.has(fromId)) this.allies.set(fromId, new Set());
    this.allies.get(whoId).add(fromId);
    this.allies.get(fromId).add(whoId);
    return { ok: true, formed: [whoId, fromId] };
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

  // 육지 위 BFS 최단 경로 (시작 제외, 목표 포함)
  findPath(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    const key = (x, y) => x + ',' + y;
    const prev = new Map([[key(sx, sy), null]]);
    let frontier = [[sx, sy]];
    while (frontier.length) {
      const next = [];
      for (const [cx, cy] of frontier) {
        for (const [nx, ny] of this.world.neighbors(cx, cy)) {
          if (!this.world.isLand(nx, ny)) continue;
          const k = key(nx, ny);
          if (prev.has(k)) continue;
          prev.set(k, [cx, cy]);
          if (nx === tx && ny === ty) {
            const path = [[nx, ny]];
            let cur = [cx, cy];
            while (cur) { path.push(cur); cur = prev.get(key(cur[0], cur[1])); }
            path.pop();
            return path.reverse();
          }
          next.push([nx, ny]);
        }
      }
      frontier = next;
    }
    return null;
  }

  // ── 접속/재접속
  join(token, playerName) {
    if (token && this.tokens.has(token)) {
      const civ = this.civs.get(this.tokens.get(token));
      civ.connected = true;
      return { civ, isNew: false };
    }
    if (this.civs.size >= MAX_PLAYERS || this.pool.length === 0) return { spectator: true };

    const country = countries[this.pool.pop()];
    const id = this.nextCivId++;
    const newToken = crypto.randomBytes(16).toString('hex');
    const [cx, cy] = this.world.lonlatToHex(country.cap[0], country.cap[1]);
    const spawn = this.world.nearestLand(cx, cy) || [cx, cy];

    const civ = {
      id,
      token: newToken,
      code: country.code,
      name: country.ko,
      en: country.en,
      player: String(playerName || '').slice(0, 20) || '플레이어',
      color: `hsl(${(id * 137) % 360} 70% 55%)`,
      capital: spawn,
      connected: true,
      resources: { meat: 0, grain: 0, wood: 0, iron: 0 },
      tech: { military: 0, gather: 0, move: 0, growth: 0 },
      alive: true,
      conqueredBy: null,
    };
    this.civs.set(id, civ);
    this.tokens.set(newToken, id);

    for (let i = 0; i < START_UNITS; i++) {
      const uid = this.nextUnitId++;
      this.units.set(uid, { id: uid, civ: id, x: spawn[0], y: spawn[1], stunned: 0 });
    }
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
      alliances: this.alliancesPublic(),
      phase: this.phase, turn: this.turn, endsAt: this.phaseEnds,
      turnLimit: TURN_LIMIT, ended: this.ended,
    };
  }
}

module.exports = { Game, MAX_PLAYERS, PHASE_MS, UNIT_CAP, SPAWN_COST_BASE, TECH_MAX, TURN_LIMIT };
