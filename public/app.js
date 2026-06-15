const form = document.getElementById("search-form");
const urlInput = document.getElementById("url-input");
const fetchBtn = document.getElementById("fetch-btn");
const resetBtn = document.getElementById("reset-btn");
const statusEl = document.getElementById("status");

const preview = document.getElementById("preview");
const thumb = document.getElementById("thumb");
const platformBadge = document.getElementById("platform-badge");
const titleEl = document.getElementById("title");
const submetaEl = document.getElementById("submeta");

const ytdlpOptions = document.getElementById("ytdlp-options");
const qualitySel = document.getElementById("quality");
const subtitleSel = document.getElementById("subtitle");
const embedSubEl = document.getElementById("embed-sub");
const audioOnlyEl = document.getElementById("audio-only");
const downloadBtn = document.getElementById("download-btn");
const subDownloadBtn = document.getElementById("sub-download-btn");
const daangnList = document.getElementById("daangn-list");

// 자막 언어 코드 → 한국어 표기
const SUB_LABEL = {
  ko: "한국어", en: "영어", ja: "일본어", "zh-Hans": "중국어(간체)",
  "zh-Hant": "중국어(번체)", es: "스페인어", fr: "프랑스어", de: "독일어",
  vi: "베트남어", th: "태국어", id: "인도네시아어", ru: "러시아어",
  pt: "포르투갈어", hi: "힌디어", ar: "아랍어", it: "이탈리아어",
};
const subLabel = (l) => SUB_LABEL[l] || l;

const progressBox = document.getElementById("progress-box");
const progressStage = document.getElementById("progress-stage");
const progressPct = document.getElementById("progress-pct");
const barFill = document.getElementById("bar-fill");
const progressResult = document.getElementById("progress-result");

const useCookiesEl = document.getElementById("use-cookies");
const cookieBrowserEl = document.getElementById("cookie-browser");
useCookiesEl.addEventListener("change", () => {
  cookieBrowserEl.disabled = !useCookiesEl.checked;
});
// 쿠키 옵션이 켜져 있으면 선택한 브라우저 이름, 아니면 null
function cookieParam() {
  return useCookiesEl.checked ? cookieBrowserEl.value : null;
}

let current = null; // 현재 불러온 메타데이터

function setStatus(msg, type = "") {
  if (!msg) {
    statusEl.hidden = true;
    statusEl.innerHTML = "";
    return;
  }
  statusEl.hidden = false;
  statusEl.className = "status" + (type ? ` ${type}` : "");
  statusEl.innerHTML = msg;
}

const PLATFORM_LABEL = {
  youtube: "YouTube",
  instagram: "Instagram",
  daangn: "당근마켓",
  threads: "Threads",
  generic: "기타",
};

// ---- 메타데이터 불러오기 ----
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  fetchBtn.disabled = true;
  preview.hidden = true;
  progressBox.hidden = true;
  setStatus('<span class="spinner"></span> 영상 정보를 불러오는 중...', "loading");

  try {
    const ck = cookieParam();
    const resp = await fetch(
      `/api/info?url=${encodeURIComponent(url)}${
        ck ? `&cookies=${encodeURIComponent(ck)}` : ""
      }`
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `오류 (HTTP ${resp.status})`);

    current = { ...data, pageUrl: url };
    setStatus("");
    renderPreview(current);
  } catch (err) {
    setStatus(`❌ ${err.message}`, "error");
  } finally {
    fetchBtn.disabled = false;
  }
});

// 초기화: 입력값/미리보기/진행률을 비우고 주소창의 ?url= 쿼리도 최신화(제거)한다.
function resetAll() {
  urlInput.value = "";
  current = null;
  setStatus("");
  preview.hidden = true;
  progressBox.hidden = true;
  daangnList.hidden = true;
  daangnList.innerHTML = "";
  progressResult.innerHTML = "";
  // 주소창을 깨끗한 경로로 되돌려 새로고침/공유 시 옛 URL이 자동 실행되지 않게 함
  history.replaceState(null, "", location.pathname);
  urlInput.focus();
}
resetBtn.addEventListener("click", resetAll);

function renderPreview(data) {
  preview.hidden = false;
  platformBadge.textContent = PLATFORM_LABEL[data.platform] || data.platform;

  if (data.thumbnail) {
    // cdninstagram 등 핫링크 차단 회피: 서버 프록시 경유로 로드
    thumb.src = `/api/thumb?url=${encodeURIComponent(data.thumbnail)}`;
    thumb.hidden = false;
    thumb.onerror = () => {
      thumb.hidden = true;
    };
  } else {
    thumb.hidden = true;
  }
  titleEl.textContent = data.title || "(제목 없음)";

  const parts = [];
  if (data.uploader) parts.push(data.uploader);
  if (data.durationString) parts.push(`⏱ ${data.durationString}`);
  submetaEl.textContent = parts.join(" · ");

  if (data.engine === "ffmpeg") {
    // 당근마켓: 찾은 영상 목록
    ytdlpOptions.hidden = true;
    renderDaangnList(data);
  } else {
    // yt-dlp: 화질/오디오 옵션
    daangnList.hidden = true;
    ytdlpOptions.hidden = false;
    qualitySel.innerHTML = "";
    const heights = data.heights && data.heights.length ? data.heights : [];
    if (heights.length === 0) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "최고 화질";
      qualitySel.appendChild(o);
    } else {
      const top = document.createElement("option");
      top.value = "";
      top.textContent = "최고 화질";
      qualitySel.appendChild(top);
      for (const h of heights) {
        const o = document.createElement("option");
        o.value = String(h);
        o.textContent = `${h}p`;
        qualitySel.appendChild(o);
      }
    }
    // 자막 목록 채우기
    subtitleSel.innerHTML = '<option value="">자막 없음</option>';
    (data.subtitles || []).forEach((l) => {
      const o = document.createElement("option");
      o.value = `m:${l}`;
      o.textContent = `${subLabel(l)} (자막)`;
      subtitleSel.appendChild(o);
    });
    (data.autoCaptions || []).forEach((l) => {
      const o = document.createElement("option");
      o.value = `a:${l}`;
      o.textContent = `${subLabel(l)} (자동생성)`;
      subtitleSel.appendChild(o);
    });
    syncQualityDisabled();
    syncSubControls();
  }
}

