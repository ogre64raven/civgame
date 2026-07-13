// M5 검증: 채팅 라우팅 (전체/동맹/귓속말)
process.env.NEUTRAL_COUNT = '0'; // 기본 테스트는 중립 유닛 제외 (전용 테스트에서 수동 배치)
const { startServer, admin, Client, wait } = require('./testUtil');

const PORT = 3200;
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

(async () => {
  const server = await startServer(PORT, { PHASE_MEETING_MS: '600000', PHASE_EXEC_MS: '1000', ALLY_NO_CONTACT_CHECK: '1' });
  try {
    const A = new Client('갑', PORT), B = new Client('을', PORT), C = new Client('병', PORT);
    await A.connect(); await B.connect(); await C.connect();
    const aId = A.welcome.you, bId = B.welcome.you, cId = C.welcome.you;

    await admin(PORT, 'POST', 'start'); // 동맹 제안은 회의 턴에만 가능
    await A.next(m => m.type === 'gameStarted');

    A.send({ type: 'ally.propose', civId: bId });
    await B.next(m => m.type === 'allyProposed' && m.from === aId);
    B.send({ type: 'ally.accept', civId: aId });
    await A.next(m => m.type === 'allyFormed');

    A.send({ type: 'chat', to: 'all', text: '안녕하세요' });
    const c1 = await C.next(m => m.type === 'chat' && m.text === '안녕하세요');
    await B.next(m => m.type === 'chat' && m.text === '안녕하세요');
    await A.next(m => m.type === 'chat' && m.text === '안녕하세요');
    check(c1.scope === 'all' && c1.from === aId, '전체 채팅: 모두 수신');

    A.send({ type: 'chat', to: 'ally', text: '동맹비밀' });
    const b2 = await B.next(m => m.type === 'chat' && m.text === '동맹비밀');
    check(b2.scope === 'ally', '동맹 채팅: 동맹 수신');
    await wait(500);
    check(!C.inbox.some(m => m.type === 'chat' && m.text === '동맹비밀'), '동맹 채팅: 비동맹 미수신');

    A.send({ type: 'chat', to: cId, text: '귓속말테스트' });
    const c3 = await C.next(m => m.type === 'chat' && m.text === '귓속말테스트');
    check(c3.scope === 'dm' && c3.from === aId && c3.to === cId, '귓속말: 대상 수신');
    await wait(500);
    check(!B.inbox.some(m => m.type === 'chat' && m.text === '귓속말테스트'), '귓속말: 제3자 미수신');

    A.send({ type: 'chat', to: 'all', text: '   ' });
    await wait(500);
    check(!B.inbox.some(m => m.type === 'chat' && m.text?.trim() === ''), '공백 메시지 무시');

    A.send({ type: 'chat', to: 'all', text: 'x'.repeat(500) });
    const b5 = await B.next(m => m.type === 'chat' && m.text.startsWith('xxx'));
    check(b5.text.length === 200, `긴 메시지 200자 제한 (${b5.text.length})`);

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
