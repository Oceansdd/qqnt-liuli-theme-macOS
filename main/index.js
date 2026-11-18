// 琉璃主题插件 · 主进程侧
// 负责：日志、自己的 uid（给 @ 高亮区分 @我 / @别人）、诊断包导出（main/diag.js）。
// 功能性的东西（防撤回、复读、引用不带 @、记住位置）都在 qq-enhance 插件里。
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const SLUG = "liuli-dsh-theme";
const LOG = path.join(LiteLoader.path.data, SLUG, "plugin.log");
const LOG_MAX_BYTES = 256 * 1024;   // plugin.log 单文件上限，与 diag 的 session.log 同一口径

/** 写满了就把 plugin.log 滚到 plugin.1.log，避免长期使用后无限增长 */
function rotateLog() {
    try {
        const old = LOG.slice(0, -4) + ".1.log";
        try { fs.unlinkSync(old); } catch (e) {}
        fs.renameSync(LOG, old);
    } catch (e) {}
}

function log(message) {
    try {
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        const line = new Date().toISOString() + " " + message + "\n";
        try {
            if (fs.statSync(LOG).size + Buffer.byteLength(line) > LOG_MAX_BYTES) rotateLog();
        } catch (e) { /* 文件还不存在，直接写 */ }
        fs.appendFileSync(LOG, line);
    } catch (e) {}
}

log("main loaded | liteloader=" + LiteLoader.versions.liteloader + " qqnt=" + LiteLoader.versions.qqnt);

/* ---------- 诊断（每次启动写 session.log + 注册导出 IPC） ----------
 * 契约见 installer/DIAG-COVERAGE.md 第三 / 3.1 / 3.4 节。
 * 任何一步失败都只记 plugin.log，绝不影响插件原有功能。 */
let diag = null;
try {
    const diagModule = require("./diag.js");
    diag = diagModule.createDiag({ ipcMain: ipcMain, electron: require("electron") });
} catch (e) {
    log("diag create failed: " + (e && e.message));
}

try {
    if (diag) {
        const info = diag.install({ ipcMain: ipcMain });
        log("diag installed | ipc=" + info.ipcRegistered + " session=" + (info.sessionLog || "?"));
    }
} catch (e) {
    log("diag install failed: " + (e && e.message));
    diag = null;
}

/* ---------- 「删掉整个数据目录 = 彻底重置」标记 ----------
 * 用户能看到的只有数据目录 <LiteLoader.path.data>/liuli-dsh-theme/，
 * 但布局 / 明暗 / 壁纸 / 字体等其实存在渲染进程的 localStorage 里，删目录清不掉。
 * 所以用一个标记文件判断"用户是不是把整个数据目录删了"：
 *   wipe = 标记文件不存在 且 config.json 也不存在
 * 老用户正常升级到这个版本时 config.json 一定在 → wipe=false，绝不清他们的 localStorage；
 * 只有真的把整个目录删了（或全新安装）才 wipe。全新安装 localStorage 本来就是空的，清了也无害。
 * 判定完立刻把标记补上（空文件），下次启动 markerExists=true，不会重复触发。 */
const LIULI_DATA_DIR = path.join(LiteLoader.path.data, SLUG);
const LIULI_INIT_MARKER = path.join(LIULI_DATA_DIR, ".liuli-init");
const LIULI_CONFIG_FILE = path.join(LIULI_DATA_DIR, "config.json");

function liuliFileExists(p) {
    try { return fs.existsSync(p); } catch (e) { return false; }
}

let liuliWipePending = false;
try {
    const markerExists = liuliFileExists(LIULI_INIT_MARKER);
    const configExists = liuliFileExists(LIULI_CONFIG_FILE);
    liuliWipePending = !markerExists && !configExists;
    try { fs.mkdirSync(LIULI_DATA_DIR, { recursive: true }); } catch (e) {}
    if (!markerExists) fs.writeFileSync(LIULI_INIT_MARKER, "", "utf8");
    log("reset marker | marker=" + (markerExists ? 1 : 0) + " config=" + (configExists ? 1 : 0) +
        " wipe=" + (liuliWipePending ? 1 : 0));
} catch (e) {
    log("reset marker failed: " + (e && e.message));
}

