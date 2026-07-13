// M1 검증: 31명 접속 → 30명 국가 배정(중복 없음, 육지 스폰, 유닛 3기), 31번째 관전자, 재접속 복귀
const WebSocket = require('ws');
const { World } = require('../server/world');

const URL = 'ws://localhost:3000';
const world = new World();
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

function joinOne(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error(name + ' timeout')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, token })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') { clearTimeout(t); resolve({ ws, msg }); }
    });
    ws.on('error', reject);
  });
}

(async () => {
  const results = [];
  for (let i = 1; i <= 31; i++) results.push(await joinOne('테스터' + i));

  const players = results.filter(r => !r.msg.spectator);
  const spectators = results.filter(r => r.msg.spectator);
  check(players.length === 30, `30명 배정 (실제 ${players.length})`);
  check(spectators.length === 1, `31번째는 관전자 (실제 ${spectators.length})`);

  const last = players[29].msg;
  const codes = last.civs.map(c => c.code);
  check(new Set(codes).size === 30, `국가 중복 없음 (${new Set(codes).size}/30)`);
  check(last.units.length === 90, `유닛 총 90기 (실제 ${last.units.length})`);

  const badSpawn = last.units.filter(u => !world.isLand(u.x, u.y));
  check(badSpawn.length === 0, `모든 유닛 육지 스폰 (바다 스폰 ${badSpawn.length})`);

  const perCiv = {};
  for (const u of last.units) perCiv[u.civ] = (perCiv[u.civ] || 0) + 1;
  check(Object.values(perCiv).every(n => n === 3), '문명당 유닛 3기');

  check(last.phase === 'MEETING' || last.phase === 'EXECUTION', `페이즈 수신 (${last.phase}, 턴 ${last.turn})`);
  check(typeof last.token === 'string' && last.token.length === 32, '세션 토큰 발급');

  // 재접속: 1번 종료 후 같은 토큰으로 복귀
  const tok = players[0].msg.token, myId = players[0].msg.you;
  players[0].ws.close();
  await new Promise(r => setTimeout(r, 300));
  const re = await joinOne('테스터1-재접속', tok);
  check(re.msg.you === myId && !re.msg.spectator, `재접속 시 같은 문명 복귀 (civ ${re.msg.you})`);

  // 페이즈 전환 브로드캐스트 수신 (최대 40초 대기)
  const phaseMsg = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 41000);
    re.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'phase') { clearTimeout(t); resolve(m); }
    });
  });
  check(!!phaseMsg, phaseMsg ? `페이즈 전환 수신 (${phaseMsg.phase}, endsAt ok=${phaseMsg.endsAt > Date.now()})` : '페이즈 전환 수신');

  console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('테스트 오류:', e.message); process.exit(1); });
