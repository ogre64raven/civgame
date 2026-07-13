// v2 검증: 연구(4계통)·동맹·연합 전투·흡수(점수=기술+영토)·승리 조건
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

// ── 1. 연구 (비용 20×레벨)
{
  const { game, civs } = newGame(1);
  const A = game.civs.get(civs[0].id);
  A.resources.iron = 20;
  const r0 = game.researchOrder(A.id, 'military');
  check(r0.ok && r0.cost === 20 && r0.res === 'iron', `군사 연구 예약 (철 ${r0.cost})`);
  game.resolveExecution();
  check(A.tech.military === 1, '군사 Lv1 완료');

  A.resources.meat = 20;
  const rd = game.researchOrder(A.id, 'defense');
  check(rd.ok && rd.res === 'meat', '방어 연구는 고기 소모');
  game.resolveExecution();
  check(A.tech.defense === 1, '방어 Lv1 완료');

  A.resources.iron = 30;
  game.researchOrder(A.id, 'military');
  const r2 = game.resolveExecution();
  check(r2.researchFails.some(f => f.reason === 'cost'), 'Lv2 비용(40) 부족 실패');
  A.tech.gather = 5;
  check(game.researchOrder(A.id, 'gather').reason === 'max', '최고 레벨 거부');
}

// ── 2. 동맹 성립/파기
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  const p = game.proposeAlly(A.id, B.id);
  check(p.ok && p.pending, '동맹 제안');
  check(game.acceptAlly(B.id, A.id).ok && game.isAllied(A.id, B.id), '수락 → 성립');
  game.proposeAlly(A.id, C.id);
  const mutual = game.proposeAlly(C.id, A.id);
  check(mutual.ok && mutual.consentNeeded === B.id, '상호 제안 → 기존 동맹국 동의 대기');
  game.consentAlly(B.id, mutual.pair, true);
  check(game.isAllied(A.id, C.id), '동의 후 성립');
  game.leaveAlly(A.id, C.id);
  game.resolveExecution();
  check(!game.isAllied(A.id, C.id), '파기 → 실행 턴에 해체');

  const hex = isolated[30];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  check(r.battles.length === 0 && ua.stunned === 0, '동맹끼리 전투 없음');
}

// ── 3. 연합 전투: 동맹 2기 vs 단독 1기 → 단독 측 후퇴
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  const hex = isolated[31];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0], uc = unitsOf(game, C.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex; [uc.x, uc.y] = hex;
  game.resolveExecution();
  const cCap = game.civs.get(C.id).capital;
  check(uc.x === cCap[0] && uc.y === cCap[1], '연합 승리 → 단독 측 수도 후퇴');
  check(ua.x === hex[0] && ub.x === hex[0], '연합 유닛은 유지');
}

// ── 4. 흡수: 점수(기술+영토) 8:2 초과 3턴
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  // A: 기술 6 + 수도 1타일 = 7, B: 수도 1타일 = 1 → 7/8 = 0.875 > 0.8
  game.civs.get(A.id).tech.military = 3;
  game.civs.get(A.id).tech.gather = 3;
  const r1 = game.resolveExecution();
  check(r1.absorptions.length === 0 && game.civs.get(B.id).alive, '흡수 1턴차: 유예');
  const r2 = game.resolveExecution();
  check(r2.absorptions.length === 0, '흡수 2턴차: 유예');
  const r3 = game.resolveExecution();
  check(r3.absorptions.length === 1 && r3.absorptions[0].civId === B.id, '3턴 연속 → 흡수');
  const bCiv = game.civs.get(B.id);
  check(!bCiv.alive && bCiv.conqueredBy === A.id, '흡수국 예속');
  check(unitsOf(game, B.id).length === 0, '유닛 강자 편입');
  const bCap = bCiv.capital;
  check(game.territory.get(bCap[0] + ',' + bCap[1]) === A.id, '영토 강자 편입');
  check([...game.units.values()].some(u => u.controller === B.id), '위임 유닛 부여');
}

