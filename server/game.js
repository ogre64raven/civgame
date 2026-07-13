// 게임 상태 v2 — 영토전: 유닛 고정 3기(불사), 이동 경로 영토화, 영토 자동 채취,
// 전투 패자 수도 후퇴, 수도 함락 = 점령(예속), 동맹/흡수, 승리
const crypto = require('crypto');
const countries = require('../data/countries.json');

const MAX_PLAYERS = 30;
const START_UNITS = 3;                  // 문명당 유닛 수 (고정, 생성/소멸 없음)
const TECH_MAX = 5;
const TECH_RES = { military: 'iron', defense: 'meat', gather: 'wood', move: 'grain' };
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
    this.territory = new Map();         // 'x,y' -> civId
    this.territoryByCiv = new Map();    // civId -> Set('x,y')
    this.allies = new Map();
    this.allyProposals = new Map();
    this.allyConsents = new Map();      // 'a:b' -> { a, b, approver } (제3국 동의 대기)
    this.leaveOrders = [];
    this.absorbCounters = new Map();
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
    for (const v of this.civs.values()) if (v.conqueredBy === civId) v.conqueredBy = null;
    this.researchOrders.delete(civId);
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
  }

  controllerOf(u) { return u.controller != null ? u.controller : u.civ; }
  isAllied(a, b) { const s = this.allies.get(a); return !!s && s.has(b); }
  tileCountOf(civId) { return this.territoryByCiv.get(civId)?.size || 0; }
  score(civ) {
    const t = civ.tech;
    return (t.military + t.defense + t.gather + t.move) + this.tileCountOf(civ.id);
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

  // 유닛이 밟은 헥스 점령 (동맹 영토는 존중)
  claim(x, y, civId) {
    if (!this.world.isLand(x, y)) return;
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

    // ① 이동 + 경로 영토화
    const moves = [];
    for (const [unitId, order] of this.orders) {
      const u = this.units.get(unitId);
      if (!u) { this.orders.delete(unitId); continue; }
      if (stunnedNow.has(unitId)) continue;
      const civ = this.civs.get(u.civ);
      // 이동력: 기본 2 (+이동 기술 3Lv마다 1). 육지 1, 바다 2 소모 → 바다는 턴당 1칸
      let budget = 2 + Math.floor((civ.tech.move || 0) / 3);
      while (order.idx < order.path.length) {
        const [nx, ny] = order.path[order.idx];
        const cost = this.world.isLand(nx, ny) ? 1 : 2;
        if (cost > budget) break;
        budget -= cost;
        order.idx++;
        u.x = nx; u.y = ny;
        this.claim(nx, ny, u.civ); // 바다는 claim에서 무시됨
      }
      moves.push({ unitId, x: u.x, y: u.y });
      if (order.idx >= order.path.length) this.orders.delete(unitId);
    }

    // ② 전투 (사망 없음 — 패자는 수도 후퇴 + 2턴 행동불능)
    const { battles, stuns, retreats } = this.resolveBattles(stunnedNow);
    for (const r of retreats) moves.push(r);

    // ③ 수도 함락 → 점령(예속)
    const conquests = [];
    for (const civ of this.civs.values()) {
      if (!civ.alive) continue;
      const owner = this.territory.get(civ.capital[0] + ',' + civ.capital[1]);
      if (owner != null && owner !== civ.id) {
        const ownerCiv = this.civs.get(owner);
        if (ownerCiv && ownerCiv.alive && !this.isAllied(owner, civ.id)) {
          conquests.push(this.subjugate(civ, owner));
        }
      }
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
      techUpdates.push({ civId, branch, level: lvl + 1 });
    }
    this.researchOrders.clear();

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
      moves, battles, stuns, captures, conquests, delegations: this._delegations,
      gains, techUpdates, researchFails, allyLeft, absorptions, gameover,
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
          u.stunned = 2;
          stuns.push({ unitId: u.id, turns: 2 });
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
    const RES = ['meat', 'grain', 'wood', 'iron'];
    const income = new Map(); // civId -> {res} (자체 채집 기술 적용)
    for (const civ of this.civs.values()) {
      if (!civ.alive) continue;
      const tiles = this.territoryByCiv.get(civ.id);
      if (!tiles || tiles.size === 0) continue;
      const count = { meat: 0, grain: 0, wood: 0, iron: 0 };
      for (const k of tiles) {
        const [x, y] = k.split(',').map(Number);
        const res = this.world.resourceAt(x, y);
        if (res) count[res]++;
      }
      const mult = 1 + 0.2 * (civ.tech.gather || 0);
      const g = { meat: 0, grain: 0, wood: 0, iron: 0 };
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
      const pool = { meat: 0, grain: 0, wood: 0, iron: 0 };
      for (const id of members) {
        const g = income.get(id);
        if (g) for (const res of RES) pool[res] += g[res];
      }
      const tilesOf = members.map(id => this.tileCountOf(id));
      const totalTiles = tilesOf.reduce((a, b) => a + b, 0);
      if (totalTiles === 0) continue;
      const out = members.map(() => ({ meat: 0, grain: 0, wood: 0, iron: 0 }));
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
    this.researchOrders.delete(civ.id);
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
  moveOrder(civId, unitId, target) {
    if (this.state !== 'RUNNING' || this.phase !== 'MEETING') return { ok: false, reason: 'phase' };
    const u = this.units.get(unitId);
    if (!u || this.controllerOf(u) !== civId) return { ok: false, reason: 'unit' };
    if (!Array.isArray(target) || target.length !== 2) return { ok: false, reason: 'target' };
    const [tx, ty] = [this.world.wrapX(Math.trunc(target[0])), Math.trunc(target[1])];
    if (ty < 0 || ty >= this.world.h) return { ok: false, reason: 'target' };
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

  // 다익스트라 최단 경로 (이동력 비용: 육지 1, 바다 2). 시작 제외, 목표 포함.
  findPath(sx, sy, tx, ty) {
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
          const cost = this.world.isLand(nx, ny) ? 1 : 2;
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

  // ── 접속/재접속
  join(token, playerName) {
    if (token && this.tokens.has(token)) {
      const civ = this.civs.get(this.tokens.get(token));
      civ.connected = true;
      return { civ, isNew: false };
    }
    if (this.state === 'ENDED') return { spectator: true };
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
      tech: { military: 0, defense: 0, gather: 0, move: 0 },
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
      alliances: this.alliancesPublic(),
      state: this.state,
      phase: this.phase, turn: this.turn, endsAt: this.phaseEnds,
      turnLimit: this.settings.turnLimit, ended: this.ended,
    };
  }
}

module.exports = { Game, MAX_PLAYERS, START_UNITS, TECH_MAX, MIN_LANDMASS };
