# 온라인 문명

30명 동시접속 실시간 턴제 문명 게임. 실제 세계지도 기반 헥스맵 위에서 UN 회원국을 랜덤 배정받아 자원 채취, 연구, 전투, 외교로 경쟁한다. 규칙 상세는 [GAME_DESIGN.md](GAME_DESIGN.md) 참고.

## 실행

```bash
npm install
npm start          # http://localhost:3000
```

- **플레이어**: `/` 접속 → 이름 입력 → 로비 대기 → 관리자가 시작하면 게임 진행
- **관리자**: `/admin` 접속 → 비밀번호 입력 → 게임 시작/리셋, 턴 시간·턴 제한 설정, 강퇴

브라우저 탭을 여러 개 열면 멀티 플레이를 시험할 수 있다 (탭마다 다른 국가 배정).

### 국가 배정

- 바다 이동이 없으므로 본토와 단절된 고립 섬나라(태평양 도서국, 쿠바, 뉴질랜드, 아이슬란드 등 23개국)는 배정에서 제외된다 (170개국 배정 가능).
- 이 그리드 해상도에서 일본·영국·인도네시아 등은 본토와 연결되어 있어 정상 배정된다.

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 |
| `ADMIN_PASSWORD` | admin1234 | 관리자 페이지 비밀번호 (**배포 시 반드시 변경**) |
| `PHASE_MEETING_MS` | 30000 | 회의 턴 길이 (ms) — 관리자 페이지에서도 변경 가능 |
| `PHASE_EXEC_MS` | 10000 | 실행 턴 길이 (ms) |
| `TURN_LIMIT` | 120 | 점수 승리 판정 턴 |

## 테스트

```bash
node tools/testM3.js   # 전투·점령·생산 (유닛 테스트)
node tools/testM4.js   # 연구·동맹·흡수·승리 (유닛 테스트)
node tools/testM2.js   # 접속·이동·채취 (통합)
node tools/testM5.js   # 채팅 라우팅 (통합)
node tools/testM6.js   # 로비·관리자 API·배정 제외 (통합)
```

## 맵 재생성

```bash
npm i -D world-atlas topojson-client d3-geo
npm run buildmap       # data/worldmask.json 갱신
```

## 배포 (GitHub → 리눅스 컨테이너)

1. GitHub 저장소에 push하면 GitHub Actions가 테스트 → Docker 이미지 빌드 → GHCR 푸시를 자동 수행한다.
2. 리눅스 서버에서 실행:
   ```bash
   docker run -d --name online-civ --restart unless-stopped \
     -p 80:3000 -e ADMIN_PASSWORD='강력한비밀번호' \
     ghcr.io/<계정>/<저장소>:latest
   ```
3. (선택) push마다 서버 자동 배포: 저장소 Settings → Secrets에 `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_ADMIN_PASSWORD` 등록, Variables에 `DEPLOY_ENABLED=true` 설정.

서버에서 직접 빌드하는 경우:

```bash
git pull origin main
docker build -t online-civ .
docker rm -f online-civ 2>/dev/null; docker run -d --name online-civ --restart unless-stopped -p 80:3000 -e ADMIN_PASSWORD='강력한비밀번호' online-civ
```

## 구조

```
server/   게임 서버 (Node.js + ws, 서버 권위, 인메모리, 관리자 API)
client/   브라우저 클라이언트 (Canvas 2D) + 관리자 페이지 (admin.html)
data/     UN 193개국 · 세계지도 헥스 마스크
tools/    맵 빌드 스크립트 · 테스트
```
