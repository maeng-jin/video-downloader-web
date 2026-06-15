import express from "express";
import * as cheerio from "cheerio";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, requestLogger, lanAddresses, LOG_DIR } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 37020;

// 다운로드 임시 작업 디렉터리 루트
const WORK_ROOT = path.join(os.tmpdir(), "video-downloader-web");
fs.mkdirSync(WORK_ROOT, { recursive: true });

// ---- 바이너리 경로 해석 (PATH에서 1회 탐색) ----
function resolveBin(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}
const BIN = {
  ytdlp: resolveBin("yt-dlp"),
  ffmpeg: resolveBin("ffmpeg"),
  ffprobe: resolveBin("ffprobe"),
};
log.info("바이너리 경로:", JSON.stringify(BIN));

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

app.use(requestLogger);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- 작업(job) 저장소 ----
/** jobId -> { status, percent, stage, fileName, filePath, error, dir, proc, createdAt } */
const jobs = new Map();

function setJob(job, patch) {
  Object.assign(job, patch);
  // 작업 종료 상태는 디버깅을 위해 기록
  if (patch.status === "done") log.info(`작업 완료 job=${job.id} file="${job.fileName}"`);
  else if (patch.status === "error") log.error(`작업 실패 job=${job.id}: ${job.error || ""}`);
}

// ---- 유틸 ----
function detectPlatform(url) {
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/(?:daangn\.com|karrotmarket\.com)/i.test(url)) return "daangn";
  if (/threads\.(?:com|net)/i.test(url)) return "threads";
  return "generic";
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function toAbsolute(raw, baseUrl) {
  if (!raw) return null;
  const u = raw.trim();
  if (!u || u.startsWith("data:") || u.startsWith("blob:")) return null;
  try {
    return new URL(u, baseUrl).href;
  } catch {
    return null;
  }
}

function unescapeForScan(text) {
  return text
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?38;/g, "&");
}

