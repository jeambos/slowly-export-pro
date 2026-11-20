import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controller = await readFile(join(project, 'src', 'controller.js'), 'utf8');
const version = controller.match(/const SCRIPT_VERSION = '(\d+\.\d+\.\d+)'/)?.[1];
if (!version) throw new Error('Could not read userscript version from controller.js');
const header = `// ==UserScript==
// @name         Slowly Export Pro
// @namespace    https://greasyfork.org/en/scripts/604685-slowly-export-pro
// @homepageURL  https://greasyfork.org/en/scripts/604685-slowly-export-pro
// @version      ${version}
// @description  Export Slowly letters as Markdown, HTML, EPUB, or TXT; export stamps and keep optional local backups.
// @description:en     Export Slowly letters as Markdown, HTML, EPUB, or TXT; export stamps and keep optional local backups.
// @description:zh-CN  将 Slowly 书信导出为 Markdown、HTML、EPUB 或 TXT，并导出邮票或保存可选的本地存档。
// @description:zh-TW  將 Slowly 書信匯出為 Markdown、HTML、EPUB 或 TXT，並匯出郵票或儲存選用的本機存檔。
// @description:ja     Slowly の手紙を Markdown、HTML、EPUB、TXT で出力し、切手と任意のローカル保存にも対応します。
// @description:ko     Slowly 편지를 Markdown, HTML, EPUB, TXT로 내보내고 우표 및 선택적 로컬 보관을 지원합니다.
// @description:es     Exporta cartas de Slowly en Markdown, HTML, EPUB o TXT, además de sellos y copias locales opcionales.
// @description:fr     Exportez les lettres Slowly en Markdown, HTML, EPUB ou TXT, ainsi que les timbres et une archive locale facultative.
// @description:de     Exportiert Slowly-Briefe als Markdown, HTML, EPUB oder TXT sowie Briefmarken und optionale lokale Archive.
// @description:pt-BR  Exporte cartas do Slowly em Markdown, HTML, EPUB ou TXT, além de selos e arquivos locais opcionais.
// @author       HUM4N_F1L3.json (original Slowly Export); Slowly Export Pro contributors
// @license      GPL-3.0-only
// @match        https://web.slowly.app/*
// @noframes
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Based on Slowly Export v1.0 by HUM4N_F1L3.json, 2025-07-27:
 * Modified 2026-11-09: reverse traversal, incremental progress, configurable
 * filenames and output, optional metadata archive, stamp album export, and i18n.
 * SPDX-License-Identifier: GPL-3.0-only
 */
`;
const sources = ['core.js', 'dom.js', 'storage.js', 'i18n.js', 'formats.js', 'zip.js', 'epub.js', 'output.js', 'controller.js'];
const chunks = await Promise.all(sources.map(name => readFile(join(project, 'src', name), 'utf8')));
await writeFile(join(project, 'Slowly Export Pro.user.js'), `${header}\n${chunks.join('\n\n').trimEnd()}\n`, 'utf8');
