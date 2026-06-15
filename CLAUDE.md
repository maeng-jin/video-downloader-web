# CLAUDE.md — video-downloader-web

> 이 파일은 향후 세션(다른 Claude 인스턴스 포함)이 이 프로젝트를 빠르게 이해하고
> 이어서 작업할 수 있도록 만든 가이드입니다.
> **중요: 코드/동작에 변경이 생기면 이 문서를 반드시 같이 최신화할 것.**
> (맨 아래 "유지보수 규칙" 참조)

## 한 줄 요약
URL을 넣으면 **유튜브·인스타그램·당근마켓·스레드(Threads)** 영상을 미리보고
화질 선택 / mp3 추출 / 자막(SRT·임베드)까지 받을 수 있는 로컬 웹 서비스.

- 기본 포트: **37020** (`http://localhost:37020`, LAN: `http://<PC-IP>:37020`)
- 실행: `npm install` → (필요시) `npx playwright install chromium` → `npm start`
- 같은 git 루트의 자매 프로젝트 `../image-downloader-web` 의 딥스캔/렌더링
  기법을 차용함.

## 필수 외부 바이너리 (PATH에 있어야 함, 시작 시 자동 탐색)
- **yt-dlp** — 유튜브/인스타 등 메타데이터·다운로드 (`pip install -U yt-dlp`)
- **ffmpeg / ffprobe** — HLS 병합, mp3 변환, H.264 재인코딩, 길이/코덱 조회
- **playwright + chromium** — 스레드 영상 URL 추출용 (`npm i playwright` + 크로미움)
- 상태 확인: `GET /api/health` → `{ ytdlp, ffmpeg, ffprobe: true }`
  (이 PC에는 셋 다 설치되어 있고, 크로미움은 image-downloader-web와 공유 캐시)

## 아키텍처
```
video-downloader-web/
├── server.js          # 전체 백엔드 (Express). 아래 "핵심 흐름" 참조
├── logger.js          # 콘솔+파일 로거 (log.info/warn/error, requestLogger, lanAddresses)
├── restart-server.bat # 포트 종료 후 서버 시작 (ASCII 전용)
├── logs/              # server-YYYY-MM-DD.log (자동 생성, gitignore)
├── public/
│   ├── index.html     # URL 입력 · 미리보기 · 옵션 · 진행률 UI
│   ├── style.css
│   └── app.js         # info 조회 → 다운로드 → SSE 진행률 → 파일 저장
│                       #  + 초기화 버튼(resetAll): 입력값/미리보기/진행률 비우고
│                       #    history.replaceState로 ?url= 쿼리 제거(최신화)
├── package.json
├── README.md          # 사용자용 문서
└── CLAUDE.md          # (이 파일)
```

### 두 가지 다운로드 엔진
요청은 `engine` 값으로 갈린다. `/api/info` 응답의 `engine` 을 프론트가 그대로
`/api/download` 에 전달한다.
- **`ytdlp`** — 유튜브/인스타/generic. yt-dlp 자식 프로세스. 화질·자막·쿠키 지원.
- **`ffmpeg`** — 당근마켓/스레드. 이미 확보한 직접 영상 URL(mp4/m3u8)을
  ffmpeg 로 받음(HLS면 병합). 화질 선택 없음, mp3 추출은 됨.

### 플랫폼별 처리 (`detectPlatform`)
| 플랫폼 | 감지 | info 경로 | 엔진 |
|---|---|---|---|
| youtube | youtube.com / youtu.be | `ytdlpInfo` | ytdlp |
| instagram | instagram.com | `ytdlpInfo` | ytdlp |
| daangn | daangn.com / karrotmarket.com | `daangnInfo`(딥스캔) | ffmpeg |
| threads | threads.com / .net | `threadsInfo`(Playwright 렌더) | ffmpeg |
| generic | 그 외 | `ytdlpInfo` 시도 | ytdlp |

- **당근**: 페이지 HTML + `<script>` JSON 을 정규식 딥스캔(`deepScanVideos`)해
  `.mp4/.m3u8` URL 추출. 영상 없으면 `noVideo:true`.
- **스레드**: yt-dlp 미지원(Unsupported URL). Playwright(`renderForVideo`)로
  렌더 후 `<video>` src / og:video / 네트워크 video 응답에서 URL 수집.
  결과는 보통 cdninstagram 진행형 H.264 mp4.

## API 엔드포인트
- `GET /api/info?url=&cookies=<browser>` → `{platform, engine, title, thumbnail,
  duration, durationString, heights[], subtitles[], autoCaptions[], videos[], noVideo}`