// 딥 스캔: HTML + <script> 에서 .mp4 / .m3u8 영상 URL 추출
const VIDEO_RE =
  /https?:\/\/[^\s"'`<>(){}\[\]\\]+?\.(?:mp4|m3u8|webm|mov)(?:\?[^\s"'`<>(){}\[\]\\]*)?/gi;

function deepScanVideos(html, $, baseUrl) {
  const urls = new Set();
  const scan = (raw) => {
    if (!raw) return;
    const text = unescapeForScan(raw);
    const m = text.match(VIDEO_RE);
    if (m) for (const x of m) urls.add(x);
  };
  scan(html);
  $("script").each((_, el) => scan($(el).text()));
  // <video src> / <source src>
  $("video[src], source[src]").each((_, el) => urls.add($(el).attr("src")));

  const out = [];
  const seen = new Set();
  for (const u of urls) {
    const abs = toAbsolute(u, baseUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const ext = /\.m3u8/i.test(abs) ? "m3u8" : abs.match(/\.(mp4|webm|mov)/i)?.[1]?.toLowerCase() || "mp4";
    out.push({ url: abs, ext });
  }
  return out;
}

// ===================== /api/info =====================
app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "유효한 http(s) URL을 입력해 주세요." });
  }
  const platform = detectPlatform(url);
  const cookiesBrowser = normalizeBrowser(req.query.cookies);

  try {
    if (platform === "daangn") {
      return res.json(await daangnInfo(url));
    }
    if (platform === "threads") {
      return res.json(await threadsInfo(url));
    }
    // 유튜브/인스타/그 외 → yt-dlp
    if (!BIN.ytdlp) {
      return res.status(500).json({
        error:
          "yt-dlp 가 설치되어 있지 않습니다. 'pip install -U yt-dlp' 또는 https://github.com/yt-dlp/yt-dlp 를 참고하세요.",
      });
    }
    const info = await ytdlpInfo(url, { cookiesBrowser });
    return res.json({ ...info, platform, engine: "ytdlp" });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// 쿠키 브라우저 인자 검증 (yt-dlp --cookies-from-browser 용)
const ALLOWED_BROWSERS = ["chrome", "edge", "firefox", "brave", "chromium", "opera", "vivaldi", "safari"];
function normalizeBrowser(v) {
  if (!v || typeof v !== "string") return null;
  const b = v.trim().toLowerCase();
  return ALLOWED_BROWSERS.includes(b) ? b : null;
}
function cookieArgs(cookiesBrowser) {
  return cookiesBrowser ? ["--cookies-from-browser", cookiesBrowser] : [];
}

function ytdlpInfo(url, { cookiesBrowser } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      BIN.ytdlp,
      ["-J", "--no-playlist", "--no-warnings", ...cookieArgs(cookiesBrowser), url],
      { maxBuffer: 1024 * 1024 * 128, timeout: 45000 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          return reject(
            new Error(
              "메타데이터를 가져오지 못했습니다. (비공개/로그인 필요 콘텐츠이거나 지원되지 않는 URL일 수 있습니다)\n" +
                (stderr || err.message).split("\n").slice(-3).join("\n")
            )
          );
        }
        let meta;
        try {
          meta = JSON.parse(stdout);
        } catch {
          return reject(new Error("yt-dlp 응답을 해석하지 못했습니다."));
        }
        if (!meta || typeof meta !== "object") {
          return reject(
            new Error(
              "영상 정보를 가져오지 못했습니다. (비공개/로그인 필요 콘텐츠이거나 지원되지 않는 URL일 수 있습니다)"
            )
          );
        }
        // 화질 목록(영상+높이) 추출
        const heights = new Set();
        for (const f of meta.formats || []) {
          if (f.vcodec && f.vcodec !== "none" && f.height) heights.add(f.height);
        }
        const sortedHeights = [...heights].sort((a, b) => b - a);
        // 흔한 화질만 노출 (있으면)
        const common = [2160, 1440, 1080, 720, 480, 360, 240];
        const offered = common.filter((h) =>
          sortedHeights.some((sh) => sh >= h - 1 && sh <= h + 60)
        );

        // 자막: 수동 자막은 전부, 자동생성은 흔한 언어만 노출(157개 폭주 방지)
        const subManual = Object.keys(meta.subtitles || {}).filter(
          (l) => l && l !== "live_chat"
        );
        const COMMON_SUB = [
          "ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de",
          "vi", "th", "id", "ru", "pt", "hi", "ar", "it",
        ];
        const autoAll = Object.keys(meta.automatic_captions || {});
        const subAuto = COMMON_SUB.filter((l) => autoAll.includes(l));

        resolve({
          title: meta.title || meta.id || "video",
          thumbnail: meta.thumbnail || (meta.thumbnails?.slice(-1)[0]?.url ?? ""),
          duration: meta.duration || 0,
          durationString: fmtDuration(meta.duration),
          uploader: meta.uploader || meta.channel || "",
          heights: offered.length ? offered : sortedHeights.slice(0, 6),
          subtitles: subManual,
          autoCaptions: subAuto,
        });
      }
    );
  });
}

async function daangnInfo(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`페이지 응답 오류 (HTTP ${resp.status})`);
  const finalUrl = resp.url || url;
  const html = await resp.text();
  const $ = cheerio.load(html);
  const videos = deepScanVideos(html, $, finalUrl);
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    "당근마켓 영상";
  const thumbnail = $('meta[property="og:image"]').attr("content") || "";
  return {
    platform: "daangn",
    engine: "ffmpeg",
    title,
    thumbnail,
    duration: 0,
    durationString: "",
    videos, // [{url, ext}]
    noVideo: videos.length === 0,
  };
}

// ---- Playwright 헤드리스 (Threads 등 SPA 영상 추출용, 인스턴스 재사용) ----
let _browserPromise = null;
async function getBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    _browserPromise = null;
  }
  const { chromium } = await import("playwright");
  _browserPromise = chromium.launch({ headless: true });
  return _browserPromise;
}

/**
 * 페이지를 실제 렌더링해 영상 URL을 수집.
 * - DOM <video>/<source> 의 src/currentSrc
 * - og:video 메타
 * - 로딩 중 발생한 video/* (또는 .mp4) 네트워크 응답
 * blob: URL(MSE)은 직접 받을 수 없어 제외.
 */
