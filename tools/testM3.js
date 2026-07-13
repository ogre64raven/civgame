// v2 검증: 영토화 이동·영토 채취·전투(후퇴/방어)·수도 함락 점령·유닛 불변
const { World } = require('../server/world');
const { Game, START_UNITS } = require('../server/game');

const world = new World();
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

const isolated = [];
for (let y = 2; y < world.h - 2 && isolated.length < 40; y += 3)
  for (let x = 0; x < world.w && isolated.length < 40; x += 8)
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
const key = (h) => h[0] + ',' + h[1];

// ── 1. 이동 경로 영토화
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  // 2칸 경로 목표
  let target = null, mid = null;
  outer:
  for (const n1 of world.neighbors(u.x, u.y)) {
    if (!world.isLand(n1[0], n1[1])) continue;
    for (const n2 of world.neighbors(n1[0], n1[1])) {
      if (!world.isLand(n2[0], n2[1])) continue;
      if (n2[0] === u.x && n2[1] === u.y) continue;
      mid = n1; target = n2;
      break outer;
    }
  }
  const mo = game.moveOrder(A.id, u.id, target);
  check(mo.ok, '이동 명령 접수');
  const r1 = game.resolveExecution();
  check(game.territory.get(key(mo.path[0])) === A.id, '1칸째 이동 → 영토화');
  check(r1.captures.some(([x, y, c]) => c === A.id), '점령 브로드캐스트');
  game.resolveExecution();
  check(game.territory.get(key(target)) === A.id, '경로 전체 영토화');
  check(game.tileCountOf(A.id) >= 3, `영토 수 누적 (수도+경로, ${game.tileCountOf(A.id)}타일)`);
}

// ── 2. 영토 자동 채취 (+채집 기술 20%)
{
  const { game, civs } = newGame(1);
  const A = game.civs.get(civs[0].id);
  const capRes = world.resourceAt(A.capital[0], A.capital[1]);
  game.resolveExecution();
  check(A.resources[capRes] === 1, `영토(수도 1타일) 자동 채취 (+1 ${capRes})`);
  A.tech.gather = 5; // +100%
  game.resolveExecution();
  check(A.resources[capRes] === 3, '채집 Lv5 → 타일당 2 (ceil(1×2))');
}

// ── 3. 동률 전투: 양측 행동불능, 후퇴·소멸 없음
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  const hex = isolated[20];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  check(r.battles.length === 1 && ua.stunned === 2 && ub.stunned === 2, '동률: 양측 2턴 행동불능');
  check(ua.x === hex[0] && ub.x === hex[0], '동률: 후퇴 없음');
  check(game.units.size === 2 * START_UNITS, '유닛 소멸 없음');
}

// ── 4. 기술 우위: 패자 수도 후퇴 + 2턴, 승자 헥스 점령
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.civs.get(A.id).tech.military = 1;
  const hex = isolated[21];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  const bCap = game.civs.get(B.id).capital;
  check(ub.x === bCap[0] && ub.y === bCap[1] && ub.stunned === 2, '패자: 수도 후퇴 + 2턴 행동불능');
  check(ua.stunned === 1 && ua.x === hex[0], '승자: 1턴 행동불능, 헥스 유지');
  check(game.territory.get(key(hex)) === A.id, '전투 헥스 승자 점령');
  check(r.moves.some(m => m.unitId === ub.id && m.x === bCap[0]), '후퇴 위치 브로드캐스트');
  check(game.units.size === 2 * START_UNITS, '유닛 소멸 없음');
}

// ── 5. 수 우위 (2배 이상 +1)
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  const hex = isolated[22];
  const [a1, a2] = unitsOf(game, A.id);
  const [b1] = unitsOf(game, B.id);
  [a1.x, a1.y] = hex; [a2.x, a2.y] = hex; [b1.x, b1.y] = hex;
  game.resolveExecution();
  const bCap = game.civs.get(B.id).capital;
  check(b1.x === bCap[0] && b1.y === bCap[1], '수 우위: 소수 측 후퇴');
  check(game.units.size === 2 * START_UNITS, '유닛 소멸 없음');
}

// ── 6. 방어 기술: 자기 영토에서 +1
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.civs.get(A.id).tech.military = 1;  // 공격 1
  game.civs.get(B.id).tech.defense = 1;   // 방어 1
  const hex = isolated[23];
  game.setTile(key(hex), B.id);           // B의 영토
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  game.resolveExecution();
  check(ua.stunned === 2 && ub.stunned === 2 && ub.x === hex[0], '자기 영토 방어 → 동률 (후퇴 없음)');
  // 공격 기술 2로 재도전
  for (const u of game.units.values()) u.stunned = 0;
  game.civs.get(A.id).tech.military = 2;
  game.resolveExecution();
  const bCap = game.civs.get(B.id).capital;
  check(ub.x === bCap[0] && ub.y === bCap[1], '방어 초과 공격 → 수비 측 후퇴');
}