// ── 5. 흡수 카운터 리셋
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  game.civs.get(A.id).tech.military = 3; // A 4, B 1 → 0.8 (초과 아님)
  game.resolveExecution();
  check((game.absorbCounters.get('1:2') || 0) === 0, '비율 이하 → 카운터 없음');
  game.civs.get(A.id).tech.military = 5; // A 6, B 1 → 0.857
  game.resolveExecution();
  check((game.absorbCounters.get('1:2') || 0) === 1, '초과 1턴 → 카운터 1');
  // B 영토 확장으로 비율 회복
  const bId = B.id;
  game.setTile(isolated[33][0] + ',' + isolated[33][1], bId);
  game.setTile(isolated[34][0] + ',' + isolated[34][1], bId);
  game.resolveExecution(); // A 6, B 3 → 0.67
  check((game.absorbCounters.get('1:2') || 0) === 0, '이하로 복귀 → 카운터 리셋');
  check(game.civs.get(B.id).alive, 'B 생존');
}

// ── 6. 제패 승리: 수도 함락으로 마지막 생존
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  const bCap = game.civs.get(B.id).capital;
  game.claim(bCap[0], bCap[1], A.id); // A가 B 수도 점령
  const r = game.resolveExecution();
  check(!!r.gameover && r.gameover.reason === 'domination', '제패 승리 판정');
  check(r.gameover.winners[0] === A.id, '승자 = 점령 문명');
  check(game.state === 'ENDED', '게임 종료 상태');
  const ua = unitsOf(game, A.id)[0];
  check(game.moveOrder(A.id, ua.id, [ua.x, ua.y]).reason === 'phase', '종료 후 명령 거부');
}

// ── 7. 점수 승리: 턴 제한, 동맹 공동 승리
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  game.civs.get(A.id).tech.military = 2; // A 3, B 1 → 0.75 흡수 안전
  game.turn = game.settings.turnLimit;
  const r = game.resolveExecution();
  check(!!r.gameover && r.gameover.reason === 'score', `점수 승리 판정 (${game.settings.turnLimit}턴)`);
  check(r.gameover.winners.includes(A.id), '최고 점수 승자');
  check(r.gameover.winners.includes(B.id), '동맹 공동 승리');
  check(!r.gameover.winners.includes(C.id), '비동맹 제외');
}

// ── 8. 위임 유닛 1~3기 선택
{
  const { game, civs } = newGame(3);
  const [A, B] = civs;
  const bCiv = game.civs.get(B.id);
  game.claim(bCiv.capital[0], bCiv.capital[1], A.id);
  game.resolveExecution(); // 수도 함락 → B 예속, 기본 위임 1기
  const cnt = () => [...game.units.values()].filter(u => u.controller === B.id).length;
  check(!bCiv.alive && cnt() === 1, '점령 직후 기본 위임 1기');
  let r = game.setDelegation(A.id, B.id, 3);
  check(r.ok && r.count === 3 && cnt() === 3, '위임 3기로 확대');
  const du = [...game.units.values()].filter(u => u.controller === B.id)[1];
  const nb2 = world.neighbors(du.x, du.y).find(([x, y]) => world.isLand(x, y));
  if (nb2) check(game.moveOrder(B.id, du.id, nb2).ok === true, '위임 유닛 모두 명령 가능');
  r = game.setDelegation(A.id, B.id, 1);
  check(r.ok && cnt() === 1, '위임 1기로 축소 (초과분 회수)');
  check(game.setDelegation(A.id, B.id, 9).count === 3 && cnt() === 3, '범위 밖 값은 1~3으로 제한');
  check(game.setDelegation(B.id, A.id, 2).ok === false, '예속국은 위임 설정 불가');
}

