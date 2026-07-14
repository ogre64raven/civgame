// M6 검증: 로비 대기·관리자 API (인증/시작/설정/강퇴/리셋)·섬나라 배정 제외
process.env.NEUTRAL_COUNT = '0'; // 기본 테스트는 중립 유닛 제외 (전용 테스트에서 수동 배치)
const { World } = require('../server/world');
const { Game, MIN_LANDMASS } = require('../server/game');
const countries = require('../data/countries.json');
const { startServer, admin, Client, wait } = require('./testUtil');

const PORT = 3300;
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

// ── 0. 섬나라 배정 제외 (오프라인 검증)
{
  const world = new World();
  const sizes = world.componentSizes();
  const g = new Game(world, () => {});
  const eligible = new Set(g.pool.map(i => countries[i].code));
  check(!eligible.has('TUV') && !eligible.has('NRU') && !eligible.has('FJI'), '태평양 도서국 배정 제외');
  check(g.pool.length >= 30, `배정 가능 국가 30개국 이상 (${g.pool.length})`);
  let bad = 0;
  for (const i of g.pool) {
    const [x, y] = world.lonlatToHex(countries[i].cap[0], countries[i].cap[1]);
    const nl = world.nearestLand(x, y, null, 2);
    if (!nl || (sizes.get(nl[0] + ',' + nl[1]) || 0) < MIN_LANDMASS) bad++;
  }
  check(bad === 0, `배정 풀 전체가 ${MIN_LANDMASS}헥스 이상 대륙 (위반 ${bad})`);
}

// ── 0.3 신규 플레이어는 기존과 최원거리 배정 (오프라인)
{
  const world3 = new World();
  const g = new Game(world3, () => {});
  const a = g.join(undefined, 'A').civ;
  const expected = Math.max(...g.pool.map(i => {
    const [sx, sy] = g.spawnOf(i);
    return world3.hexDistance(sx, sy, a.capital[0], a.capital[1]);
  }));
  const b = g.join(undefined, 'B').civ;
  const dAB = world3.hexDistance(a.capital[0], a.capital[1], b.capital[0], b.capital[1]);
  check(dAB === expected, `2번째 배정 = 최원거리 (${dAB}헥스)`);

  const expected3 = Math.max(...g.pool.map(i => {
    const [sx, sy] = g.spawnOf(i);
    return Math.min(
      world3.hexDistance(sx, sy, a.capital[0], a.capital[1]),
      world3.hexDistance(sx, sy, b.capital[0], b.capital[1]));
  }));
  const c = g.join(undefined, 'C').civ;
  const dC = Math.min(
    world3.hexDistance(c.capital[0], c.capital[1], a.capital[0], a.capital[1]),
    world3.hexDistance(c.capital[0], c.capital[1], b.capital[0], b.capital[1]));
  check(dC === expected3, `3번째 배정 = 두 수도와의 최소거리 최대화 (${dC}헥스)`);
  check(dC >= 8, `충분한 이격 (${dC} ≥ 8)`);
}