// ── 7. 수도 함락 → 점령(예속)·유닛/영토 편입·위임
{
  const { game, civs } = newGame(3);
  const [A, B] = civs;
  const bCiv = game.civs.get(B.id);
  const bCap = bCiv.capital;
  // B 유닛들을 수도에서 치우고, A 유닛을 수도 옆에서 진입시킴
  const bUnits = unitsOf(game, B.id);
  const nb = world.neighbors(bCap[0], bCap[1]).find(([x, y]) => world.isLand(x, y));
  const ua = unitsOf(game, A.id)[0];
  [ua.x, ua.y] = nb;
  const mo = game.moveOrder(A.id, ua.id, bCap);
  check(mo.ok && mo.path.length === 1, '수도 진입 경로');
  const r0 = game.resolveExecution();
  check(ua.x === bCap[0] && ua.y === bCap[1], '수도 진입');
  check(bCiv.alive && bCiv.capitalHp === 4, `1턴 공성 → HP 4 (한 번에 함락 안 됨)`);
  check(game.territory.get(key(bCap)) === B.id, '함락 전까지 수도 타일 유지');
  let r = r0;
  for (let i = 0; i < 6 && bCiv.alive; i++) r = game.resolveExecution();
  check(r.conquests.length === 1 && r.conquests[0].civId === B.id, 'HP 0 → 수도 함락·점령');
  check(!bCiv.alive && bCiv.conqueredBy === A.id, '예속 상태');
  check(bUnits.every(u => u.civ === A.id), '유닛은 점령국 소속으로 편입');
  check(game.territory.get(key(bCap)) === A.id, '영토 이전');
  check([...game.units.values()].some(u => u.controller === B.id), '위임 유닛 부여');
  check(!r.gameover, '3인 게임: 계속 진행');
}

// ── 8. 동맹 영토는 통과해도 뺏지 않음
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.proposeAlly(A.id, B.id);
  game.acceptAlly(B.id, A.id);
  const hex = isolated[24];
  game.setTile(key(hex), B.id);
  game.claim(hex[0], hex[1], A.id);
  check(game.territory.get(key(hex)) === B.id, '동맹 영토 존중');
  game.removeAlliance(A.id, B.id);
  game.claim(hex[0], hex[1], A.id);
  check(game.territory.get(key(hex)) === A.id, '동맹 해제 후엔 점령 가능');
}

// ── 9. 기본 이동력 2 (육지)
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  let mo = null;
  for (const cand of isolated) {
    const p = game.findPath(u.x, u.y, cand[0], cand[1]);
    if (p && p.length >= 4 && p.every(([px, py]) => world.isLand(px, py))) {
      mo = game.moveOrder(A.id, u.id, cand);
      break;
    }
  }
  if (mo && mo.ok) {
    game.resolveExecution();
    check(u.x === mo.path[1][0] && u.y === mo.path[1][1], '육지 기본 이동력 2 (턴당 2칸)');
    game.resolveExecution();
    check(u.x === mo.path[3][0] && u.y === mo.path[3][1], '2턴차에 4칸째 도달');
  } else {
    check(false, '육지 기본 이동력 2 (경로 탐색 실패)');
  }
}

// ── 10. 바다 이동: 턴당 1칸, 영토화 없음
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  // 해안(육지) → s1(바다) → s2(어떤 육지와도 인접하지 않은 먼바다)
  const nearLand = ([x, y]) => world.neighbors(x, y).some(([nx, ny]) => world.isLand(nx, ny));
  let coast = null, s2 = null;
  outer:
  for (let y = 1; y < world.h - 1; y++) {
    for (let x = 0; x < world.w; x++) {
      if (!world.isLand(x, y)) continue;
      for (const nb of world.neighbors(x, y)) {
        if (world.isLand(nb[0], nb[1])) continue;
        for (const nb2 of world.neighbors(nb[0], nb[1])) {
          if (!world.isLand(nb2[0], nb2[1]) && !nearLand(nb2)) {
            coast = [x, y]; s2 = nb2;
            break outer;
          }
        }
      }
    }
  }
  [u.x, u.y] = coast;
  const mo = game.moveOrder(A.id, u.id, s2);
  check(mo.ok, '바다 목표 이동 명령 허용');
  game.resolveExecution();
  check(!world.isLand(u.x, u.y) && u.x === mo.path[0][0] && u.y === mo.path[0][1], '바다는 턴당 1칸 (이동력 2 소모)');
  check(game.territory.get(u.x + ',' + u.y) == null, '바다는 영토화되지 않음');
  game.resolveExecution();
  const last = mo.path[mo.path.length - 1];
  check(u.x === last[0] && u.y === last[1], '2턴차에 바다 목표 도달');
}

// ── 11. 수도 HP: 기술 총합 비례 + 회복 + 군사 기술 피해
{
  const { game, civs } = newGame(3);
  const [A, B] = civs;
  const bCiv = game.civs.get(B.id);
  check(game.maxCapitalHp(bCiv) === 5, '기본 수도 HP 5');
  bCiv.tech.military = 2; bCiv.tech.gather = 3; bCiv.tech.move = 1; bCiv.tech.defense = 4;
  check(game.maxCapitalHp(bCiv) === 15, '기술 총합 10 → 최대 HP 15');
  // 군사 3레벨 공격자는 유닛당 4 피해
  game.civs.get(A.id).tech.military = 3;
  bCiv.capitalHp = 15;
  const ua = unitsOf(game, A.id)[0];
  [ua.x, ua.y] = bCiv.capital;
  game.resolveExecution();
  check(bCiv.capitalHp === 11, `군사 Lv3 → 턴당 4 피해 (HP ${bCiv.capitalHp})`);
  // 공격 중단 → 턴당 1 회복
  [ua.x, ua.y] = isolated[39];
  game.resolveExecution();
  check(bCiv.capitalHp === 12, `공격 중단 → 회복 (HP ${bCiv.capitalHp})`);
}

console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
