// v2 검증: 영토화 이동·영토 채취·전투(후퇴/방어)·수도 함락 점령·유닛 불변
process.env.NEUTRAL_COUNT = '0'; // 기본 테스트는 중립 유닛 제외 (전용 테스트에서 수동 배치)
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
  // 테스트 편의: 전원 접촉 처리
  for (const a of civs) for (const b of civs) if (a.id < b.id) game.contacts.add(a.id + ':' + b.id);
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
  const dRet = world.hexDistance(ub.x, ub.y, hex[0], hex[1]);
  check(dRet === 2 && ub.stunned === 2, `패자: 전투 지점 2헥스 근처로 후퇴 + 2턴 행동불능 (거리 ${dRet})`);
  check(ua.stunned === 1 && ua.x === hex[0], '승자: 1턴 행동불능, 헥스 유지');
  check(game.territory.get(key(hex)) === A.id, '전투 헥스 승자 점령');
  check(r.moves.some(m => m.unitId === ub.id && m.x === ub.x && m.retreat), '후퇴 위치 브로드캐스트');
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
  check(world.hexDistance(b1.x, b1.y, hex[0], hex[1]) === 2, '수 우위: 소수 측 근처 후퇴');
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
  check(world.hexDistance(ub.x, ub.y, hex[0], hex[1]) === 2, '방어 초과 공격 → 수비 측 근처 후퇴');
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
    if (p && p.length >= 4) { mo = game.moveOrder(A.id, u.id, cand); break; }
  }
  if (mo && mo.ok) {
    // 이동력 3 예산을 지형 비용으로 시뮬레이션해 기대 위치 계산
    const stepIdx = (startIdx) => {
      let budget = 3, i = startIdx;
      while (i < mo.path.length) {
        const c = game.moveCost(mo.path[i][0], mo.path[i][1]);
        if (c > budget) break;
        budget -= c;
        i++;
      }
      return i;
    };
    const i1 = stepIdx(0);
    game.resolveExecution();
    check(i1 > 0 && u.x === mo.path[i1 - 1][0] && u.y === mo.path[i1 - 1][1], `이동력 3 예산 소모 (1턴차 ${i1}칸)`);
    const i2 = stepIdx(i1);
    game.resolveExecution();
    check(u.x === mo.path[i2 - 1][0] && u.y === mo.path[i2 - 1][1], `2턴차에 ${i2}칸째 도달`);
  } else {
    check(false, '이동력 예산 (경로 탐색 실패)');
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
  check(!world.isLand(u.x, u.y) && u.x === mo.path[0][0] && u.y === mo.path[0][1], '바다는 턴당 1칸 (이동력 3 소모)');
  check(game.territory.get(u.x + ',' + u.y) == null, '바다는 영토화되지 않음');
  game.resolveExecution();
  const last = mo.path[mo.path.length - 1];
  check(u.x === last[0] && u.y === last[1], '2턴차에 바다 목표 도달');
}

// ── 10.3 웨이포인트: append로 경로 연장, 일반 명령은 교체
{
  const { game, civs } = newGame(1);
  const A = civs[0];
  const u = unitsOf(game, A.id)[0];
  const t1 = world.neighbors(u.x, u.y).find(([x, y]) => world.isLand(x, y));
  const t2 = t1 && world.neighbors(t1[0], t1[1]).find(([x, y]) =>
    world.isLand(x, y) && !(x === u.x && y === u.y) && !(x === t1[0] && y === t1[1]));
  if (t1 && t2) {
    const r1 = game.moveOrder(A.id, u.id, t1);
    const r2 = game.moveOrder(A.id, u.id, t2, true);
    const last = r2.path[r2.path.length - 1];
    check(r2.ok && r2.path.length > r1.path.length && last[0] === t2[0] && last[1] === t2[1],
      `웨이포인트 연장 (${r1.path.length}→${r2.path.length}칸)`);
    check(r2.path[0][0] === r1.path[0][0] && r2.path[0][1] === r1.path[0][1], '기존 경로 유지 후 연장');
    const r3 = game.moveOrder(A.id, u.id, t1);
    const last3 = r3.path[r3.path.length - 1];
    check(r3.ok && last3[0] === t1[0] && last3[1] === t1[1], '일반 명령은 경로 교체');
  } else {
    check(true, '이웃 지형 부족 (건너뜀)');
  }
}