async function renderForVideo(targetUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: BROWSER_UA, locale: "ko-KR" });
  const page = await context.newPage();
  const netVideos = new Map(); // base(쿼리 제외) -> 전체 URL
  page.on("response", (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (ct.startsWith("video/") || /\.mp4(?:\?|$)/i.test(u) || /\.m3u8(?:\?|$)/i.test(u)) {
        const base = u.split("?")[0];
        if (!netVideos.has(base)) netVideos.set(base, u);
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(2500);
    const meta = await page.evaluate(() => {
      const vids = [];
      document.querySelectorAll("video").forEach((v) => {
        if (v.src) vids.push(v.src);
        if (v.currentSrc) vids.push(v.currentSrc);
        v.querySelectorAll("source").forEach((s) => s.src && vids.push(s.src));
      });
      const m = (p) =>
        document.querySelector(`meta[property="${p}"]`)?.content || "";
      return {
        domVids: vids,
        ogVideo: m("og:video:secure_url") || m("og:video:url") || m("og:video"),
        title: m("og:title") || document.title || "",
        thumbnail: m("og:image") || "",
        finalUrl: location.href,
      };
    });

    // 우선순위: DOM video → og:video → 네트워크
    const ordered = [
      ...meta.domVids,
      ...(meta.ogVideo ? [meta.ogVideo] : []),
      ...netVideos.values(),
    ].filter((u) => u && /^https?:\/\//.test(u));

    const seen = new Set();
    const videos = [];
    for (const u of ordered) {
      const base = u.split("?")[0];
      if (seen.has(base)) continue;
      seen.add(base);
      videos.push({ url: u, ext: /\.m3u8/i.test(u) ? "m3u8" : "mp4" });
    }
    return { videos, title: meta.title, thumbnail: meta.thumbnail, finalUrl: meta.finalUrl };
  } finally {
    await context.close().catch(() => {});
  }
}

async function threadsInfo(url) {
  let r;
  try {
    r = await renderForVideo(url);
  } catch (e) {
    if (
      /Cannot find (module|package) 'playwright'|ERR_MODULE_NOT_FOUND/.test(e.message)
    ) {
      throw new Error(
        "스레드 영상 추출에는 Playwright 설치가 필요합니다: npm i playwright && npx playwright install chromium"
      );
    }
    throw new Error(`스레드 페이지 렌더링 실패: ${e.message}`);
  }
  return {
    platform: "threads",
    engine: "ffmpeg",
    title: (r.title || "threads-video").replace(/\s+/g, " ").trim(),
    thumbnail: r.thumbnail || "",
    duration: 0,
    durationString: "",
    videos: r.videos,
    noVideo: r.videos.length === 0,
  };
}

// ===================== /api/download =====================
// body: { url, engine: "ytdlp"|"ffmpeg", height?, audioOnly? }
app.post("/api/download", (req, res) => {
  const { url, engine, height, audioOnly, title, subLang, subAuto, subOnly, embedSub } =
    req.body || {};
  const cookiesBrowser = normalizeBrowser(req.body?.cookies);
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "유효한 URL이 아닙니다." });
  }
  // 자막 언어 코드 검증 (ko, en, zh-Hans 형태만 허용)
  const safeSubLang = /^[a-zA-Z]{2,3}(?:-[A-Za-z]+)?$/.test(subLang || "")
    ? subLang
    : null;
  if (subOnly && !safeSubLang) {
    return res.status(400).json({ error: "자막 언어를 선택해 주세요." });
  }
  if (engine === "ytdlp" && !BIN.ytdlp) {
    return res.status(500).json({ error: "yt-dlp 가 설치되어 있지 않습니다." });
  }
  if (engine === "ffmpeg" && !BIN.ffmpeg) {
    return res.status(500).json({ error: "ffmpeg 가 설치되어 있지 않습니다." });
  }

  const jobId = randomUUID();
  const dir = path.join(WORK_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id: jobId,
    title: typeof title === "string" ? title : "",
    status: "running",
    percent: -1, // -1 = 진행률 미상(스피너)
    stage: "준비 중",
    fileName: null,
    filePath: null,
    error: null,
    dir,
    proc: null,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);
  log.info(
    `다운로드 시작 job=${jobId} engine=${engine} ` +
      `${audioOnly ? "audio(mp3) " : ""}${subOnly ? "sub-only " : ""}` +
      `${height ? "height<=" + height + " " : ""}url=${url}`
  );
  res.json({ jobId });

  if (engine === "ffmpeg") {
    startFfmpegJob(job, { url, audioOnly: !!audioOnly });
  } else {
    startYtdlpJob(job, {
      url,
      platform: detectPlatform(url),
      height,
      audioOnly: !!audioOnly,
      cookiesBrowser,
      subLang: safeSubLang,
      subAuto: !!subAuto,
      subOnly: !!subOnly,
      embedSub: !!embedSub,
    });
  }
});