/* 只读接口：渲染进程启动最早期问一次，wipe=true 就先清 localStorage 再继续启动。
 * wipe 只交给第一个来取的窗口（取完即消费），否则后开的窗口会把先开窗口
 * 刚写回的设置又清一遍。 */
ipcMain.handle("LiteLoader.liuli.resetPending", () => {
    const wipe = liuliWipePending === true;
    liuliWipePending = false;
    return { wipe: wipe };
});


/* ---------- macOS 布局设置持久化兜底（不依赖 Chromium localStorage） ----------
 * 只接受布局/已发现菜单项两个已知结构，固定写入 data/liuli-dsh-theme/layout.json。
 * 先落同目录临时文件再原子替换，防止异常退出留下半截 JSON。 */
const LAYOUT_FILE = path.join(LIULI_DATA_DIR, "layout.json");
const LAYOUT_MAX_BYTES = 128 * 1024;
const LAYOUT_ARRAY_MAX = 300;

function layoutStrings(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, LAYOUT_ARRAY_MAX)
        .filter(item => typeof item === "string")
        .map(item => item.slice(0, 256));
}
function normalizeLayout(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const num = Number(value.barPinned);
    return {
        menuCompact: value.menuCompact === true,
        menuOrder: layoutStrings(value.menuOrder),
        barOrder: layoutStrings(value.barOrder),
        barPinned: Number.isFinite(num) ? Math.max(0, Math.min(6, Math.round(num))) : 1,
        navHidden: layoutStrings(value.navHidden),
        titlebar: value.titlebar === "native" ? "native" : "float",
        navPin: value.navPin === true
    };
}
function normalizeSeen(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
        menu: layoutStrings(value.menu),
        bar: layoutStrings(value.bar),
        nav: layoutStrings(value.nav)
    };
}
function readLayoutState() {
    try {
        if (!fs.existsSync(LAYOUT_FILE)) return { version: 1, layout: null, seen: null };
        if (fs.statSync(LAYOUT_FILE).size > LAYOUT_MAX_BYTES) throw new Error("layout.json too large");
        const data = JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1)
            throw new Error("invalid layout.json format");
        return { version: 1, layout: normalizeLayout(data.layout), seen: normalizeSeen(data.seen) };
    } catch (e) {
        log("layout load failed: " + (e && e.message));
        // 不自动覆盖损坏的文件；下次成功保存才会替换。
        return { version: 1, layout: null, seen: null };
    }
}
let layoutState = readLayoutState();
function writeLayoutState(next) {
    const json = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(json, "utf8") > LAYOUT_MAX_BYTES) throw new Error("layout state too large");
    fs.mkdirSync(LIULI_DATA_DIR, { recursive: true });
    const tmp = LAYOUT_FILE + ".tmp-" + process.pid;
    try {
        fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, LAYOUT_FILE);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}