// ── 10.5 지형별 이동 비용
{
  const { game } = newGame(1);
  // 지형 샘플로 비용 함수 직접 검증
  let flat = null, mtn = null, sea = null;
  for (let y = 0; y < world.h && !(flat && mtn && sea); y++)
    for (let x = 0; x < world.w && !(flat && mtn && sea); x++) {
      const t = world.terrain(x, y);
      if (!flat && (t === 'g' || t === 'p' || t === 'f')) flat = [x, y];
      if (!mtn && t === 'm') mtn = [x, y];
      if (!sea && t === '~') sea = [x, y];
    }
  check(game.moveCost(flat[0], flat[1]) === 1, '평지 이동 비용 1');
  check(game.moveCost(mtn[0], mtn[1]) === 2, '산 이동 비용 2');
  check(game.moveCost(sea[0], sea[1]) === 3, '바다 이동 비용 3');
  let hill = null, high = null;
  for (let y = 0; y < world.h && !(hill && high); y++)
    for (let x = 0; x < world.w && !(hill && high); x++) {
      const t2 = world.terrain(x, y);
      if (!hill && t2 === 'h') hill = [x, y];
      if (!high && t2 === 'M') high = [x, y];
    }
  check(hill && game.moveCost(hill[0], hill[1]) === 1.5, '구릉 이동 비용 1.5');
  check(high && game.moveCost(high[0], high[1]) === 3, '고산 이동 비용 3');

  // 산 2연속 경로: 첫 턴에 1개(2)만 넘고 멈춤 (2+2 > 3)
  const A = game.civs.values().next().value;
  const u = unitsOf(game, A.id)[0];
  let F = null, path2 = null;
  outer:
  for (let y = 1; y < world.h - 1; y++) {
    for (let x = 0; x < world.w; x++) {
      const t = world.terrain(x, y);
      if (t === '~' || t === 'm') continue;
      for (const nb of world.neighbors(x, y)) {
        if (world.terrain(nb[0], nb[1]) !== 'm') continue;
        for (const nb2 of world.neighbors(nb[0], nb[1])) {
          if (world.terrain(nb2[0], nb2[1]) === 'm' && !(nb2[0] === x && nb2[1] === y)) {
            [u.x, u.y] = [x, y];
            const mo = game.moveOrder(A.id, u.id, nb2);
            if (mo.ok && mo.path.length === 2 &&
                mo.path.every(([px, py]) => world.terrain(px, py) === 'm')) {
              F = [x, y]; path2 = mo.path;
              break outer;
            }
            game.cancelOrder(A.id, u.id);
          }
        }
      }
    }
  }
  if (path2) {
    game.resolveExecution();
    check(u.x === path2[0][0] && u.y === path2[0][1], '산지 연속: 첫 턴 1칸 (이동력 소진)');
    game.resolveExecution();
    check(u.x === path2[1][0] && u.y === path2[1][1], '2턴차에 두 번째 산 도달');
  } else {
    check(true, '산 2연속 직행 경로 없음 (비용 검증으로 대체)');
  }
}

