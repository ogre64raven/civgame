// 봇 AI — 회의 턴마다 실행: 연구 예약 + 유닛 이동 명령
// 전략: 자원이 되면 가장 낮은 기술부터 연구, 유닛은 주변의 비소유 타일로 확장,
//       군사 우위일 때만 적 수도를 노린다.
const TECH_RES = { military: 'iron', defense: 'meat', gather: 'wood', move: 'grain' };
const BRANCHES = ['military', 'defense', 'gather', 'move'];
const techCost = (targetLevel) => 20 * targetLevel;

function runBots(game) {
  if (game.state !== 'RUNNING' || game.phase !== 'MEETING') return;
  for (const civ of game.civs.values()) {
    if (!civ.isBot || !civ.alive) continue;
    try {
      botResearch(game, civ);
      botMoves(game, civ);
    } catch (e) {
      console.error('봇 오류:', civ.name, e.message);
    }
  }
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

function botMoves(game, civ) {
  for (const u of game.units.values()) {
    if (u.civ !== civ.id || u.controller != null || u.stunned > 0) continue;
    if (game.orders.has(u.id)) continue; // 기존 경로 진행 중
    const target = findTarget(game, civ, u);
    if (target) game.moveOrder(civ.id, u.id, target);
  }
}

// 유닛 주변 BFS(8링): 가장 가까운 비소유 육지 타일. 적 수도는 군사 우위일 때만.
function findTarget(game, civ, u) {
  const world = game.world;
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
        const owner = game.territory.get(k);
        if (owner === civ.id) continue;
        if (owner != null && game.isAllied(owner, civ.id)) continue;
        const capOwner = [...game.civs.values()].find(
          c => c.alive && c.capital[0] === nx && c.capital[1] === ny);
        if (capOwner) {
          if (capOwner.id === civ.id) continue;
          // 군사 우위가 아니면 수도 공성 회피
          if ((civ.tech.military || 0) < (capOwner.tech.military || 0) + 1) continue;
        }
        candidates.push([nx, ny]);
      }
    }
    frontier = next;
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { runBots };
