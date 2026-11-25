# 安装、升级与回滚

本版在 macOS QQNT 6.9.97-50776 与 LiteLoaderQQNT 1.4.1 上完成实机验收。

## 手动安装与升级

1. 完全退出 QQ。从 Releases 下载 `liuli-macos-v1.3.7.zip`，可用 `shasum -a 256 liuli-macos-v1.3.7.zip` 核对同页的 SHA-256。
2. 在 Finder 按 Command + Shift + G 打开 `~/Library/Containers/com.tencent.qq/Data/Documents/LiteLoaderQQNT/`。
3. 如已安装旧版，将 `plugins/liuli-dsh-theme/` 移出 `plugins/` 备份。如需保留一份个人设置快照，复制 `data/liuli-dsh-theme/`，包括外观、布局、壁纸及其元数据。
4. 将 ZIP 解压到 `plugins/liuli-dsh-theme/`，确保 `manifest.json` 直接位于其中。保留原数据目录。
5. 重开 QQ，在 LiteLoader 插件列表确认显示「琉璃 for macOS」1.3.7，再核对原有外观、壁纸和布局。

## 回滚

如果要降级到仅支持主色、次色、第三色的版本，先在当前版本将「选中项」从「强调色」切至其中一色，再备份外观与布局。旧版可能无法读取含「强调色」的配置。若已在旧版遇到读档问题，先退出 QQ，恢复支持这项设置的版本和配置备份，再转换颜色。

完全退出 QQ，将当前插件目录移出 `plugins/`，恢复先前备份的插件目录，再启动 QQ。需要撤销配置变化时，从备份恢复数据目录。卸载插件和回滚插件都可以保留数据目录。
