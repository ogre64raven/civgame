// M6 검증: 로비 대기·관리자 API (인증/시작/설정/강퇴/리셋)·섬나라 배정 제외
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
  check(!eligible.has('TV') && !eligible.has('NR') && !eligible.has('FJ'), '태평양 도서국 배정 제외');
  check(g.pool.length >= 30, `배정 가능 국가 30개국 이상 (${g.pool.length})`);
  let bad = 0;
  for (const i of g.pool) {
    const [x, y] = world.lonlatToHex(countries[i].cap[0], countries[i].cap[1]);
    const nl = world.nearestLand(x, y, null, 2);
    if (!nl || (sizes.get(nl[0] + ',' + nl[1]) || 0) < MIN_LANDMASS) bad++;
  }
  check(bad === 0, `배정 풀 전체가 ${MIN_LANDMASS}헥스 이상 대륙 (위반 ${bad})`);
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