ipcMain.handle("LiteLoader.liuli.layoutLoad", () => ({
    ok: true,
    layout: layoutState.layout,
    seen: layoutState.seen
}));
ipcMain.handle("LiteLoader.liuli.layoutSave", (_event, kind, value) => {
    if (kind !== "layout" && kind !== "seen") return { ok: false, error: "unsupported kind" };
    const normalized = kind === "layout" ? normalizeLayout(value) : normalizeSeen(value);
    if (!normalized) return { ok: false, error: "invalid payload" };
    const next = { ...layoutState, [kind]: normalized };
    try {
        writeLayoutState(next);
        layoutState = next;
        return { ok: true };
    } catch (e) {
        log("layout save failed (" + kind + "): " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});
// 给「恢复全部默认」扩展留接口；只删 layout.json，不影响其他插件数据。
ipcMain.handle("LiteLoader.liuli.layoutReset", () => {
    try {
        fs.rmSync(LAYOUT_FILE, { force: true });
        layoutState = { version: 1, layout: null, seen: null };
        return { ok: true };
    } catch (e) {
        log("layout reset failed: " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});


/* ---------- macOS 壁纸文件持久化：图片单独保存，元数据保持为小 JSON ----------
 * Chromium localStorage 可跨窗口共享，但 QQ 在 macOS 的部分会话退出后会丢失。
 * 本地存储结构：wallpaper.json + wallpaper-<sha256>.bin；只接受 data:image/...
 * 固定文件名，不接受客户端传来的文件路径，避免通过 IPC 任意读写。 */
const WP_CRYPTO = require("node:crypto");
const WALLPAPER_META_FILE = path.join(LIULI_DATA_DIR, "wallpaper.json");
const WALLPAPER_MAX_DATAURL_CHARS = 16 * 1024 * 1024;
const WALLPAPER_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const WALLPAPER_FILE_RE = /^wallpaper-[a-f0-9]{64}\.bin$/;

function wallpaperFit(fit) {
    return fit === "contain" || fit === "stretch" ? fit : "cover";
}
function wallpaperArea(area) {
    if (!area || typeof area !== "object") return null;
    const v = [area.x, area.y, area.w, area.h].map(Number);
    if (!v.every(Number.isFinite)) return null;
    if (v.some(n => n < 0 || n > 1) || v[0] + v[2] > 1.001 || v[1] + v[3] > 1.001) return null;
    return { x: v[0], y: v[1], w: v[2], h: v[3] };
}
function parseWallpaperInput(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid wallpaper state");
    const fit = wallpaperFit(data.fit);
    if (data.src == null || data.src === "") return { fit, area: null, image: null };
    if (typeof data.src !== "string" || data.src.length > WALLPAPER_MAX_DATAURL_CHARS)
        throw new Error("wallpaper dataURL too large or invalid");
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.src);
    if (!match) throw new Error("wallpaper must be a base64 JPEG/PNG/WebP dataURL");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > WALLPAPER_MAX_IMAGE_BYTES) throw new Error("wallpaper image too large");
    const hash = WP_CRYPTO.createHash("sha256").update(bytes).digest("hex");
    return {
        fit, area: wallpaperArea(data.area),
        image: { bytes, mime: match[1], hash, file: "wallpaper-" + hash + ".bin" }
    };
}
function readWallpaperFile() {
    if (!fs.existsSync(WALLPAPER_META_FILE)) return { ok: true, exists: false, state: null };
    try {
        if (fs.statSync(WALLPAPER_META_FILE).size > 8192) throw new Error("wallpaper.json too large");
        const meta = JSON.parse(fs.readFileSync(WALLPAPER_META_FILE, "utf8"));
        if (!meta || meta.version !== 1) throw new Error("unsupported wallpaper metadata");
        const fit = wallpaperFit(meta.fit);
        if (!meta.file) return { ok: true, exists: true, state: { src: null, fit, area: null } };
        if (typeof meta.file !== "string" || !WALLPAPER_FILE_RE.test(meta.file))
            throw new Error("invalid wallpaper image filename");
        if (!["image/jpeg", "image/png", "image/webp"].includes(meta.mime))
            throw new Error("invalid wallpaper image MIME");
        const imagePath = path.join(LIULI_DATA_DIR, meta.file);
        const size = fs.statSync(imagePath).size;
        if (!size || size > WALLPAPER_MAX_IMAGE_BYTES) throw new Error("wallpaper image size invalid");
        const bytes = fs.readFileSync(imagePath);
        const hash = WP_CRYPTO.createHash("sha256").update(bytes).digest("hex");
        if (meta.file !== "wallpaper-" + hash + ".bin") throw new Error("wallpaper image checksum mismatch");
        return {
            ok: true, exists: true,
            state: { src: "data:" + meta.mime + ";base64," + bytes.toString("base64"),
                area: wallpaperArea(meta.area), fit }
        };
    } catch (e) {
        log("wallpaper load failed: " + (e && e.message));
        return { ok: false, exists: true, state: null, error: String((e && e.message) || e) };
    }
}
let wallpaperFileState = readWallpaperFile();

function writeWallpaperAtomic(destination, bytes) {
    const temp = destination + ".tmp-" + process.pid;
    try {
        fs.writeFileSync(temp, bytes, { mode: 0o600 });
        fs.renameSync(temp, destination);
    } catch (e) {
        try { fs.rmSync(temp, { force: true }); } catch (_) {}
        throw e;
    }
}
function wallpaperNotify(exceptWebContents) {
    for (const w of BrowserWindow.getAllWindows()) {
        try {
            const wc = w.webContents;
            if (!wc.isDestroyed() && wc !== exceptWebContents) wc.send("LiteLoader.liuli.wallpaperChanged");
        } catch (_) {}
    }
}
function wallpaperCleanup(except) {
    try {
        for (const file of fs.readdirSync(LIULI_DATA_DIR)) {
            if (WALLPAPER_FILE_RE.test(file) && file !== except)
                fs.rmSync(path.join(LIULI_DATA_DIR, file), { force: true });
        }
    } catch (e) { log("wallpaper cleanup warning: " + (e && e.message)); }
}
ipcMain.handle("LiteLoader.liuli.wallpaperLoad", () => wallpaperFileState);
ipcMain.handle("LiteLoader.liuli.wallpaperSave", (event, data) => {
    try {
        const next = parseWallpaperInput(data);
        fs.mkdirSync(LIULI_DATA_DIR, { recursive: true });
        if (next.image) {
            const imagePath = path.join(LIULI_DATA_DIR, next.image.file);
            if (!fs.existsSync(imagePath)) writeWallpaperAtomic(imagePath, next.image.bytes);
        }
        const metadata = {
            version: 1, file: next.image ? next.image.file : null,
            mime: next.image ? next.image.mime : null,
            fit: next.fit, area: next.area, savedAt: new Date().toISOString()
        };
        writeWallpaperAtomic(WALLPAPER_META_FILE, Buffer.from(JSON.stringify(metadata, null, 2) + "\n"));
        wallpaperFileState = {
            ok: true, exists: true,
            state: { src: next.image ? data.src : null, fit: next.fit, area: next.area }
        };
        wallpaperCleanup(next.image && next.image.file);
        wallpaperNotify(event.sender);
        log("wallpaper saved | image=" + !!next.image + " fit=" + next.fit +
            " bytes=" + (next.image ? next.image.bytes.length : 0));
        return { ok: true };
    } catch (e) {
        log("wallpaper save failed: " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});
ipcMain.handle("LiteLoader.liuli.wallpaperReset", (event) => {
    try {
        fs.rmSync(WALLPAPER_META_FILE, { force: true });
        wallpaperCleanup(null);
        wallpaperFileState = { ok: true, exists: false, state: null };
        wallpaperNotify(event.sender);
        return { ok: true };
    } catch (e) {
        log("wallpaper reset failed: " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});

/* ---------- macOS 外观 / 文字独立持久化 ----------
 * 这四项原先只存在 localStorage，macOS QQ 部分会话重启会丢失。
 * 用小 JSON 作权威存档，localStorage 仍负责运行时即时反馈和跨窗口 UI 同步。
 * 只接收 4 个白名单键，不接受路径或任意数据；写入先落临时文件再原子替换。 */
const APPEARANCE_FILE = path.join(LIULI_DATA_DIR, "appearance.json");
const APPEARANCE_KEYS = Object.freeze([
    "liuli-color-roles", "liuli-md-render", "liuli-font", "liuli-dsh-mode"
]);
const APPEARANCE_MAX_BYTES = 8 * 1024;
function validateAppearance(key, raw) {
    if (!APPEARANCE_KEYS.includes(key)) throw new Error("unsupported appearance key");
    if (raw === null) return null; // 明确恢复对应项的默认值
    if (typeof raw !== "string") throw new Error("appearance value must be a string or null");
    if (key === "liuli-md-render") {
        if (raw !== "0" && raw !== "1") throw new Error("invalid markdown setting");
        return raw;
    }
    if (key === "liuli-dsh-mode") {
        if (!["auto", "dark", "light"].includes(raw)) throw new Error("invalid theme mode");
        return raw;
    }
    if (key === "liuli-font") {
        if (raw.length > 64 || /["'\\;{}<>\x00-\x1f]/.test(raw)) throw new Error("invalid font name");
        return raw;
    }
    if (raw.length > 2048) throw new Error("color roles value too large");
    let role;
    try { role = JSON.parse(raw); } catch (_) { throw new Error("color roles is not valid JSON"); }
    if (!role || typeof role !== "object" || Array.isArray(role)) throw new Error("invalid color roles");
    const allowed = {
        accent: ["primary", "secondary", "tertiary"],
        selected: ["primary", "secondary", "tertiary"],
        self: ["primary", "secondary", "tertiary", "solid", "surface", "inverse"],
        others: ["primary", "secondary", "tertiary", "surface"]
    };
    const safe = {};
    for (const [field, opts] of Object.entries(allowed)) {
        if (Object.prototype.hasOwnProperty.call(role, field)) {
            if (!opts.includes(role[field])) throw new Error("invalid color role: " + field);
            safe[field] = role[field];
        }
    }
    return JSON.stringify(safe);
}
function readAppearance() {
    try {
        if (!fs.existsSync(APPEARANCE_FILE)) return { exists: false, values: {} };
        if (fs.statSync(APPEARANCE_FILE).size > APPEARANCE_MAX_BYTES) throw new Error("appearance.json too large");
        const data = JSON.parse(fs.readFileSync(APPEARANCE_FILE, "utf8"));
        if (!data || data.version !== 1 || !data.values || typeof data.values !== "object" || Array.isArray(data.values))
            throw new Error("invalid appearance.json");
        const values = {};
        for (const key of APPEARANCE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(data.values, key))
                values[key] = validateAppearance(key, data.values[key]);
        }
        return { exists: true, values };
    } catch (e) {
        log("appearance load failed: " + (e && e.message));
        return { exists: true, values: {}, error: String((e && e.message) || e) };
    }
}
let appearanceState = readAppearance();
function writeAppearance(values) {
    const body = JSON.stringify({ version: 1, values }, null, 2) + "\n";
    if (Buffer.byteLength(body, "utf8") > APPEARANCE_MAX_BYTES) throw new Error("appearance too large");
    fs.mkdirSync(LIULI_DATA_DIR, { recursive: true });
    const tmp = APPEARANCE_FILE + ".tmp-" + process.pid;
    try {
        fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, APPEARANCE_FILE);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        throw e;
    }
}
function appearanceNotify(sender) {
    for (const w of BrowserWindow.getAllWindows()) {
        try {
            const wc = w.webContents;
            if (!wc.isDestroyed() && wc !== sender) wc.send("LiteLoader.liuli.appearanceChanged");
        } catch (_) {}
    }
}
ipcMain.handle("LiteLoader.liuli.appearanceLoad", () => ({
    ok: !appearanceState.error, exists: appearanceState.exists,
    values: { ...appearanceState.values }, error: appearanceState.error || ""
}));
ipcMain.handle("LiteLoader.liuli.appearanceSave", (event, key, raw) => {
    try {
        const value = validateAppearance(key, raw);
        const values = { ...appearanceState.values, [key]: value };
        writeAppearance(values);
        appearanceState = { exists: true, values };
        appearanceNotify(event.sender);
        return { ok: true };
    } catch (e) {
        log("appearance save failed (" + String(key).slice(0, 50) + "): " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});
ipcMain.handle("LiteLoader.liuli.appearanceImport", (event, oldValues) => {
    try {
        if (appearanceState.exists) return { ok: true, imported: false };
        if (!oldValues || typeof oldValues !== "object" || Array.isArray(oldValues))
            return { ok: false, error: "invalid import data" };
        const values = {};
        for (const key of APPEARANCE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(oldValues, key))
                values[key] = validateAppearance(key, oldValues[key]);
        }
        if (Object.keys(values).length === 0) return { ok: true, imported: false };
        writeAppearance(values);
        appearanceState = { exists: true, values };
        appearanceNotify(event.sender);
        return { ok: true, imported: true };
    } catch (e) {
        log("appearance import failed: " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});
ipcMain.handle("LiteLoader.liuli.appearanceReset", event => {
    try {
        fs.rmSync(APPEARANCE_FILE, { force: true });
        appearanceState = { exists: false, values: {} };
        appearanceNotify(event.sender);
        return { ok: true };
    } catch (e) {
        log("appearance reset failed: " + (e && e.message));
        return { ok: false, error: String((e && e.message) || e) };
    }
});

/* LiteLoader 在内核报 onSessionInitComplete 时触发 onLogin(uid)。 */
let selfUid = "";
ipcMain.handle("LiteLoader.liuli.selfUid", () => selfUid);

/* 小程序卡片用默认浏览器打开：只放行 http/https */
ipcMain.handle("LiteLoader.liuli.openExternal", async (_e, url) => {
    try {
        const u = new URL(String(url));
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        await shell.openExternal(u.href);
        log("open external " + u.href);
        return true;
    } catch (e) {
        log("open external failed: " + e.message);
        try { if (diag) diag.sessionLog("error", "main", "openExternal 失败：" + e.message, { url: String(url) }); } catch (err) {}
        return false;
    }
});

/* ---------- 记住 QQ 设置窗口（含 LiteLoader 插件设置页）的大小和位置 ----------
 * QQ 的设置窗口是预创建的池化窗口：先 #/blank / about:blank，用到时才导航到 #/setting，
 * 所以不能只在 browser-window-created 时判断一次，要给每个窗口的 webContents 挂导航监听，
 * URL 变成 #/setting 时再接管（每个窗口只接管一次）。
 * 只碰 URL 命中 #/setting 的窗口，主窗口 / 聊天窗口 / 资料卡等完全不参与。
 * 任何一步失败都只记 plugin.log，绝不把异常抛到 QQ 主进程里。 */
const SETTINGS_FILE = path.join(LiteLoader.path.data, SLUG, "settings-window.json");
const SETTINGS_DEBOUNCE_MS = 400;
const SETTINGS_MIN_WIDTH = 600;
const SETTINGS_MIN_HEIGHT = 480;
const SETTINGS_MIN_OVERLAP = 100;   // 与屏幕 workArea 至少 100×100 交集才恢复

const settingsWindows = new WeakMap();   // BrowserWindow -> 记录

/* ---------- #30 定时器安全网（2026-11-06） ----------
 * liteLoader.log 实测：[fatal] uncaughtException TypeError: Object has been destroyed
 *   at Timeout._onTimeout (...application.asar)
 * 即防抖保存的 setTimeout 在窗口/对象销毁之后才跑，回调里再读已销毁的 BrowserWindow 就抛异常。
 * 处理（本文件里只有 scheduleSettingsSave 一处注册定时器，grep setInterval|setTimeout 只有它）：
 *   1. 回调入口先判 rec.disposed / win.isDestroyed() / wc.isDestroyed()；
 *   2. 未决定时器登记到 pendingSaveRecs，app 的 before-quit / will-quit 统一 clear；
 *   3. 退出流程中不再排新定时器。 */
const pendingSaveRecs = new Set();   // 还有未决防抖定时器的 settings 记录
let liuliQuitting = false;

function isAliveWin(win) {
    try {
        if (!win || typeof win !== "object") return false;
        if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function isAliveWc(wc) {
    try {
        if (!wc || typeof wc !== "object") return false;
        if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function clearPendingSave(rec) {
    if (!rec) return;
    if (rec.timer) {
        try { clearTimeout(rec.timer); } catch (e) {}
        rec.timer = null;
    }
    try { pendingSaveRecs.delete(rec); } catch (e) {}
}

/* before-quit / will-quit：把还没跑的保存定时器全部清掉，退出流程里不再碰任何窗口 */
function clearAllPendingSaves() {
    liuliQuitting = true;
    const recs = [];
    try { pendingSaveRecs.forEach(function (rec) { recs.push(rec); }); } catch (e) {}
    for (let i = 0; i < recs.length; i++) clearPendingSave(recs[i]);
    try { pendingSaveRecs.clear(); } catch (e) {}
}

function isSettingsUrl(url) {
    const s = String(url || "");
    const i = s.indexOf("#");
    if (i < 0) return false;
    return s.slice(i + 1).startsWith("/setting");
}

/* screen 只在 app ready 后可用，延迟到调用时再取 */
function getElectronScreen() {
    try {
        const e = require("electron");
        return (e && e.screen) || null;
    } catch (e) {
        return null;
    }
}

function readSettingsBounds() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        if (!data || typeof data !== "object") return null;
        const x = Number(data.x);
        const y = Number(data.y);
        const width = Number(data.width);
        const height = Number(data.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (width <= 0 || height <= 0) return null;
        return { x: x, y: y, width: width, height: height, maximized: data.maximized === true };
    } catch (e) {
        if (e && e.code !== "ENOENT") log("settings window read failed: " + (e && e.message));
        return null;
    }
}

function writeSettingsBounds(bounds, maximized) {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        const payload = {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
            maximized: !!maximized,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
    } catch (e) {
        log("settings window save failed: " + (e && e.message));
    }
}

/* 保存的矩形和任意一块屏幕的 workArea 有足够交集才恢复，避免窗口开到看不见的地方 */
function isBoundsOnScreen(bounds) {
    try {
        const screen = getElectronScreen();
        if (!screen || typeof screen.getAllDisplays !== "function") return false;
        const displays = screen.getAllDisplays() || [];
        for (let i = 0; i < displays.length; i++) {
            const area = displays[i] && displays[i].workArea;
            if (!area) continue;
            const overlapW = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
            const overlapH = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
            if (overlapW >= SETTINGS_MIN_OVERLAP && overlapH >= SETTINGS_MIN_OVERLAP) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function saveSettingsNow(rec) {
    if (!rec || rec.disposed) return;
    const win = rec.win;
    try {
        /* #30：窗口或 webContents 任一已销毁就直接放弃，不要在销毁对象上取属性 */
        if (!isAliveWin(win)) return;
        if (rec.wc && !isAliveWc(rec.wc)) return;
        let minimized = false;
        try { minimized = typeof win.isMinimized === "function" && !!win.isMinimized(); } catch (e) { minimized = false; }
        if (minimized) return;   // 最小化时尺寸不可靠，保留上一次的存档
        let maximized = false;
        try { maximized = typeof win.isMaximized === "function" && !!win.isMaximized(); } catch (e) { maximized = false; }
        let bounds = null;
        try {
            bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
        } catch (e) {
            bounds = null;
        }
        if (!bounds) return;
        if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) return;
        writeSettingsBounds(bounds, maximized);
        log("settings window saved | " + Math.round(bounds.width) + "x" + Math.round(bounds.height) +
            " @ " + Math.round(bounds.x) + "," + Math.round(bounds.y) + (maximized ? " maximized" : ""));
    } catch (e) {
        log("settings window save failed: " + (e && e.message));
    }
}

function scheduleSettingsSave(rec) {
    if (!rec || rec.disposed) return;
    if (liuliQuitting) return;                 // #30：退出流程里不再排新的保存
    if (!isAliveWin(rec.win)) return;          // #30：窗口已销毁就别挂定时器
    clearPendingSave(rec);
    rec.timer = setTimeout(function () {
        /* #30 回调入口：这是 liteLoader.log 里报「Object has been destroyed」的那一处。
         * 定时器可能在窗口关掉之后才跑到（防抖 400ms 跨了关闭事件），
         * 所以先判销毁再进 saveSettingsNow，并把整段包进 try 兜底。 */
        try {
            rec.timer = null;
            pendingSaveRecs.delete(rec);
            if (rec.disposed || liuliQuitting) return;
            if (!isAliveWin(rec.win)) return;
            if (rec.wc && !isAliveWc(rec.wc)) return;
            saveSettingsNow(rec);
        } catch (e) {
            log("settings window timer failed: " + (e && e.message));
        }
    }, SETTINGS_DEBOUNCE_MS);
    pendingSaveRecs.add(rec);
    /* 不让防抖定时器拖住 QQ 退出 */
    if (rec.timer && typeof rec.timer.unref === "function") rec.timer.unref();
}

function flushSettingsSave(rec) {
    if (!rec || rec.disposed) return;
    clearPendingSave(rec);
    saveSettingsNow(rec);
}

function disposeSettingsWindow(rec) {
    if (!rec || rec.disposed) return;
    rec.disposed = true;
    clearPendingSave(rec);
    try {
        if (rec.wc && rec.onUrl && typeof rec.wc.removeListener === "function") {
            rec.wc.removeListener("did-navigate", rec.onUrl);
            rec.wc.removeListener("did-navigate-in-page", rec.onUrl);
        }
    } catch (e) {}
    try { settingsWindows.delete(rec.win); } catch (e) {}
}

function onSettingsWindowReady(rec) {
    const win = rec.win;
    const saved = readSettingsBounds();
    if (saved && isBoundsOnScreen(saved)) {
        try {
            const x = Math.round(saved.x);
            const y = Math.round(saved.y);
            const width = Math.max(SETTINGS_MIN_WIDTH, Math.round(saved.width));
            const height = Math.max(SETTINGS_MIN_HEIGHT, Math.round(saved.height));
            win.setBounds({ x: x, y: y, width: width, height: height });
            if (saved.maximized && typeof win.maximize === "function") win.maximize();
            log("settings window restore | " + width + "x" + height + " @ " + x + "," + y + (saved.maximized ? " maximized" : ""));
        } catch (e) {
            log("settings window restore failed: " + (e && e.message));
        }
    } else {
        log("settings window open | " + (saved ? "saved bounds off screen" : "no saved bounds"));
    }

    /* 无论有没有存档都开始记录，这样第一次用完关掉就会留下存档 */
    try {
        if (typeof win.on === "function") {
            const schedule = function () { scheduleSettingsSave(rec); };
            win.on("resize", schedule);
            win.on("move", schedule);
            win.on("close", function () { flushSettingsSave(rec); });
        }
    } catch (e) {
        log("settings window save hook failed: " + (e && e.message));
    }
}

function trackSettingsWindow(win) {
    if (!win || typeof win !== "object" || settingsWindows.has(win)) return;

    const rec = { win: win, wc: null, owned: false, disposed: false, timer: null, onUrl: null };

    let wc = null;
    try { wc = win.webContents || null; } catch (e) { wc = null; }
    if (!wc || typeof wc.on !== "function") return;

    rec.wc = wc;
    settingsWindows.set(win, rec);

    const onUrl = function () {
        try {
            if (rec.disposed || rec.owned) return;
            if (!isAliveWc(wc)) return;   // #30：webContents 已销毁，别再 getURL
            let url = "";
            try { url = typeof wc.getURL === "function" ? wc.getURL() : ""; } catch (e) { url = ""; }
            if (!isSettingsUrl(url)) return;
            rec.owned = true;
            onSettingsWindowReady(rec);
        } catch (e) {
            log("settings window url hook failed: " + (e && e.message));
        }
    };
    rec.onUrl = onUrl;

    try { wc.on("did-navigate", onUrl); } catch (e) {}
    try { wc.on("did-navigate-in-page", onUrl); } catch (e) {}
    try { if (typeof win.once === "function") win.once("closed", function () { disposeSettingsWindow(rec); }); } catch (e) {}

    /* 挂监听之前就已经导航到 #/setting 的窗口（插件后加载）也要接管 */
    onUrl();
}

function installSettingsWindowMemory() {
    if (!app || typeof app.on !== "function") return;
    try {
        app.on("browser-window-created", function (_event, win) {
            try { trackSettingsWindow(win); } catch (e) { log("settings window hook failed: " + (e && e.message)); }
        });
    } catch (e) {
        log("settings window hook install failed: " + (e && e.message));
    }

    /* #30：退出时把还没跑的保存定时器全部清掉（before-quit 先于窗口 close，
     * 窗口 close 时 flushSettingsSave 仍会把最后的位置写一次，不会丢存档）。 */
    try {
        app.on("before-quit", clearAllPendingSaves);
        app.on("will-quit", clearAllPendingSaves);
    } catch (e) {
        log("quit hook install failed: " + (e && e.message));
    }

    /* 插件可能晚于部分窗口创建，补挂一次已有窗口 */
    try {
        if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
            const wins = BrowserWindow.getAllWindows() || [];
            for (let i = 0; i < wins.length; i++) {
                try { trackSettingsWindow(wins[i]); } catch (e) {}
            }
        }
    } catch (e) {}
}

try {
    installSettingsWindowMemory();
} catch (e) {
    log("settings window memory init failed: " + (e && e.message));
}

module.exports = {
    onLogin(uid) {
        selfUid = String(uid || "");
        log("login uid=" + selfUid);
        try { if (diag) diag.sessionLog("info", "main", "登录完成", { uid: selfUid }); } catch (e) {}
    },
};
