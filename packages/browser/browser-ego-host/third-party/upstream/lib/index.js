// packages/browser/browser-ego-host/third-party/upstream/src/index.ts
import { defineTool } from "coding-tools";
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync2, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// packages/browser/browser-ego-host/third-party/upstream/src/login-import.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

// packages/browser/browser-ego-host/third-party/upstream/src/worker/cdp-client.ts
var CdpClient = class {
  ws;
  nextId;
  pending;
  events;
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = /* @__PURE__ */ new Map();
    this.events = /* @__PURE__ */ new Map();
    ws.addEventListener("message", (event) => this.#handleMessage(event));
    const close = () => this.#rejectPending(new Error("CDP connection closed"));
    ws.addEventListener("close", close, { once: true });
    ws.addEventListener("error", close, { once: true });
  }
  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `CDP error ${message.error.code}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    for (const handler of this.events.get(message.method) || []) {
      try {
        handler(message.params || {}, message.sessionId);
      } catch {
      }
    }
  }
  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  call(method, params = {}, sessionId, timeoutMs = 6e3) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, /* @__PURE__ */ new Set());
    this.events.get(method).add(handler);
    return () => {
      this.events.get(method)?.delete(handler);
    };
  }
};

// packages/browser/browser-ego-host/third-party/upstream/src/login-import.ts
var execFile = promisify(execFileCb);
function chromiumCandidates(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const la = env.LOCALAPPDATA || "";
    const pf = env["ProgramFiles"] || "C:\\Program Files";
    const pfx = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      { id: "chrome", label: "Google Chrome", exePath: `${pf}\\Google\\Chrome\\Application\\chrome.exe`, userDataDir: `${la}\\Google\\Chrome\\User Data` },
      { id: "chrome", label: "Google Chrome", exePath: `${pfx}\\Google\\Chrome\\Application\\chrome.exe`, userDataDir: `${la}\\Google\\Chrome\\User Data` },
      { id: "edge", label: "Microsoft Edge", exePath: `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`, userDataDir: `${la}\\Microsoft\\Edge\\User Data` },
      { id: "edge", label: "Microsoft Edge", exePath: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, userDataDir: `${la}\\Microsoft\\Edge\\User Data` },
      { id: "brave", label: "Brave", exePath: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, userDataDir: `${la}\\BraveSoftware\\Brave-Browser\\User Data` }
    ];
  }
  if (platform === "darwin") {
    const home2 = env.HOME || "";
    return [
      { id: "chrome", label: "Google Chrome", exePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", userDataDir: `${home2}/Library/Application Support/Google/Chrome` },
      { id: "edge", label: "Microsoft Edge", exePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", userDataDir: `${home2}/Library/Application Support/Microsoft Edge` }
    ];
  }
  const home = env.HOME || "";
  return [
    { id: "chrome", label: "Google Chrome", exePath: "/usr/bin/google-chrome", userDataDir: `${home}/.config/google-chrome` },
    { id: "chrome", label: "Chromium", exePath: "/usr/bin/chromium", userDataDir: `${home}/.config/chromium` },
    { id: "edge", label: "Microsoft Edge", exePath: "/usr/bin/microsoft-edge", userDataDir: `${home}/.config/microsoft-edge` },
    { id: "brave", label: "Brave", exePath: "/usr/bin/brave-browser", userDataDir: `${home}/.config/BraveSoftware/Brave-Browser` }
  ];
}
function detectSystemBrowsers(env = process.env, platform = process.platform) {
  const seen = /* @__PURE__ */ new Set();
  return chromiumCandidates(env, platform).filter((b) => {
    if (seen.has(b.exePath)) return false;
    seen.add(b.exePath);
    return existsSync(b.exePath) && existsSync(join(b.userDataDir, "Local State"));
  });
}
function profilesFromLocalState(localStateJson, userDataDir) {
  try {
    const j2 = JSON.parse(localStateJson);
    const cache = j2.profile?.info_cache || {};
    const out = Object.entries(cache).map(([dirName, info]) => ({
      dir: join(userDataDir, dirName),
      dirName,
      name: info && typeof info.name === "string" && info.name || dirName
    }));
    return out.length ? out : [{ dir: join(userDataDir, "Default"), dirName: "Default", name: "Default" }];
  } catch {
    return [{ dir: join(userDataDir, "Default"), dirName: "Default", name: "Default" }];
  }
}
function cookieMatchesDomains(cookieDomain, domains) {
  if (!domains || domains.length === 0) return true;
  const host = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
  return domains.some((raw) => {
    const d = String(raw || "").replace(/^\./, "").trim().toLowerCase();
    return d !== "" && (host === d || host.endsWith("." + d));
  });
}
function toCookieParam(c) {
  if (!c || typeof c.name !== "string" || c.name === "" || typeof c.value !== "string" || typeof c.domain !== "string" || c.domain === "") return null;
  const p = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly
  };
  if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") p.sameSite = c.sameSite;
  if (!c.session && typeof c.expires === "number" && c.expires > 0) p.expires = c.expires;
  return p;
}
function parseDevToolsActivePort(text) {
  const line = String(text || "").split(/\r?\n/)[0]?.trim();
  const n = Number(line);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
function resolveEgoStateDir(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || "";
  if (env.EGO_LINUX_STATE_DIR) return env.EGO_LINUX_STATE_DIR;
  return platform === "win32" ? (env.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${env.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`;
}
async function connectCdp(wsUrl, timeoutMs) {
  const WsImpl = globalThis.WebSocket;
  if (!WsImpl) throw new Error("global WebSocket is unavailable (Node >= 22 required)");
  const ws = new WsImpl(wsUrl);
  await new Promise((resolve2, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket open timed out: ${wsUrl}`)), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve2();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket connect failed: ${wsUrl}`));
    }, { once: true });
  });
  return { client: new CdpClient(ws), close: () => {
    try {
      ws.close();
    } catch {
    }
  } };
}
async function browserWsUrl(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3e3) });
  if (!r.ok) throw new Error(`/json/version HTTP ${r.status} on port ${port}`);
  const j2 = await r.json();
  if (!j2.webSocketDebuggerUrl) throw new Error("browser did not expose webSocketDebuggerUrl");
  return j2.webSocketDebuggerUrl;
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
async function sourceBrowserPids(browserExe, userDataDir = null, platform = process.platform) {
  const exeBase = basename(browserExe);
  try {
    if (platform === "win32") {
      const filter = userDataDir ? `$_.CommandLine -match [regex]::Escape('--user-data-dir=${userDataDir}') -or $_.CommandLine -match [regex]::Escape('--user-data-dir="${userDataDir}"')` : `$_.CommandLine -notmatch '--user-data-dir='`;
      const ps = [
        `Get-CimInstance Win32_Process -Filter "Name='${exeBase}'"`,
        `| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and (${filter}) }`,
        `| Select-Object -ExpandProperty ProcessId`
      ].join(" ");
      const { stdout: stdout2 } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { timeout: 1e4 });
      return String(stdout2).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    }
    const { stdout } = await execFile("pgrep", ["-x", exeBase.replace(/\.exe$/, "")], { timeout: 1e4 }).catch(() => ({ stdout: "" }));
    return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
async function closeSourceBrowser(browserExe, platform = process.platform) {
  try {
    const pids = await sourceBrowserPids(browserExe, null, platform);
    if (pids.length === 0) return true;
    if (platform === "win32") {
      for (const pid of pids) {
        await execFile("taskkill", ["/PID", String(pid)], { timeout: 8e3 }).catch(() => null);
      }
    } else {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
        }
      }
    }
    const deadline = Date.now() + 15e3;
    while (Date.now() < deadline) {
      if ((await sourceBrowserPids(browserExe, null, platform)).length === 0) return true;
      await sleep(500);
    }
    return false;
  } catch {
    return false;
  }
}
var BATCH = 200;
async function copyProfileForImport(browser, profile2) {
  const { copyFile: copyFile2 } = await import("node:fs/promises");
  const dest = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}`);
  await mkdir(join(dest, profile2.dirName, "Network"), { recursive: true });
  const localState = join(browser.userDataDir, "Local State");
  if (existsSync(localState)) await mkdir(dest, { recursive: true }).then(() => copyFile2(localState, join(dest, "Local State")));
  const cookieFiles = [
    [join(profile2.dir, "Network", "Cookies"), join(dest, profile2.dirName, "Network", "Cookies")],
    [join(profile2.dir, "Cookies"), join(dest, profile2.dirName, "Cookies")]
  ];
  let copied = false;
  for (const [src, dst] of cookieFiles) {
    if (!existsSync(src)) continue;
    try {
      await copyFile2(src, dst);
      copied = true;
    } catch (err) {
      throw new Error(`cannot copy the ${browser.label} cookie store (${err?.message || err}); quit ${browser.label} completely and retry`);
    }
  }
  if (!copied) throw new Error(`no Cookies database found in ${browser.label} profile ${profile2.dirName}`);
  return dest;
}
async function importLoginCookies(opts, deps) {
  const timeoutMs = opts.timeoutMs ?? 2e4;
  let browser;
  if (opts.browserOverride) {
    browser = opts.browserOverride;
  } else {
    const browsers = detectSystemBrowsers();
    if (browsers.length === 0) return { ok: false, error: "no system Chromium browser found (looked for Chrome/Edge/Brave profile + binary)" };
    const wanted = !opts.source || opts.source === "auto" ? null : opts.source;
    browser = wanted ? browsers.find((b) => b.id === wanted) : browsers[0];
    if (!browser) return { ok: false, error: `source "${wanted}" not found on this machine; detected: ${browsers.map((b) => b.id).join(", ")}` };
  }
  let profile2;
  try {
    const localState = await readFile(join(browser.userDataDir, "Local State"), "utf8");
    const profiles = profilesFromLocalState(localState, browser.userDataDir);
    profile2 = (opts.profile ? profiles.find((p) => p.dirName === opts.profile || p.name === opts.profile) : void 0) || profiles[0];
    if (opts.profile && !profiles.some((p) => p.dirName === profile2.dirName)) {
      return { ok: false, error: `profile "${opts.profile}" not found in ${browser.label}; available: ${profiles.map((p) => p.dirName).join(", ")}` };
    }
  } catch (err) {
    return { ok: false, error: `cannot read ${browser.label} Local State: ${err?.message || err}` };
  }
  let closedSource = false;
  let srcHandle = null;
  let tempCdp = null;
  let egoCdp = null;
  let linkDir = null;
  try {
    const runningPids = await sourceBrowserPids(browser.exePath, opts.browserOverride ? browser.userDataDir : null);
    if (runningPids.length > 0) {
      if (opts.browserOverride) {
        return { ok: false, error: "an instance is already running on the override profile \u2014 close it and retry" };
      }
      if (!opts.closeSource) {
        return {
          ok: false,
          error: `${browser.label} is running \u2014 fully quit it (check the system tray) and retry, or call with closeSource=true to let the tool close it gracefully for you (windows restore on next launch)`
        };
      }
      const closed = await closeSourceBrowser(browser.exePath);
      if (!closed) return { ok: false, error: `failed to close ${browser.label} automatically \u2014 quit it manually and retry` };
      closedSource = true;
    }
    linkDir = await copyProfileForImport(browser, profile2);
    if (process.platform === "win32") {
      const ps = [
        `Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
        `| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
        `| Select-Object -ExpandProperty ProcessId`
      ].join(" ");
      const drainDeadline = Date.now() + 8e3;
      let leftover = [];
      while (Date.now() < drainDeadline) {
        try {
          const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { timeout: 8e3 });
          leftover = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (leftover.length === 0) break;
        } catch {
          break;
        }
        await sleep(600);
      }
      if (leftover.length > 0) {
        for (const line of leftover) {
          const pid = Number(line);
          if (Number.isInteger(pid) && pid > 0) await execFile("taskkill", ["/PID", String(pid), "/F"], { timeout: 5e3 }).catch(() => null);
        }
        await sleep(1e3);
      }
    }
    let port = null;
    for (let attempt = 0; attempt < 2 && port === null; attempt++) {
      if (attempt > 0) {
        await sleep(2e3);
        try {
          await rm(linkDir, { recursive: true, force: true });
        } catch {
        }
        linkDir = await copyProfileForImport(browser, profile2);
      }
      const portFile = join(linkDir, "DevToolsActivePort");
      await rm(portFile, { force: true }).catch(() => null);
      srcHandle = deps.subprocess.spawn({
        argv: [
          browser.exePath,
          "--headless=new",
          `--user-data-dir=${linkDir}`,
          `--profile-directory=${profile2.dirName}`,
          "--remote-debugging-port=0",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-sync",
          "--hide-crash-restore-bubble",
          "about:blank"
        ],
        cwd: tmpdir(),
        env: { ...process.env },
        stdio: { stdin: { data: "" }, stdout: { maxBytes: 2048 }, stderr: { maxBytes: 4096 } },
        graceMs: 8e3
      });
      srcHandle.done.catch(() => null);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          port = parseDevToolsActivePort(await readFile(portFile, "utf8"));
          if (port !== null) break;
        } catch {
        }
        await sleep(250);
      }
    }
    if (port === null) return { ok: false, closedSource, error: `${browser.label} headless instance did not expose a DevTools port within ${timeoutMs}ms (another instance may be holding the profile)` };
    tempCdp = await connectCdp(await browserWsUrl(port), 5e3);
    let all = [];
    let stable = 0;
    let lastCount = -1;
    const readDeadline = Date.now() + timeoutMs;
    while (Date.now() < readDeadline) {
      const got = await tempCdp.client.call("Storage.getCookies");
      all = Array.isArray(got.cookies) ? got.cookies : [];
      if (all.length > 0 && all.length === lastCount) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      lastCount = all.length;
      await sleep(800);
    }
    if (all.length === 0) {
      return {
        ok: false,
        source: browser.label,
        profile: profile2.dirName,
        dryRun: opts.dryRun === true,
        closedSource,
        totalRead: 0,
        matched: 0,
        written: 0,
        domains: [],
        error: `0 cookies readable from the temporary copy of ${browser.label}. Chrome/Edge 127+ use App-Bound Encryption bound to the original profile path, so a copied profile cannot be decrypted (the source profile was NOT modified). Use the Chrome extension bridge (A) or log in once inside the agent browser; the old real-profile boot path has been removed.`
      };
    }
    const matched = all.filter((c) => cookieMatchesDomains(c.domain, opts.domains || []));
    const byDomain = /* @__PURE__ */ new Map();
    for (const c of matched) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
    const domainStats = [...byDomain.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies);
    if (opts.dryRun) {
      return { ok: true, source: browser.label, profile: profile2.dirName, dryRun: true, closedSource, totalRead: all.length, matched: matched.length, written: 0, domains: domainStats };
    }
    const stateDir = opts.stateDir || resolveEgoStateDir();
    let egoPort;
    try {
      const bj = JSON.parse(await readFile(join(stateDir, "browser.json"), "utf8"));
      if (typeof bj.port !== "number" || bj.port <= 0) throw new Error("no port in browser.json");
      egoPort = bj.port;
    } catch {
      return { ok: false, closedSource, error: "agent browser is not running (no browser.json) \u2014 call ego_status or any ego_* tool first, then retry the import" };
    }
    egoCdp = await connectCdp(await browserWsUrl(egoPort), 5e3);
    const params = matched.map(toCookieParam).filter((p) => p !== null);
    const egoClient = egoCdp.client;
    const jarTargets = [void 0];
    try {
      const spacesRaw = await readFile(join(stateDir, "task-spaces.json"), "utf8");
      const parsed = JSON.parse(spacesRaw);
      for (const space of parsed.spaces ?? []) {
        const id = space?.browserContextId;
        if (typeof id === "string" && id !== "") jarTargets.push(id);
      }
    } catch {
    }
    const jarKey = (domain, name2, path) => `${String(name2)}|${String(domain).replace(/^\./, "")}|${String(path ?? "/")}`;
    const writeJar = async (contextId) => {
      const scoped = contextId === void 0 ? {} : { browserContextId: contextId };
      for (let i = 0; i < params.length; i += BATCH) {
        await egoClient.call("Storage.setCookies", { cookies: params.slice(i, i + BATCH), ...scoped });
      }
      const back = await egoClient.call("Storage.getCookies", scoped);
      const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)));
      return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length;
    };
    let written;
    try {
      written = await writeJar(void 0);
      for (const contextId of jarTargets.slice(1)) {
        try {
          await writeJar(contextId);
        } catch {
        }
      }
    } catch {
      written = -1;
    }
    if (params.length > 0 && written === 0) {
      return {
        ok: false,
        source: browser.label,
        profile: profile2.dirName,
        dryRun: false,
        closedSource,
        totalRead: all.length,
        matched: matched.length,
        written: 0,
        error: "the agent browser accepted no cookies \u2014 its CDP endpoint may belong to a stale or replaced instance; restart the agent browser (ego_status after closing it) and retry"
      };
    }
    return { ok: true, source: browser.label, profile: profile2.dirName, dryRun: false, closedSource, totalRead: all.length, matched: matched.length, written, domains: domainStats };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try {
      tempCdp?.close();
    } catch {
    }
    try {
      egoCdp?.close();
    } catch {
    }
    if (srcHandle) {
      try {
        await Promise.race([srcHandle.done, sleep(8e3)]);
      } catch {
      }
      if (process.platform === "win32" && linkDir) {
        try {
          const ps = [
            `Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
            `| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
            `| Select-Object -ExpandProperty ProcessId`
          ].join(" ");
          const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { timeout: 8e3 });
          for (const line of String(stdout).split(/\r?\n/)) {
            const pid = Number(line.trim());
            if (Number.isInteger(pid) && pid > 0) await execFile("taskkill", ["/PID", String(pid), "/F"], { timeout: 5e3 }).catch(() => null);
          }
        } catch {
        }
      }
    }
    if (linkDir) {
      try {
        await rm(linkDir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}

// packages/browser/browser-ego-host/third-party/upstream/src/login-extension.ts
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, writeFile } from "node:fs/promises";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var LOGIN_EXTENSION_PORT = 53820;
var MAX_BODY = 5 * 1024 * 1024;
var BATCH2 = 100;
function loginExtensionTokenPath(stateDir = resolveEgoStateDir()) {
  return join2(stateDir, "login-extension-token");
}
async function getOrCreateLoginExtensionToken(stateDir = resolveEgoStateDir()) {
  const file = loginExtensionTokenPath(stateDir);
  try {
    const existing = (await readFile2(file, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch {
  }
  const token = randomBytes(24).toString("hex");
  await mkdir2(dirname(file), { recursive: true }).catch(() => null);
  await writeFile(file, token, { encoding: "utf8", mode: 384 }).catch(() => null);
  return token;
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-ego-token",
    "cache-control": "no-store"
  });
  res.end(text);
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function tokenMatches(expected, got) {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
function toCdpCookie(raw) {
  if (!raw || typeof raw !== "object") return null;
  const c = raw;
  if (typeof c.name !== "string" || c.name === "" || typeof c.value !== "string") return null;
  if (typeof c.domain !== "string" || c.domain === "") return null;
  const rawSite = c.sameSite;
  const sameSite = rawSite === "strict" ? "Strict" : rawSite === "lax" ? "Lax" : rawSite === "none" || rawSite === "no_restriction" ? "None" : void 0;
  const expires = typeof c.expirationDate === "number" ? c.expirationDate : void 0;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: sameSite === "Strict" || sameSite === "Lax" || sameSite === "None" ? sameSite : void 0,
    session: expires === void 0,
    ...expires !== void 0 ? { expires } : {}
  };
}
async function writeCookiesToEgo(cookies, stateDir = resolveEgoStateDir()) {
  let egoPort;
  try {
    const bj = JSON.parse(await readFile2(join2(stateDir, "browser.json"), "utf8"));
    if (typeof bj.port !== "number" || bj.port <= 0) throw new Error("no port in browser.json");
    egoPort = bj.port;
  } catch {
    return { written: 0, error: "agent browser is not running (no browser.json) \u2014 call ego_status or any ego_* tool first, then retry" };
  }
  const egoCdp = await connectCdp(await browserWsUrl(egoPort), 5e3);
  const params = cookies.map(toCookieParam).filter((p) => p !== null);
  const jarTargets = [void 0];
  try {
    const spacesRaw = await readFile2(join2(stateDir, "task-spaces.json"), "utf8");
    const parsed = JSON.parse(spacesRaw);
    for (const space of parsed.spaces ?? []) {
      const id = space?.browserContextId;
      if (typeof id === "string" && id !== "") jarTargets.push(id);
    }
  } catch {
  }
  const jarKey = (domain, name2, path) => `${String(name2)}|${String(domain).replace(/^\./, "")}|${String(path ?? "/")}`;
  const writeJar = async (contextId) => {
    const scoped = contextId === void 0 ? {} : { browserContextId: contextId };
    for (let i = 0; i < params.length; i += BATCH2) {
      await egoCdp.client.call("Storage.setCookies", { cookies: params.slice(i, i + BATCH2), ...scoped });
    }
    const back = await egoCdp.client.call("Storage.getCookies", scoped);
    const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)));
    return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length;
  };
  try {
    let written = await writeJar(void 0);
    for (const contextId of jarTargets.slice(1)) {
      try {
        await writeJar(contextId);
      } catch {
      }
    }
    if (params.length > 0 && written === 0) {
      return { written: 0, error: "the agent browser accepted no cookies \u2014 restart it (ego_status after closing it) and retry" };
    }
    return { written };
  } catch (err) {
    return { written: -1, error: String(err?.message || err) };
  } finally {
    try {
      egoCdp.close();
    } catch {
    }
  }
}
async function importLoginCookiesFromExtension(opts = {}) {
  const job = await startLoginExtensionJob(opts);
  return await job.done;
}
var bridge = null;
var bridgeStarting = null;
var jobSeq = 0;
async function buildExtensionReport(cookies, received, dryRun, stateDir) {
  const byDomain = /* @__PURE__ */ new Map();
  for (const c of cookies) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
  const domains = [...byDomain.entries()].map(([domain, count]) => ({ domain, cookies: count })).sort((a, b) => b.cookies - a.cookies);
  if (dryRun) {
    return { ok: true, source: "Chrome extension", profile: "extension", dryRun: true, closedSource: false, totalRead: received, matched: cookies.length, written: 0, domains };
  }
  const write = await writeCookiesToEgo(cookies, stateDir);
  if (write.error !== void 0) {
    return { ok: false, source: "Chrome extension", profile: "extension", dryRun: false, closedSource: false, totalRead: received, matched: cookies.length, written: write.written, domains, error: write.error };
  }
  return { ok: true, source: "Chrome extension", profile: "extension", dryRun: false, closedSource: false, totalRead: received, matched: cookies.length, written: write.written, domains };
}
function settlement(job, report) {
  job.state = "done";
  job.report = report;
  const waiter = bridge?.waiters.get(job.id);
  if (waiter) {
    bridge.waiters.delete(job.id);
    waiter(report);
  }
}
async function ensureBridge() {
  if (bridge) return bridge;
  if (bridgeStarting) return await bridgeStarting;
  bridgeStarting = (async () => {
    const port = Number(process.env.EGO_LOGIN_EXTENSION_PORT) || LOGIN_EXTENSION_PORT;
    const stateDir = resolveEgoStateDir();
    const token = await getOrCreateLoginExtensionToken(stateDir);
    const state = {
      server: createServer(() => {
      }),
      token,
      port,
      lastSeenAt: 0,
      pairCode: "",
      pairExpiresAt: 0,
      jobs: /* @__PURE__ */ new Map(),
      waiters: /* @__PURE__ */ new Map(),
      started: Promise.resolve()
    };
    state.server = createServer(async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          sendJson(res, 204, {});
          return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && (url.pathname === "/ping" || url.pathname === "/health")) {
          sendJson(res, 200, { ok: true, app: "ego-browser-login", port: state.port, paired: Date.now() - state.lastSeenAt < 2e4 });
          return;
        }
        if (req.method === "POST" && url.pathname === "/pair") {
          const body = await readJsonBody(req);
          if (typeof body.code !== "string" || body.code !== state.pairCode || Date.now() > state.pairExpiresAt) {
            sendJson(res, 403, { ok: false, error: "pairing code expired or invalid" });
            return;
          }
          state.lastSeenAt = Date.now();
          sendJson(res, 200, { ok: true, token: state.token, port: state.port });
          return;
        }
        if (req.method === "GET" && url.pathname === "/pending") {
          const token2 = req.headers["x-ego-token"];
          if (!tokenMatches(state.token, token2)) {
            sendJson(res, 403, { ok: false, error: "bad token" });
            return;
          }
          state.lastSeenAt = Date.now();
          const job = [...state.jobs.values()].find((j2) => j2.state === "waiting");
          if (!job) {
            sendJson(res, 204, {});
            return;
          }
          sendJson(res, 200, { jobId: job.id, domains: job.domains, dryRun: job.dryRun });
          return;
        }
        if (req.method === "POST" && url.pathname === "/cookies") {
          const body = await readJsonBody(req);
          if (!tokenMatches(state.token, body.token)) {
            sendJson(res, 403, { ok: false, error: "bad token" });
            return;
          }
          state.lastSeenAt = Date.now();
          const jobs = [...state.jobs.values()].filter((j2) => j2.state === "waiting");
          const job = (typeof body.jobId === "string" ? state.jobs.get(body.jobId) : void 0) || jobs[0];
          if (!job || job.state !== "waiting") {
            sendJson(res, 409, { ok: false, error: "no waiting import job" });
            return;
          }
          const raw = Array.isArray(body.cookies) ? body.cookies : [];
          const cookies = raw.map(toCdpCookie).filter((c) => c !== null);
          const filtered = cookies.filter((c) => cookieMatchesDomains(c.domain, job.domains));
          sendJson(res, 200, { ok: true, received: cookies.length, matched: filtered.length });
          void buildExtensionReport(filtered, cookies.length, job.dryRun, resolveEgoStateDir()).then((report) => settlement(job, report));
          return;
        }
        sendJson(res, 404, { ok: false, error: "not found" });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    });
    await new Promise((resolve2, reject) => {
      state.server.once("error", (err) => reject(new Error(`could not start login-extension bridge on 127.0.0.1:${port}: ${err.message}`)));
      state.server.listen(port, "127.0.0.1", () => resolve2());
    });
    bridge = state;
    return state;
  })();
  try {
    return await bridgeStarting;
  } catch (err) {
    bridgeStarting = null;
    throw err;
  }
}
async function getLoginExtensionHealth() {
  try {
    const state = await ensureBridge();
    return {
      ok: true,
      paired: Date.now() - state.lastSeenAt < 2e4,
      port: state.port,
      tokenPath: loginExtensionTokenPath(),
      extensionPath: fileURLToPath(new URL("../extension", import.meta.url))
    };
  } catch (err) {
    return {
      ok: false,
      paired: false,
      port: Number(process.env.EGO_LOGIN_EXTENSION_PORT) || LOGIN_EXTENSION_PORT,
      tokenPath: loginExtensionTokenPath(),
      extensionPath: fileURLToPath(new URL("../extension", import.meta.url)),
      error: String(err?.message || err)
    };
  }
}
async function createLoginExtensionPairingCode() {
  try {
    const state = await ensureBridge();
    state.pairCode = String(Math.floor(1e5 + Math.random() * 9e5));
    state.pairExpiresAt = Date.now() + 6e5;
    return { ok: true, code: state.pairCode, expiresAt: state.pairExpiresAt, port: state.port };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
async function startLoginExtensionJob(opts = {}) {
  const state = await ensureBridge();
  const timeoutMs = opts.timeoutMs ?? 12e4;
  const job = {
    id: "job-" + ++jobSeq,
    domains: opts.domains ?? [],
    dryRun: opts.dryRun === true,
    state: "waiting",
    createdAt: Date.now()
  };
  state.jobs.set(job.id, job);
  const done = new Promise((resolve2) => {
    state.waiters.set(job.id, resolve2);
    setTimeout(() => {
      if (job.state !== "waiting") return;
      settlement(job, {
        ok: false,
        source: "Chrome extension",
        profile: "extension",
        dryRun: job.dryRun,
        closedSource: false,
        totalRead: 0,
        matched: 0,
        written: 0,
        domains: [],
        error: `the Chrome extension did not pick up the job within ${Math.round(timeoutMs / 1e3)}s \u2014 pair it once in the extension popup (code from the panel) and keep Chrome running`
      });
    }, timeoutMs).unref?.();
  });
  if (state.jobs.size > 20) {
    for (const [id, old] of state.jobs) if (old.state !== "waiting" && id !== job.id) state.jobs.delete(id);
  }
  return { jobId: job.id, done };
}
async function getLoginExtensionJob(jobId) {
  try {
    const state = await ensureBridge();
    const job = state.jobs.get(jobId);
    if (!job) return { ok: false, error: "job not found" };
    return { ok: true, state: job.state, ...job.report ? { report: job.report } : {} };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
function stopLoginExtensionBridge() {
  try {
    bridge?.server.close();
  } catch {
  }
  bridge = null;
  bridgeStarting = null;
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/text.ts
function terminalText(value) {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
function sanitizeText(value) {
  return terminalText(value).replace(/\s+/g, " ").trim();
}
var segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function graphemeWidth(value) {
  if (new RegExp("\\p{Extended_Pictographic}|\\p{Regional_Indicator}|\\u20e3", "u").test(value)) return 2;
  let width = 0;
  for (const char of value) {
    if (new RegExp("\\p{Mark}|\\p{Cf}", "u").test(char)) continue;
    const cp = char.codePointAt(0);
    width += cp >= 4352 && (cp <= 4447 || cp === 9001 || cp === 9002 || cp >= 11904 && cp <= 42191 && cp !== 12351 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65040 && cp <= 65049 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 131072 && cp <= 262141) ? 2 : 1;
  }
  return width;
}
function displayWidth(text) {
  return [...segmenter.segment(terminalText(text))].reduce((sum, part) => sum + graphemeWidth(part.segment), 0);
}
function truncateCells(text, maxCells) {
  const clean = terminalText(text);
  const limit = Math.max(0, Math.floor(maxCells));
  if (!limit) return "";
  if (displayWidth(clean) <= limit) return clean;
  let result = "", cells = 0;
  for (const part of segmenter.segment(clean)) {
    const width = graphemeWidth(part.segment);
    if (cells + width > limit - 1) break;
    cells += width;
    result += part.segment;
  }
  return result + "\u2026";
}

// packages/browser/browser-ego-host/third-party/upstream/src/browser-state.ts
var BrowserStateStore = class {
  snapshot = Object.freeze({ version: 0, recent: Object.freeze([]), spaces: Object.freeze([]), frameRelayDisabled: false });
  listeners = /* @__PURE__ */ new Set();
  running = /* @__PURE__ */ new Map();
  nextToken = 0;
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(patch) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch, version: this.snapshot.version + 1 });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
      }
    }
  }
  startTool(name2, summary, at = Date.now()) {
    const token = ++this.nextToken;
    const activeTool = Object.freeze({ name: name2, summary: truncateCells(summary, 48), startedAt: at });
    this.running.set(token, activeTool);
    this.publish({ activeTool });
    return token;
  }
  finishTool(token, outcome, at = Date.now()) {
    const activity = this.running.get(token);
    if (!activity) return;
    this.running.delete(token);
    const error = outcome.error ? truncateCells(outcome.error, 160) : void 0;
    const item = Object.freeze({
      name: activity.name,
      summary: activity.summary,
      ok: outcome.ok,
      ms: Math.max(0, at - activity.startedAt),
      at,
      ...error ? { error } : {}
    });
    this.publish({
      activeTool: [...this.running.values()].at(-1),
      recent: Object.freeze([...this.snapshot.recent, item].slice(-10)),
      ...error ? { lastError: error } : {}
    });
  }
  update(patch) {
    const next = { ...patch };
    if (patch.browser) next.browser = Object.freeze({ ...patch.browser });
    if (patch.capture) next.capture = Object.freeze({ ...patch.capture });
    if (patch.spaces) next.spaces = Object.freeze(patch.spaces.map((space) => Object.freeze({
      name: space.name,
      tabs: Object.freeze(space.tabs.map((tab) => Object.freeze({
        ...tab,
        ...tab.humanCheck ? { humanCheck: Object.freeze({ ...tab.humanCheck }) } : {}
      })))
    })));
    if (patch.lastError !== void 0) next.lastError = truncateCells(patch.lastError, 160);
    if (Object.keys(next).every((key) => JSON.stringify(this.snapshot[key]) === JSON.stringify(next[key]))) return;
    this.publish(next);
  }
};

// packages/browser/browser-ego-host/third-party/upstream/dsh-plugin.json
var dsh_plugin_default = {
  $schema: "https://dsh.community/schemas/dsh-plugin-0.15.json",
  id: "dsh-ego-browser",
  name: "ego-browser",
  version: "0.9.7",
  manifestVersion: "0.15",
  facets: {
    host: {
      entry: "lib/index.js",
      apiVersion: "v1alpha1"
    }
  },
  requires: {
    contracts: [
      {
        apiVersion: "presentation.dsh/v1alpha1",
        kind: "OpenExternal",
        optional: true,
        fallback: "report the URL as text instead of opening it"
      },
      {
        apiVersion: "presentation.dsh/v1alpha1",
        kind: "Notification",
        optional: true,
        fallback: "omit transient notifications when tuiToast is unavailable; tool results remain available"
      }
    ]
  },
  permissions: [],
  contributes: {
    commands: [],
    "x-dsh-tui": [
      {
        apiVersion: "tui.dsh/v1alpha1",
        kind: "SettingsSection",
        id: "dsh-ego-browser.settings",
        name: "ego_browser_settings",
        spec: {
          namespace: "ego-browser",
          title: "Agent \u6D4F\u89C8\u5668",
          titles: {
            en: "Agent Browser",
            zh: "Agent \u6D4F\u89C8\u5668"
          },
          fields: [
            {
              path: [
                "isolateSpaces"
              ],
              label: "Space isolation",
              kind: "boolean",
              hint: "Use a temporary isolated profile; off keeps the persistent login profile.",
              titles: {
                en: "Space isolation",
                zh: "\u4EFB\u52A1\u7A7A\u95F4\u6C99\u76D2\u9694\u79BB"
              },
              hintTitles: {
                en: "Use a temporary isolated profile; off keeps the persistent login profile.",
                zh: "\u4F7F\u7528\u4E34\u65F6\u9694\u79BB\u7A7A\u95F4\uFF1B\u5173\u95ED\u65F6\u4F7F\u7528\u6301\u4E45\u5316\u767B\u5F55\u914D\u7F6E\u3002"
              }
            },
            {
              path: [
                "idleTimeoutMin"
              ],
              label: "Idle auto-stop (minutes)",
              kind: "number",
              hint: "Stop the browser after N minutes without tool calls; 0 disables. Watching is not activity.",
              titles: {
                en: "Idle auto-stop (minutes)",
                zh: "\u7A7A\u95F2\u81EA\u52A8\u56DE\u6536\uFF08\u5206\u949F\uFF09"
              },
              hintTitles: {
                en: "Stop the browser after N minutes without tool calls; 0 disables. Watching is not activity.",
                zh: "N \u5206\u949F\u6CA1\u6709\u5DE5\u5177\u8C03\u7528\u540E\u5173\u95ED\u6D4F\u89C8\u5668\uFF1B0 \u8868\u793A\u5173\u95ED\u56DE\u6536\u3002\u89C2\u770B\u4E0D\u7B97\u6D3B\u52A8\u3002"
              }
            },
            {
              path: [
                "residentExecutor"
              ],
              label: "Resident executor",
              kind: "boolean",
              hint: "Reuse the execution process; default off.",
              titles: {
                en: "Resident executor",
                zh: "\u5E38\u9A7B\u6267\u884C\u8FDB\u7A0B"
              },
              hintTitles: {
                en: "Reuse the execution process; default off.",
                zh: "\u590D\u7528\u6267\u884C\u8FDB\u7A0B\uFF1B\u9ED8\u8BA4\u5173\u95ED\u3002"
              }
            },
            {
              path: [
                "residentIdleMin"
              ],
              label: "Resident idle stop (minutes)",
              kind: "number",
              hint: "Stop the resident executor after N idle minutes; 0 keeps it until unload.",
              titles: {
                en: "Resident idle stop (minutes)",
                zh: "\u5E38\u9A7B\u7A7A\u95F2\u505C\u6B62\uFF08\u5206\u949F\uFF09"
              },
              hintTitles: {
                en: "Stop the resident executor after N idle minutes; 0 keeps it until unload.",
                zh: "\u7A7A\u95F2 N \u5206\u949F\u540E\u505C\u6B62\u5E38\u9A7B\u6267\u884C\u8FDB\u7A0B\uFF1B0 \u8868\u793A\u4FDD\u7559\u5230\u5378\u8F7D\u3002"
              }
            },
            {
              path: [
                "disableFrameRelay"
              ],
              label: "Disable live preview frames",
              kind: "boolean",
              hint: "No watch panel frames, no screencast capture and no cast worker. Handy in TUI/headless setups. ego_* tools keep working.",
              titles: {
                en: "Disable live preview frames",
                zh: "\u5173\u95ED\u5B9E\u65F6\u753B\u9762\u4F20\u8F93"
              },
              hintTitles: {
                en: "No watch panel frames, no screencast capture and no cast worker. Handy in TUI/headless setups. ego_* tools keep working.",
                zh: "\u4E0D\u4F20\u8F93\u89C2\u5BDF\u7A97\u753B\u9762\u3001\u4E0D\u505A screencast \u91C7\u96C6\u3001\u4E0D\u542F\u52A8 cast worker\uFF1B\u9002\u5408 TUI/\u65E0\u5934\u73AF\u5883\uFF0Cego_* \u5DE5\u5177\u4E0D\u53D7\u5F71\u54CD\u3002"
              }
            },
            {
              path: [
                "egoBin"
              ],
              label: "Runtime script (egoBin)",
              kind: "text",
              hint: "Node-executable script (.mjs/.js); NOT the official ego-browser.exe. Empty = bundled runtime.",
              titles: {
                en: "Runtime script (egoBin)",
                zh: "\u8FD0\u884C\u65F6\u811A\u672C\uFF08egoBin\uFF09"
              },
              hintTitles: {
                en: "Node-executable script (.mjs/.js); NOT the official ego-browser.exe. Empty = bundled runtime.",
                zh: "Node \u53EF\u6267\u884C\u811A\u672C\uFF08.mjs/.js\uFF09\uFF0C\u4E0D\u662F\u5B98\u65B9 ego-browser.exe\uFF1B\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u8FD0\u884C\u65F6\u3002"
              }
            },
            {
              path: [
                "chromePath"
              ],
              label: "Browser binary path",
              kind: "text",
              hint: "Path to Chrome, Chromium or Edge. Empty means auto-detect.",
              titles: {
                en: "Browser binary path",
                zh: "\u6D4F\u89C8\u5668\u7A0B\u5E8F\u8DEF\u5F84"
              },
              hintTitles: {
                en: "Path to Chrome, Chromium or Edge. Empty means auto-detect.",
                zh: "Chrome\u3001Chromium \u6216 Edge \u8DEF\u5F84\uFF1B\u7559\u7A7A\u81EA\u52A8\u68C0\u6D4B\u3002"
              }
            },
            {
              path: [
                "captureBackend"
              ],
              label: "Capture backend",
              kind: "select",
              options: [
                {
                  value: "auto",
                  label: "Auto"
                },
                {
                  value: "cdp",
                  label: "CDP"
                },
                {
                  value: "ffmpeg",
                  label: "FFmpeg"
                }
              ],
              titles: {
                en: "Capture backend",
                zh: "\u753B\u9762\u91C7\u96C6\u540E\u7AEF"
              },
              hint: "Choose automatic detection, CDP or FFmpeg.",
              hintTitles: {
                en: "Choose automatic detection, CDP or FFmpeg.",
                zh: "\u9009\u62E9\u81EA\u52A8\u68C0\u6D4B\u3001CDP \u6216 FFmpeg\u3002"
              }
            },
            {
              path: [
                "streamProfile"
              ],
              label: "Quality profile",
              kind: "select",
              options: [
                {
                  value: "low",
                  label: "Low",
                  titles: {
                    zh: "\u4F4E"
                  }
                },
                {
                  value: "balanced",
                  label: "Balanced",
                  titles: {
                    zh: "\u5747\u8861"
                  }
                },
                {
                  value: "high",
                  label: "High",
                  titles: {
                    zh: "\u9AD8"
                  }
                }
              ],
              titles: {
                en: "Quality profile",
                zh: "\u753B\u8D28\u9884\u8BBE"
              },
              hint: "Low reduces bandwidth; balanced is the default; high improves detail.",
              hintTitles: {
                en: "Low reduces bandwidth; balanced is the default; high improves detail.",
                zh: "\u4F4E\u753B\u8D28\u51CF\u5C11\u5E26\u5BBD\uFF1B\u5747\u8861\u4E3A\u9ED8\u8BA4\uFF1B\u9AD8\u753B\u8D28\u4FDD\u7559\u66F4\u591A\u7EC6\u8282\u3002"
              }
            },
            {
              path: [
                "ffmpegPath"
              ],
              label: "FFmpeg binary path",
              kind: "text",
              hint: "Path to FFmpeg. Empty means auto-detect or on-demand installation.",
              titles: {
                en: "FFmpeg binary path",
                zh: "FFmpeg \u7A0B\u5E8F\u8DEF\u5F84"
              },
              hintTitles: {
                en: "Path to FFmpeg. Empty means auto-detect or on-demand installation.",
                zh: "FFmpeg \u8DEF\u5F84\uFF1B\u7559\u7A7A\u81EA\u52A8\u68C0\u6D4B\u6216\u6309\u9700\u5B89\u88C5\u3002"
              }
            },
            {
              path: [
                "tuiAutoOpenPanel"
              ],
              label: "Auto-open TUI browser panel",
              titles: {
                en: "Auto-open TUI browser panel",
                zh: "\u81EA\u52A8\u6253\u5F00 TUI \u6D4F\u89C8\u5668\u9762\u677F"
              },
              kind: "boolean",
              hint: "Off by default. Open the panel on the first ego_* call; otherwise show a badge and status only.",
              hintTitles: {
                en: "Off by default. Open the panel on the first ego_* call; otherwise show a badge and status only.",
                zh: "\u9ED8\u8BA4\u5173\u95ED\u3002\u5F00\u542F\u540E\u9996\u6B21 ego_* \u8C03\u7528\u6253\u5F00\u9762\u677F\uFF1B\u5173\u95ED\u65F6\u4EC5\u663E\u793A\u89D2\u6807\u548C\u72B6\u6001\u3002"
              }
            }
          ]
        }
      }
    ]
  },
  subscriptions: [],
  license: "MIT",
  source: {
    repository: "https://github.com/Fisfzy/dsh-ego-browser"
  },
  compat: {
    hosts: [
      "dsh-tui"
    ]
  }
};

// packages/browser/browser-ego-host/third-party/upstream/src/tui/settings.ts
var manifestSettingsFields = dsh_plugin_default.contributes["x-dsh-tui"].find((section) => section.kind === "SettingsSection").spec.fields;
var tuiSettingsFields = manifestSettingsFields.map(({ titles, hintTitles, options, ...field }) => ({
  ...field,
  ...titles ? { descriptions: titles } : {},
  ...hintTitles ? { hintDescriptions: hintTitles } : {},
  ...options ? { options: options.map(({ titles: optionTitles, ...option }) => ({ ...option, ...optionTitles ? { descriptions: optionTitles } : {} })) } : {}
}));
var tuiSettingsSection = {
  ns: "ego-browser",
  title: "Agent Browser",
  descriptions: { zh: "Agent \u6D4F\u89C8\u5668" },
  page: { id: "ego-browser", title: "Agent Browser", descriptions: { zh: "Agent \u6D4F\u89C8\u5668" } },
  fields: tuiSettingsFields
};
function installTuiSettings(ctx) {
  ctx.inject?.(["tuiSettingsSections"], (sctx) => {
    const dispose = sctx.tuiSettingsSections.register(tuiSettingsSection);
    sctx.effect?.(() => dispose);
  });
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/integration.ts
function installTui(ctx, store) {
  installTuiSettings(ctx);
  let override;
  let refreshStatus;
  let deliverToast;
  ctx.inject?.(["tuiStatus"], (sctx) => {
    let previous = "";
    let previousClick;
    let disposeField;
    const render = () => {
      const snapshot = store.getSnapshot();
      const active = snapshot.activeTool;
      const lastError = snapshot.lastError ?? snapshot.recent.findLast((result) => result.error)?.error;
      const text = override?.text ?? (active ? `\u25CE ${active.name}` : "\u25CE idle");
      const tone = override?.tone ?? (active ? "accent" : "dim");
      const detail = truncateCells(override?.detail ?? (active ? [[active.name, active.summary].filter(Boolean).join(" \xB7 "), lastError].filter(Boolean).join(" | ") : lastError ?? "Agent Browser is idle"), 160);
      const key = JSON.stringify([text, tone, detail]);
      if (key === previous && previousClick === override?.onClick) return;
      previous = key;
      previousClick = override?.onClick;
      disposeField?.();
      disposeField = sctx.tuiStatus.setField("ego-browser", text, {
        slot: "right-head",
        tone,
        maxCells: 24,
        detail,
        ...override?.onClick ? { onClick: override.onClick } : {}
      });
    };
    refreshStatus = render;
    render();
    const off = store.subscribe(render);
    sctx.effect?.(() => () => {
      off();
      disposeField?.();
      if (refreshStatus === render) refreshStatus = void 0;
    });
  });
  ctx.inject?.(["tuiToast"], (sctx) => {
    let sent = [];
    const deliver = (text, color) => {
      const now = Date.now();
      sent = sent.filter((at) => now - at < 6e4);
      if (sent.length >= 20) return;
      sent.push(now);
      try {
        sctx.tuiToast.show(truncateCells(text, 200), { color, timeoutMs: 4e3 });
      } catch {
      }
    };
    deliverToast = deliver;
    sctx.effect?.(() => () => {
      if (deliverToast === deliver) deliverToast = void 0;
    });
  });
  return {
    toast: (text, color) => deliverToast?.(text, color),
    hasToast: () => deliverToast !== void 0,
    setStatusOverride: (value) => {
      override = value;
      refreshStatus?.();
    }
  };
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/panel-controller.ts
function parseSpaces(value, groups = []) {
  if (!value || typeof value !== "object") return [];
  const rows = value.spaces;
  if (!Array.isArray(rows)) return [];
  const parseTabs = (values) => values.flatMap((value2) => {
    if (!value2 || typeof value2 !== "object") return [];
    const tab = value2;
    if (typeof tab.targetId !== "string") return [];
    return [{ targetId: tab.targetId, url: sanitizeText(typeof tab.url === "string" ? tab.url : ""), title: sanitizeText(typeof tab.title === "string" ? tab.title : ""), active: tab.active === true, humanCheck: tab.humanCheck && typeof tab.humanCheck === "object" && tab.humanCheck.detected === true ? { detected: true, kind: typeof tab.humanCheck.kind === "string" ? sanitizeText(tab.humanCheck.kind) : void 0 } : void 0 }];
  });
  if (rows.some((row) => row && typeof row === "object" && Array.isArray(row.tabs))) {
    return rows.filter((row) => row && typeof row === "object" && Array.isArray(row.tabs)).map((row) => ({ name: sanitizeText(typeof row.name === "string" ? row.name : "Unnamed space"), tabs: parseTabs(row.tabs) }));
  }
  const tabs = parseTabs(rows);
  const remaining = new Map(tabs.map((tab) => [tab.targetId, tab]));
  const spaces = groups.flatMap((group) => {
    const members = group.targetIds.flatMap((id) => {
      const tab = remaining.get(id);
      if (!tab) return [];
      remaining.delete(id);
      return [tab];
    });
    return members.length ? [{ name: sanitizeText(group.name), tabs: members }] : [];
  });
  if (!spaces.length) return [{ name: "Global/default group", tabs }];
  if (remaining.size) spaces.push({ name: "Unassigned / global", tabs: [...remaining.values()] });
  return spaces;
}
function parseCapture(value) {
  if (!value || typeof value !== "object") return void 0;
  const capture = value.capture;
  if (!capture || typeof capture !== "object") return void 0;
  const fields = capture;
  if (typeof fields.backend !== "string" || typeof fields.state !== "string") return void 0;
  return {
    backend: truncateCells(sanitizeText(fields.backend), 40),
    state: truncateCells(sanitizeText(fields.state), 40),
    ...typeof fields.code === "string" ? { code: truncateCells(sanitizeText(fields.code), 40) } : {}
  };
}
function createPanelController(store, config, transport) {
  let disposed = false;
  let visible = false;
  let generation = 0;
  let timer;
  let pending;
  let queued = false;
  const refresh = () => {
    if (disposed) return Promise.resolve();
    if (pending) {
      queued = true;
      return pending;
    }
    const epoch = generation;
    pending = (async () => {
      const browser = await transport.readBrowserState();
      if (disposed || epoch !== generation) return;
      store.update({ browser, frameRelayDisabled: false });
      if (!browser.running) {
        store.update({ spaces: [], capture: void 0 });
        return;
      }
      const port = await transport.ensureWorker();
      if (disposed || epoch !== generation) return;
      if (!port) {
        store.update({ lastError: "Browser worker unavailable" });
        return;
      }
      const payload = await transport.get(port, "/api/spaces");
      if (disposed || epoch !== generation) return;
      const groups = payload ? await transport.readTaskSpaceGroups?.() ?? [] : [];
      if (disposed || epoch !== generation) return;
      store.update(payload ? { spaces: parseSpaces(payload, groups), capture: parseCapture(payload), lastError: void 0 } : { lastError: "Could not refresh browser tabs" });
    })().catch((error) => {
      if (!disposed && epoch === generation) store.update({ lastError: sanitizeText(String(error)) });
    }).finally(() => {
      pending = void 0;
      if (queued) {
        queued = false;
        void refresh();
      }
    });
    return pending;
  };
  const post = async (path, body) => {
    if (disposed) return;
    const port = await transport.ensureWorker();
    if (!port || disposed) return;
    const result = await transport.post(port, path, body);
    if (disposed) return;
    if (!result || result.status < 200 || result.status >= 300) {
      store.update({ lastError: path === "/api/close" ? "Could not close tab" : "Could not flush browser cookies" });
      return;
    }
    await refresh();
  };
  let latest = store.getSnapshot().recent.at(-1);
  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot().recent.at(-1);
    if (next === latest) return;
    latest = next;
    if (next) void refresh();
  });
  return {
    setVisible(next) {
      if (disposed || next === visible) return;
      visible = next;
      if (!visible) queued = false;
      generation++;
      if (timer) clearInterval(timer);
      timer = void 0;
      if (visible) {
        void refresh();
        timer = setInterval(() => void refresh(), 2e3);
      }
    },
    refresh,
    close: (targetId) => post("/api/close", { targetId }).catch((error) => {
      if (!disposed) store.update({ lastError: sanitizeText(String(error)) });
    }),
    flush: () => post("/api/flush", {}).catch((error) => {
      if (!disposed) store.update({ lastError: sanitizeText(String(error)) });
    }),
    dispose() {
      disposed = true;
      queued = false;
      generation++;
      if (timer) clearInterval(timer);
      unsubscribe();
    }
  };
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/panel-layout.ts
function rowTextProps(row) {
  return row.tone === "dim" || row.tone === void 0 ? { dimColor: row.tone === "dim", wrap: "truncate" } : { dimColor: false, color: row.tone, wrap: "truncate" };
}
function panelTabs(snapshot) {
  return (snapshot.spaces ?? []).flatMap((space) => space.tabs);
}
function hasHumanCheck(snapshot) {
  return panelTabs(snapshot).some((tab) => tab.humanCheck?.detected === true);
}
function layoutPanel(snapshot, width, height, selected) {
  const rows = [];
  const add = (text, tone) => rows.push({ text: truncateCells(text, width), tone });
  const tabs = panelTabs(snapshot);
  const active = tabs.find((tab) => tab.active);
  add(snapshot.spaces?.length === 1 ? `\u25CE Agent Browser \xB7 ${snapshot.spaces[0]?.name ?? ""}` : "\u25CE Agent Browser", "dim");
  if (snapshot.browser) add(snapshot.browser.running ? `\u25CE running${snapshot.browser.headless === void 0 ? "" : snapshot.browser.headless ? " \xB7 headless" : " \xB7 windowed"}` : "\u25CE stopped", snapshot.browser.running ? "success" : "dim");
  if (active) {
    add(active.title || "(untitled)", "accent");
    add(active.url, "dim");
  }
  if (hasHumanCheck(snapshot)) add("! Human check \xB7 o to take over", "warning");
  if (snapshot.activeTool) add(`\u25B6 ${snapshot.activeTool.name} \xB7 ${snapshot.activeTool.summary}`, "accent");
  if (snapshot.lastError) add(`! ${snapshot.lastError}`, "error");
  const actions = snapshot.recent.slice(-Math.min(5, Math.max(3, height - rows.length - 6)));
  const tabBudget = Math.max(0, height - rows.length - actions.length - 3);
  const flattened = (snapshot.spaces ?? []).flatMap((space) => space.tabs.map((tab) => ({ tab, group: space.name })));
  const tabRows = Math.max(0, tabBudget - 1);
  const start = Math.max(0, Math.min(selected - tabRows + 1, flattened.length - tabRows));
  if (tabBudget > 0) {
    add(`Tabs (${tabs.length}) \xB7 ${snapshot.spaces?.length === 1 ? snapshot.spaces[0]?.name : "groups"}`, "dim");
    for (let i = start; i < Math.min(flattened.length, start + tabRows); i++) {
      const item = flattened[i];
      const group = (snapshot.spaces?.length ?? 0) > 1 ? `[${item.group}] ` : "";
      add(`${i === selected ? "\u203A" : " "} ${item.tab.active ? "*" : " "} ${group}${item.tab.title || item.tab.url}`, i === selected ? "accent" : void 0);
    }
  }
  if (actions.length) add("Recent actions", "dim");
  for (const action of actions) add(`${action.ok ? "\u2713" : "\u2717"} ${action.ms}ms ${action.name} \xB7 ${action.summary}`, action.ok ? "success" : "error");
  const hint = { text: truncateCells("\u2191\u2193 select \xB7 o open \xB7 x close \xB7 f login \xB7 r refresh", width), tone: "dim" };
  return [...rows.slice(0, Math.max(0, height - 1)), hint].slice(0, Math.max(0, height));
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/panel.ts
function installBrowserPanel(ctx, config, store, tui, dependencies) {
  let dialogs;
  ctx.inject?.(["tuiDialogs"], (dctx) => {
    dialogs = dctx.tuiDialogs;
    dctx.effect?.(() => () => {
      dialogs = void 0;
    });
  });
  ctx.inject?.(["tuiPanels"], (pctx) => {
    const panels = pctx.tuiPanels;
    if (!panels) return;
    const transport = dependencies.createTransport();
    const controller = createPanelController(store, config, transport);
    let host;
    let disposed = false;
    let firstTool = false;
    let previousHuman = false;
    let lastOpen = -Infinity;
    let panelId = "";
    const openPanel = () => {
      if (!panelId || disposed || Date.now() - lastOpen < 5e3) return;
      lastOpen = Date.now();
      panels.open(panelId);
    };
    const notify = (level) => {
      if (host) host.notify(level, 1);
      else if (panelId) panels.badge(panelId, { level, unread: 1 });
    };
    const onSnapshot = () => {
      const snapshot = store.getSnapshot();
      if (!firstTool && snapshot.activeTool) {
        firstTool = true;
        notify("info");
        if (config.tuiAutoOpenPanel) openPanel();
      }
      const human = hasHumanCheck(snapshot);
      if (human && !previousHuman) {
        notify("warning");
        tui.toast("Browser needs human verification. Press o in Agent Browser to take over.", "warning");
      }
      if (human !== previousHuman) {
        previousHuman = human;
        tui.setStatusOverride(human ? { text: "\u25CE human check", tone: "warning", detail: "Human verification required. Open Agent Browser, then press o to take over.", onClick: openPanel } : void 0);
      }
    };
    const unsubscribe = store.subscribe(onSnapshot);
    function BrowserPanel(props) {
      const { React, ui } = props;
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot);
      const [selectedId, setSelectedId] = React.useState(void 0);
      const [closeArmed, setCloseArmed] = React.useState(void 0);
      const [message, setMessage] = React.useState("");
      const closing = React.useRef(false);
      const mounted = React.useRef(true);
      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);
      React.useEffect(() => {
        if (!props.visible) return;
        setSnapshot(store.getSnapshot());
        return store.subscribe(() => setSnapshot(store.getSnapshot()));
      }, [props.visible]);
      React.useEffect(() => {
        host = props.host;
        return () => {
          if (host === props.host) host = void 0;
        };
      }, [props.host]);
      React.useEffect(() => {
        controller.setVisible(props.visible);
        return () => controller.setVisible(false);
      }, [props.visible]);
      const tabs = panelTabs(snapshot);
      let selection = tabs.findIndex((tab) => tab.targetId === selectedId);
      if (selection < 0) selection = tabs.findIndex((tab) => tab.active);
      if (selection < 0) selection = 0;
      const targetId = tabs[selection]?.targetId;
      const move = (delta) => {
        if (tabs.length === 0) return;
        const next = Math.max(0, Math.min(tabs.length - 1, selection + delta));
        const id = tabs[next]?.targetId;
        if (id) setSelectedId(id);
        setCloseArmed(void 0);
      };
      React.useEffect(() => {
        setCloseArmed(void 0);
      }, [targetId, props.visible, props.focused]);
      React.useEffect(() => {
        if (!props.visible || !props.focused) return;
        return props.host.onKey((event) => {
          if (event.key.ctrl || event.key.meta) return;
          let action;
          if (event.key.upArrow) action = () => move(-1);
          else if (event.key.downArrow) action = () => move(1);
          else if (event.input === "o") action = () => {
            setCloseArmed(void 0);
            void dependencies.openAgentWindow().then((result) => {
              if (!disposed && mounted.current && !result.ok) setMessage(result.error || "Could not open browser window");
            }).catch((error) => {
              if (!disposed && mounted.current) setMessage(String(error));
            });
          };
          else if (event.input === "r") action = () => {
            setCloseArmed(void 0);
            void controller.refresh();
          };
          else if (event.input === "f") action = () => {
            setCloseArmed(void 0);
            void controller.flush();
          };
          else if (event.input === "x" && targetId) action = () => {
            if (closing.current) return;
            if (!dialogs && closeArmed !== targetId) {
              setCloseArmed(targetId);
              return;
            }
            closing.current = true;
            void (async () => {
              const confirmed = dialogs ? await dialogs.confirm({ title: "Close browser tab?", message: truncateCells(tabs[selection]?.title || tabs[selection]?.url || targetId, 200), confirmLabel: "Close tab", cancelLabel: "Keep tab" }) : true;
              if (confirmed && !disposed && mounted.current) await controller.close(targetId);
            })().finally(() => {
              closing.current = false;
              if (mounted.current) setCloseArmed(void 0);
            });
          };
          if (!action) {
            setCloseArmed(void 0);
            return;
          }
          event.preventDefault();
          action();
        });
      }, [props.host, props.visible, props.focused, snapshot, selection, closeArmed, targetId]);
      const rows = layoutPanel(snapshot, props.width, props.height, selection);
      if (closeArmed && rows.length) rows[rows.length - 1] = { text: truncateCells("Press x again to close this tab", props.width), tone: "warning" };
      else if (message && rows.length) rows[rows.length - 1] = { text: truncateCells(message, props.width), tone: "error" };
      return React.createElement(ui.Box, { flexDirection: "column", width: props.width, height: props.height }, ...rows.map((row, index) => React.createElement(ui.Text, { key: index, ...rowTextProps(row) }, row.text)));
    }
    const unregister = panels.register({ apiVersion: 1, id: "browser", title: "Agent Browser", icon: "\u25CE", minColumns: 28, component: BrowserPanel });
    panelId = panels.list().find((panel) => panel.id.endsWith(":browser"))?.id ?? "";
    pctx.effect?.(() => () => {
      disposed = true;
      controller.dispose();
      unsubscribe();
      tui.setStatusOverride(void 0);
      if (typeof unregister === "function") unregister();
    });
  });
}

// packages/browser/browser-ego-host/third-party/upstream/src/worker-client.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join3 } from "node:path";
var WORKER_BIN = fileURLToPath2(new URL("../bin/ego-cast-worker.mjs", import.meta.url));
function castStatePath() {
  const e = process.env;
  const isWin = process.platform === "win32";
  const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : "/root");
  const stateHome = e.EGO_LINUX_STATE_DIR || (isWin ? e.LOCALAPPDATA || `${home}\\AppData\\Local` : e.XDG_STATE_HOME || `${home}/.local/state`);
  return stateHome.endsWith("ego-lite-linux") ? `${stateHome}/ego-cast.json` : `${stateHome}/ego-lite-linux/ego-cast.json`;
}
async function proxyFrom(port, path) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4e3) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
async function proxyPost(port, path, body, timeoutMs = 4e3) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { status: r.status, body: await r.json().catch(() => ({ ok: false, error: `worker returned ${r.status}` })) };
  } catch {
    return null;
  }
}
async function knownWorkerState() {
  try {
    const { readFile: readFile4 } = await import("node:fs/promises");
    const state = JSON.parse(await readFile4(castStatePath(), "utf8"));
    return {
      port: typeof state.port === "number" ? state.port : null,
      pid: typeof state.pid === "number" ? state.pid : null
    };
  } catch {
    return { port: null, pid: null };
  }
}
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err;
    return e && e.code === "EPERM";
  }
}
function captureConfig(cfg, ffmpegManager) {
  const ffmpegStatus = ffmpegManager?.status();
  const unavailable = cfg.captureBackend === "ffmpeg" && !ffmpegStatus?.canSelectFfmpeg;
  return {
    captureBackend: unavailable ? "cdp" : cfg.captureBackend,
    ffmpegFallbackReason: unavailable ? ffmpegStatus?.reason || "FFmpeg is unavailable" : "",
    streamProfile: cfg.streamProfile,
    cdpFps: cfg.cdpFps,
    cdpQuality: cfg.cdpQuality,
    cdpMaxWidth: cfg.cdpMaxWidth,
    cdpBackstopIntervalMs: cfg.cdpBackstopIntervalMs,
    ffmpegFps: cfg.ffmpegFps,
    ffmpegMaxWidth: cfg.ffmpegMaxWidth,
    ffmpegBitrateKbps: cfg.ffmpegBitrateKbps,
    ffmpegEncoder: cfg.ffmpegEncoder,
    ffmpegPath: cfg.ffmpegPath,
    ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? ffmpegStatus.path || "" : ""
  };
}
function makeEnsureWorker(ctx, cfg, ffmpegManager) {
  let lastAttempt = 0;
  async function launchedWorkerPort() {
    const state = await knownWorkerState();
    if (state.pid === null || !isProcessAlive(state.pid)) return null;
    const alive = await proxyFrom(state.port, "/api/health");
    return alive ? state.port : null;
  }
  return async function ensureWorker() {
    const running = await launchedWorkerPort();
    if (running !== null) return running;
    const now = Date.now();
    if (now - lastAttempt > 8e3) {
      lastAttempt = now;
      try {
        await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null);
        const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager));
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, WORKER_BIN, initCfg],
          // cwd is required by the dsh-subprocess provider on DSH >= 0.1.5 —
          // omitting it throws inside spawn() and the catch below swallowed it
          // silently, making the watch panel never start (issue #34 defect 1).
          cwd: process.cwd(),
          // Electron hosts (DSH Desktop): process.execPath is the Electron
          // binary; children need ELECTRON_RUN_AS_NODE=1 or they boot as a
          // second Electron app (issue #42). Mirror of resolveEgoEnv's guard —
          // inlined here because cast-server cannot import from index.ts
          // (circular import).
          env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1" } : void 0,
          stdio: {
            stdin: { data: "" },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 }
          },
          graceMs: 12e3
        });
        handle.done.catch(() => null);
        const deadline = Date.now() + 8e3;
        while (Date.now() < deadline) {
          const ready = await launchedWorkerPort();
          if (ready !== null) return ready;
          await new Promise((resolve2) => setTimeout(resolve2, 100));
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  };
}
async function readTaskSpaceGroups() {
  try {
    const { readFile: readFile4 } = await import("node:fs/promises");
    const state = JSON.parse(await readFile4(join3(resolveEgoStateDir(), "task-spaces.json"), "utf8"));
    if (!Array.isArray(state.spaces)) return [];
    return state.spaces.flatMap((value) => {
      if (!value || typeof value !== "object" || typeof value.name !== "string" || !Array.isArray(value.targetIds)) return [];
      return [{ name: value.name, targetIds: value.targetIds.filter((id) => typeof id === "string") }];
    });
  } catch {
    return [];
  }
}
async function readBrowserState() {
  try {
    const { readFile: readFile4 } = await import("node:fs/promises");
    const state = JSON.parse(await readFile4(join3(resolveEgoStateDir(), "browser.json"), "utf8"));
    const running = typeof state.pid === "number" && isProcessAlive(state.pid);
    return { running, ...typeof state.headless === "boolean" ? { headless: state.headless } : {} };
  } catch {
    return { running: false };
  }
}

// packages/browser/browser-ego-host/third-party/upstream/src/tui/presentation.ts
var selectorTools = /* @__PURE__ */ new Set([
  "ego_click",
  "ego_fill",
  "ego_screenshot",
  "ego_wait_for_selector",
  "ego_hover",
  "ego_read_element",
  "ego_select",
  "ego_scroll",
  "ego_upload",
  "ego_check"
]);
var urlTools = /* @__PURE__ */ new Set(["ego_navigate", "ego_http", "ego_wait_for_response"]);
function safeLocatorSummary(name2, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const args = value;
  let summary = "";
  if (selectorTools.has(name2) && typeof args.selector === "string") summary = args.selector;
  else if (urlTools.has(name2) && typeof args.url === "string") {
    try {
      const url = new URL(args.url);
      if (url.protocol === "http:" || url.protocol === "https:") summary = url.host + url.pathname;
    } catch {
    }
  } else if (name2 === "ego_drag" && typeof args.from === "string" && typeof args.to === "string") {
    summary = `${args.from} \u2192 ${args.to}`;
  } else if (name2 === "ego_download" && typeof args.triggerSelector === "string") summary = args.triggerSelector;
  return truncateCells(sanitizeText(summary), 48);
}
function toolCallTitle(name2, args) {
  const summary = safeLocatorSummary(name2, args);
  return summary ? `${name2} \xB7 ${summary}` : name2;
}

// packages/browser/browser-ego-host/third-party/upstream/src/cast-server.ts
import { request } from "node:http";
var EGO_SPACES_ROUTE = "/api/ego/spaces";
var EGO_STREAM_ROUTE = "/api/ego/stream";
var EGO_HEALTH_ROUTE = "/api/ego/health";
var EGO_CLOSE_ROUTE = "/api/ego/close";
var EGO_FLUSH_ROUTE = "/api/ego/flush";
var EGO_RAISE_ROUTE = "/api/ego/raise";
var EGO_LOGIN_IMPORT_ROUTE = "/api/ego/login-import";
var EGO_INPUT_ROUTE = "/api/ego/input";
var EGO_WINDOW_SIZE_ROUTE = "/api/ego/window-size";
var EGO_WATCH_START_ROUTE = "/api/ego/watch/start";
var EGO_WATCH_SWITCH_ROUTE = "/api/ego/watch/switch";
var EGO_WATCH_STOP_ROUTE = "/api/ego/watch/stop";
var EGO_WATCH_STATUS_ROUTE = "/api/ego/watch/status";
var EGO_VIDEO_ROUTE = "/api/ego/video";
var EGO_VIDEO_STATUS_ROUTE = "/api/ego/video/status";
var toolCallCount = 0;
var sseClients = /* @__PURE__ */ new Set();
var lastEgoActivity = 0;
function getLastEgoActivity() {
  return lastEgoActivity;
}
function markEgoToolCall(sessionId) {
  toolCallCount += 1;
  lastEgoActivity = Date.now();
  const payload = sessionId === void 0 || sessionId === "" ? { count: toolCallCount } : { count: toolCallCount, sessionId };
  const frame = `event: tool-call