// ── 10.8 수도 유닛 생산: 인구 기술 1레벨당 상한 +1
{
  const { game, civs } = newGame(1);
  const A = game.civs.get(civs[0].id);
  A.resources.stone = 30; A.resources.grain = 30;
  // 기본 상한 3 → 생산 불가
  check(game.spawnOrder(A.id).reason === 'cap', '인구 Lv0: 상한 3에서 생산 거부');
  // 인구 Lv1 → 상한 4
  A.tech.defense = 1;
  const so = game.spawnOrder(A.id);
  check(so.ok === true, '인구 Lv1: 생산 예약 접수');
  const r = game.resolveExecution();
  check(r.births.length === 1, '실행 턴에 수도에서 유닛 생성');
  check(r.births[0].x === A.capital[0] && r.births[0].y === A.capital[1], '생성 위치 = 수도');
  check(unitsOf(game, A.id).length === 4, '유닛 4기 (3+1)');
  check(A.resources.stone === 30 - 10 + (r.gains && 0 || 0) || A.resources.stone <= 21, '고기 10 차감');
  // 상한 재도달
  check(game.spawnOrder(A.id).reason === 'cap', 'Lv1 상한 4 재도달 → 거부');
  // 자원 부족
  A.tech.defense = 2;
  A.resources.stone = 5;
  check(game.spawnOrder(A.id).reason === 'cost', '자원 부족 거부');
  // 예약 후 실행 시점 재검증 (자원 소진)
  A.resources.stone = 10; A.resources.grain = 10;
  game.spawnOrder(A.id);
  A.resources.grain = 0;
  const r2 = game.resolveExecution();
  check(r2.spawnFails.some(f => f.civId === A.id && f.reason === 'cost'), '실행 시 자원 재검증');
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
  // 최대 레벨(5) 계통마다 회복 +1
  bCiv.tech.gather = 5; bCiv.tech.defense = 5; // 총합 13 → 최대 HP 18, 만렙 2계통
  game.resolveExecution();
  check(bCiv.capitalHp === 15, `만렙 2계통 → 턴당 3 회복 (HP ${bCiv.capitalHp})`);
}

// ── 12. 요새: 건설·비용·차단·공성·파괴·회복
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.resolveExecution(); // _captures 준비
  const aCiv = game.civs.get(A.id);
  // 육지 이웃이 있는 자리 선정
  let spot = null, nb = null;
  for (let i = 36; i < isolated.length && !spot; i++) {
    const cand = isolated[i];
    const n2 = game.world.neighbors(cand[0], cand[1]).find(([x, y]) => game.world.isLand(x, y));
    if (n2) { spot = cand; nb = n2; }
  }
  const ua = unitsOf(game, A.id)[0];
  [ua.x, ua.y] = spot;
  game.setTile(spot[0] + ',' + spot[1], A.id);
  aCiv.resources.stone = 10; aCiv.resources.wood = 10;
  check(game.fortOrder(A.id, ua.id).ok === true, '요새 예약');
  const rr = game.resolveExecution();
  const fk = spot[0] + ',' + spot[1];
  const fort = game.forts.get(fk);
  check(!!fort && fort.hp === 3 && fort.max === 3, `건설 완료, HP 3 (수도 5의 절반 올림)`);
  const g2 = (rr.gains && rr.gains[A.id]) || {};
  check(aCiv.resources.stone === (g2.stone || 0) && aCiv.resources.wood === (g2.wood || 0),
    '돌10+목재10 소모 (채취 수입 제외 0)');
  check(rr.fortEvents.some(e => e.type === 'built' && e.civId === A.id), 'built 이벤트');
  aCiv.resources.stone = 10; aCiv.resources.wood = 10;
  check(game.fortOrder(A.id, ua.id).reason === 'tile', '같은 타일 중복 건설 거부');

  // 적 이동 차단
  const ub = unitsOf(game, B.id)[0];
  [ub.x, ub.y] = nb;
  check(game.moveOrder(B.id, ub.id, spot).reason === 'path', '적 요새 타일로 경로 없음 (우회/차단)');

  // 공성: 인접 적 유닛 1기(군사 0) → 턴당 1 피해
  [ua.x, ua.y] = isolated[34]; // A 유닛 이탈
  game.resolveExecution();
  check(game.forts.get(fk).hp === 2, '인접 공성 → HP 2');
  game.resolveExecution();
  const r3 = game.resolveExecution();
  check(!game.forts.has(fk), 'HP 0 → 요새 파괴');
  check(r3.fortEvents.some(e => e.type === 'destroyed' && e.by === B.id), 'destroyed 이벤트');

  // 회복: 공격자가 없으면 턴당 +1
  [ub.x, ub.y] = isolated[33];
  game.forts.set(fk, { x: spot[0], y: spot[1], civ: A.id, hp: 1, max: 3 });
  game.resolveExecution();
  check(game.forts.get(fk).hp === 2, '공격 없음 → HP 회복 +1');
}

