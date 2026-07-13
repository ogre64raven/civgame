// M3 검증: 전투(동률/수 우위/기술 우위)·점령/위임·생산/상한/비용·스턴 회복
// Game 클래스를 직접 구동하는 유닛 테스트 (서버/타이머 불필요)
const { World } = require('../server/world');
const { Game, UNIT_CAP } = require('../server/game');

const world = new World();
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

// 서로 멀리 떨어진 육지 헥스 목록
const isolated = [];
for (let y = 2; y < world.h - 2 && isolated.length < 40; y += 3)
  for (let x = 0; x < world.w && isolated.length < 40; x += 8)
    if (world.isLand(x, y)) isolated.push([x, y]);

function newGame(n) {
  const game = new Game(world, () => {});
  clearTimeout(game.timer);
  const civs = [];
  for (let i = 0; i < n; i++) civs.push(game.join(undefined, 'P' + (i + 1)).civ);
  // 모든 유닛을 격리 헥스에 분산 배치
  let i = 0;
  for (const u of game.units.values()) { [u.x, u.y] = isolated[i++]; }
  return { game, civs };
}
const unitsOf = (g, id) => [...g.units.values()].filter(u => u.civ === id);

// ── 1. 기술력 동률 → 양측 2턴 행동불능, 소멸 없음
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  const hex = isolated[20];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  check(r.deaths.length === 0 && r.battles.length === 1, '동률 전투: 사망 없음');
  check(ua.stunned === 2 && ub.stunned === 2, '동률 전투: 양측 2턴 행동불능');

  // 스턴 중 이동 불가 → 2턴 후 회복
  game.moveOrder(A.id, ua.id, [world.neighbors(hex[0], hex[1]).find(([x, y]) => world.isLand(x, y)) || hex].flat().slice(0, 2));
  const r2 = game.resolveExecution();
  check(!r2.moves.some(m => m.unitId === ua.id), '스턴 1턴차: 이동 불가');
  const r3 = game.resolveExecution();
  check(!r3.moves.some(m => m.unitId === ua.id), '스턴 2턴차: 이동 불가');
  // 3턴차: B 유닛을 치워서 순수 이동 확인
  [ub.x, ub.y] = isolated[21];
  const r4 = game.resolveExecution();
  check(r4.moves.some(m => m.unitId === ua.id), '스턴 해제 후 이동 재개');
}

// ── 2. 수 우위 (2배 이상 +1) → 소수 측 전멸, 승자 1턴 행동불능
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  const hex = isolated[22];
  const [a1, a2] = unitsOf(game, A.id);
  const [b1] = unitsOf(game, B.id);
  [a1.x, a1.y] = hex; [a2.x, a2.y] = hex; [b1.x, b1.y] = hex;
  const r = game.resolveExecution();
  check(r.deaths.includes(b1.id) && !game.units.has(b1.id), '수 우위: 소수 유닛 소멸');
  check(a1.stunned === 1 && a2.stunned === 1, '수 우위: 승자 1턴 행동불능');
  check(game.civs.get(B.id).alive === true, '유닛 남은 문명은 생존');
}

// ── 3. 기술 우위 + 점령 + 위임 (3인: 점령해도 게임이 끝나지 않도록)
{
  const { game, civs } = newGame(3);
  const [A, B] = civs; // C는 격리 상태로 생존만
  game.civs.get(A.id).tech.military = 2; // B는 3기(수 우위 +1)이므로 2 이상이어야 단독 승리
  const hex = isolated[23];
  const aUnits = unitsOf(game, A.id);
  for (const u of unitsOf(game, B.id)) { [u.x, u.y] = hex; }
  [aUnits[0].x, aUnits[0].y] = hex;
  const r = game.resolveExecution();
  check(unitsOf(game, B.id).length === 0, '기술 우위: 상대 전멸');
  const bCiv = game.civs.get(B.id);
  check(bCiv.alive === false && bCiv.conqueredBy === A.id, '인구 0 → 점령');
  check(!r.gameover, '3인 게임: 점령해도 계속 진행');
  const delegated = [...game.units.values()].find(u => u.controller === B.id);
  check(!!delegated && delegated.civ === A.id, '점령국 유닛 1기 위임');
  check(r.conquests.length === 1 && r.delegations.length === 1, '점령·위임 브로드캐스트 데이터');

  // 위임 유닛 명령 권한
  const nb = world.neighbors(delegated.x, delegated.y).find(([x, y]) => world.isLand(x, y));
  if (nb) {
    check(game.moveOrder(B.id, delegated.id, nb).ok === true, '예속국: 위임 유닛 이동 가능');
  }
  const otherA = [...game.units.values()].find(u => u.civ === A.id && u.controller == null);
  check(game.moveOrder(B.id, otherA.id, [otherA.x, otherA.y]).ok === false, '예속국: 다른 유닛 명령 불가');
  check(game.spawnOrder(B.id, [delegated.x, delegated.y]).reason === 'dead', '예속국: 생산 불가');

  // 위임 유닛 사망 → 재위임
  game._delegations = [];
  game.killUnit(delegated.id);
  const re = [...game.units.values()].find(u => u.controller === B.id);
  check(!!re && re.id !== delegated.id, '위임 유닛 사망 시 재위임');
}

// ── 4. 생산 성공
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const civ = game.civs.get(A.id);
  civ.resources.meat = 5; civ.resources.grain = 5;
  const u = unitsOf(game, A.id)[0];
  const so = game.spawnOrder(A.id, [u.x, u.y]);
  check(so.ok === true, '생산 예약 접수');
  const r = game.resolveExecution();
  check(r.births.length === 1 && unitsOf(game, A.id).length === 4, '실행 턴에 유닛 생산');
  check(r.births[0].x === u.x && r.births[0].y === u.y, '생산 위치 = 예약 헥스');
}

// ── 5. 인구 상한
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  for (let i = 0; i < UNIT_CAP - 3; i++) {
    const uid = game.nextUnitId++;
    game.units.set(uid, { id: uid, civ: A.id, x: u.x, y: u.y, stunned: 0 });
  }
  check(game.spawnOrder(A.id, [u.x, u.y]).reason === 'cap', `상한 ${UNIT_CAP}기에서 생산 거부`);
}

// ── 6. 자원 부족 → 실행 시 실패 통지
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  check(game.spawnOrder(A.id, [u.x, u.y]).ok === true, '자원 없어도 예약은 가능');
  const r = game.resolveExecution();
  check(r.spawnFails.some(f => f.civId === A.id && f.reason === 'cost'), '실행 시 자원 부족 실패');
  check(unitsOf(game, A.id).length === 3, '유닛 수 불변');
}

// ── 7. 유닛 없는 헥스 생산 거부
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const empty = isolated.find(([x, y]) => ![...game.units.values()].some(u => u.x === x && u.y === y));
  check(game.spawnOrder(A.id, empty).reason === 'nounit', '내 유닛 없는 헥스 생산 거부');
}

// ── 8. 3세력 전투: 최강 단독 생존
{
  const { game, civs } = newGame(3);
  const [A, B, C] = civs;
  game.civs.get(A.id).tech.military = 2;
  const hex = isolated[25];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0], uc = unitsOf(game, C.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex; [uc.x, uc.y] = hex;
  const r = game.resolveExecution();
  check(!game.units.has(ub.id) && !game.units.has(uc.id) && game.units.has(ua.id), '3세력: 최강만 생존');
  check(ua.stunned === 1, '3세력: 승자 1턴 행동불능');
}

console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