data: ${JSON.stringify(payload)}

`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}
function sendJson2(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}
function proxyWorkerStream(port, res, path, retry, retryDelayMs = 1500) {
  let cancelled = false;
  let ended = false;
  let timer = null;
  let upstream = null;
  const endOnce = () => {
    if (ended) return;
    ended = true;
    sseClients.delete(res);
    try {
      res.end();
    } catch {
    }
  };
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(":ok\n\n");
  sseClients.add(res);
  const onClose = () => {
    cancelled = true;
    sseClients.delete(res);
    try {
      upstream?.destroy();
    } catch {
    }
  };
  if (!Number.isInteger(port) || port <= 0) {
    res.on("close", () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      sseClients.delete(res);
    });
    if (retry) {
      const attempt = () => {
        if (cancelled || ended) return;
        retry().then((next) => {
          if (cancelled || ended) return;
          if (typeof next === "number" && next > 0) {
            res.on("close", onClose);
            attach(next);
          } else {
            timer = setTimeout(attempt, Math.max(20, retryDelayMs));
          }
        }).catch(() => {
          if (!cancelled && !ended) timer = setTimeout(attempt, Math.max(20, retryDelayMs));
        });
      };
      timer = setTimeout(attempt, Math.max(20, retryDelayMs));
      return () => {
        cancelled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        sseClients.delete(res);
      };
    }
    return () => {
      sseClients.delete(res);
    };
  }
  function attach(workerPort) {
    upstream = request(
      { host: "127.0.0.1", port: workerPort, path, method: "GET", headers: { accept: "text/event-stream" } },
      (upRes) => {
        upRes.on("data", (chunk) => {
          if (cancelled || ended) return;
          try {
            if (!res.write(chunk)) {
              upRes.pause();
              res.once("drain", () => {
                if (!cancelled && !ended) upRes.resume();
              });
            }
          } catch {
            cancelled = true;
            endOnce();
          }
        });
        upRes.on("end", endOnce);
        upRes.on("error", endOnce);
      }
    );
    upstream.on("error", endOnce);
    upstream.setTimeout(5e3, () => {
      try {
        upstream?.destroy();
      } catch {
      }
      endOnce();
    });
    upstream.end();
  }
  res.on("close", onClose);
  attach(port);
  return () => {
    cancelled = true;
    sseClients.delete(res);
    try {
      upstream?.destroy();
    } catch {
    }
  };
}
function proxyWorkerVideo(port, req, res) {
  const sourceUrl = new URL(req.url || EGO_VIDEO_ROUTE, "http://dsh.internal");
  const generation = sourceUrl.searchParams.get("generation");
  const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ""}`;
  let upstream;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    try {
      res.end();
    } catch {
    }
  };
  upstream = request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "video/mp4" } }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      "content-type": upRes.headers["content-type"] || "application/octet-stream",
      "cache-control": "no-store",
      ...upRes.headers["x-ego-generation"] ? { "x-ego-generation": upRes.headers["x-ego-generation"] } : {},
      ...upRes.headers["x-ego-backend"] ? { "x-ego-backend": upRes.headers["x-ego-backend"] } : {}
    });
    upRes.on("data", (chunk) => {
      if (ended) return;
      try {
        if (!res.write(chunk)) {
          upRes.pause();
          res.once("drain", () => {
            if (!ended) upRes.resume();
          });
        }
      } catch {
        upstream.destroy();
        end();
      }
    });
    upRes.on("end", end);
    upRes.on("error", end);
  });
  upstream.on("error", () => {
    if (!res.headersSent) sendJson2(res, 502, { ok: false, error: "video worker unavailable" });
    else end();
  });
  upstream.setTimeout(5e3, () => {
    try {
      upstream.destroy();
    } catch {
    }
    if (!res.headersSent) sendJson2(res, 504, { ok: false, error: "video worker timeout" });
    else end();
  });
  upstream.end();
  res.on("close", () => {
    ended = true;
    try {
      upstream.destroy();
    } catch {
    }
  });
}
async function readJsonBody2(req, maxBytes = 8192) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("body too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
var FRAME_RELAY_DISABLED = "frame relay disabled";
async function stopCastWorker() {
  const state = await knownWorkerState();
  if (state.pid === null || !isProcessAlive(state.pid)) return false;
  try {
    process.kill(state.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
function makePushConfig(ensureWorker, ffmpegManager) {
  let lastPush = "";
  return async function pushConfig(cfg) {
    await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null);
    const port = await ensureWorker();
    if (port === null) return;
    const payload = JSON.stringify(captureConfig(cfg, ffmpegManager));
    if (payload === lastPush) return;
    lastPush = payload;
    try {
      const result = await proxyPost(port, "/api/config", JSON.parse(payload));
      if (!result || result.status >= 400) throw new Error("worker config update failed");
    } catch {
    }
  };
}
function initCastServer(ctx, cfg, bridge2, ffmpegManager, openAgentWindow2 = async () => ({ ok: false, error: "raise not supported by this host build" }), loginImport = async () => ({ ok: false, error: "login import not supported by this host build" }), getExecutorStatus = () => ({})) {
  const ensureWorker = makeEnsureWorker(ctx, cfg, ffmpegManager);
  const pushConfig = makePushConfig(ensureWorker, ffmpegManager);
  const rawServer = ctx.get?.("webServer");
  if (!rawServer || typeof rawServer.register !== "function") {
    return;
  }
  const isTrustedRequest = (req) => {
    const remote = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return false;
    const authority = req.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(authority)) return false;
    if (req.headers.origin !== void 0 && req.headers.origin !== `http://${authority}`) return false;
    return /(?:^|;\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie ?? ""));
  };
  const guardHandler = (handler) => async (req, resRaw) => {
    const res = resRaw;
    if (!isTrustedRequest(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    return handler(req, res);
  };
  const rawRegister = rawServer.register.bind(rawServer);
  const externallyOwned = /* @__PURE__ */ new Set([
    "/api/ego/spaces",
    "/api/ego/stream",
    "/api/ego/input",
    "/api/ego/close",
    "/api/ego/status",
    "/api/ego/history",
    "/api/ego/frame",
    "/api/ego/activity"
  ]);
  const server = Object.assign(Object.create(Object.getPrototypeOf(rawServer)), rawServer, {
    register: (opts) => externallyOwned.has(opts.path) ? () => {
    } : rawRegister({
      ...opts,
      handler: opts.handler ? guardHandler(opts.handler) : opts.handler
    })
  });
  const relayDisabled = () => cfg.disableFrameRelay === true;
  const refuseFrameRelay = (res, extra = {}) => {
    sendJson2(res, 200, { ok: false, reason: FRAME_RELAY_DISABLED, frameRelay: false, ...extra });
  };
  if (typeof bridge2?.onChange === "function") {
    const off = bridge2.onChange(() => {
      if (relayDisabled()) {
        void stopCastWorker();
        return;
      }
      pushConfig(cfg);
    });
    if (typeof off === "function") {
      ctx.effect?.(() => () => {
        try {
          off();
        } catch {
        }
      });
    }
  }
  const disposeSpaces = server.register({
    kind: "exact",
    path: EGO_SPACES_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { spaces: [], toolCallCount });
      const port = await ensureWorker();
      if (port === null) {
        return sendJson2(res, 200, { ok: false, spaces: [], toolCallCount, reason: "no live agent browser", frameRelay: true });
      }
      const data = await proxyFrom(port, "/api/spaces");
      if (!data) return sendJson2(res, 200, { ok: false, spaces: [], toolCallCount, reason: "worker not ready", frameRelay: true });
      return sendJson2(res, 200, { ...data, toolCallCount, frameRelay: true });
    }
  });
  const disposeStream = server.register({
    kind: "exact",
    path: EGO_STREAM_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res);
      const port = await ensureWorker();
      proxyWorkerStream(port ?? -1, res, "/api/stream", ensureWorker);
    }
  });
  const disposeInput = server.register({
    kind: "exact",
    path: EGO_INPUT_ROUTE,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 400, { ok: false, error: "no live agent browser" });
      const body = await readJsonBody2(req).catch(() => ({}));
      const result = await proxyPost(port, "/api/input", body);
      if (!result) return sendJson2(res, 502, { ok: false, error: "input worker unavailable" });
      return sendJson2(res, result.status, result.body);
    }
  });
  const disposeWindowSize = server.register({
    kind: "exact",
    path: EGO_WINDOW_SIZE_ROUTE,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 400, { ok: false, error: "no live agent browser" });
      const body = await readJsonBody2(req).catch(() => ({}));
      const width = Number(body.width);
      const delta = Number(body.delta);
      const height = Number(body.height);
      const dy = Number(body.dy);
      const aspect = Number(body.aspect);
      if (!Number.isFinite(width) && !Number.isFinite(delta) && !Number.isFinite(height) && !Number.isFinite(dy) && !Number.isFinite(aspect)) {
        return sendJson2(res, 400, { ok: false, error: "width, delta, height, dy or aspect is required" });
      }
      const result = await proxyPost(port, "/api/window-size", {
        ...Number.isFinite(width) ? { width } : {},
        // The panel's toggle sends drag deltas; the worker applies them to the
        // page's current viewport.
        ...Number.isFinite(delta) ? { delta } : {},
        ...Number.isFinite(height) && height > 0 ? { height } : {},
        ...Number.isFinite(dy) ? { dy } : {},
        // Aspect presets keep the current width and derive the height.
        ...Number.isFinite(aspect) && aspect > 0 ? { aspect } : {},
        ...typeof body.targetId === "string" && body.targetId ? { targetId: body.targetId } : {}
      });
      if (!result) return sendJson2(res, 502, { ok: false, error: "window-size worker unavailable" });
      return sendJson2(res, result.status, result.body);
    }
  });
  const disposeClose = server.register({
    kind: "exact",
    path: EGO_CLOSE_ROUTE,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 400, { ok: false, error: "no live agent browser" });
      const body = await readJsonBody2(req).catch(() => ({}));
      const targetId = typeof body.targetId === "string" ? body.targetId : "";
      if (!targetId) return sendJson2(res, 400, { ok: false, error: "targetId required" });
      const result = await proxyPost(port, "/api/close", { targetId });
      if (!result) return sendJson2(res, 502, { ok: false, error: "close worker unavailable" });
      return sendJson2(res, result.status, result.body);
    }
  });
  const disposeFlush = server.register({
    kind: "exact",
    path: EGO_FLUSH_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 400, { ok: false, error: "no live agent browser" });
      const result = await proxyPost(port, "/api/flush", {});
      if (!result) return sendJson2(res, 502, { ok: false, error: "flush worker unavailable" });
      return sendJson2(res, result.status, result.body);
    }
  });
  const disposeRaise = server.register({
    kind: "exact",
    path: EGO_RAISE_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      try {
        const result = await openAgentWindow2();
        return sendJson2(res, result.ok ? 200 : 500, result);
      } catch (err) {
        return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
  });
  const disposeLoginImport = server.register({
    kind: "exact",
    path: EGO_LOGIN_IMPORT_ROUTE,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      const body = await readJsonBody2(req).catch(() => ({}));
      try {
        const result = await loginImport({
          source: ["chrome", "edge", "brave", "auto"].includes(String(body.source)) ? String(body.source) : "auto",
          domains: Array.isArray(body.domains) ? body.domains.map(String) : void 0,
          profile: typeof body.profile === "string" && body.profile !== "" ? body.profile : void 0,
          closeSource: body.closeSource === true,
          dryRun: body.dryRun === true
        });
        return sendJson2(res, result.ok ? 200 : 400, result);
      } catch (err) {
        return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
  });
  const disposeHealth = server.register({
    kind: "exact",
    path: EGO_HEALTH_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 200, { ok: false });
      const h = await proxyFrom(port, "/api/health");
      return sendJson2(res, 200, h || { ok: false });
    }
  });
  const watchRoutes = [
    [EGO_WATCH_START_ROUTE, "/api/watch/start"],
    [EGO_WATCH_SWITCH_ROUTE, "/api/watch/switch"],
    [EGO_WATCH_STOP_ROUTE, "/api/watch/stop"]
  ].map(([path, workerPath]) => server.register({
    kind: "exact",
    path,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: "disabled" });
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 409, { ok: false, error: "worker not ready" });
      const timeoutMs = workerPath === "/api/watch/start" || workerPath === "/api/watch/switch" ? 3e4 : 4e3;
      const result = await proxyPost(port, workerPath, await readJsonBody2(req).catch(() => ({})), timeoutMs);
      return result ? sendJson2(res, result.status, result.body) : sendJson2(res, 502, { ok: false, error: "worker request failed" });
    }
  }));
  const disposeWatchStatus = server.register({
    kind: "exact",
    path: EGO_WATCH_STATUS_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: "disabled" });
      const port = await ensureWorker();
      const result = port === null ? null : await proxyFrom(port, "/api/watch/status");
      return sendJson2(res, 200, { ...result || { ok: false, state: "idle", reason: "worker not ready" }, frameRelay: true });
    }
  });
  const disposeVideoStatus = server.register({
    kind: "exact",
    path: EGO_VIDEO_STATUS_ROUTE,
    handler: async (_req, resRaw) => {
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: "disabled" });
      const port = await ensureWorker();
      const result = port === null ? null : await proxyFrom(port, "/api/video/status");
      return sendJson2(res, 200, result || { ok: false, state: "idle", reason: "worker not ready" });
    }
  });
  const disposeVideo = server.register({
    kind: "exact",
    path: EGO_VIDEO_ROUTE,
    handler: async (reqRaw, resRaw) => {
      const req = reqRaw;
      const res = resRaw;
      if (relayDisabled()) return refuseFrameRelay(res);
      const port = await ensureWorker();
      if (port === null) return sendJson2(res, 502, { ok: false, error: "worker not ready" });
      proxyWorkerVideo(port, req, res);
    }
  });
  const disposeExecutor = server.register({
    kind: "exact",
    path: "/api/ego/executor",
    handler: async (_req, resRaw) => {
      const res = resRaw;
      let status = {};
      try {
        status = getExecutorStatus();
      } catch {
      }
      return sendJson2(res, 200, { ok: true, ...status });
    }
  });
  const disposeLoginBridge = [
    server.register({
      kind: "exact",
      path: "/api/ego/login-extension/health",
      handler: async (_req, resRaw) => {
        const res = resRaw;
        try {
          return sendJson2(res, 200, await getLoginExtensionHealth());
        } catch (err) {
          return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
        }
      }
    }),
    server.register({
      kind: "exact",
      path: "/api/ego/login-extension/pair-code",
      handler: async (_req, resRaw) => {
        const res = resRaw;
        try {
          return sendJson2(res, 200, await createLoginExtensionPairingCode());
        } catch (err) {
          return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
        }
      }
    }),
    server.register({
      kind: "exact",
      path: "/api/ego/login-extension/import",
      handler: async (reqRaw, resRaw) => {
        const req = reqRaw;
        const res = resRaw;
        try {
          const body = await readJsonBody2(req).catch(() => ({}));
          const domains = Array.isArray(body.domains) ? body.domains.map(String).filter(Boolean) : [];
          if (domains.length === 0) return sendJson2(res, 400, { ok: false, error: "domains is required" });
          const job = await startLoginExtensionJob({ domains });
          return sendJson2(res, 200, { ok: true, jobId: job.jobId });
        } catch (err) {
          return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
        }
      }
    }),
    server.register({
      kind: "exact",
      path: "/api/ego/login-extension/status",
      handler: async (reqRaw, resRaw) => {
        const req = reqRaw;
        const res = resRaw;
        try {
          const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? "";
          if (!id) return sendJson2(res, 400, { ok: false, error: "id is required" });
          return sendJson2(res, 200, await getLoginExtensionJob(id));
        } catch (err) {
          return sendJson2(res, 500, { ok: false, error: String(err?.message || err) });
        }
      }
    })
  ];
  ctx.effect?.(() => () => {
    try {
      disposeSpaces();
    } catch {
    }
    try {
      disposeStream();
    } catch {
    }
    try {
      disposeInput();
    } catch {
    }
    try {
      disposeWindowSize();
    } catch {
    }
    try {
      disposeExecutor();
    } catch {
    }
    try {
      disposeLoginBridge.forEach((dispose) => dispose());
    } catch {
    }
    try {
      stopLoginExtensionBridge();
    } catch {
    }
    try {
      disposeClose();
    } catch {
    }
    try {
      disposeFlush();
    } catch {
    }
    try {
      disposeRaise();
    } catch {
    }
    try {
      disposeLoginImport();
    } catch {
    }
    try {
      disposeHealth();
    } catch {
    }
    for (const dispose of watchRoutes) try {
      dispose();
    } catch {
    }
    try {
      disposeWatchStatus();
    } catch {
    }
    try {
      disposeVideoStatus();
    } catch {
    }
    try {
      disposeVideo();
    } catch {
    }
  });
}