// 플랫폼/화질에 맞는 yt-dlp 포맷 선택자 생성.
// H.264(avc1)+AAC 를 우선해 mp4 호환성을 높인다. (VP9/AV1-in-mp4 는 일부
// 플레이어에서 영상이 안 보이고 소리만 나는 문제가 있음)
function buildFormat(platform, height) {
  const h = parseInt(height, 10);
  const cap = h ? `[height<=${h}]` : "";
  const h264 = "[vcodec~='^(avc1|h264)']";
  const aac = "[acodec~='^(mp4a|aac)']";
  if (platform === "instagram") {
    // 인스타는 분리 스트림이 VP9 뿐이고, 합쳐진 progressive 포맷이 H.264.
    // 호환성을 위해 합쳐진 포맷(b)을 먼저 시도. (안 되면 VP9 → 이후 재인코딩)
    return [
      `b${cap}${h264}`,
      `b${h264}`,
      `bv*${cap}${h264}+ba`,
      `bv*${cap}+ba`,
      `b${cap}`,
      `best`,
    ].join("/");
  }
  // 유튜브 등: 화질 한도 내에서 H.264 우선, 없으면 최고 품질
  return [
    `bv*${cap}${h264}+ba${aac}`,
    `bv*${cap}${h264}+ba`,
    `b${cap}${h264}`,
    `bv*${cap}+ba`,
    `b${cap}`,
    `best`,
  ].join("/");
}