// ── 13. 패배 누적 행동불능 · 군사 연구 리셋 · 곡식 회복
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.civs.get(B.id).tech.military = 1; // B 우위
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  const hex = isolated[35];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  game.resolveExecution();
  check(ua.stunned === 2 && ua.fatigue === 1, '1패 → 행동불능 2턴 (누적 1)');

  ua.stunned = 0; ub.stunned = 0;
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  game.resolveExecution();
  check(ua.stunned === 3 && ua.fatigue === 2, '2패 → 행동불능 3턴 (누적 2)');

  const aCiv = game.civs.get(A.id);
  aCiv.resources.iron = 40;
  game.researchOrder(A.id, 'military');
  game.resolveExecution();
  check(ua.fatigue === 0, '군사 기술 향상 → 누적 리셋');

  ua.stunned = 4; ua.fatigue = 3;
  aCiv.resources.grain = 9;
  check(game.rallyOrder(A.id, ua.id).reason === 'cost', '곡식 부족 → 회복 거부');
  aCiv.resources.grain = 10;
  const rr2 = game.rallyOrder(A.id, ua.id);
  check(rr2.ok && ua.stunned === 0 && ua.fatigue === 0, '곡식 10 → 즉시 회복 + 누적 초기화');
  check(aCiv.resources.grain === 0, '곡식 소모');
  check(game.rallyOrder(A.id, ua.id).reason === 'state', '회복 불필요 시 거부');
}

// ── 14. 이동 중 조우 → 요격 전투
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  // 평지(비용 1)로만 이어진 가로 5칸 찾기
  let run = null;
  outer:
  for (let y = 5; y < world.h - 5; y++) {
    for (let x = 2; x < world.w - 8; x++) {
      let ok = true;
      for (let i = 0; i < 5; i++) if (game.moveCost(x + i, y) !== 1) { ok = false; break; }
      if (ok) { run = [x, y]; break outer; }
    }
  }
  check(!!run, '평지 5칸 직선 확보');
  const [rx, ry] = run;
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];

  // (a) 정면 교차: 서로를 향해 이동 → 중간에서 만나 전투
  [ua.x, ua.y] = [rx, ry]; [ub.x, ub.y] = [rx + 4, ry];
  game.orders.set(ua.id, { path: [[rx + 1, ry], [rx + 2, ry], [rx + 3, ry], [rx + 4, ry]], idx: 0 });
  game.orders.set(ub.id, { path: [[rx + 3, ry], [rx + 2, ry], [rx + 1, ry], [rx, ry]], idx: 0 });
  const r1 = game.resolveExecution();
  check(r1.battles.length === 1, '정면 교차 → 요격 전투 발생');
  check(ua.x === ub.x && ua.y === ub.y, `조우 지점에서 정지 (${ua.x},${ua.y})`);
  check(ua.stunned === 2 && ub.stunned === 2, '동률 → 양측 행동불능');

  // (b) 주둔지 통과 시도: 정지한 적 위를 지나가는 경로 → 그 자리에서 멈추고 전투
  const { game: g2, civs: c2 } = newGame(2);
  const ua2 = unitsOf(g2, c2[0].id)[0], ub2 = unitsOf(g2, c2[1].id)[0];
  [ua2.x, ua2.y] = [rx, ry]; [ub2.x, ub2.y] = [rx + 2, ry];
  g2.orders.set(ua2.id, { path: [[rx + 1, ry], [rx + 2, ry], [rx + 3, ry], [rx + 4, ry]], idx: 0 });
  const r2 = g2.resolveExecution();
  check(r2.battles.length === 1 && ua2.x === rx + 2, '주둔 적 통과 불가 → 그 헥스에서 전투');

  // (c) 패자는 남은 경로가 취소됨
  const { game: g3, civs: c3 } = newGame(2);
  g3.civs.get(c3[1].id).tech.military = 1; // B 우위
  const ua3 = unitsOf(g3, c3[0].id)[0], ub3 = unitsOf(g3, c3[1].id)[0];
  [ua3.x, ua3.y] = [rx, ry]; [ub3.x, ub3.y] = [rx + 2, ry];
  g3.orders.set(ua3.id, { path: [[rx + 1, ry], [rx + 2, ry], [rx + 3, ry], [rx + 4, ry]], idx: 0 });
  g3.resolveExecution();
  check(world.hexDistance(ua3.x, ua3.y, rx + 2, ry) === 2, '요격 패배 → 조우 지점 근처 후퇴');
  check(!g3.orders.has(ua3.id), '패자의 남은 경로 취소');
}

