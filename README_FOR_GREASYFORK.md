# Slowly Export Pro

## 中文

想把 Slowly 上的书信和邮票留一份在自己手里？Slowly Export Pro 会在 [Slowly 网页版](https://web.slowly.app/) 添加 **Export** 按钮和齿轮菜单，让你按喜欢的方式保存通信，也能导出自己的邮票册。

### 你可以用它做什么

- **保存书信：** 将与一位笔友的通信导出为 Markdown、HTML、EPUB 或 TXT。Markdown 适合整理和编辑；HTML 解压后可在浏览器中离线阅读，并提供六种布局，包括经典信件、连续阅读、时间轴和图片与语音相册；EPUB 适合放进电子书阅读器；TXT 方便留存纯文本。
- **接着上次导出：** 再次导出同一段通信时，默认只包含上次成功导出后新增的信件。需要完整副本时，也可以选择导出全部信件。可从任意一封信开始；从中间开始时，菜单会让你选择浏览范围。
- **收藏邮票：** 导出 My Stamps 页面中的邮票，或只导出当前打开的 Stamp Collection 邮票册；也可以单独收集一段通信中使用过的邮票。
- **调整阅读和文件样式：** 自定义信件文件名、Markdown 排版、HTML 布局及主题色。HTML 布局可以先用示例信件预览。界面支持九种语言，包括简体中文和繁体中文。
- **按需保留本地存档：** 开启后可在当前浏览器保存信件内容，供以后重新打包，并可备份或恢复。新安装时默认关闭。

### 开始使用

1. 使用用户脚本管理器安装本脚本。如果已安装原版 Slowly Export，请先停用原版，以免页面上出现两组按钮。
2. 登录 [Slowly 网页版](https://web.slowly.app/)，打开一封信。点击齿轮选择格式和设置，再点 **Export**；齿轮菜单中的“导出信件”提供更多浏览选项。
3. 要导出邮票，打开 My Stamps 页面或 Stamp Collection 弹窗，再点击 **Export** 或“导出当前邮票册”。

**使用提醒：** HTML 和 TXT 下载为 ZIP，解压后再打开；长篇 Markdown 的附件包也需要解压到正文旁边。浏览器可能要求允许连续下载。清理站点数据可能删除导出记录和可选的本地存档，请保留下载文件与存档备份。此版本尚未完成登录状态下的整段通信实测，建议先用较短的通信试跑；Slowly 页面或浏览器下载设置的变化也可能影响结果。

本脚本基于 HUM4N_F1L3.json 的 Slowly Export 扩展开发，遵循 [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)；与 Slowly 官方无关联。技术说明和开发信息见项目的 README.md。

---

## English

Want your own copy of your Slowly letters and stamps? Slowly Export Pro adds an **Export** button and a settings menu to [Slowly Web](https://web.slowly.app/), so you can save conversations in a format that suits you and download your stamp album.

### What you can do

- **Save letters:** Export a pen-pal conversation as Markdown, HTML, EPUB, or TXT. Markdown is easy to edit; HTML opens offline after extraction and offers six reading layouts, including a classic letter view, continuous reading, a timeline, and a photo and audio album; EPUB works with ebook readers; TXT keeps a plain-text copy.
- **Pick up where you left off:** Later exports include only letters added since the last successful export by default. Choose **Export all letters** when you want a complete copy. You can start from any letter, with navigation choices when starting in the middle of a conversation.
- **Keep your stamps:** Export stamps from My Stamps, the Stamp Collection you have open, or the stamps used in one conversation.
- **Make the files yours:** Customize letter filenames, Markdown styling, HTML layout, and accent color. Preview HTML layouts with sample letters. The interface supports nine languages.
- **Keep an optional local archive:** Enable browser storage to reuse saved letter content later, and back up or restore that archive. It is off by default for new installations.

### Get started

1. Install the script with a userscript manager. Disable the original Slowly Export script if you use it, to avoid duplicate controls.
2. Sign in to [Slowly Web](https://web.slowly.app/) and open a letter. Use the gear menu to choose your format and settings, then click **Export**. **Export letters** in the gear menu offers more navigation choices.
3. To save stamps, open My Stamps or a Stamp Collection dialog, then click **Export** or **Export current stamp album**.

**Before a large export:** Extract HTML and TXT ZIPs before opening their contents. For long Markdown, extract the attachment ZIP beside the document. Your browser may ask to allow multiple downloads. Clearing site data may erase export history and the optional local archive, so keep downloaded files and archive backups. A complete export in a signed-in browser has not yet been verified; try a short conversation first. Changes to Slowly Web or browser download settings may affect results.

Based on Slowly Export by HUM4N_F1L3.json, licensed under [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html). This project is independent of Slowly. Technical and development details are in the project's README.md.