function startYtdlpJob(
  job,
  { url, platform, height, audioOnly, cookiesBrowser, subLang, subAuto, subOnly, embedSub }
) {
  const outTmpl = path.join(job.dir, "%(title).180B [%(id)s].%(ext)s");
  const args = ["--no-playlist", "--newline", "--no-warnings", ...cookieArgs(cookiesBrowser), "-o", outTmpl];

  if (BIN.ffmpeg) args.push("--ffmpeg-location", path.dirname(BIN.ffmpeg));

  if (subOnly) {
    // 자막만 다운로드 (영상 스킵, SRT로 변환)
    args.push(
      "--skip-download",
      subAuto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", subLang,
      "--convert-subs", "srt"
    );
  } else if (audioOnly) {
    args.push("-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("-f", buildFormat(platform, height), "--merge-output-format", "mp4");
    // 영상에 자막 포함(소프트 자막)
    if (subLang) {
      args.push(
        subAuto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs", subLang,
        "--convert-subs", "srt"
      );
      if (embedSub) args.push("--embed-subs");
    }
  }
  args.push(url);

  setJob(job, {
    stage: subOnly
      ? "자막 다운로드 중"
      : audioOnly
      ? "오디오 추출 중"
      : "다운로드 중",
  });
  const proc = spawn(BIN.ytdlp, args);
  job.proc = proc;

  const onLine = (buf) => {
    const text = buf.toString();
    // [download]  45.6% of ~12.34MiB
    const m = text.match(/\[download\]\s+([\d.]+)%/);
    if (m) setJob(job, { percent: parseFloat(m[1]) });
    if (/\[Merger\]/.test(text)) setJob(job, { stage: "병합 중", percent: 99 });
    if (/\[ExtractAudio\]/.test(text))
      setJob(job, { stage: "오디오 변환 중", percent: 99 });
  };
  proc.stdout.on("data", onLine);
  proc.stderr.on("data", onLine);

  proc.on("error", (e) =>
    setJob(job, { status: "error", error: `실행 실패: ${e.message}` })
  );
  proc.on("close", async (code) => {
    if (job.status === "error") return;
    if (code !== 0) {
      return setJob(job, {
        status: "error",
        error: `다운로드 실패 (종료코드 ${code})`,
      });
    }
    // 영상 다운로드면, mp4 호환성(H.264) 보장 — VP9/AV1 이면 재인코딩
    if (!subOnly && !audioOnly) {
      try {
        await ensureH264(job);
      } catch (e) {
        return setJob(job, { status: "error", error: e.message });
      }
      if (job.status === "error") return;
    }
    await finalizeFromDir(job);
  });
}

function probeVideoCodec(file) {
  return new Promise((resolve) => {
    if (!BIN.ffprobe) return resolve("");
    execFile(
      BIN.ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name", "-of", "default=nw=1:nk=1", file],
      { timeout: 20000 },
      (e, out) => resolve(e ? "" : String(out).trim())
    );
  });
}

// mp4 안의 영상 코덱이 H.264가 아니면(VP9/AV1 등) 호환을 위해 H.264로 재인코딩.
async function ensureH264(job) {
  if (!BIN.ffmpeg || !BIN.ffprobe) return;
  const files = await fsp.readdir(job.dir);
  let target = null;
  for (const f of files) {
    if (!/\.mp4$/i.test(f)) continue;
    const st = await fsp.stat(path.join(job.dir, f));
    if (!target || st.size > target.size)
      target = { path: path.join(job.dir, f), size: st.size };
  }
  if (!target) return;

  const codec = await probeVideoCodec(target.path);
  if (!codec || codec === "h264") return; // 이미 호환되거나 확인 불가 시 그대로

  setJob(job, { stage: `호환 변환 중 (${codec}→H.264)`, percent: -1 });
  const outPath = target.path.replace(/\.mp4$/i, ".h264.mp4");
  await new Promise((resolve, reject) => {
    const p = spawn(BIN.ffmpeg, [
      "-y", "-i", target.path,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      outPath,
    ]);
    job.proc = p;
    let tail = "";
    p.stderr.on("data", (b) => (tail = (tail + b.toString()).slice(-400)));
    p.on("error", reject);
    p.on("close", (c) =>
      c === 0
        ? resolve()
        : reject(new Error(`호환 변환(재인코딩) 실패\n${tail}`))
    );
  });
  // 원본(VP9) 삭제하고 재인코딩본을 원래 이름으로
  await fsp.rm(target.path, { force: true });
  await fsp.rename(outPath, target.path);
}

async function startFfmpegJob(job, { url, audioOnly }) {
  // 길이 조회(진행률 계산용) — 실패해도 계속
  let durationSec = 0;
  if (BIN.ffprobe) {
    durationSec = await probeDuration(url).catch(() => 0);
  }

  const isAudio = !!audioOnly;
  const outName = isAudio ? "audio.mp3" : "video.mp4";
  const outPath = path.join(job.dir, outName);
  const args = [
    "-y",
    "-loglevel", "error",
    "-user_agent", BROWSER_UA,
    "-i", url,
  ];
  if (isAudio) {
    args.push("-vn", "-c:a", "libmp3lame", "-q:a", "2");
  } else {
    // HLS/mp4 → mp4 컨테이너로 복사(재인코딩 없이).
    // aac_adtstoasc 는 ffmpeg가 AAC mp4 muxing 시 자동 적용하므로 강제하지 않음
    // (AC3 등 다른 오디오 코덱에서 강제하면 실패함).
    args.push("-c", "copy");
  }
  args.push("-progress", "pipe:1", "-nostats", outPath);

  setJob(job, { stage: isAudio ? "오디오 변환 중" : "다운로드/병합 중" });
  const proc = spawn(BIN.ffmpeg, args);
  job.proc = proc;

  proc.stdout.on("data", (buf) => {
    const text = buf.toString();
    const m = text.match(/out_time_ms=(\d+)/);
    if (m && durationSec > 0) {
      const cur = parseInt(m[1], 10) / 1_000_000;
      setJob(job, { percent: Math.min(99, (cur / durationSec) * 100) });
    }
  });
  let errTail = "";
  proc.stderr.on("data", (b) => (errTail = (errTail + b.toString()).slice(-500)));

  proc.on("error", (e) =>
    setJob(job, { status: "error", error: `ffmpeg 실행 실패: ${e.message}` })
  );
  proc.on("close", async (code) => {
    if (job.status === "error") return;
    if (code !== 0 || !fs.existsSync(outPath)) {
      return setJob(job, {
        status: "error",
        error: `다운로드 실패 (ffmpeg 종료코드 ${code})\n${errTail}`,
      });
    }
    const base = (job.title || "daangn-video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
    setJob(job, {
      status: "done",
      percent: 100,
      stage: "완료",
      filePath: outPath,
      fileName: `${base}.${isAudio ? "mp3" : "mp4"}`,
    });
  });
}

function probeDuration(url) {
  return new Promise((resolve, reject) => {
    execFile(
      BIN.ffprobe,
      [
        "-v", "error",
        "-user_agent", BROWSER_UA,
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        url,
      ],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        const d = parseFloat(String(stdout).trim());
        resolve(isFinite(d) ? d : 0);
      }
    );
  });
}

async function finalizeFromDir(job) {
  try {
    const files = await fsp.readdir(job.dir);
    if (!files.length) {
      return setJob(job, { status: "error", error: "결과 파일이 없습니다." });
    }
    // 가장 큰 파일을 결과로 (부분 파일/썸네일 제외 효과)
    let best = null;
    for (const f of files) {
      if (/\.(part|ytdl|temp)$/i.test(f)) continue;
      const st = await fsp.stat(path.join(job.dir, f));
      if (!best || st.size > best.size) best = { name: f, size: st.size };
    }
    if (!best) return setJob(job, { status: "error", error: "결과 파일이 없습니다." });
    setJob(job, {
      status: "done",
      percent: 100,
      stage: "완료",
      filePath: path.join(job.dir, best.name),
      fileName: best.name,
    });
  } catch (e) {
    setJob(job, { status: "error", error: e.message });
  }
}

// ===================== /api/progress/:id (SSE) =====================
app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = () => {
    res.write(
      `data: ${JSON.stringify({
        status: job.status,
        percent: job.percent,
        stage: job.stage,
        fileName: job.fileName,
        error: job.error,
      })}\n\n`
    );
  };
  send();
  const timer = setInterval(() => {
    send();
    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  }, 500);
  req.on("close", () => clearInterval(timer));
});