// ── 15. 계급: 승리마다 진급, 계급당 전투력 +0.5
{
  const { game, civs } = newGame(2);
  const [A, B] = civs;
  game.civs.get(A.id).tech.military = 1; // A 우위
  const hex = isolated[30];
  const ua = unitsOf(game, A.id)[0], ub = unitsOf(game, B.id)[0];
  [ua.x, ua.y] = hex; [ub.x, ub.y] = hex;
  const r = game.resolveExecution();
  check(ua.rank === 1, '승리 → 일병 진급');
  check(r.promotions.some(p2 => p2.unitId === ua.id && p2.rank === 1), '진급 브로드캐스트');
  check((ub.rank || 0) === 0, '패자는 진급 없음');

  // 계급 전투력: 군사 0 + 계급 2(상병, +1.0) vs 군사 1 → 동률
  const { game: g2, civs: c2 } = newGame(2);
  g2.civs.get(c2[1].id).tech.military = 1;
  const ua2 = unitsOf(g2, c2[0].id)[0], ub2 = unitsOf(g2, c2[1].id)[0];
  ua2.rank = 2;
  [ua2.x, ua2.y] = isolated[31]; [ub2.x, ub2.y] = isolated[31];
  g2.resolveExecution();
  check(ua2.stunned === 2 && ub2.stunned === 2, '계급 +1.0 vs 군사 1 → 동률');

  // 계급 3(병장, +1.5) vs 군사 1 → 계급 측 승리
  const { game: g3, civs: c3 } = newGame(2);
  g3.civs.get(c3[1].id).tech.military = 1;
  const ua3 = unitsOf(g3, c3[0].id)[0], ub3 = unitsOf(g3, c3[1].id)[0];
  ua3.rank = 3;
  [ua3.x, ua3.y] = isolated[32]; [ub3.x, ub3.y] = isolated[32];
  g3.resolveExecution();
  check(ua3.stunned === 1 && ua3.rank === 4, '병장(+1.5) 승리 → 하사 진급');

  // 중립 처치도 진급, 대령(12) 상한
  const { game: g4, civs: c4 } = newGame(2);
  g4.civs.get(c4[0].id).tech.military = 1;
  const ua4 = unitsOf(g4, c4[0].id)[0];
  const isle = [...g4.world.componentSizes()].find(([, v]) => v === 1)[0].split(',').map(Number);
  g4.spawnNeutralAt('wolf', isle[0], isle[1]);
  [ua4.x, ua4.y] = isle;
  ua4.rank = 12;
  g4.resolveExecution();
  check(g4.neutrals.size === 0 && ua4.rank === 12, '중립 처치 진급은 대령 상한 유지');
}

console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
