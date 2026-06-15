# 🎬 영상 다운로더 (Video Downloader Web)

URL을 입력하면 **유튜브 · 인스타그램 · 당근마켓 · 스레드(Threads)** 영상을
미리보고, 원하는 화질로 다운로드하거나 **오디오(mp3)만 추출**할 수 있는 로컬 웹
서비스입니다.

- 기본 주소: **http://localhost:37020** (같은 네트워크에서는 `http://<PC-IP>:37020`)

## 주요 기능

- **플랫폼 자동 감지**: youtube / instagram / daangn / threads / generic(그 외)
- **초기화 버튼**: 입력값·미리보기·진행률을 비우고 주소창의 `?url=` 쿼리까지 최신화(제거)
- **메타데이터 미리보기**: 제목, 썸네일, 길이, 선택 가능한 화질
- **화질 선택**: 2160p / 1440p / 1080p / 720p / 480p / 360p / 240p 중 가능한 것
  (yt-dlp 지원 플랫폼). H.264(avc1)+AAC 포맷을 우선 선택해 mp4 호환성을 높임.
- **오디오만(mp3) 추출**
- **자막**: 수동 자막(전부) + 자동생성 자막(흔한 16개 언어) 목록 노출
  - `자막 다운로드(.srt)` — 선택 언어 자막만 SRT로 저장 (영상 다운로드 생략)
  - `영상에 자막 포함` — 다운로드 영상에 소프트 자막(mov_text)으로 내장
- **실시간 진행률**: yt-dlp/ffmpeg 진행 로그를 파싱해 % 표시 (SSE)
- **재생 호환성(H.264 보장)**: 다운로드 결과 영상이 VP9/AV1(일부 플레이어에서
  "영상 없이 소리만" 재생되는 코덱)이면 자동으로 H.264로 재인코딩해 mp4가
  어디서나 재생되게 함. 인스타그램 릴스(분리 스트림이 VP9)에 특히 중요.
  이미 H.264면 재인코딩 없이 빠르게 통과.
- **스레드(Threads) 영상**: yt-dlp 미지원이라 **Playwright(헤드리스 크로미움)** 로
  페이지를 렌더링해 `<video>`/`og:video`/네트워크 응답에서 영상 URL(주로
  cdninstagram 진행형 H.264 mp4)을 추출 → ffmpeg로 다운로드.
- **당근마켓 영상**: yt-dlp가 지원하지 않으므로 페이지 HTML/`<script>` JSON에서
  `.mp4`/`.m3u8` 영상 URL을 **딥 스캔**으로 추출 → ffmpeg로 다운로드(HLS면 병합).
- **썸네일 프록시**: cdninstagram 등 핫링크(Referer) 차단 썸네일도 서버가 대신
  받아 동일 출처로 전달해 미리보기가 보이도록 함.
- **LAN 공유 / 아이폰 단축어**: 모든 인터페이스(0.0.0.0)에 바인딩되어 같은
  네트워크의 다른 기기에서도 접속 가능. `?url=...` 쿼리가 있으면 자동 실행되어
  iOS 공유 시트/단축어와 연동하기 좋음.

## 사전 준비 (필수 바이너리)

이 서비스는 외부 바이너리 **yt-dlp**, **ffmpeg/ffprobe**, 그리고 스레드 추출용
**Playwright + 크로미움**을 호출합니다. 모두 시스템 PATH에 있어야 하며 서버 시작
시 자동으로 경로를 탐색합니다.

```bash
# yt-dlp (Python 필요) — 유튜브/인스타 등 메타데이터·다운로드
pip install -U yt-dlp

# ffmpeg / ffprobe — HLS 병합, mp3 변환, H.264 재인코딩, 길이·코덱 조회
# Windows: winget install Gyan.FFmpeg  (또는 https://ffmpeg.org)
```

- 설치 확인: 서버 실행 후 `GET /api/health` 가 `bin: { ytdlp, ffmpeg, ffprobe: true }`
  를 반환하는지 확인하세요.
- yt-dlp는 플랫폼 변경에 맞춰 자주 업데이트됩니다. 추출이 깨지면
  `pip install -U yt-dlp` 로 최신화하세요.
- Playwright/크로미움은 **스레드(Threads) 영상에만** 필요합니다. 스레드를 쓰지
  않는다면 설치를 건너뛰어도 다른 플랫폼은 정상 동작합니다.

## 실행

```bash
cd video-downloader-web
npm install
npx playwright install chromium   # 스레드(Threads)용 — 1회만
npm start                         # 개발: npm run dev (파일 변경 시 자동 재시작)
```

브라우저에서 http://localhost:37020 접속.

### 재시작 (Windows)

- **가장 쉬운 방법: `restart-server.bat` 더블클릭** — 포트(37020)를 점유 중인 기존
  서버를 자동 종료하고 새로 띄웁니다. 포트를 바꾸려면 bat 안의 `set "PORT="` 수정.
- 수동:
  ```powershell
  Get-NetTCPConnection -LocalPort 37020 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
  npm start
  ```
- 포트는 환경변수로 변경 가능: `PORT=8080 npm start`.
  (이미 사용 중인 포트면 좀비로 남지 않고 안내 로그 후 즉시 종료됩니다.)

