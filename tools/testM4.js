// M4 검증: 연구·동맹·연합 전투·흡수(8:2, 3턴)·승리 조건
const { World } = require('../server/world');
const { Game } = require('../server/game');

const world = new World();
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

const isolated = [];
for (let y = 2; y < world.h - 2 && isolated.length < 60; y += 3)
  for (let x = 0; x < world.w && isolated.length < 60; x += 8)
    if (world.isLand(x, y)) isolated.push([x, y]);

function newGame(n) {
  const game = new Game(world, () => {});
  const civs = [];
  for (let i = 0; i < n; i++) civs.push(game.join(undefined, 'P' + (i + 1)).civ);
  game.startGame();
  clearTimeout(game.timer);
  let i = 0;
  for (const u of game.units.values()) { [u.x, u.y] = isolated[i++]; }
  return { game, civs };
}
const unitsOf = (g, id) => [...g.units.values()].filter(u => u.civ === id);

// ── 1. 연구
{
  const { game, civs } = newGame(1);
  const A = game.civs.get(civs[0].id);
  A.resources.iron = 10;
  const r0 = game.researchOrder(A.id, 'military');
  check(r0.ok && r0.cost === 10, `연구 예약 (비용 ${r0.cost})`);
  const r = game.resolveExecution();
  check(A.tech.military === 1 && A.resources.iron === 0, '군사 Lv1 완료, 철 차감');
  check(r.techUpdates.some(t => t.civId === A.id && t.level === 1), '연구 완료 브로드캐스트');

  A.resources.iron = 15;
  game.researchOrder(A.id, 'military');
  const r2 = game.resolveExecution();
  check(r2.researchFails.some(f => f.civId === A.id && f.reason === 'cost'), 'Lv2 비용(20) 부족 실패');
  check(A.tech.military === 1 && A.resources.iron === 15, '실패 시 자원 보존');

  A.tech.gather = 5;
  check(game.researchOrder(A.id, 'gather').reason === 'max', '최고 레벨 연구 거부');
}

// ── 2. 동맹
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  const p = game.proposeAlly(A.id, B.id);
  check(p.ok && p.pending, '동맹 제안');
  check(game.acceptAlly(B.id, A.id).ok && game.isAllied(A.id, B.id), '수락 → 동맹 성립');
  game.proposeAlly(A.id, C.id);
  const mutual = game.proposeAlly(C.id, A.id);
  check(mutual.ok && mutual.formed && game.isAllied(A.id, C.id), '상호 제안 → 즉시 성립');
  game.leaveAlly(A.id, C.id);
  game.resolveExecution();
  check(!game.isAllied(A.id, C.id), '파기 선언 → 실행 턴에 해체');

  const hex = isolated[30];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  check(r.battles.length === 0 && ua.stunned === 0, '동맹끼리 전투 없음');
}

// ── 3. 연합 전투
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  const hex = isolated[31];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0], uc = unitsOf(game, C.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex; [uc.x, uc.y] = hex;
  const r = game.resolveExecution();
  check(!game.units.has(uc.id) && game.units.has(ua.id) && game.units.has(ub.id), '연합(2기) vs 단독(1기): 연합 승리');
  check(r.battles.length === 1, '전투 1건 기록');
}

// ── 4. 흡수
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  game.civs.get(A.id).tech.military = 3;
  game.civs.get(A.id).tech.gather = 3;
  const bUnits = unitsOf(game, B.id);
  game.units.delete(bUnits[1].id);
  game.units.delete(bUnits[2].id);
  // A: 3+6=9, B: 1 → 0.9 > 0.8
  const r1 = game.resolveExecution();
  check(r1.absorptions.length === 0 && game.civs.get(B.id).alive, '흡수 1턴차: 유예');
  const r2 = game.resolveExecution();
  check(r2.absorptions.length === 0, '흡수 2턴차: 유예');
  const r3 = game.resolveExecution();
  check(r3.absorptions.length === 1 && r3.absorptions[0].civId === B.id, '3턴 연속 → 흡수');
  const bCiv = game.civs.get(B.id);
  check(!bCiv.alive && bCiv.conqueredBy === A.id, '흡수국은 예속 상태');
  check(unitsOf(game, B.id).length === 0, '유닛은 강자 소속으로 편입');
  check([...game.units.values()].some(u => u.controller === B.id), '위임 유닛 부여');
  check(!game.isAllied(A.id, B.id), '흡수 후 동맹 해제');
}

// ── 5. 흡수 카운터 리셋
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  game.civs.get(A.id).tech.military = 5; // A 8, B 3 → 0.727 (안전)
  game.resolveExecution();
  check((game.absorbCounters.get('1:2') || 0) === 0, '비율 이하 → 카운터 없음');
  game.civs.get(A.id).tech.gather = 5;   // A 13, B 3 → 0.8125
  game.resolveExecution();
  check((game.absorbCounters.get('1:2') || 0) === 1, '초과 1턴 → 카운터 1');
  game.civs.get(A.id).tech.gather = 0;
  game.resolveExecution();
  check((game.absorbCounters.get('1:2') || 0) === 0, '이하로 복귀 → 카운터 리셋');
  check(game.civs.get(B.id).alive, 'B 생존');
}

// ── 6. 제패 승리
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.civs.get(A.id).tech.military = 2;
  const hex = isolated[35];
  for (const u of unitsOf(game, B.id)) { [u.x, u.y] = hex; }
  const ua = unitsOf(game, A.id)[0];
  [ua.x, ua.y] = hex;
  const r = game.resolveExecution();
  check(!!r.gameover && r.gameover.reason === 'domination', '제패 승리 판정');
  check(r.gameover.winners.length === 1 && r.gameover.winners[0] === A.id, '승자 = 정복 문명');
  check(game.ended === true && game.state === 'ENDED', '게임 종료 상태');
  check(game.moveOrder(A.id, ua.id, [ua.x, ua.y]).reason === 'phase', '종료 후 명령 거부');
}

// ── 7. 점수 승리 (턴 제한, 동맹 공동 승리)
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  game.civs.get(A.id).tech.military = 3; // A 6, B 3, C 3 — 흡수 안 됨(0.67)
  game.turn = game.settings.turnLimit;
  const r = game.resolveExecution();
  check(!!r.gameover && r.gameover.reason === 'score', `점수 승리 판정 (${game.settings.turnLimit}턴)`);
  check(r.gameover.winners.includes(A.id), '최고 점수 승자');
  check(r.gameover.winners.includes(B.id), '동맹 공동 승리');
  check(!r.gameover.winners.includes(C.id), '비동맹 제외');
}

console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