- `POST /api/download` body `{url, engine, height?, audioOnly?, subLang?, subAuto?,
  subOnly?, embedSub?, cookies?, title?}` → `{jobId}`
- `GET /api/progress/:jobId` → **SSE**. `data:` 로 `{status, percent, stage,
  fileName, error}`. percent `-1` = 진행률 미상(스피너).
- `GET /api/file/:jobId` → 완료 파일 다운로드. 전송 후 5초 뒤 작업 폴더 정리.
- `GET /api/thumb?url=` → **썸네일 프록시**(핫링크 차단 우회). 아래 참조.
- `GET /api/health` → 바이너리 설치 상태.

## 주요 기능과 구현 위치 (server.js)
- **화질 선택 + H.264 우선** — `buildFormat(platform, height)`.
  H.264(avc1)+AAC 를 우선 선택해 mp4 호환성 확보. 인스타는 합쳐진 progressive(H.264)
  포맷을 먼저 시도.
- **재생 호환성 보장(중요)** — `ensureH264(job)`. 다운로드 결과 영상 코덱이
  H.264가 아니면(VP9/AV1) ffmpeg로 H.264 재인코딩. 진행 단계 "호환 변환 중".
  → 인스타 릴스가 "소리만 재생"되던 문제의 해결책. 이미 H.264면 건너뜀(빠름).
- **mp3 추출** — `audioOnly` → `yt-dlp -x --audio-format mp3` 또는 ffmpeg `-vn libmp3lame`.
- **자막** — `subtitles`(수동, 전부) + `autoCaptions`(자동생성, 흔한 16개 언어만).
  - `자막만(.srt)`: `--skip-download --write(-auto)-subs --sub-langs --convert-subs srt`
  - `영상에 자막 포함`: 영상 다운로드에 `--embed-subs` 추가 (mov_text 소프트 자막)
- **진행률** — yt-dlp `[download] N%` / ffmpeg `out_time_ms` 파싱 → job.percent → SSE.
- **쿠키(로그인 콘텐츠)** — `--cookies-from-browser <chrome|edge|firefox|brave>`.
  인스타 비공개/로그인 필요 콘텐츠용. 프론트 "🔐 브라우저 로그인 쿠키 사용".
- **썸네일 프록시** — cdninstagram 등은 브라우저 `<img>` 직접 로드 시 Referer
  핫링크 차단으로 안 보임. `/api/thumb` 가 서버에서 받아 동일 출처로 전달.
  프론트는 `thumb.src = /api/thumb?url=...` 로 로드.
- **작업/임시파일** — `jobs` Map + OS 임시폴더(`video-downloader-web/<jobId>/`).
  다운로드 후 또는 30분 경과 시 정리. `uncaughtException`/`unhandledRejection`
  핸들러로 단일 추출 실패가 서버를 죽이지 않게 함.

## 그동안 발견·해결한 핵심 이슈 (재발 방지용)
1. **yt-dlp `null` JSON → 크래시**: `meta.formats` 접근 전 `meta` null 가드 필수.
   + 프로세스 레벨 안전망(`process.on("uncaughtException"/"unhandledRejection")`).
2. **VP9-in-mp4 = 소리만 재생**: 인스타 DASH 영상은 VP9뿐. mp4로 합치면 다수
   플레이어가 영상 디코드 못 함 → `ensureH264` 재인코딩으로 해결.
3. **`-bsf:a aac_adtstoasc` 무조건 적용 금지**: AC3 등 비AAC 오디오에서 실패.
   ffmpeg가 AAC mp4 muxing 시 자동 적용하므로 강제하지 말 것(ffmpeg 엔진 copy).
4. **인스타 비로그인 차단**: 대부분 "empty media response". 공개 릴스 일부만 익명
   접근 가능. 그 외엔 브라우저 쿠키 필요. (Windows Chrome/Edge는 app-bound
   encryption으로 `--cookies-from-browser` 가 실패할 수 있음 — 알려진 한계.)
5. **스레드/cdninstagram 서명 URL은 시간제한**: info 로 URL 확보 후 곧바로
   다운로드해야 안전.
6. **포트 충돌(EADDRINUSE) 좀비 방지**: 시작 시 포트가 이미 쓰이면, 예전엔
   `uncaughtException` 핸들러가 에러를 삼켜 프로세스가 안 죽고 좀비로 남았음.
   → `app.listen()` 결과에 `server.on("error")` 를 달아 EADDRINUSE 시 안내 로그 후
   `process.exit(1)` 하도록 수정. **기존 서버를 안 끄고 또 실행하면** 새 인스턴스가
   깔끔히 종료됨(좀비 X). 재시작은 `restart-server.bat`(포트 자동 종료) 사용 권장.

