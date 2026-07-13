// M2 검증: (로비→시작 후) 이동 명령·경로·실행 턴 이동·채취·명령 거부
const { World } = require('../server/world');
const { startServer, admin, Client } = require('./testUtil');

const PORT = 3100;
const world = new World();
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

(async () => {
  const server = await startServer(PORT, { PHASE_MEETING_MS: '2500', PHASE_EXEC_MS: '800' });
  try {
    const A = new Client('공격자', PORT);
    const B = new Client('수비자', PORT);
    await A.connect();
    await B.connect();

    check(!!A.welcome.resources && Array.isArray(A.welcome.orders), 'welcome에 자원·명령 포함');

    // 게임 시작 (관리자)
    await admin(PORT, 'POST', 'start');
    const gs = await A.next(m => m.type === 'gameStarted');
    check(gs.units.length === 6 && gs.phase === 'MEETING', '게임 시작: 유닛 6기 스폰');

    const myUnits = gs.units.filter(u => u.civ === A.welcome.you);
    const u = myUnits[0];

    // 적 유닛 위치 (전투 회피용)
    const enemySet = new Set(gs.units.filter(x => x.civ !== A.welcome.you).map(x => x.x + ',' + x.y));
    const safe = (x, y) => !enemySet.has(x + ',' + y);

    let target = null;
    outer:
    for (const [n1x, n1y] of world.neighbors(u.x, u.y)) {
      if (!world.isLand(n1x, n1y) || !safe(n1x, n1y)) continue;
      for (const [n2x, n2y] of world.neighbors(n1x, n1y)) {
        if (!world.isLand(n2x, n2y) || !safe(n2x, n2y)) continue;
        if (n2x === u.x && n2y === u.y) continue;
        target = [n2x, n2y];
        break outer;
      }
    }
    check(!!target, '2칸 거리 안전한 육지 목표 탐색');

    A.clearInbox();
    A.send({ type: 'order.move', unitId: u.id, target });
    const ack = await A.next(m => m.type === 'orderAck' && m.unitId === u.id);
    check(ack.path.length >= 1 && ack.path.length <= 3, `경로 수신 (${ack.path.length}칸)`);

    const bUnit = gs.units.find(x => x.civ !== A.welcome.you);
    A.send({ type: 'order.move', unitId: bUnit.id, target });
    const rej1 = await A.next(m => m.type === 'orderRejected' && m.unitId === bUnit.id);
    check(rej1.reason === 'unit', `남의 유닛 명령 거부 (${rej1.reason})`);

    let sea = null;
    for (let y = 0; y < world.h && !sea; y++)
      for (let x = 0; x < world.w && !sea; x++)
        if (!world.isLand(x, y)) sea = [x, y];
    A.send({ type: 'order.move', unitId: u.id, target: sea });
    const rej2 = await A.next(m => m.type === 'orderRejected' && m.unitId === u.id);
    check(rej2.reason === 'target', `바다 목표 거부 (${rej2.reason})`);

    const exec1 = await A.next(m => m.type === 'exec' && m.moves.some(v => v.unitId === u.id), 10000);
    const mv1 = exec1.moves.find(v => v.unitId === u.id);
    check(mv1.x === ack.path[0][0] && mv1.y === ack.path[0][1], `실행 턴에 1칸 이동 (${mv1.x},${mv1.y})`);

    const execB = await B.next(m => m.type === 'exec' && m.moves.some(v => v.unitId === u.id), 10000);
    check(!!execB, '상대 클라이언트도 이동 수신');

    const res1 = await A.next(m => m.type === 'resources', 10000);
    const total = Object.values(res1.resources).reduce((a, b) => a + b, 0);
    check(total > 0, `채취 동작 (누적 자원 ${total})`);
    check(res1.gained && Object.values(res1.gained).some(v => v > 0), '이번 턴 채취량 수신');

    let reached = false;
    for (let i = 0; i < ack.path.length + 2 && !reached; i++) {
      const ex = await A.next(m => m.type === 'exec' && m.moves.some(v => v.unitId === u.id), 12000).catch(() => null);
      if (!ex) break;
      A.inbox = A.inbox.filter(m => m !== ex);
      const mv = ex.moves.find(v => v.unitId === u.id);
      if (mv.x === target[0] && mv.y === target[1]) reached = true;
    }
    check(reached, `목표 헥스 도달 (${target})`);

    await A.next(m => m.type === 'phase' && m.phase === 'EXECUTION', 10000);
    A.clearInbox();
    A.send({ type: 'order.move', unitId: u.id, target: [u.x, u.y] });
    const rej3 = await A.next(m => m.type === 'orderRejected');
    check(rej3.reason === 'phase', `실행 턴 중 명령 거부 (${rej3.reason})`);

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