// 선택된 자막 파싱: "m:ko" -> {lang:"ko", auto:false}, "" -> null
function selectedSub() {
  const v = subtitleSel.value;
  if (!v) return null;
  const [pfx, ...rest] = v.split(":");
  return { lang: rest.join(":"), auto: pfx === "a" };
}
function syncSubControls() {
  const has = !!subtitleSel.value;
  subDownloadBtn.disabled = !has;
  embedSubEl.disabled = !has;
  if (!has) embedSubEl.checked = false;
}
subtitleSel.addEventListener("change", syncSubControls);

function syncQualityDisabled() {
  qualitySel.disabled = audioOnlyEl.checked;
}
audioOnlyEl.addEventListener("change", syncQualityDisabled);

function renderDaangnList(data) {
  daangnList.hidden = false;
  daangnList.innerHTML = "";
  if (data.noVideo || !data.videos || data.videos.length === 0) {
    daangnList.innerHTML =
      '<p class="submeta">이 페이지에서 영상을 찾지 못했습니다. (영상이 없는 게시글이거나 로그인이 필요할 수 있어요)</p>';
    return;
  }
  data.videos.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "dvideo";

    const info = document.createElement("div");
    info.className = "dinfo";
    info.innerHTML = `<span class="dtag">${v.ext}</span> 영상 #${i + 1}<br>${v.url}`;

    const dlBtn = document.createElement("button");
    dlBtn.className = "primary";
    dlBtn.textContent = "영상 다운로드";
    dlBtn.addEventListener("click", () =>
      startDownload({
        url: v.url,
        engine: "ffmpeg",
        audioOnly: false,
        title: `${data.title}-${i + 1}`,
      })
    );

    const mp3Btn = document.createElement("button");
    mp3Btn.textContent = "mp3";
    mp3Btn.addEventListener("click", () =>
      startDownload({
        url: v.url,
        engine: "ffmpeg",
        audioOnly: true,
        title: `${data.title}-${i + 1}`,
      })
    );

    row.appendChild(info);
    row.appendChild(dlBtn);
    row.appendChild(mp3Btn);
    daangnList.appendChild(row);
  });
}

// ---- yt-dlp 다운로드 버튼 ----
downloadBtn.addEventListener("click", () => {
  if (!current) return;
  const sub = audioOnlyEl.checked ? null : selectedSub();
  startDownload({
    url: current.pageUrl,
    engine: "ytdlp",
    height: audioOnlyEl.checked ? "" : qualitySel.value,
    audioOnly: audioOnlyEl.checked,
    title: current.title,
    cookies: cookieParam(),
    subLang: sub ? sub.lang : null,
    subAuto: sub ? sub.auto : false,
    embedSub: sub ? embedSubEl.checked : false,
  });
});

// 자막만(.srt) 다운로드
subDownloadBtn.addEventListener("click", () => {
  if (!current) return;
  const sub = selectedSub();
  if (!sub) return;
  startDownload({
    url: current.pageUrl,
    engine: "ytdlp",
    subOnly: true,
    subLang: sub.lang,
    subAuto: sub.auto,
    title: current.title,
    cookies: cookieParam(),
  });
});

// ---- 다운로드 작업 시작 + 진행률 구독 ----
async function startDownload(payload) {
  progressBox.hidden = false;
  progressResult.innerHTML = "";
  setBar(-1, "준비 중");
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));

  try {
    const resp = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `오류 (HTTP ${resp.status})`);
    subscribeProgress(data.jobId);
  } catch (err) {
    setBar(0, "실패");
    progressResult.innerHTML = `<div class="err">❌ ${err.message}</div>`;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

function setBar(percent, stage) {
  progressStage.textContent = stage || "";
  if (percent < 0) {
    barFill.classList.add("indeterminate");
    progressPct.textContent = "";
  } else {
    barFill.classList.remove("indeterminate");
    barFill.style.width = `${percent}%`;
    progressPct.textContent = `${Math.floor(percent)}%`;
  }
}

function subscribeProgress(jobId) {
  const es = new EventSource(`/api/progress/${jobId}`);
  es.onmessage = (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    setBar(d.percent, d.stage);

    if (d.status === "done") {
      es.close();
      setBar(100, "완료");
      progressResult.innerHTML = `<a class="dl" href="/api/file/${jobId}">⬇ 저장하기${
        d.fileName ? ` — ${escapeHtml(d.fileName)}` : ""
      }</a>`;
      document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    } else if (d.status === "error") {
      es.close();
      setBar(0, "실패");
      progressResult.innerHTML = `<div class="err">❌ ${escapeHtml(
        d.error || "다운로드 실패"
      )}</div>`;
      document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  es.onerror = () => {
    es.close();
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 공유/단축어 연동: ?url=... 자동 실행
(function autoRun() {
  const p = new URLSearchParams(location.search);
  const shared = p.get("url");
  if (!shared) return;
  urlInput.value = shared;
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.dispatchEvent(new Event("submit", { cancelable: true }));
})();