// packages/browser/browser-ego-host/third-party/upstream/src/help.ts
var EGO_HELP_INDEX = {
  overview: "ego-browser \u7ED3\u6784\u5316\u6D4F\u89C8\u5668\u5DE5\u5177\u3002\u5BFC\u822A/\u4EA4\u4E92/\u89C2\u5BDF/\u8868\u5355/\u7F51\u7EDC/\u7B49\u5F85/\u952E\u9F20\u7686\u6709\u4E13\u9879\u5DE5\u5177\uFF0C\u53E6\u63D0\u4F9B ego_help(\u672C\u7D22\u5F15)\u3001ego_doctor(\u4F53\u68C0)\u3001ego_cli/ego_script(\u81EA\u7531\u811A\u672C\u9003\u751F\u8231)\u3002\u5206\u7C7B\u89C1: tools / navigate / observe / input / keyboard-mouse / form / wait / network / login / script / doctor\u3002\u7528 `topic` \u67E5\u8BE2\uFF0C\u6216\u76F4\u63A5\u7ED9\u5DE5\u5177\u540D\u3002",
  tools: "\u5DE5\u5177\u6E05\u5355: ego_status, ego_space_open, ego_space_close, ego_snapshot, ego_navigate, ego_tabs, ego_click(+double), ego_fill, ego_js, ego_cdp, ego_screenshot(+selector), ego_page_info, ego_wait, ego_wait_for_selector, ego_wait_for_url, ego_wait_for_response, ego_wait_for_human, ego_key(+text/type), ego_hover, ego_read_element, ego_select, ego_drag, ego_scroll, ego_upload, ego_check, ego_dialog, ego_download, ego_http, ego_captcha, ego_auth_flush, ego_login_import, ego_help, ego_doctor, ego_cli, ego_script\u3002",
  navigate: "ego_navigate: \u6253\u5F00URL\u6216\u5207tab(\u540C\u4EFB\u52A1\u590D\u7528\u5F53\u524Dtab)\u3002ego_wait_for_url: \u7B49\u8DF3\u8F6C(\u767B\u5F55/\u5206\u9875)\u3002ego_tabs: \u5217\u51FA/\u5207\u6362/\u65B0\u5EFA/\u5173\u95ED\u6807\u7B7E\u9875(list/switch/open/close)\u3002",
  tabs: "ego_tabs: \u6807\u7B7E\u9875\u7BA1\u7406\u3002action=list \u5217\u51FA\u6240\u6709\u6807\u7B7E(targetId/title/url/active); switch \u7528 targetId \u5207\u6362; open \u7528 url \u65B0\u5EFA\u6807\u7B7E(\u9ED8\u8BA4 about:blank); close \u7528 targetId \u5173\u95ED\u3002targetId \u6765\u81EA list/open/ego_space_open/ego_navigate \u7684\u8FD4\u56DE\u3002\u4F9D\u8D56\u8FD0\u884C\u65F6\u63D0\u4F9B browser.listTabs/switchTab/closeTab \u4E0E ego.createTab\uFF1B\u5B98\u65B9 ego lite \u82E5\u7F3A\u5C11\u8FD9\u4E9B API \u4F1A\u8FD4\u56DE\u660E\u786E\u9519\u8BEF\uFF08\u5185\u7F6E\u8FD0\u884C\u65F6\u5B8C\u6574\u652F\u6301\uFF09\u3002",
  observe: "ego_snapshot: \u6574\u9875\u8BED\u4E49\u6811(\u5E26[ref]/loc\u4F9B\u70B9\u51FB); ego_page_info: url/\u6807\u9898/\u89C6\u53E3/\u6EDA\u52A8/\u5BF9\u8BDD\u6846/\u4EBA\u673A\u9A8C\u8BC1; ego_read_element: \u8BFB\u5355\u5143\u7D20\u6587\u672C/HTML/\u503C/\u5C5E\u6027/\u53EF\u89C1\u6027/\u8BA1\u6570; ego_screenshot(+selector): \u6574\u9875\u6216\u5143\u7D20\u622A\u56FE\u3002",
  input: "ego_click(selector/\u5750\u6807, double\u53CC\u51FB); ego_fill(\u586B\u6846); ego_key(press\u7EC4\u5408\u952E \u6216 text\u8FDE\u7EED\u952E\u5165); ego_check(\u52FE\u9009/\u53D6\u6D88); ego_select(\u4E0B\u62C9); ego_upload(\u6587\u4EF6\u4E0A\u4F20); ego_dialog(\u63A5\u53D7/\u53D6\u6D88JS\u5BF9\u8BDD\u6846)\u3002",
  "keyboard-mouse": "ego_key: \u952E\u76D8(press/text); ego_hover: \u60AC\u505C; ego_drag: \u62D6\u62FD(\u5143\u7D20\u6216\u5750\u6807); ego_scroll: \u6EDA\u8F6E/\u6EDA\u5230\u5143\u7D20; ego_click: \u70B9\u51FB/\u53CC\u51FB\u3002",
  form: "ego_fill \u586B\u8F93\u5165\u6846; ego_select \u4E0B\u62C9; ego_check checkbox/radio; ego_upload \u6587\u4EF6; ego_key \u56DE\u8F66/Tab\u5BFC\u822A; ego_dialog \u5904\u7406\u63D0\u4EA4\u5F39\u7A97\u3002",
  wait: "ego_wait(\u56FA\u5B9A\u6BEB\u79D2); ego_wait_for_selector(\u7B49\u5143\u7D20\u51FA\u73B0/\u6D88\u5931); ego_wait_for_url(\u7B49\u8DF3\u8F6C); ego_wait_for_response(\u7B49\u7F51\u7EDC\u54CD\u5E94\u5E76\u53EF\u8BFBbody)\u3002",
  network: "ego_http: \u53D1HTTP\u8BF7\u6C42(\u9ED8\u8BA4\u6D4F\u89C8\u5668\u4E0A\u4E0B\u6587 fetch.browser, mode=server\u8D70Node fetch.server); ego_wait_for_response: \u7B49\u5E76\u8BFB\u63A5\u53E3\u54CD\u5E94\u3002",
  download: "ego_download: \u7B49\u4E0B\u8F7D\u4E8B\u4EF6\u5E76\u843D\u5230\u6307\u5B9A\u8DEF\u5F84(triggerSelector/triggerScript + \u53EF\u9009 savePath)\u3002",
  captcha: "ego_captcha: \u68C0\u6D4B\u9875\u9762\u4EBA\u673A\u9A8C\u8BC1(CAPTCHA)\u5E76\u8FD4\u56DE{detected,kind}; \u68C0\u6D4B\u5230\u8BF7\u8BA9\u7528\u6237\u53BB ego \u6D4F\u89C8\u5668\u5B8C\u6210; ego_page_info \u4E5F\u9644\u5E26 humanCheck\u3002ego_wait_for_human: \u5148\u544A\u8BC9\u7528\u6237\u8981\u505A\u4EC0\u4E48\uFF0C\u7136\u540E\u963B\u585E\u8F6E\u8BE2\u76F4\u5230\u9A8C\u8BC1\u7801\u6D88\u5931/\u767B\u5F55\u5B8C\u6210(\u53EF\u9009 selector \u4F5C\u4E3A\u201C\u767B\u5F55\u6210\u529F\u201D\u4FE1\u53F7)\uFF0C\u8D85\u65F6\u8FD4\u56DE resolved:false \u800C\u4E0D\u662F\u62A5\u9519\uFF1B\u4E0D\u8981\u8D70\u5BA1\u6279\uFF08never \u7B56\u7565\u4F1A\u81EA\u52A8\u62D2\u7EDD\uFF09\u3002",
  login: "ego_auth_flush: \u628A\u767B\u5F55cookie\u843D\u76D8\u5230ego profile; \u89C2\u5BDF\u7A97\u767B\u5F55\u5F15\u5BFC\u6761+\u300E\u5DF2\u767B\u5F55,\u4FDD\u5B58\u300F\u6309\u94AE\u89E6\u53D1\u540C\u4E00\u52A8\u4F5C\u3002ego_login_import: \u6309\u57DF\u540D\u5BFC\u5165\u7CFB\u7EDF\u6D4F\u89C8\u5668\u767B\u5F55cookie\u2014\u2014\u73B0\u4EE3 Chrome/Edge \u7528 source=extension\uFF1A\u5148\u5728 Agent \u6D4F\u89C8\u5668\u9762\u677F\u70B9\u300C\u8FDE\u63A5 Chrome \u767B\u5F55\u6001\u300D\uFF0C\u6309 6 \u4F4D\u914D\u5BF9\u7801\u5728\u6269\u5C55\u91CC\u914D\u5BF9\u4E00\u6B21\uFF0C\u4E4B\u540E\u9762\u677F\u6309\u94AE/\u8BE5\u5DE5\u5177\u5373\u53EF\u81EA\u52A8\u5BFC\u5165\uFF08\u6269\u5C55\u540E\u53F0\u8F6E\u8BE2\uFF0C30 \u79D2\u5185\uFF09\uFF1B\u65E7\u7248\u6216\u5DF2\u5173\u95ED\u6D4F\u89C8\u5668\u7528 source=chrome|edge|brave \u5B89\u5168\u590D\u5236\uFF08Chrome/Edge 127+ \u7684 ABE \u4F1A\u8BFB\u5230 0 \u5E76\u660E\u786E\u62A5\u9519\uFF0C\u6E90 profile \u4E0D\u4F1A\u88AB\u6253\u5F00/\u5199\u5165\uFF09\u3002\u5148 dryRun \u770B\u53EF\u5BFC\u5165\u9879\uFF1Bego \u6D4F\u89C8\u5668\u987B\u5DF2\u5728\u8FD0\u884C\u3002",
  script: "ego_cli / ego_script: \u539F\u6837\u8FD0\u884C\u4EFB\u610F ego-browser nodejs heredoc\u811A\u672C(page/browser/taskSpaces/site/fetch/cdp\u9884\u8F7D)\u3002ego_script\u989D\u5916\u8FD4\u56DE duration/timedOut\u3002\u6CE8\u610F page \u662F\u672C runtime \u7684\u9875\u9762\u95E8\u9762\u3001\u4E0D\u662F Playwright API\uFF1A\u53EF\u7528 goto/reload/info/url/title/locator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId/waitForTimeout/waitForLoadState/waitForSelector/waitForFunction/waitForURL/waitForRequest/waitForResponse/waitForEvent/evaluate/screenshot/snapshot/snapshotRaw/elementCenter/drainEvents/screencast/keyboard/mouse\uFF1B\u6CA1\u6709 fill/click/type/press\u2014\u2014\u4EA4\u4E92\u7528 ego_fill/ego_click \u6216 page.locator(...)\u3002page.goto() \u4E0D\u8FD4\u56DE Playwright Response\uFF0C\u53D6\u72B6\u6001\u7801\u7528 ego_wait_for_response \u6216 page.info()\u3002",
  doctor: "ego_doctor: \u4F53\u68C0\u73AF\u5883(\u6D4F\u89C8\u5668\u5019\u9009\u3001vendored runtime\u3001\u72B6\u6001\u76EE\u5F55\u3001CDP\u7AEF\u53E3\u3001\u4EFB\u52A1\u7A7A\u95F4)\u3002"
};