// ===================== /api/file/:id =====================
app.get("/api/file/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.filePath) {
    return res.status(404).send("파일을 찾을 수 없습니다.");
  }
  res.download(job.filePath, job.fileName, (err) => {
    // 전송 후 정리 (성공/실패 무관하게 잠시 뒤 삭제)
    setTimeout(() => cleanupJob(job.id), 5000);
    if (err && !res.headersSent) res.status(500).end();
  });
});

async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  try {
    if (job.proc && job.status === "running") job.proc.kill();
  } catch {}
  try {
    await fsp.rm(job.dir, { recursive: true, force: true });
  } catch {}
  jobs.delete(id);
}

// 오래된 작업 주기적 정리 (30분)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 30 * 60 * 1000) cleanupJob(id);
  }
}, 5 * 60 * 1000);

// ===================== /api/thumb =====================
// 썸네일 프록시: cdninstagram 등은 브라우저에서 직접 <img> 로 불러오면
// 핫링크(Referer) 차단으로 안 보이므로, 서버가 받아서 동일 출처로 전달한다.
app.get("/api/thumb", async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("유효한 이미지 URL이 아닙니다.");
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(target, {
      headers: { "User-Agent": BROWSER_UA, Accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return res.status(502).send(`썸네일 응답 오류 (HTTP ${resp.status})`);
    const ct = resp.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (err) {
    res.status(500).send(`썸네일을 가져오지 못했습니다: ${err.message}`);
  }
});

// 진단용
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    bin: {
      ytdlp: !!BIN.ytdlp,
      ffmpeg: !!BIN.ffmpeg,
      ffprobe: !!BIN.ffprobe,
    },
  });
});

// 안전망: 자식 프로세스/추출 중 예기치 못한 예외로 서버가 죽지 않도록
process.on("uncaughtException", (err) => {
  log.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (err) => {
  log.error("[unhandledRejection]", err);
});

const server = app.listen(PORT, () => {
  log.info(`영상 다운로더 서비스 실행 중 (PID ${process.pid})`);
  log.info(`  로컬:    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) log.info(`  네트워크: http://${ip}:${PORT}`);
  log.info(`  로그 파일: ${LOG_DIR}`);
});

// 포트 바인딩 실패(EADDRINUSE 등)는 치명적 → 좀비로 남기지 말고 명확히 종료.
// (uncaughtException 핸들러가 삼켜 프로세스가 안 죽는 문제 방지)
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.error(
      `포트 ${PORT} 이(가) 이미 사용 중입니다. 기존 서버를 먼저 종료하거나` +
        ` (restart-server.bat 권장), PORT 환경변수로 다른 포트를 지정하세요.`
    );
  } else {
    log.error("서버 시작 실패:", err);
  }
  process.exit(1);
});