// ── 0.5 봇 AI (오프라인)
{
  const { runBots } = require('../server/bots');
  const world2 = new World();
  const g = new Game(world2, () => {});
  g.join(undefined, '사람');
  const rb = g.addBot();
  check(rb.ok && g.civs.get(rb.civ.id).isBot === true, '봇 생성 (isBot 플래그)');
  g.startGame();
  clearTimeout(g.timer);
  const bot = g.civs.get(rb.civ.id);
  bot.resources.iron = 20;
  runBots(g);
  check(g.researchOrders.get(bot.id) != null, '봇 자동 연구 예약');
  check(g.ordersOf(bot.id).length >= 1, '봇 자동 이동 명령');
  g.resolveExecution();
  check(g.tileCountOf(bot.id) >= 1, `봇 영토 활동 (${g.tileCountOf(bot.id)}타일)`);

  // 회복: 오래 묶인 유닛은 곡식으로 즉시 회복
  const bu = [...g.units.values()].find(u2 => u2.civ === bot.id);
  bu.stunned = 4; bu.fatigue = 3;
  bot.resources.grain = 40;
  runBots(g);
  check(bu.stunned === 0 && bu.fatigue === 0, '봇 유닛 회복 (곡식 소모)');

  // 요새: 여유 자원 + 국경 영토 위 유닛 → 예약
  const bu2 = [...g.units.values()].find(u2 => u2.civ === bot.id && u2.stunned === 0);
  const nb = g.world.neighbors(bot.capital[0], bot.capital[1]).find(([x, y]) => g.world.isLand(x, y));
  if (nb) {
    [bu2.x, bu2.y] = nb;
    g.setTile(nb[0] + ',' + nb[1], bot.id);
    g.orders.delete(bu2.id);
    bot.resources.stone = 30; bot.resources.wood = 30;
    runBots(g);
    check(g.fortOrders.get(nb[0] + ',' + nb[1]) === bot.id, '봇 국경 요새 예약');
  }
}

// ── 0.6 봇 외교: 제안 수락 + 동의 승인
{
  const { runBots } = require('../server/bots');
  const world5 = new World();
  const g = new Game(world5, () => {});
  const h = g.join(undefined, '사람').civ;
  const b1 = g.addBot().civ, b2 = g.addBot().civ;
  g.startGame();
  clearTimeout(g.timer);
  for (const x of [b1.id, b2.id]) g.contacts.add(Math.min(h.id, x) + ':' + Math.max(h.id, x));
  g.contacts.add(Math.min(b1.id, b2.id) + ':' + Math.max(b1.id, b2.id));
  g.proposeAlly(h.id, b1.id);
  const ev = runBots(g);
  check(g.isAllied(h.id, b1.id), '봇이 동맹 제안 수락');
  check(ev.formed.length === 1, '성립 이벤트 반환 (브로드캐스트용)');
  // 3국 확장: 사람이 b2에 제안 + b2가 수락 → 기존 동맹국 b1... (사람-b1 동맹에서 b2 확장은 b1 동의 필요)
  g.proposeAlly(h.id, b2.id);
  const r2 = g.acceptAlly(b2.id, h.id);
  check(r2.consentNeeded === b1.id, '확장 동의 대기 (봇 b1)');
  const ev2 = runBots(g);
  check(g.isAllied(h.id, b2.id), '봇이 동의 요청 승인 → 3국 동맹');
  check(ev2.formed.length === 1, '동의 성립 이벤트 반환');
}