// packages/browser/browser-ego-host/third-party/upstream/src/captcha.ts
var HUMAN_CHECK_PROBE = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const html = (el.outerHTML || '') + (el.closest('body') && el.closest('body').innerHTML ? '' : '');
    const s = String(html);
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile|cf-turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare|challenge-form/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  // [#62] Text-only fallback. It used to match a bare /captcha/ word, which
  // fires on ANY page that merely discusses captchas \u2014 including a local
  // dashboard rendering an agent session whose transcript quotes this plugin's
  // own source. Two guards: loopback origins are never text-probed (a locally
  // served page is the user's own tooling, not a challenge page), and the
  // pattern requires a challenge *phrase* rather than the bare noun.
  const loc = String(location.hostname || '');
  if (loc === 'localhost' || loc === '127.0.0.1' || loc === '::1' || loc === '[::1]' || loc.endsWith('.localhost')) {
    return { detected: false, kind: null };
  }
  const txt = (document.body ? document.body.innerText || '' : '').slice(0, 120000);
  const lower = txt.toLowerCase();
  if (/verify (that )?you are (a )?human|your activity looks unusual|i.?m not a robot|confirm you.?re human|\u4EBA\u673A\u9A8C\u8BC1|\u5B89\u5168\u9A8C\u8BC1|\u6211\u662F\u4EBA\u7C7B|\u6ED1\u5757\u9A8C\u8BC1|\u62D6\u52A8\u6ED1\u5757|\u70B9\u51FB.{0,8}\u9A8C\u8BC1/.test(lower)) {
    return { detected: true, kind: 'captcha' };
  }
  return { detected: false, kind: null };
})()`;

// packages/browser/browser-ego-host/third-party/upstream/src/config.ts
import z from "@deepseek-ai/schemastery";
var DEFAULT_CURSOR_NAME = "Agent";
var backend = z.union(["auto", "cdp", "ffmpeg"]);
var profile = z.union(["low", "balanced", "high"]);
var encoder = z.union([
  "auto",
  "software",
  "h264_mf",
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "h264_videotoolbox",
  "h264_vaapi"
]);
var prefs = {
  tuiAutoOpenPanel: z.boolean().description("Open the TUI Agent Browser panel on the first ego_* call. Default off; activity still appears in the badge and status."),
  isolateSpaces: z.boolean().description("Space isolation: false = persistent profile (keep logins across restarts); true = isolated sandbox."),
  sessionScopedSpaces: z.boolean().description("Give each DSH session its own task space (dsh-agent-<session>) so concurrent sessions and subagents do not share tabs or steal each other's active tab. Off = one shared space."),
  idleTimeoutMin: z.number().min(0).max(1440).step(1).description("Auto-stop the backing browser after N minutes without an ego_* call (0 = off). Relaunches on demand at the next call."),
  disableFrameRelay: z.boolean().description("Disable the live frame relay (watch panel): no ego-cast worker, no screencast capture and no /api/ego stream routes. ego_* tools keep working."),
  residentExecutor: z.boolean().description("Reuse one resident `ego-browser --serve` process across ego_* calls: the first call pays startup, later calls skip it (~16ms). Off = spawn per call. A dead resident falls back to a fresh spawn automatically."),
  residentIdleMin: z.number().min(0).max(1440).step(1).description("Stop the resident process after N minutes without an ego_* call (0 = keep it until the plugin unmounts). The browser itself is unaffected."),
  chromePath: z.string().description("Path to Chrome/Chromium. Empty = auto-detect."),
  headless: z.boolean().description("Run the backing browser without a window: the workspace panel is the only view, and the browser cannot take focus from your work. Turn it off to watch a real window."),
  cursorName: z.string().description("Label drawn next to the agent cursor on the page. Empty = no label."),
  captureBackend: backend.description("Capture backend: auto, cdp, or ffmpeg."),
  streamProfile: profile.description("Capture quality profile."),
  cdpFps: z.number().min(5).max(30).step(1).description("CDP preview FPS."),
  cdpQuality: z.number().min(1).max(100).step(1).description("CDP JPEG quality."),
  cdpMaxWidth: z.number().min(320).max(2560).step(40).description("CDP frame max width."),
  cdpBackstopIntervalMs: z.number().min(1e3).max(1e4).step(100).description("CDP recovery screenshot interval."),
  ffmpegFps: z.number().min(5).max(30).step(1).description("FFmpeg video FPS."),
  ffmpegMaxWidth: z.number().min(320).max(1920).step(40).description("FFmpeg video max width."),
  ffmpegBitrateKbps: z.number().min(500).max(2e4).step(250).description("FFmpeg target video bitrate in kbps."),
  ffmpegEncoder: encoder.description("FFmpeg H.264 encoder."),
  ffmpegPath: z.string().description("Custom FFmpeg path. Empty = detect PATH or managed install."),
  githubMirror: z.string().description("HTTPS base replacing https://github.com for managed downloads."),
  // User-defined extra CLI args. Shell-like tokenize; mutually-exclusive
  // control flags are stripped (see EGO_CLI_BLOCKED / CHROME_BLOCKED below).
  egoCliArgs: z.string().description("Extra args appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call."),
  chromeArgs: z.string().description("Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton)."),
  // Fixed viewport (issue: HiDPI hosts shrink the CSS viewport, so sites serve
  // their collapsed mobile layout). Applied with CDP emulation on every call,
  // because a one-shot ego process cannot keep an override alive by itself.
  viewportWidth: z.number().min(0).max(3840).step(10).description("Fixed CSS viewport width for agent pages, e.g. 1440. 0 = use the browser window size."),
  viewportHeight: z.number().min(0).max(2160).step(10).description("Fixed CSS viewport height for agent pages, e.g. 900. 0 = use the browser window size."),
  deviceScaleFactor: z.number().min(0).max(4).step(0.25).description("Device pixel ratio for the fixed viewport. 0 = the browser default.")
};
var volatilePrefs = Object.fromEntries(
  // The fork's public typings do not declare `volatile()`, but the runtime has
  // it (DSH's own plugins rely on it) — hence the unknown-cast.
  Object.entries(prefs).map(([key, field]) => {
    const mark = field.volatile;
    return [key, typeof mark === "function" ? mark.call(field) : field];
  })
);
var Config = z.object({
  ...volatilePrefs,
  /** Optional Node-executable runtime script (not the official .exe). */
  egoBin: z.string(),
  // Deprecated read-compatible keys. The settings UI only writes canonical keys.
  castFpsCap: z.number().min(0).max(60).step(1),
  screencastQuality: z.number().min(1).max(100).step(1),
  screencastMaxWidth: z.number().min(320).max(2560).step(40),
  backstopIntervalMs: z.number().min(200).max(1e4).step(100)
});
function validateEgoBinPath(value) {
  const p = typeof value === "string" ? value.trim() : "";
  if (!p) return { ok: false, reason: "egoBin is empty" };
  if (/\.(exe|cmd|bat)$/i.test(p)) {
    return {
      ok: false,
      reason: "egoBin must be a Node-executable script (.mjs/.js/.cjs), not a Windows executable. The official ego-browser.exe needs a Node bridge; use the bundled runtime or set egoBin to a .mjs bridge."
    };
  }
  return { ok: true };
}
var EGO_CLI_BLOCKED = /* @__PURE__ */ new Set([
  "--status",
  "--stop",
  "--open",
  "--spaces",
  "--spaces-daemon",
  "--prune-spaces",
  "--import-chrome-profile",
  "--install-desktop-entry",
  "--help",
  "-h"
]);
var CHROME_BLOCKED = /* @__PURE__ */ new Set([
  "--user-data-dir",
  "--remote-debugging-port",
  "--remote-allow-origins",
  "--headless",
  "--no-startup-window",
  "--proxy-server",
  "--proxy-bypass-list"
]);
function tokenizeArgs(input) {
  if (typeof input !== "string") return [];
  const out = [];
  let cur = "";
  let i = 0;
  let quote = null;
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === "\\") {
        const next = input[i + 1];
        if (next !== void 0) {
          cur += next;
          i += 2;
          continue;
        }
      } else if (c === quote) {
        quote = null;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      const next = input[i + 1];
      if (next !== void 0) {
        cur += next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur !== "") out.push(cur);
  return out;
}
function filterArgs(raw, blocked) {
  const tokens = tokenizeArgs(raw);
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
    if (blocked.has(key)) {
      if (!tok.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    kept.push(tok);
  }
  return kept;
}
var finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
function oneOf(value, values, fallback) {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}
function unwrapVolatile(value) {
  if (value === null || typeof value !== "object") return value;
  const candidate = value;
  if (typeof candidate.get !== "function") return value;
  const isVolatile = Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes("cosmokit.volatile"));
  if (!isVolatile) return value;
  try {
    return candidate.get();
  } catch {
    return value;
  }
}
function normalizeVolatile(config) {
  const source = config;
  const plain = {};
  for (const key of Object.keys(source)) plain[key] = unwrapVolatile(source[key]);
  return plain;
}
function resolveConfig(config = {}) {
  config = normalizeVolatile(config);
  const legacyFps = finiteIn(config.castFpsCap, 0, 60) ? config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)) : 20;
  const selectedProfile = oneOf(config.streamProfile, ["low", "balanced", "high"], "balanced");
  const profileDefaults = selectedProfile === "low" ? { fps: 15, width: 960, bitrateKbps: 2e3 } : selectedProfile === "high" ? { fps: 30, width: 1600, bitrateKbps: 8e3 } : { fps: 20, width: 1280, bitrateKbps: 4e3 };
  return {
    chromePath: typeof config.chromePath === "string" ? config.chromePath : "",
    headless: typeof config.headless === "boolean" ? config.headless : true,
    cursorName: typeof config.cursorName === "string" ? config.cursorName : DEFAULT_CURSOR_NAME,
    captureBackend: oneOf(config.captureBackend, ["auto", "cdp", "ffmpeg"], "auto"),
    streamProfile: selectedProfile,
    cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
    cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 80,
    // 2560 (not 1280): the agent window is 2560x1080, and a 1280 cap downsizes
    // that viewport by half — the panel then upscales it, which is the
    // "soft/garbled text" report. 2560 keeps a wide workbench at native width;
    // a smaller panel can lower it to trade sharpness for bandwidth.
    cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 2560) ? config.cdpMaxWidth : finiteIn(config.screencastMaxWidth, 320, 2560) ? config.screencastMaxWidth : 2560,
    cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1e3, 1e4) ? config.cdpBackstopIntervalMs : finiteIn(config.backstopIntervalMs, 200, 1e4) ? Math.max(1e3, config.backstopIntervalMs) : 3e3,
    ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
    ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
    ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 2e4) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
    ffmpegEncoder: oneOf(config.ffmpegEncoder, ["auto", "software", "h264_mf", "h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_vaapi"], "auto"),
    ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
    githubMirror: typeof config.githubMirror === "string" ? config.githubMirror : "",
    // User-defined extra args: stored raw (string), filtered at the call site
    // so a saved value is not silently mutated by a later blocklist change.
    egoCliArgs: typeof config.egoCliArgs === "string" ? config.egoCliArgs : "",
    chromeArgs: typeof config.chromeArgs === "string" ? config.chromeArgs : "",
    // 0 = leave the browser's own viewport untouched (previous behavior). Both
    // dimensions must be non-zero before the emulation prelude is emitted.
    viewportWidth: finiteIn(config.viewportWidth, 0, 3840) ? config.viewportWidth : 0,
    viewportHeight: finiteIn(config.viewportHeight, 0, 2160) ? config.viewportHeight : 0,
    deviceScaleFactor: finiteIn(config.deviceScaleFactor, 0, 4) ? config.deviceScaleFactor : 0,
    isolateSpaces: typeof config.isolateSpaces === "boolean" ? config.isolateSpaces : config.isolateSpaces === "true" || config.isolateSpaces === "1" || config.isolateSpaces === 1,
    // Default true: two sessions silently sharing one space was the root of
    // cross-session tab theft. Explicit opt-out keeps the old shared space.
    sessionScopedSpaces: typeof config.sessionScopedSpaces === "boolean" ? config.sessionScopedSpaces : !(config.sessionScopedSpaces === "false" || config.sessionScopedSpaces === "0" || config.sessionScopedSpaces === 0),
    idleTimeoutMin: finiteIn(config.idleTimeoutMin, 0, 1440) ? config.idleTimeoutMin : 0,
    // Default false (= frame relay ON, unchanged behavior); the switch is opt-in.
    disableFrameRelay: typeof config.disableFrameRelay === "boolean" ? config.disableFrameRelay : config.disableFrameRelay === "true" || config.disableFrameRelay === "1" || config.disableFrameRelay === 1,
    // #56: opt-in resident executor (default false = today's spawn-per-call
    // behavior). 30 minutes idle is long enough to cover a session without
    // leaving a Node process around forever.
    residentExecutor: typeof config.residentExecutor === "boolean" ? config.residentExecutor : config.residentExecutor === "true" || config.residentExecutor === "1" || config.residentExecutor === 1,
    tuiAutoOpenPanel: typeof config.tuiAutoOpenPanel === "boolean" ? config.tuiAutoOpenPanel : config.tuiAutoOpenPanel === "true" || config.tuiAutoOpenPanel === "1" || config.tuiAutoOpenPanel === 1,
    residentIdleMin: finiteIn(config.residentIdleMin, 0, 1440) ? config.residentIdleMin : 30
  };
}

// packages/browser/browser-ego-host/third-party/upstream/src/settings.ts
var SETTINGS_NAMESPACE = "ego-browser";
var SHARED_SCOPE_KEY = /* @__PURE__ */ Symbol.for("dsh-ego-browser.settings-scope");
function getSharedScope() {
  const existing = globalThis[SHARED_SCOPE_KEY];
  if (existing) return existing;
  const fresh = { scope: null, refs: 0 };
  globalThis[SHARED_SCOPE_KEY] = fresh;
  return fresh;
}
function isUnloading(ctx) {
  const state = ctx.fiber?.state;
  return state === 4 || state === 5;
}
function installEgoBrowserSettings(ctx, entry, live) {
  const listeners = /* @__PURE__ */ new Set();
  let source = () => entry;
  const liveSource = () => {
    let values;
    try {
      values = live?.();
    } catch {
      values = void 0;
    }
    if (values === void 0 || values === null) return entry;
    return { ...entry, ...values };
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  ctx.inject?.(["settings"], (sctx) => {
    const sharedScope = getSharedScope();
    let scope = sharedScope.scope;
    const service = sctx.settings;
    if (service === void 0 || typeof service.register !== "function") {
      source = liveSource;
      const subscribe = sctx.on;
      const offUpdate = typeof subscribe === "function" ? subscribe.call(sctx, "settings/document-updated", (ns) => {
        if (ns !== SETTINGS_NAMESPACE || isUnloading(ctx)) return;
        notify();
      }) : void 0;
      if (typeof offUpdate === "function") {
        sctx.effect?.(() => () => {
          try {
            offUpdate();
          } catch {
          }
        });
      }
      notify();
      return;
    }
    if (!scope) {
      try {
        scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, {
          base: entry
        });
        sharedScope.scope = scope;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("already registered"))
          throw error;
        ctx.logger?.("ego-browser")?.warn(
          "settings namespace already registered outside the shared bridge"
        );
        return;
      }
    }
    sharedScope.refs += 1;
    source = () => scope.get();
    const offScopeWatch = scope.watch(() => {
      if (isUnloading(ctx)) return;
      notify();
    });
    sctx.effect?.(() => () => {
      offScopeWatch?.();
      sharedScope.refs = Math.max(0, sharedScope.refs - 1);
      if (sharedScope.refs === 0 && sharedScope.scope === scope) sharedScope.scope = null;
      if (isUnloading(ctx)) return;
      source = () => entry;
      notify();
    });
    notify();
  });
  return {
    source: () => source(),
    onChange: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }
  };
}

// packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-manifest.ts
var BTBN_TAG = "autobuild-2026-08-17-13-05";
var BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
var STATIC_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
var FFMPEG_MANIFEST = Object.freeze({
  "win32-x64": Object.freeze({
    provider: "btbn",
    buildId: BTBN_TAG,
    archiveType: "tar",
    size: 170641412,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-win64-gpl.zip`,
    sha256: "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299",
    executableName: "ffmpeg.exe",
    archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
  }),
  "win32-arm64": Object.freeze({
    provider: "btbn",
    buildId: BTBN_TAG,
    archiveType: "tar",
    size: 116275753,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-winarm64-gpl.zip`,
    sha256: "451d181c0774f19dc7c30711911f3aad4f4ee4feb1cecb7b5efc1b895e093c67",
    executableName: "ffmpeg.exe",
    archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
  }),
  "linux-x64": Object.freeze({
    provider: "btbn",
    buildId: BTBN_TAG,
    archiveType: "tar",
    size: 127977972,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linux64-gpl.tar.xz`,
    sha256: "646080fba1f295446fdf35fbdd4bad6ab934a30f9fcb86f3e96ad50eaff06c82",
    executableName: "ffmpeg",
    archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
  }),
  "linux-arm64": Object.freeze({
    provider: "btbn",
    buildId: BTBN_TAG,
    archiveType: "tar",
    size: 109615592,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linuxarm64-gpl.tar.xz`,
    sha256: "7cda2218fe0107e449631eb6b850146a4522ebf4ed13733010d0aada9858b119",
    executableName: "ffmpeg",
    archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
  }),
  "darwin-x64": Object.freeze({
    provider: "evermeet",
    buildId: "ffmpeg-static-b6.1.1",
    archiveType: "gzip",
    size: 25296431,
    url: `${STATIC_BASE}/ffmpeg-darwin-x64.gz`,
    sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    executableName: "ffmpeg"
  }),
  "darwin-arm64": Object.freeze({
    provider: "osxexperts",
    buildId: "ffmpeg-static-b6.1.1",
    archiveType: "gzip",
    size: 19246198,
    url: `${STATIC_BASE}/ffmpeg-darwin-arm64.gz`,
    sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    executableName: "ffmpeg"
  })
});
function platformManifest(platform = process.platform, arch = process.arch) {
  return FFMPEG_MANIFEST[`${platform}-${arch}`] ?? null;
}
function rewriteGithubUrl(url, mirror = "") {
  if (!mirror || !url.startsWith("https://github.com/")) return url;
  let parsed;
  try {
    parsed = new URL(mirror);
  } catch {
    throw codedError("ffmpeg-mirror-invalid", "GitHub mirror must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw codedError("ffmpeg-mirror-invalid", "GitHub mirror must be an HTTPS base URL without credentials, query, or fragment");
  }
  const base = parsed.toString().replace(/\/+$/, "");
  return `${base}${url.slice("https://github.com".length)}`;
}
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// packages/browser/browser-ego-host/third-party/upstream/src/gateway.ts
var API_PREFIX = "/ego/api";
var ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "isolateSpaces",
  "idleTimeoutMin",
  "disableFrameRelay",
  "residentExecutor",
  "residentIdleMin",
  "chromePath",
  "captureBackend",
  "streamProfile",
  "cdpFps",
  "cdpQuality",
  "cdpMaxWidth",
  "cdpBackstopIntervalMs",
  "ffmpegFps",
  "ffmpegMaxWidth",
  "ffmpegBitrateKbps",
  "ffmpegEncoder",
  "ffmpegPath",
  "githubMirror",
  "egoCliArgs",
  "chromeArgs"
]);
function registerEgoBrowserGateway(ctx, bridge2, ffmpegManager) {
  let settings;
  ctx.inject?.(["settings"], (sctx) => {
    settings = sctx.settings;
    return () => {
      settings = void 0;
    };
  });
  ctx.effect?.(() => {
    const webServer = ctx.get?.("webServer");
    if (!webServer || typeof webServer.register !== "function") return;
    return webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (reqRaw, resRaw) => {
        const req = reqRaw;
        const res = resRaw;
        if (req.method !== "POST") {
          writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          let originHost;
          try {
            originHost = new URL(origin).host;
          } catch {
            writeJson(res, 400, envelopeError("invalid-origin", "invalid Origin header"));
            return;
          }
          if (!req.headers.host || originHost !== req.headers.host) {
            writeJson(res, 403, envelopeError("origin-not-allowed", "same-origin requests only"));
            return;
          }
        }
        if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
          writeJson(res, 415, envelopeError("content-type-not-supported", "application/json required"));
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : void 0;
        if (method === void 0 || method.includes("/")) {
          writeJson(res, 404, envelopeError("not-found", "unknown ego-browser API method"));
          return;
        }
        try {
          const body = await readJsonBody3(req);
          if (method === "get") {
            const config = resolveConfig(bridge2.source());
            const ffmpegStatus = ffmpegManager ? await ffmpegManager.check({ configuredPath: config.ffmpegPath, requestedEncoder: config.ffmpegEncoder }) : null;
            writeJson(res, 200, envelopeOk({ config, ffmpegStatus }));
          } else if (method === "set") {
            const result = await handleSet(body, settings, bridge2, ffmpegManager);
            writeJson(res, 200, envelopeOk(result));
          } else if (method === "ffmpeg-status") {
            writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegManager?.status() || null }));
          } else if (method === "ffmpeg-check") {
            const config = resolveConfig(bridge2.source());
            const ffmpegStatus = await ffmpegManager?.check({ configuredPath: config.ffmpegPath, requestedEncoder: config.ffmpegEncoder });
            writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegStatus || null }));
          } else if (method === "ffmpeg-install") {
            const config = resolveConfig(bridge2.source());
            const githubMirror = typeof body.githubMirror === "string" ? body.githubMirror : config.githubMirror;
            const ffmpegStatus = ffmpegManager?.startInstall({ githubMirror, configuredPath: config.ffmpegPath, requestedEncoder: config.ffmpegEncoder });
            writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegStatus || null }));
          } else {
            writeJson(res, 404, envelopeError("not-found", `unknown ego-browser API method "${method}"`));
          }
        } catch (error) {
          const e = error;
          const message = e instanceof Error ? e.message : String(error);
          const status = e?.code === "ffmpeg-unavailable" ? 409 : e?.code === "ffmpeg-mirror-invalid" ? 400 : 500;
          writeJson(res, status, envelopeError(e?.code || "internal", message));
        }
      }
    });
  }, "ego-browser: /ego/api routes");
}
async function handleSet(body, settings, bridge2, ffmpegManager) {
  const patch = extractPatch(body);
  if (Object.keys(patch).length === 0) {
    return { config: resolveConfig(bridge2.source()), ffmpegStatus: ffmpegManager?.status() || null };
  }
  if (settings === void 0 || !settings.update) {
    throw new Error(
      "ego-browser: settings service is unavailable \u2014 configuration cannot be written"
    );
  }
  const current = resolveConfig(bridge2.source());
  const next = resolveConfig({ ...current, ...patch });
  if (patch.githubMirror) rewriteGithubUrl("https://github.com/example/repo/releases/download/tag/file", patch.githubMirror);
  const mustValidateFfmpeg = patch.captureBackend === "ffmpeg" || (Object.hasOwn(patch, "ffmpegPath") || Object.hasOwn(patch, "ffmpegEncoder")) && next.captureBackend === "ffmpeg";
  if (mustValidateFfmpeg && ffmpegManager) {
    const status = await ffmpegManager.check({ configuredPath: next.ffmpegPath, requestedEncoder: next.ffmpegEncoder });
    if (!status.canSelectFfmpeg) {
      const error = new Error(status.reason || "FFmpeg is not installed or does not satisfy capture requirements");
      error.code = "ffmpeg-unavailable";
      throw error;
    }
  }
  await settings.update(SETTINGS_NAMESPACE, patch);
  const ffmpegStatus = Object.hasOwn(patch, "ffmpegPath") && ffmpegManager ? await ffmpegManager.check({ configuredPath: next.ffmpegPath, requestedEncoder: next.ffmpegEncoder }) : ffmpegManager?.status() || null;
  return { config: resolveConfig(bridge2.source()), ffmpegStatus };
}
function extractPatch(body) {
  if (!isObject(body)) return {};
  const raw = Reflect.get(body, "patch");
  if (!isObject(raw)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === null || value === void 0) continue;
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (typeof value === "boolean") {
      normalized[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}
async function readJsonBody3(req, maxBytes = 16384) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
}
function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}
function envelopeOk(value) {
  return { ok: true, value };
}
function envelopeError(code, message) {
  return { ok: false, error: { code, message } };
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}

// packages/browser/browser-ego-host/third-party/upstream/src/resident.ts
import { spawn } from "node:child_process";
var ResidentNotRunningError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ResidentNotRunningError";
  }
};
var MAX_STDERR_BYTES = 512e3;
var ResidentProcess = class {
  opts;
  pending = /* @__PURE__ */ new Map();
  child = null;
  stdoutBuffer = "";
  stderrText = "";
  nextId = 1;
  idleTimer = null;
  deadReason = null;
  stopping = false;
  constructor(opts) {
    this.opts = opts;
  }
  get alive() {
    return this.child !== null && this.deadReason === null;
  }
  /** PID of the live resident (null when stopped/never started). */
  get pid() {
    return this.child?.pid ?? null;
  }
  /** Spawn the process if it is not running. Idempotent. */
  start() {
    if (this.alive || this.stopping) return;
    this.deadReason = null;
    this.stdoutBuffer = "";
    this.stderrText = "";
    const [executable, ...args] = this.opts.argv;
    if (executable === void 0) throw new Error("resident: empty argv");
    const child = spawn(executable, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: "pipe",
      windowsHide: true
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrText += chunk;
      if (this.stderrText.length > MAX_STDERR_BYTES) {
        this.stderrText = this.stderrText.slice(-MAX_STDERR_BYTES);
      }
    });
    child.on("error", (error) => this.die(`resident process error: ${error.message}`));
    child.on(
      "exit",
      (code, signal) => this.die(`resident process exited (${code === null ? `signal ${String(signal)}` : `code ${code}`})`)
    );
  }
  /**
   * Send one script and await its frame.
   *
   * @throws ResidentNotRunningError when the request was not written (retryable).
   * @throws Error on timeout/abort/process death (NOT retryable — the process is
   *         killed so a half-executed script cannot keep running).
   */
  async run(script, { signal, graceMs } = {}) {
    this.start();
    if (!this.alive || this.child === null) {
      throw new ResidentNotRunningError(this.deadReason ?? "resident is not running");
    }
    const child = this.child;
    const id = String(this.nextId++);
    const timeoutMs = graceMs !== void 0 && graceMs > 0 ? graceMs : this.opts.graceMs;
    return await new Promise((resolve2, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.die(`resident request timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      const onAbort = () => {
        this.die("ego-browser tool aborted");
      };
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal !== void 0) signal.removeEventListener("abort", onAbort);
        if (this.pending.get(id) === entry) this.pending.delete(id);
        fn();
      };
      const entry = {
        resolve: (frame) => finish(() => {
          this.touchIdle();
          resolve2(frame);
        }),
        reject: (error) => finish(() => reject(error))
      };
      this.pending.set(id, entry);
      if (signal !== void 0) {
        if (signal.aborted) {
          finish(() => reject(new Error("ego-browser tool aborted")));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        child.stdin.write(`${JSON.stringify({ id, code: script })}
`);
      } catch (error) {
        finish(
          () => reject(
            new ResidentNotRunningError(
              `could not write to the resident process: ${error?.message ?? String(error)}`
            )
          )
        );
      }
    });
  }
  /** Gracefully end stdin, then force-kill if it ignores that. */
  stop() {
    this.stopping = true;
    this.clearIdle();
    const child = this.child;
    this.child = null;
    this.deadReason = "resident stopped";
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(new Error("resident stopped"));
    if (child === null) return;
    try {
      child.stdin.end();
    } catch {
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
    }, 1500);
    killTimer.unref?.();
  }
  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    for (; ; ) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame === null || typeof frame !== "object" || typeof frame.id !== "string") continue;
      const entry = this.pending.get(frame.id);
      if (entry === void 0) continue;
      this.pending.delete(frame.id);
      entry.resolve({
        id: frame.id,
        ok: frame.ok === true,
        stdout: typeof frame.stdout === "string" ? frame.stdout : "",
        stderr: typeof frame.stderr === "string" ? frame.stderr : "",
        ...typeof frame.error === "string" ? { error: frame.error } : {}
      });
    }
  }
  die(reason) {
    if (this.deadReason !== null) return;
    this.deadReason = reason;
    this.clearIdle();
    const child = this.child;
    this.child = null;
    try {
      child?.kill();
    } catch {
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(
        new Error(
          `${reason}${this.stderrText.trim() === "" ? "" : `: ${this.stderrText.trim().slice(-1e3)}`}`
        )
      );
    }
    if (!this.stopping) this.opts.onExit?.(reason);
  }
  touchIdle() {
    this.clearIdle();
    if (this.opts.idleMs <= 0 || this.pending.size > 0 || !this.alive) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.stop();
    }, this.opts.idleMs);
    this.idleTimer.unref?.();
  }
  clearIdle() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
};

// packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-installation.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir as mkdir3, open, readdir, readFile as readFile3, rename, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname as dirname2, join as join4, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawn as nodeSpawn2 } from "node:child_process";

// packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-probe.ts
import { spawn as nodeSpawn } from "node:child_process";
function runFfmpegProbe(path, argv, { spawn: spawn2 = nodeSpawn, timeoutMs = 3e3 } = {}) {
  return new Promise((resolve2) => {
    let child;
    let output = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2({ ok, output });
    };
    try {
      child = spawn2(path, argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve2({ ok: false, output });
      return;
    }
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      finish(false);
    }, timeoutMs);
  });
}
async function probeFfmpeg(path, { platform = process.platform, env = process.env, spawn: spawn2 = nodeSpawn, requestedEncoder = "auto" } = {}) {
  const versionResult = await runFfmpegProbe(path, ["-version"], { spawn: spawn2 });
  if (!versionResult.ok) throw codedError2("ffmpeg-not-executable", `FFmpeg is not executable: ${path}`);
  const version = versionResult.output.split(/\r?\n/, 1)[0] || "FFmpeg";
  if (platform === "win32") {
    const support = await runFfmpegProbe(path, ["-hide_banner", "-h", "filter=gfxcapture"], { spawn: spawn2 });
    if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError2("ffmpeg-gfxcapture-unavailable", "FFmpeg does not support Windows gfxcapture");
  } else if (platform === "darwin") {
    const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn2 });
    if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError2("ffmpeg-capture-input-unavailable", "FFmpeg does not support avfoundation capture");
  } else if (platform === "linux") {
    if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw codedError2("ffmpeg-platform-unsupported", "Wayland capture is not supported");
    const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn2 });
    if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError2("ffmpeg-capture-input-unavailable", "FFmpeg does not support x11grab capture");
  }
  const automatic = platform === "win32" ? ["h264_mf", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"] : platform === "darwin" ? ["h264_videotoolbox", "libx264"] : ["h264_nvenc", "h264_vaapi", "h264_qsv", "libx264"];
  const encoders = requestedEncoder === "auto" ? automatic : [requestedEncoder === "software" ? "libx264" : requestedEncoder];
  for (const encoder2 of encoders) {
    const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=64x64:rate=1", "-frames:v", "1", "-c:v", encoder2, "-f", "null", "-"];
    if ((await runFfmpegProbe(path, args, { spawn: spawn2, timeoutMs: 5e3 })).ok) return { version, encoder: encoder2 };
  }
  throw codedError2("ffmpeg-encoder-unavailable", "FFmpeg has no usable H.264 encoder");
}
function codedError2(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-installation.ts
function defaultFfmpegCacheRoot(home = homedir()) {
  return join4(home, ".dsh", "cache", "ego-browser", "ffmpeg");
}
var SHARED_MANAGERS_KEY = /* @__PURE__ */ Symbol.for("dsh-ego-browser.ffmpeg-installation-managers");
function getSharedManagers() {
  const existing = globalThis[SHARED_MANAGERS_KEY];
  if (existing) return existing;
  const fresh = /* @__PURE__ */ new Map();
  globalThis[SHARED_MANAGERS_KEY] = fresh;
  return fresh;
}
function getSharedFfmpegInstallationManager(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot();
  const key = `${platform}:${arch}:${cacheRoot}`;
  const managers = getSharedManagers();
  if (!managers.has(key)) managers.set(key, new FfmpegInstallationManager({ ...options, platform, arch, cacheRoot }));
  return managers.get(key);
}
var FfmpegInstallationManager = class {
  getConfig;
  platform;
  arch;
  env;
  cacheRoot;
  fetch;
  spawn;
  manifest;
  installPromise;
  checkPromise;
  checkKey;
  statusValue;
  constructor({
    getConfig = () => ({}),
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    cacheRoot = defaultFfmpegCacheRoot(),
    fetchImpl = globalThis.fetch,
    spawn: spawn2 = nodeSpawn2
  } = {}) {
    this.getConfig = getConfig;
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.cacheRoot = cacheRoot;
    this.fetch = fetchImpl;
    this.spawn = spawn2;
    this.manifest = platformManifest(platform, arch);
    this.installPromise = null;
    this.checkPromise = null;
    this.checkKey = null;
    this.statusValue = this.#baseStatus();
  }
  #baseStatus() {
    const unsupported = this.platform === "linux" && (this.env.XDG_SESSION_TYPE === "wayland" || this.env.WAYLAND_DISPLAY);
    return {
      state: unsupported ? "unsupported" : "missing",
      source: null,
      path: null,
      version: null,
      encoder: null,
      progress: null,
      canDownload: !unsupported && !!this.manifest,
      canSelectFfmpeg: false,
      updateAvailable: false,
      reason: unsupported ? "Wayland capture is not supported" : null,
      candidates: [],
      platform: this.platform,
      arch: this.arch,
      buildId: this.manifest?.buildId || null
    };
  }
  status() {
    return structuredClone(this.statusValue);
  }
  managedPath() {
    if (!this.manifest) return null;
    return join4(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName);
  }
  async check({ configuredPath, requestedEncoder = "auto" } = {}) {
    if (this.installPromise) return this.status();
    const key = JSON.stringify([configuredPath ?? "", requestedEncoder]);
    if (this.checkPromise) {
      if (this.checkKey === key) return this.checkPromise;
      await this.checkPromise.catch(() => {
      });
    }
    if (this.statusValue.state === "unsupported") return this.status();
    this.checkKey = key;
    const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
      if (this.checkPromise === promise) {
        this.checkPromise = null;
        this.checkKey = null;
      }
    });
    this.checkPromise = promise;
    return this.checkPromise;
  }
  async #check(configuredPath, requestedEncoder = "auto") {
    this.#set({ state: "checking", reason: null, progress: null, canSelectFfmpeg: false });
    const custom = configuredPath ?? this.getConfig().ffmpegPath ?? "";
    const candidates = [];
    if (custom) candidates.push({ source: "custom", path: custom });
    candidates.push({ source: "system", path: "ffmpeg" });
    const managed = this.managedPath();
    if (managed) candidates.push({ source: "managed", path: managed });
    const results = [];
    for (const candidate of candidates) {
      try {
        const probe = await probeFfmpeg(candidate.path, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder });
        results.push({ ...candidate, usable: true, version: probe.version, encoder: probe.encoder });
        this.#set({
          state: "ready",
          source: candidate.source,
          path: candidate.path,
          version: probe.version,
          encoder: probe.encoder,
          canSelectFfmpeg: true,
          canDownload: !!this.manifest,
          reason: null,
          candidates: results,
          updateAvailable: candidate.source === "managed" && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || ""))
        });
        return this.status();
      } catch (error) {
        const e = error;
        results.push({ ...candidate, usable: false, code: e.code || "ffmpeg-unavailable", reason: e.message });
      }
    }
    this.#set({ ...this.#baseStatus(), state: "missing", candidates: results, reason: results[0]?.reason || "No compatible FFmpeg installation was found" });
    return this.status();
  }
  async resolvedPath() {
    const status = this.statusValue.state === "ready" ? this.status() : await this.check();
    return status.canSelectFfmpeg ? status.path : null;
  }
  install({ githubMirror, configuredPath, requestedEncoder = "auto" } = {}) {
    if (this.installPromise) return this.installPromise;
    if (!this.manifest) return Promise.reject(codedError3("ffmpeg-platform-unsupported", `No managed FFmpeg build for ${this.platform}-${this.arch}`));
    this.installPromise = this.#install(githubMirror ?? this.getConfig().githubMirror ?? "", configuredPath ?? this.getConfig().ffmpegPath ?? "", requestedEncoder).finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }
  startInstall(options = {}) {
    void this.install(options).catch(() => {
    });
    return this.status();
  }
  async #install(githubMirror, configuredPath, requestedEncoder) {
    const manifest = this.manifest;
    const platformRoot = join4(this.cacheRoot, `${this.platform}-${this.arch}`);
    const tempRoot = join4(platformRoot, `.install-${randomUUID()}`);
    const archivePath = join4(tempRoot, `archive.${manifest.archiveType === "gzip" ? "gz" : "pkg"}`);
    const extractedPath = join4(tempRoot, manifest.executableName);
    const finalRoot = join4(platformRoot, manifest.buildId);
    const finalPath = join4(finalRoot, manifest.executableName);
    let releaseLock = null;
    let backup = null;
    let published = false;
    try {
      await mkdir3(platformRoot, { recursive: true });
      releaseLock = await acquireInstallLock(platformRoot);
      await cleanupInterruptedInstalls(platformRoot);
      if (manifest.archiveType === "tar") await ensureTarAvailable(this.spawn);
      await mkdir3(tempRoot, { recursive: true });
      const url = rewriteGithubUrl(manifest.url, githubMirror);
      this.#set({ state: "downloading", reason: null, progress: { receivedBytes: 0, totalBytes: manifest.size, percent: 0 }, canSelectFfmpeg: false });
      const digest = await downloadFile(url, archivePath, {
        fetchImpl: this.fetch,
        expectedSize: manifest.size,
        onProgress: (progress) => this.#set({ state: "downloading", progress })
      });
      this.#set({ state: "verifying", progress: null });
      if (digest !== manifest.sha256) throw codedError3("ffmpeg-checksum-mismatch", "Downloaded FFmpeg archive failed SHA-256 verification");
      this.#set({ state: "extracting" });
      if (manifest.archiveType === "gzip") {
        await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 493 }));
      } else {
        await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable, this.spawn);
      }
      if (this.platform !== "win32") await chmod(extractedPath, 493);
      if (this.platform === "darwin") await prepareMacExecutable(extractedPath, this.arch, this.spawn);
      this.#set({ state: "probing" });
      const probe = await probeFfmpeg(extractedPath, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder });
      const executableSha256 = await hashFile(extractedPath);
      await writeFile2(join4(tempRoot, "install.json"), JSON.stringify({
        provider: manifest.provider,
        buildId: manifest.buildId,
        archiveSha256: manifest.sha256,
        executableSha256,
        installedAt: (/* @__PURE__ */ new Date()).toISOString(),
        version: probe.version,
        encoder: probe.encoder
      }, null, 2));
      await rm2(archivePath, { force: true });
      backup = `${finalRoot}.old-${randomUUID()}`;
      let hadExisting = false;
      try {
        await rename(finalRoot, backup);
        hadExisting = true;
      } catch (error) {
        const e = error;
        if (e.code !== "ENOENT") throw error;
      }
      await mkdir3(dirname2(finalRoot), { recursive: true });
      await rename(tempRoot, finalRoot);
      published = true;
      await access(finalPath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (hadExisting) await rm2(backup, { recursive: true, force: true });
      backup = null;
      return await this.#check(configuredPath, requestedEncoder);
    } catch (error) {
      if (published) await rm2(finalRoot, { recursive: true, force: true }).catch(() => {
      });
      if (backup) await rename(backup, finalRoot).catch(() => {
      });
      await rm2(tempRoot, { recursive: true, force: true }).catch(() => {
      });
      const e = error;
      this.#set({ state: "failed", reason: e.message, progress: null, canSelectFfmpeg: false, canDownload: true });
      throw error;
    } finally {
      await releaseLock?.();
    }
  }
  #set(patch) {
    this.statusValue = { ...this.statusValue, ...patch };
  }
};
async function acquireInstallLock(platformRoot) {
  const lockPath = join4(platformRoot, ".install.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }));
      return async () => {
        await handle.close().catch(() => {
        });
        const owner = await readFile3(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
        if (owner?.token === token) await rm2(lockPath, { force: true }).catch(() => {
        });
      };
    } catch (error) {
      const e = error;
      if (e.code !== "EEXIST") throw error;
      const owner = await readFile3(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
      if (!owner?.pid || !isProcessAlive2(owner.pid)) {
        await rm2(lockPath, { force: true });
        continue;
      }
      throw codedError3("ffmpeg-install-busy", "Another FFmpeg installation is already running");
    }
  }
  throw codedError3("ffmpeg-install-busy", "Another FFmpeg installation is already running");
}
function isProcessAlive2(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    const e = error;
    return e?.code === "EPERM";
  }
}
async function cleanupInterruptedInstalls(platformRoot) {
  const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => {
    const e = error;
    return e.code === "ENOENT" ? [] : Promise.reject(error);
  });
  await Promise.all(
    entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".install-")).map((entry) => rm2(join4(platformRoot, entry.name), { recursive: true, force: true }))
  );
}
async function downloadFile(url, target, { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {
}, maxBytes = 250 * 1024 * 1024 } = {}) {
  let current = url;
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeDownloadUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    try {
      response = await fetchImpl(current, { redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw codedError3("ffmpeg-download-failed", "FFmpeg download redirect omitted Location");
    current = new URL(location, current).toString();
    await response.body?.cancel().catch(() => {
    });
    if (!current.startsWith("https://")) throw codedError3("ffmpeg-download-failed", "FFmpeg download refused a non-HTTPS redirect");
    if (redirects === 5) throw codedError3("ffmpeg-download-failed", "Too many FFmpeg download redirects");
  }
  if (!response?.ok || !response.body) throw codedError3("ffmpeg-download-failed", `FFmpeg download failed with HTTP ${response?.status || 0}`);
  const declared = Number(response.headers.get("content-length")) || expectedSize || null;
  const hash = createHash("sha256");
  const file = await open(target, "w");
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await readChunk(reader, 3e4);
      if (done) break;
      const buffer = Buffer.from(value);
      received += buffer.length;
      if (received > maxBytes) throw codedError3("ffmpeg-download-failed", "FFmpeg archive exceeds the allowed size");
      hash.update(buffer);
      await file.write(buffer);
      onProgress({ receivedBytes: received, totalBytes: declared, percent: declared ? Math.min(100, Math.round(received * 100 / declared)) : null });
    }
  } finally {
    await reader.cancel().catch(() => {
    });
    await file.close();
  }
  return hash.digest("hex");
}
async function ensureTarAvailable(spawn2) {
  try {
    await runCommand("tar", ["--version"], spawn2, 5e3);
  } catch {
    throw codedError3("ffmpeg-extractor-unavailable", "The managed FFmpeg archive requires the system tar extractor");
  }
}
function assertSafeDownloadUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) {
    throw codedError3("ffmpeg-download-failed", "FFmpeg downloads require a public HTTPS destination");
  }
}
function isPrivateIp(host) {
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  if (family === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  return false;
}
async function extractWithTar(archivePath, tempRoot, destination, matcher, spawn2) {
  const listing = await runCommand("tar", ["-tf", archivePath], spawn2, 15e3);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const matches = entries.filter((entry2) => safeArchiveEntry(entry2) && matcher.test(entry2));
  if (matches.length !== 1) throw codedError3("ffmpeg-executable-missing", `Expected one FFmpeg executable in archive, found ${matches.length}`);
  const entry = matches[0];
  await runCommand("tar", ["-xf", archivePath, "-C", tempRoot, entry], spawn2, 6e4);
  const extracted = resolve(tempRoot, normalize(entry));
  if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError3("ffmpeg-archive-unsafe", "FFmpeg archive path escaped the install directory");
  await copyFile(extracted, destination);
}
function safeArchiveEntry(entry) {
  const value = entry.replaceAll("\\", "/");
  return value !== "" && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes("..");
}
async function prepareMacExecutable(path, arch, spawn2) {
  await runCommand("xattr", ["-d", "com.apple.quarantine", path], spawn2, 5e3).catch(() => {
  });
  if (arch === "arm64") await runCommand("codesign", ["--force", "--sign", "-", path], spawn2, 15e3).catch(() => {
  });
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function readChunk(reader, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(codedError3("ffmpeg-download-timeout", "FFmpeg download stalled")), timeoutMs);
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function runCommand(command, argv, spawn2, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn2(command, argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => code === 0 ? finish(resolvePromise, { stdout, stderr }) : finish(reject, codedError3("ffmpeg-archive-invalid", stderr || `${command} exited with ${code}`)));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish(reject, codedError3("ffmpeg-archive-invalid", `${command} timed out`));
    }, timeoutMs);
  });
}
function codedError3(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// packages/browser/browser-ego-host/third-party/upstream/src/util.ts
var SENTINEL = "@@DSH_RESULT@@";
var j = (v) => JSON.stringify(v);
var str = (v, fallback) => typeof v === "string" && v !== "" ? v : fallback;
var num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
var SAFE_FN = "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";
function readAll(reader) {
  if (!reader) return "";
  return reader.readFrom(0).text;
}

// packages/browser/browser-ego-host/third-party/upstream/src/index.ts
var name = "ego-browser";
var inject = ["tools", "subprocess"];
var Config2 = Config;
var VENDORED_EGO_BIN = fileURLToPath3(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url)
);
var DEFAULT_EGO_BIN = VENDORED_EGO_BIN;
var DEFAULT_SPACE = "dsh-agent";
var DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
var DEFAULT_GRACE_MS = 15e3;
var TOOL_TIMEOUT_MS = 12e4;
function humanCheckScript(space) {
  return `${useSpace(space)}${ensureRealTab()}let __hc = null
try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }
console.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))
`;
}
function waitForHumanScript(space, opts) {
  const selector = opts.selector ?? "";
  const selectorCheck = selector === "" ? "  const __selOk = true\n" : `  let __selOk = false
  try { __selOk = (await page.count(${j(selector)})) > 0 } catch { __selOk = false }
`;
  return `${useSpace(space)}${ensureRealTab()}const __wb = Date.now()
let __saw = false, __resolved = false, __polls = 0, __last = null
for (;;) {
  let __hc = null
  try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }
  if (__hc && __hc.detected) __saw = true
  __last = __hc
` + selectorCheck + `  if (!(__hc && __hc.detected) && __selOk) { __resolved = true; break }
  if (Date.now() - __wb >= ${opts.timeoutMs}) break
  __polls++
  await page.waitForTimeout(${opts.pollMs})
}
console.log('${SENTINEL}' + JSON.stringify({ ok: true, needed: __saw, resolved: __resolved, waitedMs: Date.now() - __wb, polls: __polls, detected: !!(__last && __last.detected), kind: (__last && __last.kind) || null, url: await page.url().catch(() => null) }))
`;
}
function createActiveSpaceTracker(defaultSpace = DEFAULT_SPACE) {
  let activeSpace = defaultSpace;
  let activeName = typeof defaultSpace === "string" ? defaultSpace : null;
  return {
    current: () => activeSpace,
    opened: (args, result) => {
      activeName = result?.name ?? str(args?.name, defaultSpace) ?? null;
      activeSpace = result?.id ?? activeName ?? defaultSpace;
    },
    selected: (space) => {
      if (space !== void 0 && space !== "") {
        activeSpace = space;
        activeName = typeof space === "string" ? space : null;
      }
    },
    closed: (space, done) => {
      if (done && (String(space) === String(activeSpace) || activeName !== null && String(space) === String(activeName))) {
        activeSpace = defaultSpace;
        activeName = typeof defaultSpace === "string" ? defaultSpace : null;
      }
    },
    // A browser restart resets the runtime's space table, leaving the
    // remembered NUMERIC id dangling — the runtime then hard-fails every
    // tool with "task space not found: N" until the user manually reopens a
    // space. Falling back to the space's NAME lets useOrCreate recreate it.
    resetToName: () => {
      activeSpace = activeName ?? defaultSpace;
    }
  };
}
var pendingSessionId;
function currentSessionId() {
  return pendingSessionId;
}
function spaceNameForSession(sessionId, baseDefault, scoped) {
  if (!scoped || sessionId === void 0 || sessionId === "") return baseDefault;
  const digest = createHash2("sha256").update(String(sessionId)).digest("hex");
  return `coding-ego-${digest}`;
}
function scopedTargetKey(sessionId, space) {
  return `${sessionId ?? ""}\0${String(space)}`;
}
function createSessionScopedSpaceTracker(baseDefault = DEFAULT_SPACE, isScoped = () => true) {
  const bySession = /* @__PURE__ */ new Map();
  const trackerFor = (sessionId) => {
    const key = sessionId ?? "";
    let tracker = bySession.get(key);
    if (tracker === void 0) {
      tracker = createActiveSpaceTracker(
        spaceNameForSession(sessionId, baseDefault, isScoped())
      );
      bySession.set(key, tracker);
    }
    return tracker;
  };
  return {
    forSession: trackerFor,
    current: () => trackerFor(pendingSessionId).current(),
    opened: (args, result) => trackerFor(pendingSessionId).opened(args, result),
    selected: (space) => trackerFor(pendingSessionId).selected(space),
    closed: (space, done) => trackerFor(pendingSessionId).closed(space, done),
    resetToName: () => trackerFor(pendingSessionId).resetToName()
  };
}
var egoLockChain = Promise.resolve();
function withEgoLock(fn) {
  const run = egoLockChain.then(
    () => fn(),
    () => fn()
  );
  egoLockChain = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
var BUNDLED_WRAPPER = fileURLToPath3(
  new URL("../bin/ego-chrome-wrapper.sh", import.meta.url)
);
var IS_WIN = process.platform === "win32";
var IS_DARWIN = process.platform === "darwin";
var AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(
  process.env.EGO_BROWSER_AUTO_ADAPT ?? ""
);
var COMMON_CHROME_BINS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/google-chrome"
];
function windowsChromeCandidates() {
  const pf = process.env.ProgramFiles;
  const pfx86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  const base = local || `${process.env.USERPROFILE || process.env.HOME || ""}\\AppData\\Local`;
  const b = (p) => p ? p.replace(/\\+$/, "") : p;
  const out = [
    b(pf) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(pfx86) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(local) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(pf) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(pfx86) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(local) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(pfx86) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    b(local) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  ];
  return out.filter(Boolean);
}
function darwinChromeCandidates() {
  const roots = ["/Applications"];
  if (process.env.HOME) {
    roots.push(`${process.env.HOME}/Applications`);
  }
  const bundles = [
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Chromium.app/Contents/MacOS/Chromium",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Brave Browser.app/Contents/MacOS/Brave Browser"
  ];
  const out = [];
  for (const root of roots) {
    for (const bundle of bundles) {
      out.push(`${root}/${bundle}`);
    }
  }
  return out;
}
function findChromeBinary() {
  if (process.env.EGO_LINUX_CHROME) {
    return process.env.EGO_LINUX_CHROME;
  }
  if (IS_WIN) {
    for (const p of windowsChromeCandidates()) {
      try {
        if (existsSync2(p)) {
          return p;
        }
      } catch {
      }
    }
    const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map(
      (e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`
    );
    const dirs = (process.env.PATH ?? "").split(";").map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
    for (const dir of dirs) {
      for (const name2 of ["chrome", "msedge", "brave"]) {
        for (const ext of exts) {
          try {
            const p = `${dir}\\${name2}${ext}`;
            if (existsSync2(p)) {
              return p;
            }
          } catch {
          }
        }
      }
    }
    return void 0;
  }
  if (IS_DARWIN) {
    for (const p of darwinChromeCandidates()) {
      try {
        if (existsSync2(p)) {
          return p;
        }
      } catch {
      }
    }
    return void 0;
  }
  for (const name2 of COMMON_CHROME_BINS) {
    if (name2.includes("/")) {
      try {
        if (existsSync2(name2)) {
          return name2;
        }
      } catch {
      }
    } else {
      for (const dir of (process.env.PATH ?? "").split(":")) {
        if (!dir) {
          continue;
        }
        const p = `${dir}/${name2}`;
        try {
          if (existsSync2(p)) {
            return p;
          }
        } catch {
        }
      }
    }
  }
  return void 0;
}
function isPosixRoot(platform = process.platform) {
  const uid = process.getuid?.();
  return typeof uid === "number" && uid === 0 && platform !== "win32";
}
function isHeadlessDetected(platform = process.platform, env = process.env) {
  if (platform === "win32" || platform === "darwin") {
    return false;
  }
  return env.DISPLAY === void 0 || env.DISPLAY === "";
}
function resolveEgoEnv(cfg, { platform = process.platform, baseEnv = process.env } = {}) {
  if (AUTO_ADAPT_OFF) {
    return baseEnv;
  }
  const env = { ...baseEnv };
  if (process.versions.electron && env.ELECTRON_RUN_AS_NODE === void 0) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const chrome = findChromeBinary();
  const configChrome = cfg?.chromePath;
  if (env.EGO_LINUX_CHROME === void 0 && configChrome) {
    env.EGO_LINUX_CHROME = configChrome;
  }
  if (env.EGO_LINUX_CHROME === void 0 && isPosixRoot(platform) && chrome) {
    env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
  }
  if (env.EGO_LINUX_CHROME === void 0 && (platform === "win32" || platform === "darwin") && chrome) {
    env.EGO_LINUX_CHROME = chrome;
  }
  if (env.EGO_LINUX_HEADLESS === void 0 && isHeadlessDetected(platform, env)) {
    env.EGO_LINUX_HEADLESS = "1";
  }
  const configChromeArgs = cfg?.chromeArgs;
  if (env.EGO_LINUX_EXTRA_ARGS === void 0 && typeof configChromeArgs === "string" && configChromeArgs.trim() !== "") {
    env.EGO_LINUX_EXTRA_ARGS = configChromeArgs;
  }
  if (env.EGO_ISOLATE_SPACES === void 0 && cfg?.isolateSpaces !== void 0) {
    env.EGO_ISOLATE_SPACES = cfg.isolateSpaces ? "1" : "0";
  }
  if (env.EGO_LINUX_HEADLESS === void 0 && cfg?.headless !== void 0) {
    env.EGO_LINUX_HEADLESS = cfg.headless ? "1" : "0";
  }
  if (env.EGO_LINUX_CURSOR_NAME === void 0 && typeof cfg?.cursorName === "string" && cfg.cursorName !== "") {
    env.EGO_LINUX_CURSOR_NAME = cfg.cursorName;
  }
  return env;
}
function describeStderr(stderr) {
  const tail = stderr.trim();
  return tail === "" ? "" : `
--- ego-browser stderr (tail) ---
${tail.slice(-2e3)}`;
}
function describeSpawnFailure(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(
    msg
  )) {
    return "ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. " + msg;
  }
  return `failed to start ego-browser: ${msg}`;
}
var COLD_START_SIGNS = [
  /CDP channel is not open/i,
  /DevTools.*(port|timeout|active)/i,
  /could not connect to/i,
  /browser (was |is )?not (reachable|running|ready)/i,
  /target.*(closed|not found|detached|crashed)/i,
  /ECONNREFUSED/i
];
function isColdStartError(message) {
  return COLD_START_SIGNS.some((re) => re.test(message));
}
async function withWarmupRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const result = await fn();
    if (result.ok || !isColdStartError(result.error ?? "")) {
      return result;
    }
    last = result;
    if (i < tries - 1) {
      await new Promise(
        (resolve2) => setTimeout(resolve2, baseDelayMs * (i + 1))
      );
    }
  }
  return last;
}
function shouldReapBrowser(nowMs, lastActivityMs, idleTimeoutMin) {
  if (!(idleTimeoutMin > 0) || !(lastActivityMs > 0)) return false;
  return nowMs - lastActivityMs > idleTimeoutMin * 6e4;
}
async function openAgentWindow(ctx, cfg) {
  try {
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, cfg.egoBin, "--open"],
      cwd: process.cwd(),
      env: resolveEgoEnv(cfg),
      stdio: {
        stdin: { data: "" },
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 }
      },
      graceMs: 25e3
    });
    const outcome = await handle.done;
    if (outcome.exitCode !== 0) {
      const stderr = readAll(handle.collected.stderr).trim();
      return { ok: false, error: stderr || `ego-browser --open exited with code ${outcome.exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSpawnFailure(err) };
  }
}
async function runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs) {
  let result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
  if (!result.ok && /task space not found: \d+/.test(result.error ?? "")) {
    cfg.spaceTracker.resetToName();
    result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
  }
  if (!result.ok && isColdStartError(result.error ?? "")) cfg.onColdStartFailure?.();
  return result;
}
function parseSentinel(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(SENTINEL);
    if (idx === -1) continue;
    const payload = lines[i].slice(idx + SENTINEL.length).trim();
    try {
      return JSON.parse(payload);
    } catch {
      return void 0;
    }
  }
  return void 0;
}
function parseSentinelOrLastJson(stdout) {
  const sentinel = parseSentinel(stdout);
  if (sentinel !== void 0) return { value: sentinel, fallback: false };
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim();
    if (text === "" || !/^[[{]/.test(text)) continue;
    try {
      return { value: JSON.parse(text), fallback: true };
    } catch {
    }
  }
  return void 0;
}
var residentTransport = null;
var residentTransportKey = "";
var residentCooldownUntil = 0;
var residentConsecutiveFailures = 0;
var residentStartedAt = 0;
var residentLastRebuildReason = "not started";
var residentParkReason = null;
function superviseResidentFailure(failures, error) {
  const next = failures + 1;
  return {
    failures: next,
    parkReason: next >= 3 ? `resident failed ${next} times in a row; last error: ${error}` : null
  };
}
function residentDiagnostics(cfg) {
  const running = residentTransport !== null && residentTransport.alive;
  const active = cfg.residentExecutor === true && residentParkReason === null && Date.now() >= residentCooldownUntil;
  return {
    enabled: cfg.residentExecutor === true,
    mode: !active ? "one-shot" : running ? "resident" : "starting",
    running,
    pid: running ? residentTransport?.pid ?? null : null,
    ageMs: running && residentStartedAt > 0 ? Date.now() - residentStartedAt : null,
    consecutiveFailures: residentConsecutiveFailures,
    lastRebuildReason: residentLastRebuildReason,
    parked: residentParkReason !== null,
    parkReason: residentParkReason
  };
}
function resetResidentTransportForTests() {
  const transport = residentTransport;
  residentTransport = null;
  residentTransportKey = "";
  residentCooldownUntil = 0;
  residentConsecutiveFailures = 0;
  residentStartedAt = 0;
  residentLastRebuildReason = "not started";
  residentParkReason = null;
  transport?.stop();
}
function stopResidentTransport() {
  const transport = residentTransport;
  residentTransport = null;
  residentTransportKey = "";
  transport?.stop();
}
function ensureResidentTransport(cfg) {
  const extraCliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
  const key = JSON.stringify([cfg.egoBin, extraCliArgs]);
  if (residentTransport !== null && residentTransportKey === key && residentTransport.alive) {
    return residentTransport;
  }
  const rebuilding = residentTransport !== null;
  stopResidentTransport();
  residentTransportKey = key;
  residentTransport = new ResidentProcess({
    argv: [process.execPath, cfg.egoBin, "nodejs", "--serve", ...extraCliArgs],
    env: resolveEgoEnv(cfg),
    cwd: process.cwd(),
    graceMs: cfg.graceMs,
    idleMs: cfg.residentIdleMin > 0 ? cfg.residentIdleMin * 6e4 : 0,
    onExit: () => {
    }
  });
  residentTransport.start();
  residentStartedAt = Date.now();
  residentLastRebuildReason = rebuilding ? "rebuilt: configuration changed" : "created";
  return residentTransport;
}
function residentFrameToResult(frame) {
  const stdout = frame.stdout;
  const stderr = frame.stderr;
  if (!frame.ok) {
    return {
      ok: false,
      error: `ego-browser script failed: ${frame.error ?? "unknown failure"}${describeStderr(stderr)}`,
      stdout,
      stderr
    };
  }
  const parsed = parseSentinelOrLastJson(stdout);
  if (parsed === void 0) {
    return {
      ok: false,
      error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(
        stderr
      )}`,
      stdout,
      stderr
    };
  }
  const value = parsed.fallback ? { ...parsed.value, fallback: true } : parsed.value;
  return { ok: true, value, stdout, stderr };
}
async function runEgoScript(subprocess, script, exec, cfg, graceOverrideMs) {
  const egoBinCheck = validateEgoBinPath(cfg.egoBin);
  if (!egoBinCheck.ok) return { ok: false, error: `egoBin is not usable: ${egoBinCheck.reason}`, stdout: "", stderr: "" };
  if (cfg.residentExecutor && Date.now() >= residentCooldownUntil) {
    let transport = null;
    try {
      transport = ensureResidentTransport(cfg);
    } catch {
      transport = null;
    }
    if (transport !== null) {
      try {
        const frame = await transport.run(script, {
          ...exec.signal !== void 0 ? { signal: exec.signal } : {},
          ...Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? { graceMs: graceOverrideMs } : {}
        });
        const result = residentFrameToResult(frame);
        if (result.ok) {
          residentConsecutiveFailures = 0;
          residentParkReason = null;
          return result;
        }
        if (!isColdStartError(result.error ?? "")) return result;
        const supervision = superviseResidentFailure(residentConsecutiveFailures, result.error ?? "cold start");
        residentConsecutiveFailures = supervision.failures;
        residentLastRebuildReason = `cold-start failure: ${result.error ?? "unknown"}`;
        if (supervision.parkReason !== null) {
          residentParkReason = supervision.parkReason;
          residentCooldownUntil = Number.MAX_SAFE_INTEGER;
        } else {
          residentCooldownUntil = Date.now() + 1e4;
        }
        stopResidentTransport();
      } catch (err) {
        if (!(err instanceof ResidentNotRunningError)) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            stdout: "",
            stderr: ""
          };
        }
      }
    }
  } else if (!cfg.residentExecutor) {
    if (residentTransport !== null) stopResidentTransport();
    if (residentParkReason !== null || residentConsecutiveFailures !== 0) {
      residentConsecutiveFailures = 0;
      residentParkReason = null;
      residentLastRebuildReason = "disabled by setting";
    }
  }
  let handle;
  try {
    const extraCliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
    handle = subprocess.spawn({
      // Run through the node interpreter so the vendored CLI needs no +x bit.
      argv: [process.execPath, cfg.egoBin, "nodejs", ...extraCliArgs],
      cwd: process.cwd(),
      env: resolveEgoEnv(cfg),
      stdio: {
        stdin: { data: script },
        stdout: {
          maxBytes: cfg.maxOutputBytes,
          spill: { maxBytes: cfg.maxOutputBytes }
        },
        stderr: { maxBytes: 512e3, spill: { maxBytes: 2e6 } }
      },
      graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? graceOverrideMs : cfg.graceMs,
      ...exec.signal !== void 0 ? { signal: exec.signal } : {}
    });
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: "",
      stderr: ""
    };
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: "",
      stderr: ""
    };
  }
  const stdout = readAll(handle.collected.stdout);
  const stderr = readAll(handle.collected.stderr);
  if (exec.signal !== void 0 && exec.signal.aborted) {
    return {
      ok: false,
      error: "ego-browser tool aborted (harness timeout or cancellation)",
      stdout,
      stderr
    };
  }
  if (outcome.exitCode !== 0) {
    const missingModule = /Cannot find module|MODULE_NOT_FOUND/i.test(stderr);
    return {
      ok: false,
      error: missingModule ? describeSpawnFailure(new Error(`node could not load ${cfg.egoBin}`)) : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
      stdout,
      stderr
    };
  }
  const parsed = parseSentinelOrLastJson(stdout);
  if (parsed === void 0) {
    return {
      ok: false,
      error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(
        stderr
      )}`,
      stdout,
      stderr
    };
  }
  const value = parsed.fallback ? { ...parsed.value, fallback: true } : parsed.value;
  return { ok: true, value, stdout, stderr };
}
var useSpace = (name2) => `const task = await taskSpaces.useOrCreate(${j(name2)})
`;
var tabParam = {
  type: "string",
  description: "Optional tab targetId (from ego_tabs list). Omit to use the tab Chrome reports as active, falling back to the first real page."
};
var TARGET_MARKER = "@@EGO_TARGET@@";
function createTargetTracker() {
  const bySpace = /* @__PURE__ */ new Map();
  return {
    get: (space) => bySpace.get(space),
    set: (space, targetId) => {
      if (space !== "" && targetId !== "") bySpace.set(space, targetId);
    }
  };
}
var pendingTargetPin;
var pendingViewport;
function recordPinnedTarget(tracker, space, stdout) {
  const at = stdout.lastIndexOf(TARGET_MARKER);
  if (at === -1) return;
  const id = stdout.slice(at + TARGET_MARKER.length).split(/\s/)[0];
  if (id !== void 0 && id !== "") tracker.set(space, id);
}
function stripTargetMarkers(text) {
  if (!text.includes(TARGET_MARKER)) return text;
  return text.split("\n").filter((line) => !line.includes(TARGET_MARKER)).join("\n");
}
function deliverToSession(ctx, exec, files) {
  if (files.length === 0) return false;
  const session = exec?.agent?.session;
  if (session === void 0 || typeof session.append !== "function") return false;
  try {
    const projections = ctx.get?.("sessionProjections");
    const turn = projections?.stateOf?.(session, "turnBoundary")?.lastTurn;
    if (typeof turn !== "number") return false;
    session.append("deliverables/presented", {
      turn,
      callId: exec?.callId,
      files
    });
    return true;
  } catch {
    return false;
  }
}
var ensureRealTab = (preferred, viewport) => {
  const explicit = preferred !== void 0 && preferred !== "" ? preferred : void 0;
  const pin = explicit ?? pendingTargetPin;
  const spec = viewport ?? pendingViewport;
  return `const __tabs = await browser.listTabs()
const __want = ${pin !== void 0 ? j(pin) : "null"}
const __active = __want ? __tabs.find(t => t.targetId === __want) : __tabs.find(t => t.active === true)
const __real = __active ?? __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]
if (__real) await browser.switchTab(__real.targetId)
if (__real) console.log('${TARGET_MARKER}' + __real.targetId)
` + // Guarded: an existing space can be tab-less (every tab closed), and cdp
  // has no session then. Skip emulation rather than failing the whole call.
  (spec ? `if (__real) {
${viewportPrelude(spec)}}
` : "");
};
var viewportPrelude = (cfg) => {
  const width = Math.round(cfg.viewportWidth ?? 0);
  const height = Math.round(cfg.viewportHeight ?? 0);
  if (!(width > 0) || !(height > 0)) return "";
  const scale = cfg.deviceScaleFactor !== void 0 && cfg.deviceScaleFactor > 0 ? cfg.deviceScaleFactor : 1;
  return `await cdp('Emulation.setDeviceMetricsOverride', { width: ${width}, height: ${height}, deviceScaleFactor: ${scale}, mobile: false })
`;
};
var rawScriptPrelude = (cfg, tab) => `try {
${ensureRealTab(tab, cfg)}} catch {}
`;
var selectOptionScript = (selector, value) => `const __sel = ${j(selector)}
const __v = ${j(value ?? "")}
const __pick = async (v) => {
  try { return await page.locator(__sel).selectOption(v) } catch (__e) {
    if (typeof v === 'string') { try { return await page.locator(__sel).selectOption({ label: v }) } catch {} }
    if (typeof v === 'number') { try { return await page.locator(__sel).selectOption({ index: v }) } catch {} }
    throw __e
  }
}
const __list = Array.isArray(__v) ? __v : [__v]
let __picked = []
try { __picked = await page.locator(__sel).selectOption(__v) } catch { __picked = [] }
if (!Array.isArray(__picked) || __picked.length === 0) {
  for (const __one of __list) { const __r = await __pick(__one); __picked = Array.isArray(__r) ? __r : [__r] }
}
console.log('${SENTINEL}' + JSON.stringify({ ok: true, select: __sel, values: __picked }))
`;
const CSS_PIERCE_FN = `(selector) => {
  const matches = []
  let invalid = false
  const walk = (root, offsetX, offsetY) => {
    if (matches.length > 0 || invalid) return
    let list
    try { list = root.querySelectorAll(selector) } catch { invalid = true; return }
    if (list.length > 0) {
      for (const el of list) matches.push({ el, offsetX, offsetY })
      return
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, offsetX, offsetY)
      if (matches.length > 0 || invalid) return
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null
        try { doc = el.contentDocument } catch { doc = null }
        if (doc && doc.documentElement) {
          const rect = el.getBoundingClientRect()
          walk(doc, offsetX + rect.left, offsetY + rect.top)
          if (matches.length > 0 || invalid) return
        }
      }
    }
  }
  const locate = () => { matches.length = 0; invalid = false; walk(document, 0, 0) }
  locate()
  if (invalid) return { ok: false, reason: 'invalid' }
  if (matches.length === 0) return { ok: false, reason: 'not-found' }
  if (matches.length > 1) return { ok: false, reason: 'multiple', count: matches.length }
  try { matches[0].el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
  locate()
  if (matches.length !== 1) return { ok: false, reason: 'not-found' }
  const found = matches[0]
  const rect = found.el.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return { ok: false, reason: 'hidden' }
  return { ok: true, x: found.offsetX + rect.left + rect.width / 2, y: found.offsetY + rect.top + rect.height / 2 }
}`;
function cssPierceFallback(kind, selector, label) {
  const native = kind === "hover" ? `await page.locator(${j(selector)}).hover()` : `await page.locator(${j(selector)}).${kind}(${label === "" ? "" : `{ label: ${j(label)} }`})`;
  const retry = kind === "hover" ? `await page.mouse.move(__cssPoint.x, __cssPoint.y)` : `await page.mouse.${kind}(__cssPoint.x, __cssPoint.y)`;
  return `let __cssPoint = null
try {
  ${native}
} catch (__cssErr) {
  try { __cssPoint = await page.evaluate(${CSS_PIERCE_FN}, ${j(selector)}) } catch { __cssPoint = null }
  if (!__cssPoint || __cssPoint.ok !== true) throw __cssErr
  ${retry}
}`;
}
function renderText(_args, value) {
  const v = value;
  if (v !== null && typeof v === "object" && v.ok === true && typeof v.text === "string") {
    return [{ type: "text", text: v.text }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
var commonOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean", required: true }
  }
};
function callingSessionId(exec) {
  const agent = exec?.agent;
  const id = agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : void 0;
}
function observeEgoTool(cfg, name2, args, run) {
  return cfg.observeTool ? cfg.observeTool(name2, args, run) : Promise.resolve().then(run);
}
function defineEgoTool(ctx, cfg, opts) {
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    output: {
      schema: commonOutputSchema,
      render: renderText
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, opts.name, args, async () => {
      const sessionId = callingSessionId(exec);
      pendingSessionId = sessionId;
      try {
        markEgoToolCall(sessionId);
        const spaceKey = scopedTargetKey(sessionId, str(args.space, cfg.defaultSpace));
        const buildScript = () => {
          pendingTargetPin = cfg.targetTracker.get(spaceKey);
          pendingViewport = cfg;
          try {
            return opts.buildScript(args);
          } finally {
            pendingTargetPin = void 0;
            pendingViewport = void 0;
          }
        };
        const result = await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript);
        if (!result.ok) throw new Error(result.error);
        recordPinnedTarget(cfg.targetTracker, spaceKey, result.stdout);
        if (typeof opts.afterExecute === "function") opts.afterExecute(args, result.value);
        if (typeof opts.deliverFiles === "function") {
          deliverToSession(ctx, exec, opts.deliverFiles(args, result.value));
        }
        return result.value;
      } finally {
        pendingSessionId = void 0;
      }
    })),
    presentCall: (args) => ({
      card: "generic",
      title: toolCallTitle(opts.name, args),
      kind: "other",
      rawInput: null
    })
  });
}
function apply(ctx, config = {}) {
  const settingKeys = [
    "chromePath",
    "headless",
    "cursorName",
    "captureBackend",
    "streamProfile",
    "cdpFps",
    "cdpQuality",
    "cdpMaxWidth",
    "cdpBackstopIntervalMs",
    "ffmpegFps",
    "ffmpegMaxWidth",
    "ffmpegBitrateKbps",
    "ffmpegEncoder",
    "ffmpegPath",
    "githubMirror",
    "egoCliArgs",
    "chromeArgs",
    "castFpsCap",
    "screencastQuality",
    "screencastMaxWidth",
    "backstopIntervalMs",
    "idleTimeoutMin",
    "disableFrameRelay",
    "tuiAutoOpenPanel",
    "residentExecutor",
    "residentIdleMin"
  ];
  const entry = Object.fromEntries(settingKeys.filter((key) => config[key] !== void 0).map((key) => [key, config[key]]));
  const bridge2 = installEgoBrowserSettings(ctx, entry, () => {
    let live;
    try {
      live = ctx.config;
    } catch {
      live = void 0;
    }
    return live ?? config;
  });
  const ffmpegManager = getSharedFfmpegInstallationManager();
  const initialFfmpegConfig = resolveConfig(bridge2.source());
  if (initialFfmpegConfig.captureBackend === "ffmpeg") {
    void ffmpegManager.check({ configuredPath: initialFfmpegConfig.ffmpegPath, requestedEncoder: initialFfmpegConfig.ffmpegEncoder }).catch(() => {
    });
  }
  const spaceTracker = createSessionScopedSpaceTracker(
    config.defaultSpace ?? DEFAULT_SPACE,
    () => resolveConfig(bridge2.source()).sessionScopedSpaces
  );
  const cfg = {
    egoBin: typeof config.egoBin === "string" && config.egoBin !== "" ? config.egoBin : DEFAULT_EGO_BIN,
    configuredDefaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
    spaceTracker,
    targetTracker: createTargetTracker(),
    get defaultSpace() {
      return this.spaceTracker.current();
    },
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    // Live getter: reads from the settings bridge so GUI edits take effect on
    // the next spawn without restarting the plugin.
    get chromePath() {
      return resolveConfig(bridge2.source()).chromePath;
    },
    get headless() { return resolveConfig(bridge2.source()).headless },
    get cursorName() { return resolveConfig(bridge2.source()).cursorName },
    get captureBackend() {
      return resolveConfig(bridge2.source()).captureBackend;
    },
    get streamProfile() {
      return resolveConfig(bridge2.source()).streamProfile;
    },
    get cdpFps() {
      return resolveConfig(bridge2.source()).cdpFps;
    },
    get cdpQuality() {
      return resolveConfig(bridge2.source()).cdpQuality;
    },
    get cdpMaxWidth() {
      return resolveConfig(bridge2.source()).cdpMaxWidth;
    },
    get cdpBackstopIntervalMs() {
      return resolveConfig(bridge2.source()).cdpBackstopIntervalMs;
    },
    get ffmpegFps() {
      return resolveConfig(bridge2.source()).ffmpegFps;
    },
    get ffmpegMaxWidth() {
      return resolveConfig(bridge2.source()).ffmpegMaxWidth;
    },
    get ffmpegBitrateKbps() {
      return resolveConfig(bridge2.source()).ffmpegBitrateKbps;
    },
    get ffmpegEncoder() {
      return resolveConfig(bridge2.source()).ffmpegEncoder;
    },
    get ffmpegPath() {
      return resolveConfig(bridge2.source()).ffmpegPath;
    },
    get githubMirror() {
      return resolveConfig(bridge2.source()).githubMirror;
    },
    // User-defined extra CLI args (see src/config.ts). Live getters so GUI
    // edits take effect on the next spawn / next browser cold start.
    get egoCliArgs() {
      return resolveConfig(bridge2.source()).egoCliArgs;
    },
    get chromeArgs() {
      return resolveConfig(bridge2.source()).chromeArgs;
    },
    // Live getters: the viewport prelude is rebuilt for every call, so a GUI
    // edit takes effect on the next ego_* call without a restart.
    get viewportWidth() {
      return resolveConfig(bridge2.source()).viewportWidth;
    },
    get viewportHeight() {
      return resolveConfig(bridge2.source()).viewportHeight;
    },
    get deviceScaleFactor() {
      return resolveConfig(bridge2.source()).deviceScaleFactor;
    },
    get isolateSpaces() {
      return resolveConfig(bridge2.source()).isolateSpaces;
    },
    get sessionScopedSpaces() {
      return resolveConfig(bridge2.source()).sessionScopedSpaces;
    },
    get idleTimeoutMin() {
      return resolveConfig(bridge2.source()).idleTimeoutMin;
    },
    // Live getter: cast-server reads this on EVERY /api/ego/* request, so the
    // settings card toggle takes effect without a host restart.
    get disableFrameRelay() {
      return resolveConfig(bridge2.source()).disableFrameRelay;
    },
    get tuiAutoOpenPanel() {
      return resolveConfig(bridge2.source()).tuiAutoOpenPanel;
    },
    // #56: resident executor (opt-in) and its idle window. Both are read on
    // every call, so toggling the setting takes effect on the next ego_* call.
    get residentExecutor() {
      return resolveConfig(bridge2.source()).residentExecutor;
    },
    get residentIdleMin() {
      return resolveConfig(bridge2.source()).residentIdleMin;
    }
  };
  ctx.exportBrowserEnv?.(() => resolveEgoEnv(cfg));
  const browserState = new BrowserStateStore();
  const tui = installTui(ctx, browserState);
  installBrowserPanel(ctx, cfg, browserState, tui, {
    createTransport: () => ({ readBrowserState, readTaskSpaceGroups, ensureWorker: makeEnsureWorker(ctx, cfg, ffmpegManager), get: proxyFrom, post: proxyPost }),
    openAgentWindow: () => openAgentWindow(ctx, cfg)
  });
  cfg.onColdStartFailure = () => tui.toast("Agent Browser could not start after retrying. Run ego_doctor for details.", "error");
  cfg.observeTool = async (name2, args, run) => {
    const token = browserState.startTool(name2, safeLocatorSummary(name2, args));
    try {
      const value = await run();
      const result = value;
      const error = typeof result?.error === "string" ? result.error : void 0;
      browserState.finishTool(token, { ok: result?.ok !== false, error });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      browserState.finishTool(token, { ok: false, error: message });
      throw error;
    }
  };
  const reg = (tool) => {
    if (["ego_cli", "ego_script", "ego_help", "ego_doctor"].includes(tool.name)) {
      const execute = tool.execute;
      tool.execute = (args, exec) => observeEgoTool(cfg, tool.name, args, () => execute(args, exec));
    }
    const dispose = ctx.tools.register(tool);
    ctx.effect?.(() => dispose);
  };
  registerEgoStatus(ctx, cfg, reg);
  registerAuthFlush(ctx, cfg, reg);
  registerLoginImport(ctx, cfg, reg);
  registerActionTools(ctx, cfg, reg);
  registerHelpAndDoctor(ctx, cfg, reg);
  ctx.inject?.(["webServer"], (wctx) => {
    try {
      initCastServer(
        wctx,
        cfg,
        bridge2,
        ffmpegManager,
        () => openAgentWindow(ctx, cfg),
        (opts) => importLoginCookies(opts, { subprocess: ctx.subprocess }),
        () => residentDiagnostics(cfg)
      );
    } catch (err) {
      ctx.logger?.warn?.(
        `ego-browser: cast server init failed: ${err?.message ?? err}`
      );
    }
    try {
      registerEgoBrowserGateway(wctx, bridge2, ffmpegManager);
    } catch (err) {
      ctx.logger?.warn?.(
        `ego-browser: settings gateway init failed: ${err?.message ?? err}`
      );
    }
  });
  ctx.effect?.(() => {
    if (cfg.idleTimeoutMin <= 0) return;
    let reapedFor = 0;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const last = getLastEgoActivity();
          if (!shouldReapBrowser(Date.now(), last, cfg.idleTimeoutMin)) return;
          if (last <= reapedFor) return;
          const e = process.env;
          const isWin = process.platform === "win32";
          const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir2());
          const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
          const { readFile: readFile4 } = await import("node:fs/promises");
          let reapedPid;
          try {
            const stateText = await readFile4(`${stateDir}/browser.json`, "utf8");
            if (tui.hasToast()) {
              try {
                const pid = JSON.parse(stateText).pid;
                if (Number.isInteger(pid) && pid > 0) {
                  process.kill(pid, 0);
                  reapedPid = pid;
                }
              } catch {
              }
            }
          } catch {
            return;
          }
          reapedFor = last;
          ctx.logger?.info?.(`ego-browser: idle reaper stopping the backing browser after ${cfg.idleTimeoutMin}min without ego_* activity`);
          const handle = ctx.subprocess.spawn({
            argv: [process.execPath, cfg.egoBin, "--stop"],
            cwd: process.cwd(),
            env: resolveEgoEnv(cfg),
            stdio: {
              stdin: { data: "" },
              stdout: { maxBytes: 1024 },
              stderr: { maxBytes: 1024 }
            },
            graceMs: 8e3
          });
          void handle.done.then((outcome) => {
            if (outcome.exitCode !== 0 || reapedPid === void 0 || !tui.hasToast()) return;
            try {
              process.kill(reapedPid, 0);
            } catch (error) {
              if (error.code === "ESRCH") {
                tui.toast("Agent Browser stopped after the idle timeout.", "success");
              }
            }
          }).catch(() => null);
        } catch {
        }
      })();
    }, 6e4);
    return () => clearInterval(timer);
  }, "ego-browser: idle reaper");
  ctx.effect?.(() => () => stopResidentTransport(), "ego-browser: resident executor");
  ctx.effect?.(() => () => {
    try {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, cfg.egoBin, "--stop"],
        cwd: process.cwd(),
        env: resolveEgoEnv(cfg),
        stdio: {
          stdin: { data: "" },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 }
        },
        // Keep it short; never let this outlive the host's own teardown budget.
        // But DO give the graceful stop enough time (>= the runtime's
        // Browser.close + waitForProcessExit window) so the browser merges its
        // cookie journal into the on-disk profile before DSH is gone — that is
        // what keeps logins across a restart (original ego-lite behavior).
        graceMs: 8e3
      });
      handle.done.catch(() => {
      });
    } catch {
    }
  });
  ctx.logger?.info?.(
    `ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`
  );
}
function registerEgoStatus(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_status",
      description: 'Check whether the ego-browser CLI is usable (runs `ego-browser --status`). Use this first when other ego_* tools report "CLI not found".',
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            available: { type: "boolean", required: true },
            path: { type: "string" },
            exitCode: { type: "integer" },
            resident: { type: "object", additionalProperties: true }
          }
        },
        render: renderText
      },
      // Chrome cold-start can exceed the runtime's own 20s DevTools window on
      // a first launch (root/CI boxes in particular). Give --status a generous
      // budget so it does not report "unavailable" merely because the backing
      // browser was still warming up.
      timeoutMs: 25e3,
      execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_status", args, async () => {
        try {
          const handle = ctx.subprocess.spawn({
            argv: [process.execPath, cfg.egoBin, "--status"],
            cwd: process.cwd(),
            env: resolveEgoEnv(cfg),
            stdio: {
              stdin: { data: "" },
              stdout: { maxBytes: 4096 },
              stderr: { maxBytes: 4096 }
            },
            graceMs: 25e3
          });
          const outcome = await handle.done;
          const out = readAll(handle.collected.stdout).trim();
          return {
            ok: true,
            available: outcome.exitCode === 0 && out !== "",
            path: cfg.egoBin,
            exitCode: outcome.exitCode,
            resident: residentDiagnostics(cfg)
          };
        } catch (err) {
          return {
            ok: true,
            available: false,
            path: "",
            exitCode: null,
            error: describeSpawnFailure(err)
          };
        }
      })),
      presentCall: (args) => ({
        card: "generic",
        title: toolCallTitle("ego_status", args),
        kind: "other",
        rawInput: null
      })
    })
  );
}
function registerAuthFlush(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_auth_flush",
      description: "Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart \u2014 Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            total: { type: "integer" },
            flushed: { type: "integer" },
            error: { type: "string" }
          }
        },
        render: renderText
      },
      timeoutMs: 1e4,
      execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_auth_flush", args, async () => {
        try {
          const { readFile: readFile4 } = await import("node:fs/promises");
          const e = process.env;
          const isWin = process.platform === "win32";
          const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir2());
          const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
          let port = null;
          try {
            const state = JSON.parse(
              await readFile4(`${stateDir}/ego-cast.json`, "utf8")
            );
            port = typeof state.port === "number" ? state.port : null;
          } catch {
            port = null;
          }
          if (port === null)
            return {
              ok: false,
              error: "no live ego-cast worker (browser not running)"
            };
          const r = await fetch(`http://127.0.0.1:${port}/api/flush`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(8e3)
          });
          const jbody = await r.json();
          return {
            ok: !!jbody.ok,
            total: jbody.total ?? 0,
            flushed: jbody.flushed ?? 0,
            // [#60-3] undefined is not lossless JSON — strict hosts reject
            // the WHOLE result; omit the key when there is no error.
            ...typeof jbody.error === "string" ? { error: jbody.error } : {}
          };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      })),
      presentCall: (args) => ({
        card: "generic",
        title: toolCallTitle("ego_auth_flush", args),
        kind: "other",
        rawInput: null
      })
    })
  );
}
function loginImportPolicy({
  platform,
  chromeMajor,
  force
}) {
  if (force) return { allowed: true };
  if (platform !== "win32") return { allowed: true };
  if (chromeMajor === null) {
    return {
      allowed: false,
      reason: "could not determine the installed Chrome version on Windows; refusing to risk the source profile (set EGO_LINUX_LOGIN_IMPORT_FORCE=1 to override)"
    };
  }
  if (chromeMajor >= 127) {
    return {
      allowed: false,
      reason: `Chrome ${chromeMajor} on Windows uses App-Bound Encryption (127+), which makes the current import path both unable to read cookies and potentially destructive to the source profile (#69). Set EGO_LINUX_LOGIN_IMPORT_FORCE=1 to override.`
    };
  }
  return { allowed: true };
}
function loginImportForced(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env.EGO_LINUX_LOGIN_IMPORT_FORCE ?? "");
}
function detectChromeMajorVersion(binPath) {
  if (!binPath) return null;
  try {
    if (process.platform === "win32") {
      const versions = readdirSync(dirname3(binPath)).filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry)).map((entry) => Number(entry.split(".")[0])).filter((major) => Number.isInteger(major) && major > 0);
      return versions.length === 0 ? null : Math.max(...versions);
    }
    const out = execFileSync(binPath, ["--version"], { encoding: "utf8", timeout: 5e3 });
    const match = String(out).match(/(\d+)\.\d+\.\d+/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
function registerLoginImport(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_login_import",
      description: `Import login cookies from the system browser into the agent browser, so sites open already logged in, with two SAFE routes (#69): (1) source="extension" \u2014 load the companion extension/ folder once in Chrome/Edge, keep the browser open, run this with explicit domains and click Export in the extension popup; cookies are read through the browser's own cookies API and POSTed to a loopback receiver (token file: <stateDir>/login-extension-token). This works on modern Chrome/Edge (including Windows 127+ ABE). (2) source="chrome"|"edge"|"brave"|"auto" \u2014 the source browser must be closed; the tool copies only Local State + the Cookies DB to a throwaway profile and reads it headless. On Chrome/Edge 127+ (App-Bound Encryption) that copy reads 0 cookies and the tool reports it explicitly; the real profile is never booted or modified. dryRun=true reports what would be imported. The agent browser must be running (call ego_status first). Imported logins persist in the on-disk profile. Cookie values are never shown \u2014 only domain names and counts.`,
      parameters: {
        source: {
          type: "string",
          description: 'extension | chrome | edge | brave | auto (default: auto = first detected browser). Use "extension" for modern Chrome/Edge without closing it.'
        },
        domains: {
          type: "json",
          description: 'Optional array of domains to import, e.g. ["bilibili.com","zhihu.com"] (subdomains included). Omit = ALL cookies \u2014 prefer an explicit list.'
        },
        profile: {
          type: "string",
          description: 'Source browser profile directory name, e.g. "Default" or "Profile 1" (default: the first profile).'
        },
        closeSource: {
          type: "boolean",
          description: "A running source browser holds an exclusive lock on its cookie store (Windows). true = gracefully close it first (its windows/tabs restore on next launch). false (default) = return an actionable error instead."
        },
        dryRun: {
          type: "boolean",
          description: "true = only report what would be imported (domains + cookie counts), write nothing."
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            source: { type: "string" },
            profile: { type: "string" },
            dryRun: { type: "boolean" },
            totalRead: { type: "integer" },
            matched: { type: "integer" },
            written: { type: "integer" },
            domains: { type: "json" },
            closedSource: { type: "boolean" },
            disabled: { type: "boolean" },
            error: { type: "string" }
          }
        },
        render: renderText
      },
      timeoutMs: 18e4,
      execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_login_import", args, async () => {
        try {
          const domains = Array.isArray(args.domains) ? args.domains.map(String) : void 0;
          const source = typeof args.source === "string" && args.source !== "" ? args.source : "auto";
          if (!["chrome", "edge", "brave", "auto", "extension"].includes(source)) {
            return { ok: false, error: `invalid source "${source}" \u2014 expected chrome|edge|brave|auto|extension` };
          }
          if (source === "extension") {
            return await importLoginCookiesFromExtension({
              domains,
              dryRun: args.dryRun === true,
              timeoutMs: 12e4
            });
          }
          const guardBinary = cfg.chromePath || findChromeBinary();
          const policy = loginImportPolicy({
            platform: process.platform,
            chromeMajor: detectChromeMajorVersion(guardBinary),
            force: loginImportForced()
          });
          if (!policy.allowed) {
            return {
              ok: false,
              disabled: true,
              error: `ego_login_import is disabled here: ${policy.reason}`
            };
          }
          return await importLoginCookies(
            {
              source,
              domains,
              profile: typeof args.profile === "string" && args.profile !== "" ? args.profile : void 0,
              closeSource: args.closeSource === true,
              dryRun: args.dryRun === true
            },
            { subprocess: ctx.subprocess }
          );
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      })),
      presentCall: (args) => ({
        card: "generic",
        title: toolCallTitle("ego_login_import", args),
        kind: "other",
        rawInput: null
      })
    })
  );
}
function registerActionTools(ctx, cfg, reg) {
  const t = (opts) => defineEgoTool(ctx, cfg, {
    ...opts,
    afterExecute: (args, result) => {
      if (!result || result.ok === false) return;
      if (opts.name === "ego_space_open") {
        cfg.spaceTracker.opened(args, result);
      } else if (opts.name === "ego_space_close") {
        cfg.spaceTracker.closed(args.name, result.done);
      } else if (args && args.space !== void 0 && args.space !== "") {
        cfg.spaceTracker.selected(args.space);
      }
      opts.afterExecute?.(args, result);
    }
  });
  const spaceParam = {
    type: "string",
    description: "Task-space name or numeric id. Omit to use this session\u2019s own space (dsh-agent-<session>) when session-scoped spaces are on (default), otherwise the most recently opened or explicitly selected space."
  };
  reg(
    t({
      name: "ego_space_open",
      get description() {
        return cfg.isolateSpaces ? "Open (or reuse) an ego-lite task space in isolated sandbox mode." : "Open (or reuse) the ego-lite task space. In persistent profile mode (default), ALWAYS use or reuse the single 'default' space. Login credentials automatically persist on disk across restarts \u2014 if a page requires login, prompt user to log in manually in the opened window. DO NOT create numbered spaces like #4, #5.";
      },
      parameters: {
        name: {
          type: "string",
          required: true,
          get description() {
            return cfg.isolateSpaces ? "Task-space name or numeric id." : "Task-space name. In persistent mode, ALWAYS specify 'default'. Reuse this single space for all browsing tasks.";
          }
        }
      },
      buildScript: (args) => `${useSpace(str(args.name, cfg.defaultSpace))}console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(
        str(args.name, cfg.defaultSpace)
      )} }))
`
    })
  );
  reg(
    t({
      name: "ego_space_close",
      get description() {
        return cfg.isolateSpaces ? "Complete (close) an ego-lite task space in sandbox mode." : "Close an ego-lite task space. WARNING: In persistent profile mode, DO NOT call this tool when finishing tasks! Keep the space, tabs, and browser window alive so login sessions and streams remain intact. Conclude tasks by replying to the user directly without closing the space.";
      },
      parameters: {
        name: {
          type: "string",
          required: true,
          description: "Task-space name or numeric id to close."
        },
        keep: {
          type: "boolean",
          description: "Keep the live page open (default false: close it)."
        }
      },
      buildScript: (args) => `const res = await taskSpaces.complete(${j(
        str(args.name, cfg.defaultSpace)
      )}, { keep: ${bool(args.keep, false)} })
console.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j(
        "target space was not agent-owned"
      )} : null }))
`
    })
  );
  reg(
    t({
      name: "ego_snapshot",
      description: "Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.",
      parameters: {
        space: spaceParam,
        scope: {
          type: "string",
          description: "snapshot scope: 'full_page' (default) or 'only_within_viewport'."
        }
      },
      buildScript: (args) => {
        const scope = str(args.scope, "");
        const call = scope === "" ? "await page.snapshotRaw()" : `await page.snapshotRaw({ scope: ${j(scope)} })`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}let s = ${call}
let tries = 0
while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }
const text = s.content ?? ''
console.log('${SENTINEL}' + JSON.stringify(text === ''
  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }
  : { ok: true, text, tries }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_navigate",
      description: "Open a URL in the task space, or switch to the existing tab for it. Always prefer reusing existing open tabs before opening duplicate URLs. Waits for document load. Returns resulting page info.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Absolute URL to open, e.g. https://example.com/path."
        },
        wait: {
          type: "boolean",
          description: "Wait for document load (default true)."
        },
        timeout: {
          type: "number",
          description: "Load wait timeout in ms (default 20000)."
        },
        tab: tabParam,
        space: spaceParam
      },
      buildScript: (args) => {
        const u = str(args.url, "");
        if (u === "") {
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'ego_navigate: url is required' }))
`;
        }
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab(str(args.tab, ""))}const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(
          u.split("#")[0]
        )})
const tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(
          u
        )}, { wait: ${bool(args.wait, true)}, timeout: ${num(
          args.timeout,
          2e4
        )} })
const pginfo = await page.info()
console.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_click",
      description: "Click an element in the current page. Target with a CSS selector, an xpath=.../loc=.../ref=N value from ego_snapshot, or viewport coordinates.",
      parameters: {
        selector: {
          type: "string",
          description: "CSS selector, xpath=..., loc=..., or ref=N from the snapshot. Required unless x/y are given."
        },
        x: {
          type: "number",
          description: "Viewport x coordinate for a coordinate click."
        },
        y: {
          type: "number",
          description: "Viewport y coordinate for a coordinate click."
        },
        label: {
          type: "string",
          description: 'Short human label for the action, e.g. "click submit button".'
        },
        double: {
          type: "boolean",
          description: "Double-click instead of single-click. Useful for opening files/rows or triggering dblclick handlers."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const x = args.x;
        const y = args.y;
        if (sel === "" && !(typeof x === "number" && typeof y === "number")) {
          throw new Error(
            "ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates"
          );
        }
        const dbl = bool(args.double, false);
        let action;
        if (sel !== "") {
          action = cssPierceFallback(dbl ? "dblclick" : "click", sel, str(args.label, ""));
        } else {
          action = dbl ? `await page.mouse.dblclick(${x}, ${y})` : `await page.mouse.click(${x}, ${y})`;
        }
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${action}
const pginfo = await page.info()
console.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_fill",
      description: "Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=N from ego_snapshot.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector, xpath=..., loc=..., or ref=N for the input."
        },
        text: {
          type: "string",
          required: true,
          description: "Text to type into the field."
        },
        space: spaceParam
      },
      buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).fill(${j(
        str(args.text, "")
      )})
const pginfo = await page.info()
console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))
`
    })
  );
  reg(
    t({
      name: "ego_js",
      description: `Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. "document.title", "document.querySelectorAll('a').length").`,
      parameters: {
        expression: {
          type: "string",
          required: true,
          description: "JavaScript expression string to evaluate in the page."
        },
        space: spaceParam
      },
      buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = await page.evaluate(${j(str(args.expression, ""))})
console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))
`
    })
  );
  reg(
    t({
      name: "ego_cdp",
      description: 'Issue a raw CDP command on the page target, e.g. cdp("Page.handleJavaScriptDialog", { accept: true }).',
      parameters: {
        method: {
          type: "string",
          required: true,
          description: "CDP method name, e.g. Page.handleJavaScriptDialog."
        },
        params: {
          type: "object",
          additionalProperties: true,
          description: "CDP method parameters object."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const params = args.params;
        const call = params !== void 0 && params !== null ? `await cdp(${j(str(args.method, ""))}, ${j(params)})` : `await cdp(${j(str(args.method, ""))})`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = ${call}
console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_screenshot",
      description: "Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.",
      parameters: {
        selector: {
          type: "string",
          description: "Optional CSS selector of an element to screenshot instead of the whole page."
        },
        path: {
          type: "string",
          description: "Optional absolute output path for the PNG."
        },
        deliver: {
          type: "boolean",
          description: "Surface the PNG as a deliverable card in the conversation (default true). Set false to keep it a bare path."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const pth = str(args.path, "");
        const shot = sel !== "" ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ""})` : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const path = ${shot}
console.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))
`;
      },
      deliverFiles: (args, value) => {
        const file = value?.path;
        if (args.deliver === false || typeof file !== "string" || file === "") return [];
        const selector = str(args.selector, "");
        return [{ path: file, description: selector === "" ? "Screenshot" : `Screenshot of ${selector}` }];
      }
    })
  );
  reg(
    t({
      name: "ego_page_info",
      description: "Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` \u2014 whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).",
      parameters: {
        space: spaceParam
      },
      buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const pginfo = await page.info()
