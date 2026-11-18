// 琉璃主题插件 · preload：给界面开主进程接口
// preload 每页可能跑两次，重复 expose 会报错，先查一下
const { contextBridge, ipcRenderer } = require("electron");

const api = {
    selfUid: () => ipcRenderer.invoke("LiteLoader.liuli.selfUid"),
    openExternal: url => ipcRenderer.invoke("LiteLoader.liuli.openExternal", url),
    // 数据目录被整个删掉后的一次性重置标记（wipe=true → 渲染进程先清 localStorage）
    resetPending: () => ipcRenderer.invoke("LiteLoader.liuli.resetPending"),
    // 布局/右键菜单持久化兜底：真正落盘到 data/liuli-dsh-theme/layout.json
    layoutLoad: () => ipcRenderer.invoke("LiteLoader.liuli.layoutLoad"),
    layoutSave: (kind, value) => ipcRenderer.invoke("LiteLoader.liuli.layoutSave", kind, value),
    layoutReset: () => ipcRenderer.invoke("LiteLoader.liuli.layoutReset"),
    // 图片单独写入 LiteLoader 数据目录，wallpaper.json 只存裁剪/适配参数。
    wallpaperLoad: () => ipcRenderer.invoke("LiteLoader.liuli.wallpaperLoad"),
    wallpaperSave: state => ipcRenderer.invoke("LiteLoader.liuli.wallpaperSave", state),
    wallpaperReset: () => ipcRenderer.invoke("LiteLoader.liuli.wallpaperReset"),
    onWallpaperChanged: cb => {
        const listener = () => cb();
        ipcRenderer.on("LiteLoader.liuli.wallpaperChanged", listener);
        return () => ipcRenderer.removeListener("LiteLoader.liuli.wallpaperChanged", listener);
    },
    // 四项轻量外观设置的可靠文件存档：appearance.json
    appearanceLoad: () => ipcRenderer.invoke("LiteLoader.liuli.appearanceLoad"),
    appearanceSave: (key, value) => ipcRenderer.invoke("LiteLoader.liuli.appearanceSave", key, value),
    appearanceImport: values => ipcRenderer.invoke("LiteLoader.liuli.appearanceImport", values),
    appearanceReset: () => ipcRenderer.invoke("LiteLoader.liuli.appearanceReset"),
    onAppearanceChanged: cb => {
        const listener = () => cb();
        ipcRenderer.on("LiteLoader.liuli.appearanceChanged", listener);
        return () => ipcRenderer.removeListener("LiteLoader.liuli.appearanceChanged", listener);
    },
    // 诊断包（契约 installer/DIAG-COVERAGE.md 3.1）
    diagExport: payload => ipcRenderer.invoke("LiteLoader.liuli.diagExport", payload),
    diagLog: entry => ipcRenderer.send("LiteLoader.liuli.diagLog", entry),
    diagOpenPath: path => ipcRenderer.invoke("LiteLoader.liuli.diagOpenPath", path),
};

const exists = contextBridge.executeInMainWorld({ func: key => key in globalThis, args: ["liuli_api"] });
if (!exists) contextBridge.exposeInMainWorld("liuli_api", api);