### LAN 접속 (방화벽)

같은 네트워크의 다른 기기에서 접속하려면 인바운드 허용이 필요할 수 있습니다
(관리자 PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Video DL 37020" -Direction Inbound -Protocol TCP -LocalPort 37020 -Action Allow -Profile Private
```

## API

- **`GET /api/info?url=&cookies=<browser>`** — 메타데이터 조회
  → `{ platform, engine, title, thumbnail, duration, durationString, uploader,
  heights[], subtitles[], autoCaptions[], videos[], noVideo }`
  - youtube/instagram/generic: `yt-dlp -J` 로 조회 (`engine: "ytdlp"`)
  - daangn: 페이지 HTML/`<script>` JSON 딥 스캔으로 `.mp4`/`.m3u8` URL 추출
    (`engine: "ffmpeg"`)
  - threads: Playwright 렌더링으로 영상 URL 추출 (`engine: "ffmpeg"`)
- **`POST /api/download`** body
  `{ url, engine, height?, audioOnly?, subLang?, subAuto?, subOnly?, embedSub?, cookies?, title? }`
  → `{ jobId }`
  - `engine: "ytdlp"` → yt-dlp 로 다운로드/병합/오디오추출/자막
  - `engine: "ffmpeg"` → ffmpeg 로 HLS/mp4 다운로드(또는 mp3 변환)
- **`GET /api/progress/:jobId`** — SSE 로 진행률/상태 스트리밍
  `data:` 로 `{ status, percent, stage, fileName, error }` 전송 (percent `-1` = 진행률 미상)
- **`GET /api/file/:jobId`** — 완료된 파일 다운로드 (전송 5초 뒤 임시파일 자동 삭제)
- **`GET /api/thumb?url=`** — 썸네일 프록시 (핫링크 차단 우회)
- **`GET /api/health`** — 바이너리 설치 상태

임시 파일은 작업별 폴더(OS 임시 디렉터리 `video-downloader-web/<jobId>/`)에 저장되고,
다운로드 후 또는 30분 경과 시 자동 정리됩니다.

## 로그인 필요 콘텐츠 (브라우저 쿠키 사용)

**인스타그램은 현재 로그인하지 않은 접근을 거의 모두 차단**합니다(yt-dlp가
"empty media response" 를 받음). 따라서 인스타그램 영상은 **브라우저 로그인
쿠키**가 있어야 받을 수 있습니다.

- 화면 상단의 **`🔐 브라우저 로그인 쿠키 사용`** 을 체크하고, 인스타그램에
  로그인되어 있는 브라우저를 선택하세요.
  (chrome / edge / firefox / brave / chromium / opera / vivaldi / safari)
- 내부적으로 yt-dlp `--cookies-from-browser <브라우저>` 를 사용합니다.
- Windows의 Chrome 계열은 app-bound encryption 때문에 쿠키 DB가 잠겨 실패할 수
  있습니다(알려진 한계). 해당 브라우저를 완전히 종료한 뒤 시도하거나 Firefox를
  사용하세요.
- ⚠️ 본인 계정의 인증 정보로 접근하므로, 반드시 **본인이 접근 권한을 가진
  콘텐츠**에만 사용하세요.

## 제약 / 주의

- ⚠️ **저작권 · 이용약관**: 각 플랫폼의 ToS와 저작권을 준수해야 합니다. 본인이
  권리를 가진 콘텐츠, 또는 다운로드가 허용된 범위·개인 학습용으로만 사용하세요.
  유튜브·인스타그램 영상 다운로드는 각 서비스 약관 위반이 될 수 있습니다.
- **인스타그램**: 위 "브라우저 쿠키" 없이는 사실상 실패합니다.
- **당근마켓**은 영상이 없는 게시글이 많으며, 이 경우 "영상 없음"으로 안내합니다.
- **스레드**: 비공개/로그인 게시물·MSE(blob) 전용 스트림은 추출할 수 없습니다.
- **서명 URL은 시간제한**: 스레드/cdninstagram URL은 짧은 시간만 유효하므로 info
  조회 후 곧바로 다운로드하세요.
- 플랫폼이 구조를 바꾸면 추출이 일시적으로 실패할 수 있습니다
  (`pip install -U yt-dlp` 로 최신화).

## 로그

- 콘솔과 파일에 동시 출력됩니다: `logs/server-YYYY-MM-DD.log` (날짜별, UTF-8).
- 모든 요청이 `METHOD URL → status (ms)` 로 기록되며, 시작 배너에 로컬/LAN 주소와
  PID가 표시됩니다.
- cmd/구버전 PowerShell 콘솔에서 한글이 깨져 보이면 로그 **파일**을 VS Code 등
  UTF-8 에디터로 여세요(파일 자체는 정상 UTF-8).

## 기술 스택

- 백엔드: Node.js + Express, child_process(yt-dlp / ffmpeg / ffprobe),
  cheerio(HTML 파싱), playwright(스레드 렌더링)
- 프론트엔드: 순수 HTML/CSS/JavaScript, EventSource(SSE)