let __hc = null
try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }
console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))
`
    })
  );
  reg(
    t({
      name: "ego_tabs",
      description: "List, switch, open, or close agent-browser tabs. Use it to keep tab hygiene: list the open pages, switch to one, open a new tab for a URL, or close scratch tabs. Tab ids are stable target ids (also returned by ego_space_open / ego_navigate).",
      parameters: {
        action: {
          type: "string",
          description: "'list' (default) | 'switch' | 'open' | 'close'."
        },
        targetId: {
          type: "string",
          description: "Tab target id for action=switch / action=close."
        },
        url: {
          type: "string",
          description: "URL for action=open (default: 'about:blank')."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const action = str(args.action, "list");
        const targetId = str(args.targetId, "");
        const url = str(args.url, "");
        const space = useSpace(str(args.space, cfg.defaultSpace));
        const done = (extra) => `const __tabs = await browser.listTabs()
console.log('${SENTINEL}' + JSON.stringify({ ok: true${extra}, tabs: __tabs }))
`;
        const fail = (message) => `console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: ${j(message)} }))
`;
        const guard = (expr, missing, body) => `${space}if (${expr}) {
${fail(`runtime capability missing: ${missing}; use the bundled runtime or extend your bridge with it`)}} else {
${body}}
`;
        const noBrowser = (cap) => `typeof browser === 'undefined' || typeof browser.${cap} !== 'function'`;
        const knownTabs = `const __pre = await browser.listTabs()