## 실행 / 재시작 메모 (Windows)
- **가장 쉬운 재시작: `restart-server.bat` 더블클릭** (또는 `cmd /c restart-server.bat`).
  → 포트(37020) 점유 중인 기존 서버를 자동 종료하고 `node server.js` 로 새로 띄움.
  내용은 **ASCII 전용**(cmd 한글 깨짐 방지). 포트 바꾸려면 bat 안 `set "PORT="` 수정.
- 수동으로 하려면:
  ```powershell
  Get-NetTCPConnection -LocalPort 37020 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
  node server.js   # 또는 npm start
  ```
- LAN 접속하려면 방화벽 인바운드 허용(관리자):
  `New-NetFirewallRule -DisplayName "Video DL 37020" -Direction Inbound -Protocol TCP -LocalPort 37020 -Action Allow -Profile Private`
- 아이폰 단축어/공유: 프론트는 `?url=` 쿼리가 있으면 자동 실행(app.js `autoRun`).

## 로그 / 디버깅 (`logger.js`)
외부 의존성 없는 간단 로거. **콘솔 + 파일** 동시 출력.
- 파일: `logs/server-YYYY-MM-DD.log` (날짜별, UTF-8, `.gitignore` 처리됨).
- `log.info/warn/error(...)` — 어디서든 호출. `log.dir` = 로그 폴더 경로.
- `requestLogger` 미들웨어가 모든 요청을 `METHOD URL → status (ms)` 로 기록
  (4xx=warn, 5xx=error). server.js 최상단 `app.use(requestLogger)`.
- `lanAddresses()` — 시작 배너에서 LAN IPv4 출력용.
- 자동 기록 지점: 시작 배너(로컬+LAN 주소+PID), 다운로드 시작(`다운로드 시작 job=...`),
  작업 완료/실패(setJob 종료 상태), uncaught 예외/거부.
- 로그가 한글 깨져 보이면 **UTF-8 지원 에디터(VS Code 등)** 로 열 것(파일은 정상 UTF-8,
  cmd 콘솔/구버전 PowerShell 표시만 깨짐).

## 이식성 / 다른 PC로 옮기기 (검토 완료)
코드에는 **IP·localhost·사용자 경로 하드코딩이 없다.** 소스 복사 + 아래 환경만
갖추면 어느 PC에서나 동작한다.
- 프론트엔드 API 호출은 전부 **상대경로**(`/api/...`) → 접속한 호스트/IP를 그대로 따름.
- `app.listen(PORT)` 는 **모든 인터페이스(0.0.0.0)** 바인딩 → LAN IP로 접속 가능.
- 포트는 `process.env.PORT || 37020` → 환경변수로 변경 가능.
- 바이너리(yt-dlp/ffmpeg/ffprobe)는 `where`/`which` 로 **PATH에서 런타임 자동 탐색**
  (절대경로 하드코딩 없음). 시작 로그의 `localhost`는 안내 메시지일 뿐 동작 무관.

**새 PC 체크리스트**: ① Node 설치 ② yt-dlp·ffmpeg·ffprobe 를 PATH에 설치
③ `npm install` ④ `npx playwright install chromium`(스레드용) ⑤ 방화벽 37020
인바운드 허용(LAN 접속 시) ⑥ 포트 변경 필요하면 `PORT` 환경변수.

## 알려진 한계
- 유튜브·인스타 영상 다운로드는 각 플랫폼 ToS 위반 가능 — 개인/학습용 전제.
- 플랫폼 구조 변경 시 추출이 깨질 수 있음 → `pip install -U yt-dlp`.
- 스레드는 비공개/로그인 게시물·MSE(blob) 전용 스트림은 추출 불가.

## 유지보수 규칙 (Claude에게)
이 프로젝트를 수정할 때마다 **이 CLAUDE.md를 같은 커밋/변경 단위로 최신화**한다:
- 새 플랫폼/핸들러 추가 → "플랫폼별 처리" 표와 detectPlatform 설명 갱신
- API 시그니처 변경 → "API 엔드포인트" 갱신
- 새 기능/옵션 → "주요 기능" 갱신
- 버그 수정으로 얻은 교훈 → "발견·해결한 핵심 이슈"에 추가
- 포트/실행 방법 변경 → 해당 섹션 갱신
README.md(사용자용)도 사용자에게 보이는 동작이 바뀌면 함께 갱신할 것.