// ── 9. 동맹 수입 합산 → 영토 수 비율 배분
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  // 영토를 초기화하고 지형을 지정 배치: A = 철2+곡식1 (3타일), B = 철1 (1타일), C = 철1 (비동맹)
  game.territory.clear();
  game.territoryByCiv.clear();
  const used = new Set();
  const findTiles = (t, n) => {
    const out = [];
    for (let y = 0; y < world.h && out.length < n; y++)
      for (let x = 0; x < world.w && out.length < n; x++) {
        const k = x + ',' + y;
        if (world.terrain(x, y) === t && !used.has(k)) { out.push(k); used.add(k); }
      }
    return out;
  };
  for (const k of findTiles('m', 2)) game.setTile(k, A.id);
  for (const k of findTiles('g', 1)) game.setTile(k, A.id);
  for (const k of findTiles('m', 1)) game.setTile(k, B.id);
  for (const k of findTiles('m', 1)) game.setTile(k, C.id);
  const a = game.civs.get(A.id), b = game.civs.get(B.id), c = game.civs.get(C.id);
  a.resources = { meat: 0, grain: 0, wood: 0, iron: 0 };
  b.resources = { meat: 0, grain: 0, wood: 0, iron: 0 };
  c.resources = { meat: 0, grain: 0, wood: 0, iron: 0 };
  const r = game.resolveExecution();
  // 동맹 합산: 철3 + 곡식1 → A(3/4 영토): 철2+곡식1, B(1/4 영토): 철1
  check(a.resources.iron === 2 && a.resources.grain === 1, `A 배분: 철${a.resources.iron} 곡식${a.resources.grain} (영토 3/4)`);
  check(b.resources.iron === 1 && b.resources.grain === 0, `B 배분: 철${b.resources.iron} (영토 1/4)`);
  check(c.resources.iron === 1, '비동맹은 독립 수입');
  check(!!r.gains[A.id] && !!r.gains[B.id], '배분 결과 통지');
  // 총량 보존
  const total = a.resources.iron + b.resources.iron + c.resources.iron;
  check(total === 4, `철 총량 보존 (${total})`);
}

// ── 10. 동맹 최대 3국 + 제3국 동의
{
  const { game, civs } = newGame(4);
  const [A, B, C, D] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id); // A-B 동맹
  // A-C 확장 → B 동의 필요
  game.proposeAlly(A.id, C.id);
  const r = game.acceptAlly(C.id, A.id);
  check(r.ok && r.consentNeeded === B.id, '확장 시 기존 동맹국 동의 필요');
  check(!game.isAllied(A.id, C.id), '동의 전에는 미성립');
  check(game.consentAlly(C.id, r.pair, true).ok === false, '당사자는 동의 불가');
  const c1 = game.consentAlly(B.id, r.pair, true);
  check(c1.ok && !!c1.formed && game.isAllied(A.id, C.id), '동의 → 3국 동맹 성립');
  check(game.groupOf(A.id).size === 3, '동맹 그룹 3국');
  // 4국째는 거부
  check(game.proposeAlly(A.id, D.id).reason === 'full', '동맹 4국 확장 거부');
  check(game.proposeAlly(D.id, C.id).reason === 'full', '외부에서의 4국 확장도 거부');
}

// ── 11. 제3국 거부(비토)
{
  const { game, civs } = newGame(3);
  const [X, Y, Z] = civs;
  game.proposeAlly(X.id, Y.id);
  game.acceptAlly(Y.id, X.id);
  game.proposeAlly(X.id, Z.id);
  const rr = game.acceptAlly(Z.id, X.id);
  const veto = game.consentAlly(Y.id, rr.pair, false);
  check(veto.ok && !!veto.vetoed && !game.isAllied(X.id, Z.id), '거부 → 동맹 불성립');
  check(game.isAllied(X.id, Y.id), '기존 동맹은 유지');
  // 재시도 후 동의 → 성립
  game.proposeAlly(X.id, Z.id);
  const rr2 = game.acceptAlly(Z.id, X.id);
  const ok2 = game.consentAlly(Y.id, rr2.pair, true);
  check(ok2.ok && game.isAllied(X.id, Z.id), '재시도 + 동의 → 성립');
}

console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