const __openIds = __pre.map(t => t.targetId).join(', ') || 'none'
`;
        const withKnownTarget = (target, body) => `if (!__pre.some(t => t.targetId === ${target})) {
  console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: 'targetId ' + ${target} + ' is not open in this task space (open ids: ' + __openIds + '); call action=list and reuse one of them' }))
} else {
${body}}
`;
        if (action === "switch") {
          if (!targetId) return `${space}${fail("targetId is required for action=switch")}`;
          return guard(
            `${noBrowser("switchTab")} || ${noBrowser("listTabs")}`,
            "browser.switchTab / browser.listTabs",
            `${knownTabs}${withKnownTarget(j(targetId),
              `await browser.switchTab(${j(targetId)})
${done(`, switched: ${j(targetId)}`)}`)}`
          );
        }
        if (action === "open") {
          return guard(
            `${noBrowser("listTabs")} || typeof ego === 'undefined' || typeof ego.createTab !== 'function'`,
            "ego.createTab / browser.listTabs",
            `let __created = null
try { __created = await ego.createTab(${j(url || "about:blank")}) } catch (__openErr) {
  console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: 'could not open a tab: ' + String((__openErr && __openErr.message) || __openErr) }))
}
if (__created) {
${done(`, created: __created && __created.targetId || null`)}}
`
          );
        }
        if (action === "close") {
          if (!targetId) return `${space}${fail("targetId is required for action=close")}`;
          return guard(
            `${noBrowser("closeTab")} || ${noBrowser("listTabs")}`,
            "browser.closeTab / browser.listTabs",
            `${knownTabs}${withKnownTarget(j(targetId),
              `await browser.closeTab(${j(targetId)})
${done(`, closed: ${j(targetId)}`)}`)}`
          );
        }
        if (action !== "list") return `${space}${fail(`unknown action: ${action}`)}`;
        return guard(noBrowser("listTabs"), "browser.listTabs", `${done("")}`);
      },
      // Tab switches must move the per-space cursor too, otherwise the next
      // page tool would re-pin the tab this call just left.
      afterExecute: (args, value) => {
        const v = value;
        const target = str(v?.switched, "") || str(v?.created, "");
        if (target !== "") {
          cfg.targetTracker.set(
            scopedTargetKey(currentSessionId(), str(args.space, cfg.defaultSpace)),
            target
          );
        }
      }
    })
  );
  reg(
    t({
      name: "ego_wait",
      description: "Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate's wait option.",
      parameters: {
        ms: {
          type: "number",
          required: true,
          description: "Milliseconds to wait."
        }
      },
      buildScript: (args) => `await page.waitForTimeout(${Math.max(0, num(args.ms, 1e3))})
