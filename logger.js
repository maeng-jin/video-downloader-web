// 가벼운 파일+콘솔 로거 (외부 의존성 없음)
// - logs/server-YYYY-MM-DD.log 에 날짜별로 append
// - log.info / log.warn / log.error
// - requestLogger: Express 요청 로깅 미들웨어
// - lanAddresses: 시작 배너용 LAN IPv4 목록
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}

const fmt = (a) =>
  typeof a === "string"
    ? a
    : a instanceof Error
    ? a.stack || a.message
    : (() => {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })();

function writeLine(level, args) {
  const now = new Date();
  const line = `[${now.toISOString()}] [${level}] ${args.map(fmt).join(" ")}`;
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    const file = path.join(LOG_DIR, `server-${now.toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* 파일 쓰기 실패는 무시(콘솔에는 이미 출력됨) */
  }
}

export const log = {
  info: (...a) => writeLine("INFO", a),
  warn: (...a) => writeLine("WARN", a),
  error: (...a) => writeLine("ERROR", a),
  dir: LOG_DIR, // 로그 디렉터리 경로 (시작 배너 등에서 사용)
};

// 모든 API 요청을 상태코드/소요시간과 함께 기록
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const msg = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) log.error(msg);
    else if (res.statusCode >= 400) log.warn(msg);
    else log.info(msg);
  });
  next();
}

// 시작 배너용: 내부/가상 인터페이스 제외한 LAN IPv4 주소들
export function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export { LOG_DIR };