(async () => {
  const server = await startServer(PORT, { PHASE_MEETING_MS: '600000', PHASE_EXEC_MS: '1000' });
  try {
    // ── 1. 관리자 인증
    const bad = await admin(PORT, 'POST', 'login', null, 'wrongpass');
    check(bad.status === 401, '잘못된 비밀번호 → 401');
    const good = await admin(PORT, 'POST', 'login');
    check(good.status === 200 && good.body.ok, '올바른 비밀번호 → 로그인');

    // ── 2. 로비 대기
    const empty = await admin(PORT, 'POST', 'start');
    check(empty.status === 400, '플레이어 0명 → 시작 거부');

    const A = new Client('갑', PORT), B = new Client('을', PORT);
    await A.connect(); await B.connect();
    check(A.welcome.state === 'LOBBY' && A.welcome.units.length === 0, '로비: 유닛 미스폰');

    const aUnit = 1; // 아무 id
    A.send({ type: 'order.move', unitId: aUnit, target: [0, 0] });
    const rej = await A.next(m => m.type === 'orderRejected');
    check(rej.reason === 'phase', '로비 중 명령 거부');

    let st = (await admin(PORT, 'GET', 'state')).body;
    check(st.state === 'LOBBY' && st.playerCount === 2, `관리자 상태 조회 (로비, ${st.playerCount}명)`);
    check(st.room === '1111', `관리자 상태에 방 번호 (${st.room})`);
    check(A.welcome.room === '1111', '환영 메시지에 방 번호');

    // 잘못된 방 번호 → 입장 거부
    const W = new Client('오방', PORT, '9999');
    const wrongJoin = new Promise((resolve, reject) => {
      W.ws = new (require('ws'))(`ws://localhost:${PORT}`);
      W.ws.on('open', () => W.ws.send(JSON.stringify({ type: 'join', name: '오방', room: '9999' })));
      W.ws.on('message', (raw) => resolve(JSON.parse(raw)));
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    const wr = await wrongJoin;
    check(wr.type === 'joinRejected' && wr.reason === 'room', '잘못된 방 번호 → 입장 거부');
    W.ws.close();

    // ── 3. 설정 변경
    const set = await admin(PORT, 'POST', 'settings', { meetingMs: 7000, execMs: 3000, turnLimit: 50 });
    check(set.body.settings.meetingMs === 7000 && set.body.settings.turnLimit === 50, '설정 변경 적용');
    const clamped = await admin(PORT, 'POST', 'settings', { meetingMs: 1, execMs: 999999, turnLimit: 'abc' });
    check(clamped.body.settings.meetingMs === 5000 && clamped.body.settings.execMs === 120000 && clamped.body.settings.turnLimit === 50, '설정 범위 제한(클램프)');

    // ── 4. 게임 시작
    const start = await admin(PORT, 'POST', 'start');
    check(start.status === 200, '게임 시작 API');
    const gs = await A.next(m => m.type === 'gameStarted');
    check(gs.units.length === 6 && gs.phase === 'MEETING', '시작 시 유닛 6기 스폰 + 회의 턴');
    st = (await admin(PORT, 'GET', 'state')).body;
    check(st.state === 'RUNNING', '상태 RUNNING 전환');
    const again = await admin(PORT, 'POST', 'start');
    check(again.status === 400, '진행 중 재시작 거부');

    // ── 5. 강퇴
    const bId = B.welcome.you;
    let bKicked = false;
    B.ws.on('close', () => { bKicked = true; });
    await admin(PORT, 'POST', 'kick', { civId: bId });
    await A.next(m => m.type === 'civKicked' && m.civId === bId);
    await wait(300);
    check(bKicked, '강퇴: 대상 연결 종료');
    st = (await admin(PORT, 'GET', 'state')).body;
    check(st.playerCount === 1, '강퇴 후 참가자 1명');
    check(st.players[0].units === 3, '강퇴된 문명 유닛 제거');

    // ── 5.5 봇 추가/제거 (관리자 API)
    const ab = await admin(PORT, 'POST', 'addBot');
    check(ab.status === 200 && ab.body.ok, `봇 추가 API (${ab.body.name || ''})`);
    st = (await admin(PORT, 'GET', 'state')).body;
    const bot = st.players.find(p => p.isBot);
    check(!!bot && st.playerCount === 2, '봇 참가 확인');
    check(bot.units === 3, '진행 중 추가된 봇 유닛 3기 스폰');
    const rmHuman = await admin(PORT, 'POST', 'removeBot', { civId: A.welcome.you });
    check(rmHuman.status === 400, '사람은 removeBot으로 제거 불가');
    await admin(PORT, 'POST', 'removeBot', { civId: bot.id });
    st = (await admin(PORT, 'GET', 'state')).body;
    check(st.playerCount === 1 && !st.players.some(p => p.isBot), '봇 제거');

    // ── 6. 리셋
    await admin(PORT, 'POST', 'reset');
    await A.next(m => m.type === 'reset');
    st = (await admin(PORT, 'GET', 'state')).body;
    check(st.state === 'LOBBY' && st.playerCount === 0, '리셋 → 빈 로비');

    console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('테스트 오류:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    process.exit();
  }
})();