console.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(
        0,
        num(args.ms, 1e3)
      )} }))
`
    })
  );
  reg(
    t({
      name: "ego_wait_for_selector",
      description: "Wait until an element matching a CSS selector appears (state=visible, default) or disappears (state=hidden). Use instead of a blind fixed wait when a page renders asynchronously.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the element to wait for, e.g. '.results' or '[data-id=done]'."
        },
        state: {
          type: "string",
          description: "Target state: 'visible' (default) | 'attached' | 'hidden' | 'detached'."
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000)."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.selector, "").trim();
        if (sel === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, waited: false, reason: 'ego_wait_for_selector: selector is required' }))
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.waitForSelector(${j(sel)}, { state: ${j(
          str(args.state, "visible")
        )}, timeout: ${num(args.timeout, 1e4)} })
console.log('${SENTINEL}' + JSON.stringify({ ok: true, waited: true, selector: ${j(
          sel
        )}, state: ${j(str(args.state, "visible"))} }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_wait_for_url",
      description: 'Wait until the page navigates to a URL matching a substring / glob / regex. Use to catch login redirects or pagination. IMPORTANT: it only observes navigations that happen DURING this call \u2014 if the navigation already finished in a previous ego_* call, read ego_page_info instead. Matching is Playwright semantics: a full URL or a ** glob ("**/search**"); a bare substring does not match. The result always carries the current URL.',
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description: "URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/)."
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000)."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const p = str(args.pattern, "").trim();
        if (p === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, reason: 'ego_wait_for_url: pattern is required' }))
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __u0 = await page.url()
const __p = ${j(p)}
const __isPattern = /[*?[\\\\]]/.test(__p) || __p.startsWith('/')
const __already = !__isPattern && __u0.includes(__p)
const __ok = __already || await page.waitForURL(__p, { timeout: ${num(
          args.timeout,
          1e4
        )} }).catch(() => false)
const __u = await page.url()
console.log('${SENTINEL}' + JSON.stringify({ ok: !!__ok, reached: !!__ok, url: __u, matchedCurrent: __already, hint: __ok ? undefined : 'waitForURL only sees FUTURE navigations: issue the wait in the same ego_script as the action that navigates, and pass a full URL or a ** glob (a bare substring does not match).' }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_wait_for_response",
      description: 'Wait for a network response matching a URL/glob/regex and return it. Optionally return the body (text or JSON) \u2014 ideal for scraping API responses or confirming a submission. By default it also matches responses that already finished during the CURRENT document load (includeBuffered), because "wait for the response of the page I just opened" is the common case; set includeBuffered=false for strict future-only semantics. Across separate ego_* calls only future responses can be seen \u2014 trigger the request and the wait in the same ego_script. On timeout the result carries the current URL and a hint instead of throwing.',
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "URL/glob/regex to match, e.g. '/api/search' or 'https://*.com/data'."
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000)."
        },
        body: {
          type: "string",
          description: "Return the response body: 'none' (default) | 'text' | 'json'."
        },
        includeBuffered: {
          type: "boolean",
          description: "Also match responses that already completed during the current document load (default true). Set false to wait only for future responses."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const u = str(args.url, "").trim();
        const mode = str(args.body, "none");
        const wantBody = mode === "text" || mode === "json";
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}let __res = null, __err = null
try { __res = await page.waitForResponse(${j(u)}, { timeout: ${num(
          args.timeout,
          1e4
        )}, includeBuffered: ${bool(args.includeBuffered, true)} }) } catch (e) { __err = String(e && e.message || e) }
if (!__res) {
  const __u = await page.url().catch(() => null)
  console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, url: __u, error: __err, hint: 'no matching response arrived during this call. Include the wait in the same ego_script as the request; a cached response produces no network event (add a cache-busting query); the url pattern is a full URL or glob/regex, not a bare substring.' }))
} else {
${wantBody ? `  const __body = ${mode === "json" ? "await __res.json().catch(()=>null)" : "await __res.text().catch(()=>null)"}
` : ""}  console.log('${SENTINEL}' + JSON.stringify({ ok: true, reached: true, url: __res.url(), status: __res.status()${wantBody ? ", body: __body" : ""} }))
}
`;
      }
    })
  );
  reg(
    t({
      name: "ego_key",
      description: "Press a keyboard key or shortcut combination on the current page, e.g. 'Enter', 'Tab', 'Control+a', 'Escape', 'ArrowDown'. Useful for forms, shortcuts and navigation. Pass `text` to type a string of characters instead (keyboard.type).",
      parameters: {
        key: {
          type: "string",
          description: "Key or combo: 'Enter', 'Tab', 'Control+c', 'Meta+v', 'ArrowDown', 'Escape', 'F5', etc. (ignored when `text` is given)."
        },
        text: {
          type: "string",
          description: "Type this text character-by-character (keyboard.type). Use instead of `key` for typing words into the focused element."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const txt = str(args.text, "");
        const k = str(args.key, "").trim();
        if (txt !== "") {
          return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.type(${j(txt)})
console.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))
`;
        }
        if (k === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_key: provide key or text to type' }))
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.press(${j(k)})
console.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_hover",
      description: "Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.",
      parameters: {
        selector: {
          type: "string",
          description: "CSS selector, xpath=..., loc=..., or ref=N for the element."
        },
        x: { type: "number", description: "Viewport x (only with y)." },
        y: { type: "number", description: "Viewport y (only with x)." },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const hasXY = typeof args.x === "number" && typeof args.y === "number";
        if (sel === "" && !hasXY)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_hover: provide selector or both x and y' }))
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + (sel !== "" ? `${cssPierceFallback("hover", sel, "")}
` : `await page.mouse.move(${args.x}, ${args.y})
`) + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_read_element",
      description: "Read a single element (by selector): its text, HTML, input value, an attribute, or visibility/enabled/count. Cheaper and more precise than a full-page snapshot.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the target element."
        },
        what: {
          type: "string",
          description: "What to read: 'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'."
        },
        attribute: {
          type: "string",
          description: "Attribute name when what=attribute."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.selector, "").trim();
        const what = str(args.what, "text");
        if (sel === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_read_element: selector is required' }))
`;
        const selExpr = `page.locator(${j(sel)})`;
        let expr;
        switch (what) {
          case "html":
            expr = `await ${selExpr}.innerHTML()`;
            break;
          case "value":
            expr = `await ${selExpr}.inputValue()`;
            break;
          case "attribute":
            expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ""))})`;
            break;
          case "visible":
            expr = `await ${selExpr}.isVisible()`;
            break;
          case "enabled":
            expr = `await ${selExpr}.isEnabled()`;
            break;
          case "count":
            expr = `await ${selExpr}.count()`;
            break;
          default:
            expr = `await ${selExpr}.textContent()`;
        }
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const __v = ${expr}
console.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(
          sel
        )}, value: safe(__v) }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_select",
      description: "Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the <select> element."
        },
        value: {
          type: "json",
          description: "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select."
        },
        space: spaceParam
      },
      buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + selectOptionScript(str(args.selector, ""), args.value ?? "")
    })
  );
  reg(
    t({
      name: "ego_drag",
      description: "Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.",
      parameters: {
        from: {
          type: "string",
          description: "CSS selector of the element to drag from."
        },
        to: {
          type: "string",
          description: "CSS selector of the drop target (used with from)."
        },
        points: {
          type: "array",
          items: { type: "number" },
          description: "Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const pts = Array.isArray(args.points) ? args.points.map(Number).filter((n) => Number.isFinite(n)) : [];
        const hasEl = str(args.from, "") !== "" && str(args.to, "") !== "";
        if (!hasEl && pts.length < 4)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))
`;
        const action = hasEl ? `await page.locator(${j(str(args.from, ""))}).dragTo(page.locator(${j(
          str(args.to, "")
        )}))
` : `const __pts = ${j(pts)}
const __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}
await page.mouse.drag(__coords)
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_scroll",
      description: "Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).",
      parameters: {
        deltaX: { type: "number", description: "Horizontal scroll delta (wheel) in px." },
        deltaY: { type: "number", description: "Vertical scroll delta (wheel) in px." },
        selector: {
          type: "string",
          description: "CSS selector to scroll into view (primary if given)."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const hasSelector = str(args.selector, "") !== "";
        const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY);
        if (!hasSelector && !hasDelta)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_scroll: provide deltaX/deltaY or a selector' }))
`;
        const action = hasSelector ? `await page.locator(${j(str(args.selector, ""))}).scrollIntoViewIfNeeded()
` : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(
          args.deltaY,
          300
        )})
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `const __p = await page.info()
console.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_upload",
      description: "Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the <input type=file> element."
        },
        path: {
          type: "string",
          required: true,
          description: "Absolute path of the file(s) to upload on this machine."
        },
        space: spaceParam
      },
      buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).setInputFiles(${j(
        str(args.path, "")
      )})
console.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(
        str(args.selector, "")
      )} }))
`
    })
  );
  reg(
    t({
      name: "ego_download",
      description: "Wait for a file download triggered by the current action, then return its saved path. Provide `triggerSelector` (a download button/link to click) or `triggerScript` (arbitrary JS that triggers the download). The file is captured into a temp dir and (optionally) copied to `savePath`. Returns { path, suggestedFilename, url }.",
      parameters: {
        triggerSelector: {
          type: "string",
          description: "CSS selector of the element (button/link) whose click starts the download."
        },
        triggerScript: {
          type: "string",
          description: "Full JS snippet that triggers the download (e.g. window.open() or a fetch-to-blob download); runs in the page before waiting for the download."
        },
        savePath: {
          type: "string",
          description: "Optional absolute destination path to also copy the downloaded file to. Otherwise only the temp-captured path is returned."
        },
        timeout: {
          type: "number",
          description: "How long to wait for the download in ms (default 30000)."
        },
        deliver: {
          type: "boolean",
          description: "Surface the downloaded file as a deliverable card in the conversation (default true). Set false to keep it a bare path."
        },
        space: spaceParam
      },
      buildScript: (args) => {
        const sel = str(args.triggerSelector, "");
        const script = str(args.triggerScript, "");
        const savePath = str(args.savePath, "");
        const timeout = num(args.timeout, 3e4);
        const trigger = sel !== "" ? `await page.locator(${j(sel)}).click()
` : script !== "" ? `await page.evaluate(() => { ${script} })
` : "/* no trigger given \u2014 the download may be started by an earlier navigation */\n";
        const save = savePath !== "" ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)
` : `const __final = await __dl.path().catch(()=>null)
`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })
` + trigger + `const __dl = await __dlPromise
const __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null
const __url = typeof __dl.url === 'function' ? __dl.url() : null
` + save + `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))
`;
      },
      deliverFiles: (args, value) => {
        const v = value;
        const file = v?.path;
        if (args.deliver === false || typeof file !== "string" || file === "") return [];
        const name2 = typeof v?.suggestedFilename === "string" ? v.suggestedFilename : "";
        return [{ path: file, description: name2 === "" ? "Download" : `Download: ${name2}` }];
      }
    })
  );
  reg(
    t({
      name: "ego_check",
      description: "Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.",
      parameters: {
        selector: { type: "string", required: true, description: "CSS selector of the checkbox/radio." },
        checked: { type: "boolean", description: "true=check (default), false=uncheck." },
        space: spaceParam
      },
      buildScript: (args) => {
        const chk = bool(args.checked, true);
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).${chk ? "check" : "uncheck"}()
console.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_dialog",
      description: 'Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. This tool only reaches a dialog that is blocking the page RIGHT NOW \u2014 a dialog fired by an earlier ego_* call has already been auto-dismissed across the call boundary. To accept a dialog triggered by a click, do both in one call: page.once("dialog", d => d.accept()); await page.click(selector). If a dialog is blocking the page, page.evaluate/snapshot calls hang until it is handled.',
      parameters: {
        accept: { type: "boolean", description: "true=Accept/OK (default), false=Dismiss/Cancel." },
        text: { type: "string", description: "Text to type into a prompt dialog." },
        space: spaceParam
      },
      buildScript: (args) => {
        const accept = bool(args.accept, true);
        const text = str(args.text, "");
        const params = `{ accept: ${accept}${text !== "" ? `, promptText: ${j(text)}` : ""} }`;
        return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))
const __ok = !!(__r && !__r.error)
let __u = null
if (!__ok) { try { __u = await page.url() } catch {} }
console.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null, url: __u, hint: __ok ? undefined : 'no dialog was blocking the page. Dialogs do not survive the call that triggered them \u2014 trigger and handle in one ego_script: page.once("dialog", d => d.accept()); await page.click(...)' }))
`;
      }
    })
  );
  reg(
    t({
      name: "ego_http",
      description: "Make an HTTP request and return status + body. Default runs in the agent page's browser context (cross-origin allowed when the server's CORS permits); set `mode: server` to use Node-side fetch.server. Use to scrape an API, POST data, or hit a service. (Note: on the vendored ego-linux Windows runtime, fetch.server can hit a libuv crash, so prefer the default browser mode there.)",
      parameters: {
        url: { type: "string", required: true, description: "Absolute URL to request." },
        method: { type: "string", description: "HTTP method, default GET." },
        headers: { type: "object", additionalProperties: true, description: "Request headers, e.g. { 'Content-Type': 'application/json' }." },
        body: { type: "string", description: "Request body (for POST/PUT)." },
        timeout: { type: "number", description: "Timeout in ms (default 20000)." },
        mode: { type: "string", description: "'browser' (default) runs via the page context; 'server' uses Node-side fetch.server." },
        space: spaceParam
      },
      buildScript: (args) => {
        const opts = {
          method: str(args.method, "GET"),
          headers: args.headers && typeof args.headers === "object" ? args.headers : {},
          timeout: num(args.timeout, 2e4)
        };
        if (str(args.body, "") !== "") opts.body = str(args.body, "");
        const mode = str(args.mode, "browser");
        const pre = mode === "server" ? "" : `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}`;
        return `${pre}${SAFE_FN}const __r = await fetch.${mode === "server" ? "server" : "browser"}(${j(
          str(args.url, "")
        )}, ${j(opts)})
const __status = typeof __r.status !== "undefined" ? __r.status : 200
let __body = null
try { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }
console.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(
          str(args.url, "")
        )} }))
`;
      }
    })
  );
  reg(
    (() => {
      const def = defineTool({
        name: "ego_cli",
        description: "Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim (facades page/browser/taskSpaces/site/fetch and the raw cdp() are preloaded). Use when the structured ego_* tools do not cover the task. Returns raw stdout plus the parsed console.log payload when present.",
        parameters: {
          script: {
            type: "string",
            required: true,
            description: "Full JS script body for the heredoc; ego-browser helpers are preloaded. End with console.log('@@DSH_RESULT@@' + JSON.stringify({...})) \u2014 the literal @@DSH_RESULT@@ sentinel is required. (A trailing plain JSON line is accepted as a fallback, with result.fallback=true.)"
          },
          tab: tabParam
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              stdout: { type: "string", required: true },
              stderr: { type: "string" },
              result: { type: "json" }
            }
          },
          render: renderText
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        execute: async (args, exec) => {
          const sessionId = callingSessionId(exec);
          pendingSessionId = sessionId;
          try {
            markEgoToolCall(sessionId);
            const result = await runWithStaleSpaceRetry(
              ctx,
              cfg,
              exec,
              () => rawScriptPrelude(cfg, str(args.tab, "")) + str(args.script, "")
            );
            if (!result.ok) throw new Error(result.error);
            recordPinnedTarget(
              cfg.targetTracker,
              scopedTargetKey(sessionId, cfg.defaultSpace),
              result.stdout
            );
            const stdout = stripTargetMarkers(result.stdout);
            const parsed = parseSentinel(stdout);
            return {
              ok: true,
              stdout,
              stderr: result.stderr,
              // result.value carries the plugin's fallback (last JSON line) when
              // the script forgot the sentinel — keep it visible here too (#71).
              result: parsed ?? result.value ?? null
            };
          } finally {
            pendingSessionId = void 0;
          }
        },
        presentCall: (args) => ({
          card: "generic",
          title: toolCallTitle("ego_cli", args),
          kind: "other",
          rawInput: null
        })
      });
      return def;
    })()
  );
}
function registerHelpAndDoctor(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_captcha",
      description: "Check the current page for a human-verification (CAPTCHA) challenge \u2014 reCAPTCHA / hCaptcha / Cloudflare / Turnstile \u2014 and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the 'ego lite - agent' browser window (it is the same live session shown in the watch panel), then continue after they have.",
      parameters: {
        space: { type: "string", description: "Task-space name or numeric id; defaults to the configured defaultSpace." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            detected: { type: "boolean", required: true },
            kind: { oneOf: [{ type: "string" }, { type: "null" }] }
          }
        },
        render: renderText
      },
      timeoutMs: 15e3,
      execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, "ego_captcha", args, async () => {
        markEgoToolCall(callingSessionId(exec));
        const result = await runWithStaleSpaceRetry(
          ctx,
          cfg,
          { signal: exec?.signal },
          () => humanCheckScript(str(args.space, cfg.defaultSpace))
        );
        if (!result.ok)
          return { ok: false, detected: false, kind: null, error: result.error };
        const p = parseSentinel(result.stdout) || {};
        const hc = p.humanCheck;
        return {
          ok: true,
          detected: !!hc?.detected,
          kind: hc?.kind ?? null
        };
      })),
      presentCall: (args) => ({ card: "generic", title: toolCallTitle("ego_captcha", args), kind: "other", rawInput: null })
    })
  );
  reg(
    defineTool({
      name: "ego_wait_for_human",
      description: 'Hand the page to the human for a CAPTCHA / login / 2FA / confirmation, then wait until it is cleared. Say what you need in the conversation FIRST ("solve the challenge in the agent browser window, I will wait"), then call this. It polls the page until the challenge disappears \u2014 and, when `selector` is given, until that selector exists \u2014 returning { needed, resolved, waitedMs }. A timeout is not an error: resolved=false means "still not done", so report back and call again. This is a deliberate blocking wait; do not route it through approval flows, which auto-reject under policy "never".',
      parameters: {
        reason: {
          type: "string",
          description: "Why the wait is needed: captcha | login | 2fa | confirm (free text is fine)."
        },
        timeoutSec: {
          type: "number",
          description: "How long to wait in seconds (default 60, clamped to 5\u2013110)."
        },
        pollMs: {
          type: "number",
          description: "Polling interval in ms (default 1500, clamped to 250\u201310000)."
        },
        selector: {
          type: "string",
          description: "Optional selector that must also exist before returning (e.g. a post-login element). Omitting it waits only for the challenge to clear."
        },
        space: { type: "string", description: "Task-space name or numeric id; defaults to this session\u2019s space." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            needed: { type: "boolean", required: true },
            resolved: { type: "boolean", required: true },
            waitedMs: { type: "number", required: true }
          }
        },
        render: renderText
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, "ego_wait_for_human", args, async () => {
        {
          markEgoToolCall(callingSessionId(exec));
          const timeoutMs = Math.min(11e4, Math.max(5e3, num(args.timeoutSec, 60) * 1e3));
          const pollMs = Math.min(1e4, Math.max(250, num(args.pollMs, 1500)));
          const selector = str(args.selector, "");
          const spaceKey = String(str(args.space, cfg.defaultSpace));
          const build = () => {
            pendingTargetPin = cfg.targetTracker.get(spaceKey);
            pendingViewport = cfg;
            try {
              return waitForHumanScript(str(args.space, cfg.defaultSpace), {
                timeoutMs,
                pollMs,
                selector
              });
            } finally {
              pendingTargetPin = void 0;
              pendingViewport = void 0;
            }
          };
          const result = await runWithStaleSpaceRetry(ctx, cfg, exec, build);
          if (!result.ok) {
            return {
              ok: false,
              needed: true,
              resolved: false,
              waitedMs: 0,
              reason: str(args.reason, "confirm"),
              error: result.error
            };
          }
          recordPinnedTarget(cfg.targetTracker, spaceKey, result.stdout);
          const p = parseSentinel(result.stdout) || {};
          const resolved = !!p.resolved;
          return {
            ok: true,
            needed: !!p.needed,
            resolved,
            waitedMs: typeof p.waitedMs === "number" ? p.waitedMs : 0,
            polls: typeof p.polls === "number" ? p.polls : 0,
            detected: !!p.detected,
            kind: p.kind ?? null,
            url: p.url ?? null,
            reason: str(args.reason, "confirm"),
            ...resolved ? {} : {
              hint: "still waiting after the timeout. Make sure the user knows which window to use (the agent browser window / watch panel), say what to click, then call ego_wait_for_human again."
            }
          };
        }
      })),
      presentCall: (args) => ({ card: "generic", title: toolCallTitle("ego_wait_for_human", args), kind: "other", rawInput: null })
    })
  );
  reg(
    defineTool({
      name: "ego_help",
      description: "Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. ego_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use.",
      parameters: {
        topic: {
          type: "string",
          description: "Category or tool name to look up; omitted/all returns the overview index."
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            topic: { type: "string", required: true },
            text: { type: "string", required: true }
          }
        },
        render: renderText
      },
      timeoutMs: 1e4,
      execute: async (args) => {
        const q = str(args.topic, "").trim().toLowerCase();
        const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : "";
        const text = key ? EGO_HELP_INDEX[key] : q ? `\u672A\u627E\u5230 topic "${q}"\u3002\u53EF\u7528: ` + Object.keys(EGO_HELP_INDEX).filter((k) => k !== "overview").join(", ") + "\n\noverview: " + EGO_HELP_INDEX.overview : EGO_HELP_INDEX.overview;
        return { ok: true, topic: q || "overview", text };
      },
      presentCall: (args) => ({ card: "generic", title: toolCallTitle("ego_help", args), kind: "other", rawInput: null })
    })
  );
  reg(
    defineTool({
      name: "ego_doctor",
      description: "Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, report: { type: "string", required: true } }
        },
        render: renderText
      },
      timeoutMs: 25e3,
      execute: async () => {
        const lines = [];
        lines.push(`egoBin: ${cfg.egoBin}`);
        try {
          lines.push(`egoBin exists: ${existsSync2(cfg.egoBin)}`);
        } catch {
          lines.push("egoBin exists: n/a");
        }
        const egoBinCheck = validateEgoBinPath(cfg.egoBin);
        lines.push(`egoBin kind: ${egoBinCheck.ok ? "node-script" : "invalid"}`);
        if (!egoBinCheck.ok) lines.push(`egoBin warning: ${egoBinCheck.reason}`);
        const chrome = findChromeBinary();
        const configured = cfg.chromePath;
        if (configured) {
          lines.push(`browser binary: ${configured} (from settings)`);
        } else {
          lines.push(`browser binary: ${chrome || "(none found \u2014 set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave; on Termux/Android: pkg install chromium)"}`);
        }
        const cliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
        const chrArgs = filterArgs(cfg.chromeArgs ?? "", CHROME_BLOCKED);
        lines.push(`egoCliArgs (effective): ${cliArgs.length ? cliArgs.join(" ") : "(none)"}`);
        lines.push(`chromeArgs (effective, next cold start): ${chrArgs.length ? chrArgs.join(" ") : "(none)"}`);
        const isWin = process.platform === "win32";
        const e = process.env;
        const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir2());
        const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
        lines.push(`state dir: ${stateDir} (exists: ${existsSync2(stateDir)})`);
        const bjson = `${stateDir}/browser.json`;
        let browserReport = "browser.json: (none \u2014 agent browser not running)";
        if (existsSync2(bjson)) {
          try {
            const { readFile: readFile4 } = await import("node:fs/promises");
            const b = JSON.parse(await readFile4(bjson, "utf8"));
            const alive = b.pid ? await (async () => {
              try {
                process.kill(b.pid, 0);
                return true;
              } catch (x) {
                return x?.code === "EPERM";
              }
            })() : false;
            browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`;
          } catch (err) {
            browserReport = `browser.json: unreadable (${err?.message})`;
          }
        }
        lines.push(browserReport);
        const tjson = `${stateDir}/task-spaces.json`;
        if (existsSync2(tjson)) {
          try {
            const { readFile: readFile4 } = await import("node:fs/promises");
            const t = JSON.parse(await readFile4(tjson, "utf8"));
            lines.push(`task spaces: ${(t.spaces || []).length}`);
          } catch {
          }
        }
        lines.push("headless override: " + (e.EGO_LINUX_HEADLESS ? "yes (" + e.EGO_LINUX_HEADLESS + ")" : "no"));
        lines.push("npm/node: " + process.version);
        return { ok: true, report: lines.join("\n") };
      },
      presentCall: (args) => ({ card: "generic", title: toolCallTitle("ego_doctor", args), kind: "other", rawInput: null })
    })
  );
  reg(
    (() => {
      const def = defineTool({
        name: "ego_script",
        description: "Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (same runtime/API as ego_cli: page/\u2026locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script. NOTE: `page` is the ego runtime page facade, NOT Playwright \u2014 it has goto/reload/info/url/title/locator/getBy*/waitFor*/evaluate/screenshot/snapshot/drainEvents/keyboard/mouse but no fill/click/type/press; use ego_fill/ego_click or page.locator(...). page.goto() does not return a Playwright Response; get status via ego_wait_for_response or page.info().",
        parameters: {
          script: {
            type: "string",
            required: true,
            description: "Full JS script body; end with console.log('@@DSH_RESULT@@' + JSON.stringify({...})) \u2014 the literal @@DSH_RESULT@@ sentinel is required. (A trailing plain JSON line is accepted as a fallback, with result.fallback=true.)"
          },
          timeoutMs: { type: "integer", description: "Per-run timeout in ms (default plugin grace)." },
          tab: tabParam
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              stdout: { type: "string", required: true },
              stderr: { type: "string" },
              result: { type: "json" },
              durationMs: { type: "integer" },
              timedOut: { type: "boolean" },
              error: { type: "string" }
            }
          },
          render: renderText
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        execute: async (args, exec) => {
          const sessionId = callingSessionId(exec);
          pendingSessionId = sessionId;
          try {
            markEgoToolCall(sessionId);
            const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : void 0;
            const start = Date.now();
            const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => rawScriptPrelude(cfg, str(args.tab, "")) + str(args.script, ""), timeoutMs);
            const durationMs = Date.now() - start;
            if (!result.ok)
              return {
                ok: false,
                stdout: stripTargetMarkers(result.stdout),
                stderr: result.stderr,
                durationMs,
                timedOut: false,
                error: result.error
              };
            recordPinnedTarget(
              cfg.targetTracker,
              scopedTargetKey(sessionId, cfg.defaultSpace),
              result.stdout
            );
            const stdout = stripTargetMarkers(result.stdout);
            const parsed = parseSentinel(stdout);
            return {
              ok: true,
              stdout,
              stderr: result.stderr,
              // result.value carries the plugin's fallback (last JSON line) when
              // the script forgot the sentinel — keep it visible here too (#71).
              result: parsed ?? result.value ?? null,
              durationMs,
              timedOut: false
            };
          } finally {
            pendingSessionId = void 0;
          }
        },
        presentCall: (args) => ({ card: "generic", title: toolCallTitle("ego_script", args), kind: "other", rawInput: null })
      });
      return def;
    })()
  );
}
export {
  Config2 as Config,
  apply,
  createActiveSpaceTracker,
  createSessionScopedSpaceTracker,
  createTargetTracker,
  currentSessionId,
  deliverToSession,
  detectChromeMajorVersion,
  ensureRealTab,
  ensureResidentTransport,
  findChromeBinary,
  inject,
  isColdStartError,
  loginImportForced,
  loginImportPolicy,
  name,
  parseSentinelOrLastJson,
  rawScriptPrelude,
  recordPinnedTarget,
  resetResidentTransportForTests,
  residentDiagnostics,
  resolveEgoEnv,
  runWithStaleSpaceRetry,
  scopedTargetKey,
  selectOptionScript,
  shouldReapBrowser,
  spaceNameForSession,
  stripTargetMarkers,
  superviseResidentFailure,
  tabParam,
  viewportPrelude,
  waitForHumanScript
};
