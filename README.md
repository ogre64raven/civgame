# 온라인 문명

30명 동시접속 실시간 턴제 문명 게임. 실제 세계지도 기반 헥스맵 위에서 UN 회원국을 랜덤 배정받아 자원 채취, 연구, 전투, 외교로 경쟁한다. 규칙 상세는 [GAME_DESIGN.md](GAME_DESIGN.md) 참고.

## 실행

```bash
npm install
npm start          # http://localhost:3000
```

브라우저 탭을 여러 개 열면 멀티 플레이를 시험할 수 있다 (탭마다 다른 국가 배정).

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 |
| `PHASE_MEETING_MS` | 30000 | 회의 턴 길이 (ms) |
| `PHASE_EXEC_MS` | 10000 | 실행 턴 길이 (ms) |
| `TURN_LIMIT` | 120 | 점수 승리 판정 턴 |

## 테스트

```bash
node tools/testM3.js   # 전투·점령·생산 (유닛 테스트)
node tools/testM4.js   # 연구·동맹·흡수·승리 (유닛 테스트)
node tools/testM2.js   # 접속·이동·채취 (통합, 서버 자동 스폰)
```

## 맵 재생성

```bash
npm i -D world-atlas topojson-client d3-geo
npm run buildmap       # data/worldmask.json 갱신
```

## 배포 (GitHub → 리눅스 컨테이너)

1. GitHub 저장소 생성 후 push:
   ```bash
   git init
   git add -A
   git commit -m "online-civ"
   git remote add origin https://github.com/<계정>/<저장소>.git
   git push -u origin main
   ```
2. push하면 GitHub Actions가 테스트 → Docker 이미지 빌드 → GHCR(`ghcr.io/<계정>/<저장소>`) 푸시까지 자동 수행한다.
3. 리눅스 서버에서 직접 실행:
   ```bash
   docker run -d --name online-civ --restart unless-stopped -p 80:3000 ghcr.io/<계정>/<저장소>:latest
   ```
4. (선택) push마다 서버 자동 배포: 저장소 Settings → Secrets에 `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` 등록, Variables에 `DEPLOY_ENABLED=true` 설정.

## 구조

```
server/   게임 서버 (Node.js + ws, 서버 권위, 인메모리)
client/   브라우저 클라이언트 (Canvas 2D, 의존성 없음)
data/     UN 193개국 · 세계지도 헥스 마스크
tools/    맵 빌드 스크립트 · 테스트
```
