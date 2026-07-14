// 봇 AI — 회의 턴마다 실행: 연구·회복·생산·요새·이동·외교
// 전략: 가장 낮은 기술부터 연구(패배 누적은 군사 연구로 자동 리셋),
//       오래 묶인 유닛은 곡식으로 회복, 여유 자원이면 국경에 요새,
//       주변 비소유 타일로 확장(보물 우선, 중립 유닛·적 장성 회피),
//       군사 우위일 때만 적 수도 공성, 동맹 제안은 수락·동의 요청은 승인.
const TECH_RES = { military: 'iron', defense: 'grain', gather: 'wood', move: 'stone' };
const BRANCHES = ['military', 'defense', 'gather', 'move'];
const techCost = (targetLevel) => 20 * targetLevel;

function runBots(game) {
  if (game.state !== 'RUNNING' || game.phase !== 'MEETING') return { formed: [] };
  const events = { formed: [] };
  for (const civ of game.civs.values()) {
    if (!civ.isBot || !civ.alive) continue;
    try {
      botResearch(game, civ);
      botRally(game, civ);
      if (game.unitCountOf(civ.id) < game.maxUnits(civ) &&
          civ.resources.stone >= 10 && civ.resources.grain >= 10) {
        game.spawnOrder(civ.id);
      }
      botFort(game, civ);
      botMoves(game, civ);
      botDiplomacy(game, civ, events);
    } catch (e) {
      console.error('봇 오류:', civ.name, e.message);
    }
  }
  return events;
}

function botResearch(game, civ) {
  let best = null;
  for (const br of BRANCHES) {
    const lvl = civ.tech[br];
    if (lvl >= 5) continue;
    if (civ.resources[TECH_RES[br]] < techCost(lvl + 1)) continue;
    if (best === null || lvl < civ.tech[best]) best = br;
  }
  if (best) game.researchOrder(civ.id, best);
}

// 오래 묶였거나 패배가 누적된 유닛은 곡식으로 회복 (버퍼 30 유지)
function botRally(game, civ) {
  for (const u of game.units.values()) {
    if (civ.resources.grain < 30) return;
    if (u.civ !== civ.id || u.controller != null) continue;
    if (u.stunned >= 3 || (u.fatigue || 0) >= 2) game.rallyOrder(civ.id, u.id);
  }
}

// 자원이 넉넉하면 국경(비소유 이웃이 있는 자기 영토)에 요새 — 턴당 1개
function botFort(game, civ) {
  if (civ.resources.stone < 30 || civ.resources.wood < 30) return;
  for (const u of game.units.values()) {
    if (u.civ !== civ.id || u.controller != null || u.stunned > 0) continue;
    const k = u.x + ',' + u.y;
    if (game.territory.get(k) !== civ.id || game.forts.has(k)) continue;
    const border = game.world.neighbors(u.x, u.y).some(([x, y]) =>
      game.world.isLand(x, y) && game.territory.get(x + ',' + y) !== civ.id);
    if (!border) continue;
    if (game.fortOrder(civ.id, u.id).ok) return;
  }
}

function botMoves(game, civ) {
  for (const u of game.units.values()) {
    if (u.civ !== civ.id || u.controller != null || u.stunned > 0) continue;
    if (game.orders.has(u.id)) continue; // 기존 경로 진행 중
    const target = findTarget(game, civ, u);
    if (target) game.moveOrder(civ.id, u.id, target);
  }
}

// 유닛 주변 BFS(8링): 가장 가까운 비소유 육지 타일.
// 보물 우선. 중립 유닛은 군사 0이면 회피, 적 장성은 우회, 적 수도는 군사 우위일 때만.
function findTarget(game, civ, u) {
  const world = game.world;
  const mil = civ.tech.military || 0;
  const seen = new Set([u.x + ',' + u.y]);
  let frontier = [[u.x, u.y]];
  const candidates = [];
  for (let d = 0; d < 8 && candidates.length === 0; d++) {
    const next = [];
    for (const [cx, cy] of frontier) {
      for (const [nx, ny] of world.neighbors(cx, cy)) {
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([nx, ny]);
        if (!world.isLand(nx, ny)) continue;
        const fort = game.forts.get(k);
        if (fort && fort.civ !== civ.id && !game.isAllied(fort.civ, civ.id)) continue; // 적 장성
        if (mil < 1) { // 군사 0이면 중립 유닛과 비겨서 묶임 → 회피
          let neutral = false;
          for (const n of game.neutrals.values()) if (n.x === nx && n.y === ny) { neutral = true; break; }
          if (neutral) continue;
        }
        if (game.treasures && game.treasures.has(k)) return [nx, ny]; // 보물 우선
        const owner = game.territory.get(k);
        if (owner === civ.id) continue;
        if (owner != null && game.isAllied(owner, civ.id)) continue;
        const capOwner = [...game.civs.values()].find(
          c => c.alive && c.capital[0] === nx && c.capital[1] === ny);
        if (capOwner) {
          if (capOwner.id === civ.id) continue;
          // 군사 우위가 아니면 수도 공성 회피
          if (mil < (capOwner.tech.military || 0) + 1) continue;
        }
        candidates.push([nx, ny]);
      }
    }
    frontier = next;
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// 동맹 제안 수락 + 제3국 동의 요청 승인 (성립 쌍은 이벤트로 반환 → 서버가 브로드캐스트)
function botDiplomacy(game, civ, events) {
  const props = game.allyProposals.get(civ.id);
  if (props && props.size) {
    for (const fromId of [...props]) {
      const r = game.acceptAlly(civ.id, fromId);
      if (r.ok && r.formed) { events.formed.push(r.formed); break; }
    }
  }
  for (const [, req] of [...game.allyConsents]) {
    if (req.approver !== civ.id) continue;
    const r = game.consentAlly(civ.id, [req.a, req.b], true);
    if (r.ok && r.formed) events.formed.push(r.formed);
  }
}

module.exports = { runBots };
