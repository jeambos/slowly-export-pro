// ==UserScript==
// @name         Slowly Export Pro
// @namespace    https://greasyfork.org/en/scripts/604685-slowly-export-pro
// @homepageURL  https://greasyfork.org/en/scripts/604685-slowly-export-pro
// @version      0.8.4
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

/* Core functions for Slowly Export Pro. GPL-3.0-only. */
(function (root) {
  'use strict';

  const DEFAULT_TEMPLATE = '{date}-{time} ({index}) {author} from {location}';
  const pad = value => String(value).padStart(2, '0');

  function parseLetterId(url) {
    try {
      const parts = new URL(url, 'https://web.slowly.app').pathname.split('/').filter(Boolean);
      return parts.length === 3 && parts[0] === 'friend' ? parts[2] : null;
    } catch { return null; }
  }

  function parseFriendId(url) {
    try {
      const parts = new URL(url, 'https://web.slowly.app').pathname.split('/').filter(Boolean);
      return parts[0] === 'friend' && parts[1] ? parts[1] : null;
    } catch { return null; }
  }

  function planTraversal(ids, checkpoint, all) {
    if (all || !checkpoint) return { ids: [...ids], status: 'oldest' };
    const stop = ids.indexOf(checkpoint);
    return stop < 0
      ? { ids: [], status: 'missing-checkpoint' }
      : { ids: ids.slice(0, stop), status: 'checkpoint' };
  }

  function dateFields(raw) {
    if (!raw || /^(today|yesterday|tomorrow)$/i.test(String(raw).trim())) {
      return { date: 'undated', time: 'unknown-time', valid: false };
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return { date: 'undated', time: 'unknown-time', valid: false };
    return {
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      time: `${pad(date.getHours())}-${pad(date.getMinutes())}`,
      valid: true,
    };
  }

  function cleanFilename(name) {
    let cleaned = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ').trim().slice(0, 180).replace(/[. ]+$/g, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
    return cleaned || 'letter';
  }

  function renderFilename(template, letter, index, extension = 'md') {
    const fields = dateFields(letter.date);
    const values = {
      date: fields.date, time: fields.time, index: String(index),
      author: letter.author || 'Unknown', location: letter.location || 'Unknown',
    };
    const base = String(template || DEFAULT_TEMPLATE).replace(/\{(date|time|index|author|location)\}/g,
      (_, key) => values[key]);
    const safeExtension = ['md', 'html', 'txt'].includes(extension) ? extension : 'md';
    return `${cleanFilename(base.replace(/\.(?:md|html|txt)$/i, ''))}.${safeExtension}`;
  }

  function extensionFromUrl(url, type) {
    try {
      const ext = new URL(url, 'https://web.slowly.app').pathname.match(/\.([a-z0-9]{2,6})$/i)?.[1]?.toLowerCase();
      if (ext && /^(png|jpe?g|gif|webp|avif|svg|mp3|m4a|ogg|opus|wav|flac|aac|mp4|webm|pdf)$/.test(ext)) return ext;
    } catch { /* use type fallback */ }
    return ({ picture: 'jpg', voice: 'mp3', stamp: 'png', avatar: 'png', video: 'mp4' })[type] || 'bin';
  }

  function folderFor(type, layout) {
    if (layout === 'assets') return 'assets/';
    if (layout === 'category') return `${({ picture: 'picture', voice: 'voice', stamp: 'stamp', avatar: 'avatar', video: 'video' })[type] || 'other'}/`;
    return '';
  }

  function planAssetPaths(letters, layout = 'root') {
    const planned = [];
    const used = new Set();
    const sharedPaths = new Map();
    for (const letter of letters) {
      const assets = [
        ...(letter.attachments || []).map(a => ({ ...a, type: a.type || 'picture' })),
        ...(letter.stampUrl ? [{ url: letter.stampUrl, type: 'stamp' }] : []),
        ...(letter.avatarUrl ? [{ url: letter.avatarUrl, type: 'avatar' }] : []),
      ];
      const stem = (letter.filename || renderFilename(null, letter, letter.index || 1))
        .replace(/\.(?:md|html|txt)$/i, '');
      assets.forEach((asset, i) => {
        const sharedKey = `${asset.type}|${asset.url}`;
        if (sharedPaths.has(sharedKey)) {
          planned.push({ ...asset, path: sharedPaths.get(sharedKey), letterId: letter.id });
          return;
        }
        const ext = extensionFromUrl(asset.url, asset.type);
        const folder = folderFor(asset.type, layout);
        const numbered = assets.length > 1 ? ` (${i + 1})` : '';
        let path = `${folder}${stem}${numbered}.${ext}`;
        let extra = 2;
        while (used.has(path.toLowerCase())) path = `${folder}${stem}${numbered} (${extra++}).${ext}`;
        used.add(path.toLowerCase());
        sharedPaths.set(sharedKey, path);
        planned.push({ ...asset, path, letterId: letter.id });
      });
    }
    return planned;
  }

  function planTxtAssetPaths(letters) {
    const planned = [];
    const used = new Set();
    const sharedPaths = new Map();
    for (const letter of letters) {
      const assets = [
        ...(letter.attachments || []).map(asset => ({ ...asset, type: asset.type || 'picture' })),
        ...(letter.stampUrl ? [{ url: letter.stampUrl, type: 'stamp' }] : []),
        ...(letter.avatarUrl ? [{ url: letter.avatarUrl, type: 'avatar' }] : []),
      ];
      const stem = (letter.filename || renderFilename(null, letter, letter.index || 1, 'txt')).replace(/\.txt$/i, '');
      const counts = new Map();
      for (const asset of assets) {
        const category = ({ picture: 'picture', voice: 'voice', stamp: 'stamp', avatar: 'avatar', video: 'video' })[asset.type] || 'other';
        const sharedKey = `${asset.type}|${asset.url}`;
        if (sharedPaths.has(sharedKey)) {
          planned.push({ ...asset, path: sharedPaths.get(sharedKey), letterId: letter.id });
          continue;
        }
        const number = (counts.get(category) || 0) + 1;
        counts.set(category, number);
        const ext = extensionFromUrl(asset.url, asset.type);
        let path = `${stem}-${category}-${number}.${ext}`;
        let extra = 2;
        while (used.has(path.toLowerCase())) path = `${stem}-${category}-${number} (${extra++}).${ext}`;
        used.add(path.toLowerCase());
        sharedPaths.set(sharedKey, path);
        planned.push({ ...asset, path, letterId: letter.id });
      }
    }
    return planned;
  }

  const escapeHtml = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function renderMarkdown(letter, style = 'simple', assetPaths = []) {
    const title = `${letter.author || 'Unknown'} — ${letter.date || 'Unknown'}`;
    const header = style === 'rich'
      ? `<div class="slowly-letter"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(letter.location || '')}</p></div>`
      : style === 'compact'
        ? `## ${title} · ${letter.location || ''}`
        : `# ${title}\n\n**Location:** ${letter.location || 'Unknown'}`;
    const links = assetPaths.map(asset => {
      const path = asset.path.split('/').map(encodeURIComponent).join('/');
      return asset.type === 'picture' || asset.type === 'stamp' || asset.type === 'avatar'
        ? `![${asset.type}](<${path}>)`
        : `[${asset.type}](<${path}>)`;
    });
    return `${header}\n\n${letter.body || ''}${links.length ? `\n\n${links.join('\n\n')}` : ''}\n`;
  }

  const api = { DEFAULT_TEMPLATE, parseLetterId, parseFriendId, planTraversal, dateFields,
    cleanFilename, renderFilename, extensionFromUrl, planAssetPaths, planTxtAssetPaths, renderMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Slowly Web DOM adapter for Slowly Export Pro. GPL-3.0-only. */
(function (root) {
  'use strict';
  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.SEP;
  const SELECTORS = {
    olderLink: '.friend-header a.no-underline.link',
    collectionDialog: '[role="dialog"].modal.show',
    collectionImage: 'button.stamp-zoomable img.stamp',
    myStampCard: '.store-item-group > .col-6',
    accountMenuTrigger: 'header .dropdown-toggle, nav .dropdown-toggle, .navbar .dropdown-toggle, .topbar .dropdown-toggle, header [aria-haspopup="menu"], nav [aria-haspopup="menu"], .navbar [aria-haspopup="menu"], .topbar [aria-haspopup="menu"], header .dropdown > button, header .dropdown > a, nav .dropdown > button, nav .dropdown > a, .navbar .dropdown > button, .navbar .dropdown > a',
    accountAvatar: 'img.avatar-border, img.rounded-circle, img[class*="avatar"]',
    accountPopover: '.popover.show',
  };

  function text(node) { return (node?.innerText ?? node?.textContent ?? '').trim(); }
  function stripTags(value) { return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim(); }

  function findAccountMenuTrigger(doc, viewportWidth) {
    const visibleTopRight = node => {
      if (node.closest?.('.friend-header, .popover')) return false;
      const rect = node.getBoundingClientRect?.();
      return rect && rect.top >= 0 && rect.top < 160 && rect.right > viewportWidth * 0.55;
    };
    const avatar = Array.from(doc.querySelectorAll(SELECTORS.accountAvatar)).find(visibleTopRight);
    if (avatar) return avatar.closest?.('button, a, [role="button"], .link, .dropdown-toggle') || avatar;
    return Array.from(doc.querySelectorAll(SELECTORS.accountMenuTrigger))
      .find(trigger => trigger.querySelector(SELECTORS.accountAvatar) && visibleTopRight(trigger)) || null;
  }

  function accountMenu(trigger) {
    const popover = Array.from(trigger?.ownerDocument?.querySelectorAll(SELECTORS.accountPopover) || [])
      .find(node => node.querySelector('a[href="/profile"] .media-body .h5'));
    if (popover) return popover;
    const group = trigger?.closest?.('.dropdown') || trigger?.parentElement;
    return group?.querySelector('.dropdown-menu.show')
      || group?.querySelector('[role="menu"][data-state="open"]') || null;
  }

  function readAccountLabelFromMenu(trigger) {
    const menu = accountMenu(trigger);
    const node = menu?.querySelector('a[href="/profile"] .media-body .h5')
      || menu?.querySelector('.dropdown-header strong, .dropdown-header h5, .dropdown-header h6, .user-name, .username, .dropdown-header');
    const value = text(node).split(/\r?\n/)[0].trim();
    return value && value.length <= 80 ? value : '';
  }

  function readLetter(doc, location) {
    const id = core.parseLetterId(location.href);
    if (!id) throw new Error('Not a letter URL');
    const bodyNode = doc.querySelector('.modal-body .pre-wrap.mb-3');
    if (!bodyNode) throw new Error('Letter text was not found');
    const footer = doc.querySelector('.modal-footer .media-body');
    const parts = (footer?.querySelector('p')?.innerHTML || '').split(/<br\s*\/?\s*>/i);
    const machineTime = footer?.querySelector('time[datetime]') || doc.querySelector('.modal-footer time[datetime]');
    const avatar = footer?.parentElement?.querySelector('img.avatar-border, img.rounded-circle');
    const stamp = doc.querySelector('.modal-header img.stamp') || doc.querySelector('img.stamp');
    const attachments = [];
    const seen = new Set();
    doc.querySelectorAll('.slider img, .slider audio, .slider video, .modal-body audio, .modal-body video')
      .forEach(node => {
        const url = node.currentSrc || node.src || node.querySelector?.('source')?.src;
        if (!url || seen.has(url)) return;
        seen.add(url);
        const tag = node.tagName?.toLowerCase() || 'img';
        attachments.push({ url, type: tag === 'audio' ? 'voice' : tag === 'video' ? 'video' : 'picture', alt: node.alt || '' });
      });
    return {
      id, friendId: core.parseFriendId(location.href), friendName: text(doc.querySelector('.friend-header .text-primary.h6')),
      url: location.href,
      author: text(footer?.querySelector('h5')),
      date: machineTime?.dateTime || machineTime?.getAttribute?.('datetime') || stripTags(parts[0]),
      location: stripTags(parts[1]),
      body: text(bodyNode), attachments,
      stampUrl: stamp?.src || '', avatarUrl: avatar?.src || '',
    };
  }

  function getOlderLetterLink(doc) {
    return Array.from(doc.querySelectorAll(SELECTORS.olderLink))
      .find(link => link.querySelector('i.icon-chevron-right')) || null;
  }

  function getNewerLetterLink(doc) {
    return Array.from(doc.querySelectorAll(SELECTORS.olderLink))
      .find(link => link.querySelector('i.icon-chevron-left')) || null;
  }

  function detectStampContext(doc, location) {
    const dialog = Array.from(doc.querySelectorAll(SELECTORS.collectionDialog))
      .find(node => node.querySelector('.stamp-collection'));
    if (dialog) return { type: 'collection', root: dialog };
    if (/^\/stamps(?:\/|$)/.test(location.pathname)) return { type: 'my-stamps', root: doc };
    return null;
  }

  function stampId(url) {
    try { return decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '')); }
    catch { return ''; }
  }

  function readStampItems(context) {
    if (!context) return [];
    const items = [];
    const seen = new Set();
    if (context.type === 'collection') {
      context.root.querySelectorAll(SELECTORS.collectionImage).forEach(img => {
        const url = img.currentSrc || img.src;
        const id = stampId(url);
        if (!id || seen.has(id)) return;
        seen.add(id);
        items.push({ id, title: img.alt || id, description: '', unlockedAt: '',
          url, highResUrl: url.replace('/stamp-sm/', '/stamp/'), album: 'collection' });
      });
    } else if (context.type === 'my-stamps') {
      context.root.querySelectorAll(SELECTORS.myStampCard).forEach(card => {
        if (!card.querySelector('.icon-unlock')) return;
        const img = card.querySelector('.store-item-img img.stamp');
        const url = img?.currentSrc || img?.src;
        const id = stampId(url);
        if (!id || seen.has(id)) return;
        seen.add(id);
        items.push({ id, title: text(card.querySelector('h5')) || id,
          description: text(card.querySelector('p.singleline-desc')),
          unlockedAt: text(card.querySelector('span.badge')),
          url, highResUrl: url, album: 'my-stamps' });
      });
    }
    return items;
  }

  const api = { SELECTORS, findAccountMenuTrigger, accountMenu, readAccountLabelFromMenu,
    readLetter, getOlderLetterLink, getNewerLetterLink, detectStampContext, readStampItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Metadata-only local archive. GPL-3.0-only. */
(function (root) {
  'use strict';

  function makeStoredLetter(letter) {
    return {
      id: String(letter.id), friendId: String(letter.friendId), url: letter.url || '',
      author: letter.author || '', friendName: letter.friendName || '', date: letter.date || '', location: letter.location || '',
      body: letter.body || '', index: Number(letter.index) || 0,
      attachments: (letter.attachments || []).map(a => ({ url: a.url, type: a.type || 'picture', alt: a.alt || '' })),
      stampUrl: letter.stampUrl || '', avatarUrl: letter.avatarUrl || '',
    };
  }

  function summarizeArchive(rows) {
    const friends = new Map();
    let attachmentCount = 0;
    for (const row of rows) {
      const friendId = String(row.friendId || '');
      if (!friends.has(friendId)) friends.set(friendId, {
        friendId, friendName: row.friendName || friendId, letterCount: 0,
        attachmentCount: 0, attachmentTypes: new Map(), oldestDate: '', newestDate: '',
        oldestTime: Infinity, newestTime: -Infinity,
      });
      const friend = friends.get(friendId);
      if (row.friendName) friend.friendName = row.friendName;
      friend.letterCount++;
      for (const attachment of row.attachments || []) {
        const type = attachment.type || 'picture';
        friend.attachmentTypes.set(type, (friend.attachmentTypes.get(type) || 0) + 1);
        friend.attachmentCount++;
        attachmentCount++;
      }
      const time = /\b\d{4}\b/.test(String(row.date || '')) ? Date.parse(row.date) : NaN;
      if (Number.isFinite(time) && time < friend.oldestTime) {
        friend.oldestTime = time;
        friend.oldestDate = row.date;
      }
      if (Number.isFinite(time) && time > friend.newestTime) {
        friend.newestTime = time;
        friend.newestDate = row.date;
      }
    }
    return {
      letterCount: rows.length, friendCount: friends.size, attachmentCount,
      friends: [...friends.values()].sort((a, b) => a.friendName.localeCompare(b.friendName))
        .map(({ oldestTime, newestTime, attachmentTypes, ...friend }) => ({
          ...friend, attachmentTypes: [...attachmentTypes].sort(([a], [b]) => a.localeCompare(b))
            .map(([type, count]) => ({ type, count })),
        })),
    };
  }

  function createStore(backend, accountId) {
    if (!accountId) throw new Error('Local account key is required');
    const own = row => row.accountId === accountId;
    const withKey = clean => ({ ...clean, accountId,
      key: `${encodeURIComponent(accountId)}|${encodeURIComponent(clean.friendId)}|${encodeURIComponent(clean.id)}` });
    return {
      async put(letter) {
        const clean = makeStoredLetter(letter);
        await backend.put(withKey(clean));
      },
      async putMany(letters) {
        await backend.putMany(letters.map(letter => withKey(makeStoredLetter(letter))));
      },
      async replaceFriend(friendId, letters) {
        if (letters.some(letter => String(letter.friendId) !== friendId || !letter.id)) {
          throw new Error('Archive letters do not match the selected friend');
        }
        await backend.replaceFriend(accountId, friendId, letters.map(letter => withKey(makeStoredLetter(letter))));
      },
      async list(friendId) {
        return (await backend.all()).filter(row => own(row) && row.friendId === friendId);
      },
      async all() { return (await backend.all()).filter(own); },
      async clearFriend(friendId) {
        for (const row of await backend.all()) if (own(row) && row.friendId === friendId) await backend.delete(row.key);
      },
      async clearAll() {
        for (const row of await backend.all()) if (own(row)) await backend.delete(row.key);
      },
      async backup() { return JSON.stringify({ format: 'Slowly Export Pro archive v1', accountId, letters: await this.all() }, null, 2); },
      async restore(json) {
        const data = typeof json === 'string' ? JSON.parse(json) : json;
        if (data?.format !== 'Slowly Export Pro archive v1' || data.accountId !== accountId || !Array.isArray(data.letters)) {
          throw new Error('Archive format or account does not match');
        }
        const rows = data.letters.map(row => {
          if (!row?.id || !row.friendId) throw new Error('Invalid archived letter');
          return withKey(makeStoredLetter(row));
        });
        await backend.replaceAccount(accountId, rows);
      },
    };
  }

  function createIndexedDBBackend(indexedDB) {
    let dbPromise;
    function open() {
      if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('SlowlyExportPro', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('letters')) req.result.createObjectStore('letters', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
      });
      return dbPromise;
    }
    function transaction(mode, operation) {
      return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('letters', mode);
        const req = operation(tx.objectStore('letters'));
        let result;
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => reject(req.error || new Error('IndexedDB operation failed'));
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      }));
    }
    function replaceMatching(accountId, friendId, rows) {
      return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('letters', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        const store = tx.objectStore('letters');
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            for (const row of request.result) {
              if (row.accountId === accountId && (friendId === null || row.friendId === friendId)) store.delete(row.key);
            }
            for (const row of rows) store.put(row);
          } catch (error) {
            try { tx.abort(); } catch { /* transaction may already be inactive */ }
            reject(error);
          }
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      }));
    }
    return {
      put: row => transaction('readwrite', store => store.put(row)),
      putMany: rows => open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('letters', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        try {
          const store = tx.objectStore('letters');
          rows.forEach(row => store.put(row));
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          reject(error);
        }
      })),
      replaceFriend: (accountId, friendId, rows) => replaceMatching(accountId, friendId, rows),
      replaceAccount: (accountId, rows) => replaceMatching(accountId, null, rows),
      all: () => transaction('readonly', store => store.getAll()),
      delete: key => transaction('readwrite', store => store.delete(key)),
    };
  }

  const api = { makeStoredLetter, summarizeArchive, createStore, createIndexedDBBackend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* UI translations for Slowly Export Pro. GPL-3.0-only. */
(function (root) {
  'use strict';
  const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR'];
  // Values in each row follow SUPPORTED_LOCALES.
  const rows = {
    title: ['Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro', 'Slowly Export Pro'],
    close: ['Close', '关闭', '關閉', '閉じる', '닫기', 'Cerrar', 'Fermer', 'Schließen', 'Fechar'],
    settings: ['Settings', '设置', '設定', '設定', '설정', 'Configuración', 'Paramètres', 'Einstellungen', 'Configurações'],
    language: ['Language', '界面语言', '介面語言', '表示言語', '표시 언어', 'Idioma', 'Langue', 'Sprache', 'Idioma'],
    localAccount: ['My pen name', '我的笔名', '我的筆名', '私のペンネーム', '내 필명', 'Mi seudónimo', 'Mon pseudonyme', 'Mein Pseudonym', 'Meu pseudônimo'],
    accountHint: ['Keeps local archives separate. Use a different name for each account; it is not added to letters.', '用于区分本地存档与导出记录；多个账号请使用不同名称，不会写进信件。', '用於區分本機存檔與匯出紀錄；多個帳號請使用不同名稱，不會寫進信件。', 'ローカル保存と出力履歴の区別に使います。アカウントごとに異なる名前を使ってください。手紙には書き込まれません。', '로컬 보관함과 내보내기 기록을 구분합니다. 계정마다 다른 이름을 사용하세요. 편지에는 추가되지 않습니다.', 'Separa los archivos locales. Use un nombre distinto para cada cuenta; no se añade a las cartas.', 'Sépare les archives locales. Utilisez un nom différent pour chaque compte ; il n’est pas ajouté aux lettres.', 'Trennt lokale Archive. Verwenden Sie für jedes Konto einen anderen Namen; er wird nicht in Briefe eingefügt.', 'Separa os arquivos locais. Use um nome diferente para cada conta; ele não aparece nas cartas.'],
    filenameTemplate: ['Filename template', '文件名模板', '檔名範本', 'ファイル名テンプレート', '파일 이름 템플릿', 'Plantilla de nombre', 'Modèle de nom de fichier', 'Dateinamensvorlage', 'Modelo de nome'],
    templateDate: ['date', '日期', '日期', '日付', '날짜', 'Fecha', 'Date', 'Datum', 'Data'],
    templateTime: ['time', '时间', '時間', '時刻', '시간', 'Hora', 'Heure', 'Uhrzeit', 'Hora'],
    templateIndex: ['letter number', '信件序号', '信件序號', '手紙番号', '편지 번호', 'Número de carta', 'Numéro de lettre', 'Briefnummer', 'Número da carta'],
    templateAuthor: ['sender', '发信人', '寄件人', '差出人', '보낸 사람', 'Remitente', 'Expéditeur', 'Absender', 'Remetente'],
    templateLocation: ['location', '地点', '地點', '場所', '위치', 'Ubicación', 'Lieu', 'Ort', 'Localização'],
    templateClear: ['Clear', '清空', '清空', '消去', '지우기', 'Borrar', 'Effacer', 'Leeren', 'Limpar'],
    templateDelete: ['Delete selection', '删除选中内容', '刪除選取內容', '選択範囲を削除', '선택 영역 삭제', 'Eliminar selección', 'Supprimer la sélection', 'Auswahl löschen', 'Excluir seleção'],
    filenamePreview: ['Preview', '预览', '預覽', 'プレビュー', '미리 보기', 'Vista previa', 'Aperçu', 'Vorschau', 'Prévia'],
    assetFilenameTemplate: ['Media filename template', '媒体文件名模板', '媒體檔名範本', 'メディア名のテンプレート', '미디어 파일 이름 템플릿', 'Plantilla de archivos multimedia', 'Modèle de nom des médias', 'Vorlage für Mediendateien', 'Modelo de nome da mídia'],
    assetNamePreview: ['Media filename preview', '媒体文件名预览', '媒體檔名預覽', 'メディア名のプレビュー', '미디어 파일 이름 미리 보기', 'Vista previa del nombre multimedia', 'Aperçu du nom des médias', 'Vorschau des Mediendateinamens', 'Prévia do nome da mídia'],
    outputFormat: ['Output format', '输出格式', '輸出格式', '出力形式', '출력 형식', 'Formato de salida', 'Format de sortie', 'Ausgabeformat', 'Formato de saída'],
    formatMarkdown: ['Markdown (.md)', 'Markdown（.md）', 'Markdown（.md）', 'Markdown（.md）', 'Markdown (.md)', 'Markdown (.md)', 'Markdown (.md)', 'Markdown (.md)', 'Markdown (.md)'],
    formatHtml: ['HTML archive (.zip)', 'HTML 档案（.zip）', 'HTML 檔案（.zip）', 'HTML アーカイブ（.zip）', 'HTML 보관 파일 (.zip)', 'Archivo HTML (.zip)', 'Archive HTML (.zip)', 'HTML-Archiv (.zip)', 'Arquivo HTML (.zip)'],
    formatEpub: ['EPUB book (.epub)', 'EPUB 电子书（.epub）', 'EPUB 電子書（.epub）', 'EPUB 電子書（.epub）', 'EPUB 전자책 (.epub)', 'Libro EPUB (.epub)', 'Livre EPUB (.epub)', 'EPUB-Buch (.epub)', 'Livro EPUB (.epub)'],
    formatTxt: ['Plain text (ZIP of .txt files)', '纯文本（TXT 文件 ZIP）', '純文字（TXT 檔案 ZIP）', 'テキスト（TXT の ZIP）', '일반 텍스트 (TXT ZIP)', 'Texto sin formato (ZIP de TXT)', 'Texte brut (ZIP de TXT)', 'Klartext (ZIP mit TXT-Dateien)', 'Texto simples (ZIP de TXT)'],
    htmlLayout: ['HTML reading layout', 'HTML 阅读布局', 'HTML 閱讀版面', 'HTML 閲覧レイアウト', 'HTML 읽기 레이아웃', 'Diseño de lectura HTML', 'Présentation HTML', 'HTML-Leselayout', 'Layout de leitura HTML'],
    previewHtml: ['Preview layout', '预览布局', '預覽版面', 'レイアウトをプレビュー', '레이아웃 미리 보기', 'Vista previa', 'Aperçu', 'Vorschau', 'Prévia'],
    statusPreviewBlocked: ['Preview window was blocked. Allow pop-ups for Slowly Web.', '预览窗口被拦截，请允许 Slowly Web 打开弹窗。', '預覽視窗遭到攔截，請允許 Slowly Web 開啟彈出式視窗。', 'プレビュー画面がブロックされました。Slowly Web のポップアップを許可してください。', '미리 보기 창이 차단되었습니다. Slowly Web의 팝업을 허용하세요.', 'Se bloqueó la ventana de vista previa. Permita ventanas emergentes para Slowly Web.', 'La fenêtre d’aperçu a été bloquée. Autorisez les fenêtres surgissantes pour Slowly Web.', 'Das Vorschaufenster wurde blockiert. Erlauben Sie Pop-ups für Slowly Web.', 'A janela de prévia foi bloqueada. Permita pop-ups para o Slowly Web.'],
    layoutSlowly: ['Classic letter view', '经典信件视图', '經典信件檢視', 'クラシックな手紙表示', '기본 편지 보기', 'Vista clásica de cartas', 'Vue classique des lettres', 'Klassische Briefansicht', 'Visualização clássica de cartas'],
    layoutAlbum: ['Photo and audio album', '图片与语音相册', '圖片與語音相簿', '写真と音声のアルバム', '사진·음성 앨범', 'Álbum de fotos y audios', 'Album photo et audio', 'Foto- und Audioalbum', 'Álbum de fotos e áudios'],
    layoutContinuous: ['Continuous reading', '连续阅读', '連續閱讀', '連続表示', '연속 읽기', 'Lectura continua', 'Lecture continue', 'Fortlaufendes Lesen', 'Leitura contínua'],
    layoutSidebar: ['Sidebar reader', '侧栏阅读器', '側欄閱讀器', 'サイドバー閲覧', '사이드바 읽기', 'Lector con barra lateral', 'Lecteur avec barre latérale', 'Leser mit Seitenleiste', 'Leitor com barra lateral'],
    layoutTimeline: ['Timeline cards', '时间轴卡片', '時間軸卡片', 'タイムラインカード', '타임라인 카드', 'Tarjetas cronológicas', 'Cartes chronologiques', 'Zeitleistenkarten', 'Cartões de linha do tempo'],
    layoutGallery: ['Stamp gallery', '邮票图录', '郵票圖錄', '切手ギャラリー', '우표 갤러리', 'Galería de sellos', 'Galerie de timbres', 'Briefmarkengalerie', 'Galeria de selos'],
    accentColor: ['Accent color', '主题色', '主題色', 'アクセントカラー', '강조 색상', 'Color de acento', 'Couleur d’accent', 'Akzentfarbe', 'Cor de destaque'],
    formatHintHtml: ['One ZIP with index.html and local assets. Extract it before opening.', '生成包含 index.html 和本地附件的 ZIP；请先解压再打开。', '產生包含 index.html 和本機附件的 ZIP；請先解壓再開啟。', 'index.html と添付ファイルを ZIP にまとめます。展開してから開いてください。', 'index.html과 첨부 파일을 ZIP으로 묶습니다. 압축을 푼 뒤 여세요.', 'Un ZIP con index.html y adjuntos locales. Extráigalo antes de abrirlo.', 'Un ZIP avec index.html et pièces jointes locales. Extrayez-le avant ouverture.', 'Ein ZIP mit index.html und lokalen Anhängen. Vor dem Öffnen entpacken.', 'Um ZIP com index.html e anexos locais. Extraia antes de abrir.'],
    formatHintEpub: ['One EPUB with chapters and a table of contents in your reader.', '生成一本标准 EPUB，以章节和阅读器目录浏览。', '產生一本標準 EPUB，以章節和閱讀器目錄瀏覽。', '章とリーダーの目次を備えた標準 EPUB を作成します。', '장과 리더 목차가 있는 표준 EPUB 한 권을 만듭니다.', 'Un EPUB estándar con capítulos e índice del lector.', 'Un EPUB standard avec chapitres et sommaire du lecteur.', 'Ein Standard-EPUB mit Kapiteln und Inhaltsverzeichnis des Lesers.', 'Um EPUB padrão com capítulos e sumário do leitor.'],
    formatHintTxt: ['One ZIP with a .txt file per letter and numbered attachments in the same folder.', '生成一个 ZIP：每封信一个 TXT，附件按类别编号并放在同级目录。', '產生一個 ZIP：每封信一個 TXT，附件依類別編號並放在同層目錄。', '手紙ごとの TXT と種類別に番号を付けた添付ファイルを同じ ZIP に保存します。', '편지별 TXT와 종류별 번호가 붙은 첨부 파일을 같은 ZIP에 저장합니다.', 'Un ZIP con un TXT por carta y adjuntos numerados por categoría junto a ellos.', 'Un ZIP avec un TXT par lettre et les pièces jointes numérotées par catégorie à côté.', 'Ein ZIP mit einer TXT-Datei je Brief und daneben Anhängen mit Kategorie und Nummer.', 'Um ZIP com um TXT por carta e anexos numerados por categoria ao lado.'],
    archiveTitle: ['Slowly letters', 'Slowly 书信', 'Slowly 書信', 'Slowly の手紙', 'Slowly 편지', 'Cartas de Slowly', 'Lettres Slowly', 'Slowly-Briefe', 'Cartas do Slowly'],
    archiveLetter: ['Letter', '信件', '信件', '手紙', '편지', 'Carta', 'Lettre', 'Brief', 'Carta'],
    archiveLetters: ['Letters', '信件目录', '信件目錄', '手紙一覧', '편지 목록', 'Cartas', 'Lettres', 'Briefe', 'Cartas'],
    archiveContents: ['Contents', '目录', '目錄', '目次', '목차', 'Índice', 'Sommaire', 'Inhalt', 'Sumário'],
    archiveNewer: ['Newer letter', '较新信件', '較新信件', '新しい手紙', '새 편지', 'Carta más reciente', 'Lettre plus récente', 'Neuerer Brief', 'Carta mais recente'],
    archiveOlder: ['Older letter', '较旧信件', '較舊信件', '古い手紙', '오래된 편지', 'Carta más antigua', 'Lettre plus ancienne', 'Älterer Brief', 'Carta mais antiga'],
    archiveAttachments: ['Attachments', '附件', '附件', '添付ファイル', '첨부 파일', 'Adjuntos', 'Pièces jointes', 'Anhänge', 'Anexos'],
    archiveNoMedia: ['No pictures or voice messages were found in these letters.', '这些信件中没有图片或语音。', '這些信件中沒有圖片或語音。', 'これらの手紙には写真も音声もありません。', '이 편지에는 사진이나 음성이 없습니다.', 'No hay fotos ni mensajes de voz en estas cartas.', 'Aucune photo ni aucun message vocal dans ces lettres.', 'In diesen Briefen gibt es keine Bilder oder Sprachnachrichten.', 'Não há fotos nem mensagens de voz nessas cartas.'],
    archiveStamp: ['Stamp', '邮票', '郵票', '切手', '우표', 'Sello', 'Timbre', 'Briefmarke', 'Selo'],
    archiveAvatar: ['Avatar', '头像', '頭像', 'アバター', '아바타', 'Avatar', 'Avatar', 'Profilbild', 'Avatar'],
    archiveUnknown: ['Unknown', '未知', '未知', '不明', '알 수 없음', 'Desconocido', 'Inconnu', 'Unbekannt', 'Desconhecido'],
    outputMode: ['Letter output', '信件输出方式', '信件輸出方式', '手紙の出力形式', '편지 출력 방식', 'Salida de cartas', 'Sortie des lettres', 'Briefausgabe', 'Saída de cartas'],
    modeZip: ['One ZIP, separate letters', '一个 ZIP，逐封信件', '一個 ZIP，逐封信件', '個別の手紙を ZIP にまとめる', '개별 편지를 ZIP으로 묶기', 'Un ZIP con cartas separadas', 'Un ZIP avec lettres séparées', 'Ein ZIP mit einzelnen Briefen', 'Um ZIP com cartas separadas'],
    modeSingle: ['One long Markdown + assets.zip', '一个长文档 + assets.zip', '一個長文件 + assets.zip', '長い Markdown 1 件 + assets.zip', '긴 Markdown 1개 + assets.zip', 'Un Markdown largo + assets.zip', 'Un long Markdown + assets.zip', 'Ein langes Markdown + assets.zip', 'Um Markdown longo + assets.zip'],
    modeDirect: ['Download each letter', '逐封直接下载', '逐封直接下載', '手紙を個別にダウンロード', '편지별로 다운로드', 'Descargar cada carta', 'Télécharger chaque lettre', 'Jeden Brief herunterladen', 'Baixar cada carta'],
    assetLayout: ['Attachment folders', '附件目录', '附件目錄', '添付ファイルのフォルダー', '첨부 파일 폴더', 'Carpetas de adjuntos', 'Dossiers des pièces jointes', 'Anhangordner', 'Pastas de anexos'],
    layoutRoot: ['Same folder as letters', '与信件同目录', '與信件同目錄', '手紙と同じフォルダー', '편지와 같은 폴더', 'Junto a las cartas', 'Dans le dossier des lettres', 'Im Ordner der Briefe', 'Na mesma pasta das cartas'],
    layoutAssets: ['assets/ folder', 'assets/ 目录', 'assets/ 目錄', 'assets/ フォルダー', 'assets/ 폴더', 'Carpeta assets/', 'Dossier assets/', 'Ordner assets/', 'Pasta assets/'],
    layoutCategory: ['Folders by type', '按类别分目录', '依類別分目錄', '種類別フォルダー', '종류별 폴더', 'Carpetas por tipo', 'Dossiers par type', 'Ordner nach Typ', 'Pastas por tipo'],
    style: ['Markdown style', 'Markdown 样式', 'Markdown 樣式', 'Markdown スタイル', 'Markdown 스타일', 'Estilo Markdown', 'Style Markdown', 'Markdown-Stil', 'Estilo Markdown'],
    styleSimple: ['Simple', '简洁', '簡潔', 'シンプル', '간단', 'Simple', 'Simple', 'Einfach', 'Simples'],
    styleRich: ['Rich', '图文', '圖文', 'リッチ', '풍부하게', 'Con imágenes', 'Enrichi', 'Mit Bildern', 'Com imagens'],
    styleCompact: ['Compact', '紧凑', '緊湊', 'コンパクト', '간결', 'Compacto', 'Compact', 'Kompakt', 'Compacto'],
    cache: ['Keep local letter archive', '保存本地信件存档', '儲存本機信件存檔', '手紙をローカル保存', '편지 로컬 보관', 'Guardar archivo local', 'Conserver une archive locale', 'Lokales Briefarchiv', 'Guardar arquivo local'],
    cacheHint: ['Text, metadata and attachment URLs only. Browser data can be erased.', '仅存正文、元数据与附件 URL；清理浏览器数据会删除存档。', '僅存內文、元資料與附件 URL；清理瀏覽器資料會刪除存檔。', '本文・情報・添付 URL のみ保存。ブラウザーのデータ削除で失われます。', '본문, 메타데이터, 첨부 URL만 저장합니다. 브라우저 데이터 삭제 시 사라집니다.', 'Solo texto, datos y URL de adjuntos. Los datos del navegador pueden borrarse.', 'Texte, métadonnées et URL des pièces jointes uniquement. Les données du navigateur peuvent être effacées.', 'Nur Text, Metadaten und Anhang-URLs. Browserdaten können gelöscht werden.', 'Somente texto, metadados e URLs de anexos. Dados do navegador podem ser apagados.'],
    exportAll: ['Export all letters', '导出全部信件', '匯出全部信件', 'すべての手紙を出力', '모든 편지 내보내기', 'Exportar todas las cartas', 'Exporter toutes les lettres', 'Alle Briefe exportieren', 'Exportar todas as cartas'],
    exportAllHint: ['Also include letters you exported before.', '勾选后，也会包含以前导出过的信件。', '勾選後，也會包含以前匯出過的信件。', '以前に出力した手紙も含めます。', '이전에 내보낸 편지도 포함합니다.', 'Incluye también las cartas exportadas anteriormente.', 'Inclut aussi les lettres déjà exportées.', 'Bereits exportierte Briefe werden ebenfalls einbezogen.', 'Inclui também cartas exportadas anteriormente.'],
    archiveManagement: ['Archive management', '存档管理', '存檔管理', '保存データの管理', '보관함 관리', 'Administrar archivo', 'Gestion de l’archive', 'Archivverwaltung', 'Gerenciar arquivo'],
    viewArchiveStatus: ['View archive status', '查看存档状态', '檢視存檔狀態', '保存状況を表示', '보관 상태 보기', 'Ver estado del archivo', 'Voir l’état de l’archive', 'Archivstatus anzeigen', 'Ver estado do arquivo'],
    archiveLettersCount: ['letters', '封信件', '封信件', '通の手紙', '통의 편지', 'cartas', 'lettres', 'Briefe', 'cartas'],
    archivePenPals: ['pen pals', '位笔友', '位筆友', '人の文通相手', '명의 펜팔', 'amigos por carta', 'correspondants', 'Brieffreunde', 'amigos por carta'],
    archiveAttachmentsCount: ['attachments', '个附件', '個附件', '件の添付ファイル', '개의 첨부 파일', 'adjuntos', 'pièces jointes', 'Anhänge', 'anexos'],
    archiveOldest: ['Oldest', '最旧', '最舊', '最古', '가장 오래된 날짜', 'Más antigua', 'Plus ancienne', 'Älteste', 'Mais antiga'],
    archiveNewest: ['Newest', '最新', '最新', '最新', '가장 최근 날짜', 'Más reciente', 'Plus récente', 'Neueste', 'Mais recente'],
    archiveNoAttachments: ['No attachments', '无附件', '無附件', '添付ファイルなし', '첨부 파일 없음', 'Sin adjuntos', 'Aucune pièce jointe', 'Keine Anhänge', 'Sem anexos'],
    archiveEmpty: ['No archived letters for this pen name.', '此笔名下没有已存档信件。', '此筆名下沒有已存檔信件。', 'このペンネームの保存済み手紙はありません。', '이 필명으로 보관된 편지가 없습니다.', 'No hay cartas archivadas para este seudónimo.', 'Aucune lettre archivée pour ce pseudonyme.', 'Keine archivierten Briefe für diesen Namen.', 'Não há cartas arquivadas para este nome.'],
    archiveTypePicture: ['picture', '图片', '圖片', '画像', '사진', 'imagen', 'image', 'Bild', 'imagem'],
    archiveTypeVoice: ['voice', '语音', '語音', '音声', '음성', 'audio', 'audio', 'Audio', 'áudio'],
    archiveTypeVideo: ['video', '视频', '影片', '動画', '동영상', 'vídeo', 'vidéo', 'Video', 'vídeo'],
    creditPrefix: ['Based on ', '基于 ', '基於 ', '原作：', '원본: ', 'Basado en ', 'Basé sur ', 'Basierend auf ', 'Baseado em '],
    creditSuffix: [' (original author HUM4N_F1L3.json — thank you!)', ' 制作（原作者HUM4N_F1L3.json，谢谢你！）', ' 製作（原作者HUM4N_F1L3.json，謝謝你！）', ' を元に制作（原作者 HUM4N_F1L3.json、ありがとうございます！）', ' 기반으로 제작 (원작자 HUM4N_F1L3.json님, 감사합니다!)', ' (autor original: HUM4N_F1L3.json; ¡gracias!)', ' (auteur original : HUM4N_F1L3.json, merci !)', ' (Originalautor: HUM4N_F1L3.json – vielen Dank!)', ' (autor original: HUM4N_F1L3.json, obrigado!)'],
    middleLetterPrompt: ['Both letter arrows are available. Choose how to proceed.', '当前信件的两个翻页箭头均可用。请选择下一步。', '目前信件的兩個翻頁箭頭均可用。請選擇下一步。', '両方向に移動できます。続行方法を選んでください。', '양쪽 편지 화살표를 모두 사용할 수 있습니다. 진행 방법을 선택하세요.', 'Las dos flechas están disponibles. Elija cómo continuar.', 'Les deux flèches sont disponibles. Choisissez comment continuer.', 'Beide Briefpfeile sind verfügbar. Wählen Sie das weitere Vorgehen.', 'As duas setas estão disponíveis. Escolha como continuar.'],
    navigateManually: ['Stop; I will open the newest or oldest letter', '中断；我会手动翻到最新或最旧信件', '中斷；我會手動翻到最新或最舊信件', '中止して最新または最古の手紙を手動で開く', '중단하고 최신 또는 가장 오래된 편지를 직접 열기', 'Detener; abriré manualmente la carta más nueva o antigua', 'Arrêter ; j’ouvrirai manuellement la lettre la plus récente ou ancienne', 'Stoppen; ich öffne den neuesten oder ältesten Brief selbst', 'Parar; abrirei manualmente a carta mais recente ou antiga'],
    continueFromMiddle: ['Continue exporting from this letter', '仍然从当前信件开始导出', '仍然從目前信件開始匯出', 'この手紙から出力を続ける', '이 편지부터 내보내기 계속', 'Continuar exportando desde esta carta', 'Continuer l’export depuis cette lettre', 'Export ab diesem Brief fortsetzen', 'Continuar a exportação a partir desta carta'],
    middleLetterOptions: ['Choose the first direction and what happens at the end.', '选择先翻页的方向，以及到达尽头后的行为。', '選擇先翻頁的方向，以及到達盡頭後的行為。', '最初の方向と端に着いた後の動作を選んでください。', '처음 이동할 방향과 끝에 도달했을 때의 동작을 선택하세요.', 'Elija la primera dirección y qué hacer al llegar al final.', 'Choisissez le premier sens et l’action à la fin.', 'Wählen Sie die erste Richtung und die Aktion am Ende.', 'Escolha a primeira direção e a ação ao chegar ao fim.'],
    directionLabel: ['First direction', '先翻页的方向', '先翻頁的方向', '最初の方向', '처음 이동할 방향', 'Primera dirección', 'Premier sens', 'Erste Richtung', 'Primeira direção'],
    directionOlder: ['Toward older letters', '向较旧信件翻', '往較舊信件翻', '古い手紙へ', '오래된 편지로', 'Hacia cartas más antiguas', 'Vers les lettres plus anciennes', 'Zu älteren Briefen', 'Rumo às cartas mais antigas'],
    directionNewer: ['Toward newer letters', '向较新信件翻', '往較新信件翻', '新しい手紙へ', '최신 편지로', 'Hacia cartas más recientes', 'Vers les lettres plus récentes', 'Zu neueren Briefen', 'Rumo às cartas mais recentes'],
    endBehaviorLabel: ['At the end', '到达尽头后', '到達盡頭後', '端に着いたら', '끝에 도달하면', 'Al llegar al final', 'À l’extrémité', 'Am Ende', 'Ao chegar ao fim'],
    endStop: ['Stop and export this segment only', '停止，只导出经过的这一段', '停止，只匯出經過的這一段', '停止し、この範囲だけ出力', '중단하고 이 구간만 내보내기', 'Detener y exportar solo este tramo', 'Arrêter et exporter ce segment seulement', 'Stoppen und nur diesen Abschnitt exportieren', 'Parar e exportar somente este trecho'],
    endReverse: ['Reverse and cover the whole conversation', '折返，遍历整段通信', '折返，遍歷整段通信', '折り返して会話全体をたどる', '되돌아가 대화 전체 탐색', 'Volver y recorrer toda la conversación', 'Revenir et parcourir toute la conversation', 'Umkehren und alle Briefe durchlaufen', 'Voltar e percorrer toda a conversa'],
    reverseWarning: ['Reversing traverses some letters twice and can take a long time. Stopping exports only the visited segment; its indices are relative to that segment and the incremental checkpoint will not advance.', '折返会重复翻阅部分信件，可能很耗时。到头停止只导出经过的一段；序号按这一段计算，且不会更新增量断点。', '折返會重複翻閱部分信件，可能很耗時。到頭停止只匯出經過的一段；序號按這一段計算，且不會更新增量斷點。', '折り返すと一部の手紙を二度通り、時間がかかります。停止時は通った範囲だけを出力し、番号はその範囲内の番号になります。増分記録は更新しません。', '되돌아가면 일부 편지를 두 번 방문하므로 시간이 오래 걸릴 수 있습니다. 끝에서 멈추면 방문한 구간만 내보내며 번호는 해당 구간 기준이고 증분 기록은 갱신되지 않습니다.', 'Volver recorre algunas cartas dos veces y puede tardar. Detenerse exporta solo el tramo visitado; sus números son relativos y no se actualiza el punto de exportación.', 'Le retour parcourt certaines lettres deux fois et peut prendre du temps. L’arrêt n’exporte que le segment visité ; sa numérotation est relative et le point de reprise n’est pas mis à jour.', 'Beim Umkehren werden einige Briefe zweimal besucht; das kann dauern. Beim Stoppen wird nur der besuchte Abschnitt exportiert, relativ nummeriert und ohne Aktualisierung des Exportpunkts.', 'Voltar percorre algumas cartas duas vezes e pode demorar. Parar exporta só o trecho visitado, com numeração relativa e sem atualizar o ponto de exportação.'],
    startExport: ['Start', '开始', '開始', '開始', '시작', 'Iniciar', 'Démarrer', 'Starten', 'Iniciar'],
    statusPartial: ['Partial export; checkpoint unchanged.', '局部导出；断点未更新。', '局部匯出；斷點未更新。', '一部のみ出力；再開地点は変更なし。', '부분 내보내기; 이어받기 지점은 변경되지 않았습니다.', 'Exportación parcial; punto de reanudación sin cambios.', 'Export partiel ; point de reprise inchangé.', 'Teilexport; Exportpunkt unverändert.', 'Exportação parcial; ponto de retomada inalterado.'],
    exportLetters: ['Export letters', '导出信件', '匯出信件', '手紙を出力', '편지 내보내기', 'Exportar cartas', 'Exporter les lettres', 'Briefe exportieren', 'Exportar cartas'],
    quickExport: ['Export', '导出', '匯出', '出力', '내보내기', 'Exportar', 'Exporter', 'Exportieren', 'Exportar'],
    exportStamps: ['Export current stamp album', '导出当前邮票册', '匯出目前郵票冊', '現在の切手アルバムを出力', '현재 우표 앨범 내보내기', 'Exportar álbum actual', 'Exporter cet album', 'Aktuelles Album exportieren', 'Exportar álbum atual'],
    exportLetterStamps: ['Export letter stamps only', '仅导出信件邮票', '僅匯出信件郵票', '手紙の切手のみ出力', '편지 우표만 내보내기', 'Exportar solo sellos de cartas', 'Exporter les timbres des lettres', 'Nur Briefmarken exportieren', 'Exportar só selos das cartas'],
    fillArchive: ['Fill local archive', '补全本地存档', '補全本機存檔', 'ローカル保存を補完', '로컬 보관함 채우기', 'Completar archivo local', 'Compléter l’archive locale', 'Lokales Archiv füllen', 'Completar arquivo local'],
    backupArchive: ['Back up archive', '备份存档', '備份存檔', '保存データをバックアップ', '보관함 백업', 'Respaldar archivo', 'Sauvegarder l’archive', 'Archiv sichern', 'Fazer backup do arquivo'],
    restoreArchive: ['Restore archive', '恢复存档', '還原存檔', '保存データを復元', '보관함 복원', 'Restaurar archivo', 'Restaurer l’archive', 'Archiv wiederherstellen', 'Restaurar arquivo'],
    clearArchive: ['Clear archive', '清除存档', '清除存檔', '保存データを削除', '보관함 지우기', 'Borrar archivo', 'Effacer l’archive', 'Archiv löschen', 'Limpar arquivo'],
    cancel: ['Cancel', '取消', '取消', '中止', '취소', 'Cancelar', 'Annuler', 'Abbrechen', 'Cancelar'],
    statusReady: ['Ready', '就绪', '就緒', '準備完了', '준비됨', 'Listo', 'Prêt', 'Bereit', 'Pronto'],
    statusScanning: ['Reading letters…', '正在读取信件…', '正在讀取信件…', '手紙を読み込み中…', '편지 읽는 중…', 'Leyendo cartas…', 'Lecture des lettres…', 'Briefe werden gelesen…', 'Lendo cartas…'],
    statusBuilding: ['Preparing downloads…', '正在准备下载…', '正在準備下載…', 'ダウンロードを準備中…', '다운로드 준비 중…', 'Preparando descargas…', 'Préparation des téléchargements…', 'Downloads werden vorbereitet…', 'Preparando downloads…'],
    statusAssetProgress: ['Downloading attachments…', '正在下载附件…', '正在下載附件…', '添付ファイルをダウンロード中…', '첨부 파일 다운로드 중…', 'Descargando adjuntos…', 'Téléchargement des pièces jointes…', 'Anhänge werden geladen…', 'Baixando anexos…'],
    statusRendering: ['Formatting letters…', '正在排版信件…', '正在排版信件…', '手紙を整形中…', '편지 서식 지정 중…', 'Dando formato a las cartas…', 'Mise en forme des lettres…', 'Briefe werden formatiert…', 'Formatando cartas…'],
    statusSeekingEnd: ['Moving to the end of the conversation… letter', '正在寻找通信尽头…第', '正在尋找通信盡頭…第', '会話の終端を検索中…手紙', '대화 끝으로 이동 중…편지', 'Buscando el final de la conversación… carta', 'Recherche de la fin de la conversation… lettre', 'Suche nach dem Gesprächsende… Brief', 'Buscando o fim da conversa… carta'],
    statusCheckingArchive: ['Checking the local archive…', '正在检查本地存档…', '正在檢查本機存檔…', 'ローカル保存を確認中…', '로컬 보관함 확인 중…', 'Comprobando el archivo local…', 'Vérification de l’archive locale…', 'Lokales Archiv wird geprüft…', 'Verificando o arquivo local…'],
    statusSavingArchive: ['Saving letters locally…', '正在保存本地信件…', '正在儲存本機信件…', '手紙をローカル保存中…', '편지를 로컬에 저장 중…', 'Guardando cartas localmente…', 'Enregistrement local des lettres…', 'Briefe werden lokal gespeichert…', 'Salvando cartas localmente…'],
    statusStartingDownloads: ['Starting downloads…', '正在启动下载…', '正在開始下載…', 'ダウンロードを開始中…', '다운로드 시작 중…', 'Iniciando descargas…', 'Démarrage des téléchargements…', 'Downloads werden gestartet…', 'Iniciando downloads…'],
    statusBackingUp: ['Preparing archive backup…', '正在准备存档备份…', '正在準備存檔備份…', 'バックアップを準備中…', '보관함 백업 준비 중…', 'Preparando copia del archivo…', 'Préparation de la sauvegarde…', 'Archiv-Backup wird vorbereitet…', 'Preparando backup do arquivo…'],
    statusRestoring: ['Restoring local archive…', '正在恢复本地存档…', '正在還原本機存檔…', 'ローカル保存を復元中…', '로컬 보관함 복원 중…', 'Restaurando el archivo local…', 'Restauration de l’archive locale…', 'Lokales Archiv wird wiederhergestellt…', 'Restaurando o arquivo local…'],
    statusClearingArchive: ['Clearing local archive…', '正在清除本地存档…', '正在清除本機存檔…', 'ローカル保存を削除中…', '로컬 보관함 삭제 중…', 'Borrando el archivo local…', 'Suppression de l’archive locale…', 'Lokales Archiv wird gelöscht…', 'Limpando o arquivo local…'],
    statusDone: ['Download started.', '已开始下载。', '已開始下載。', 'ダウンロードを開始しました。', '다운로드가 시작되었습니다.', 'Descarga iniciada.', 'Téléchargement lancé.', 'Download gestartet.', 'Download iniciado.'],
    statusArchiveDone: ['Local archive operation completed.', '本地存档操作已完成。', '本機存檔操作已完成。', 'ローカル保存の操作が完了しました。', '로컬 보관함 작업이 완료되었습니다.', 'Operación del archivo local completada.', 'Opération de l’archive locale terminée.', 'Lokaler Archivvorgang abgeschlossen.', 'Operação do arquivo local concluída.'],
    statusNoNew: ['No new letters.', '没有新信件。', '沒有新信件。', '新しい手紙はありません。', '새 편지가 없습니다.', 'No hay cartas nuevas.', 'Aucune nouvelle lettre.', 'Keine neuen Briefe.', 'Nenhuma carta nova.'],
    statusMissingCheckpoint: ['Previous export point not found. Select Export all letters.', '找不到上次导出终点，请选择“导出全部”。', '找不到上次匯出終點，請選擇「匯出全部」。', '前回の終点が見つかりません。すべて出力してください。', '이전 내보내기 지점을 찾을 수 없습니다. 모두 내보내기를 선택하세요.', 'No se encontró el punto anterior. Exporte todo.', 'Point précédent introuvable. Exportez tout.', 'Letzter Exportpunkt nicht gefunden. Alles exportieren.', 'Ponto anterior não encontrado. Exporte tudo.'],
    statusCancelled: ['Export cancelled.', '已取消导出。', '已取消匯出。', '出力を中止しました。', '내보내기를 취소했습니다.', 'Exportación cancelada.', 'Export annulé.', 'Export abgebrochen.', 'Exportação cancelada.'],
    statusNavigation: ['Letter navigation did not advance.', '信件翻页未成功。', '信件翻頁未成功。', '次の手紙に移動できませんでした。', '다음 편지로 이동하지 못했습니다.', 'No se pudo avanzar a otra carta.', 'Impossible de passer à une autre lettre.', 'Briefnavigation ist nicht weitergegangen.', 'Não foi possível avançar para outra carta.'],
    statusEnableCache: ['Enable the local archive first.', '请先启用本地存档。', '請先啟用本機存檔。', '先にローカル保存を有効にしてください。', '먼저 로컬 보관함을 켜세요.', 'Active primero el archivo local.', 'Activez d’abord l’archive locale.', 'Aktivieren Sie zuerst das lokale Archiv.', 'Ative primeiro o arquivo local.'],
    statusNoStamps: ['No stamp images in this album.', '这个邮票册没有图片。', '這個郵票冊沒有圖片。', 'このアルバムに切手画像はありません。', '이 앨범에는 우표 이미지가 없습니다.', 'No hay imágenes de sellos en este álbum.', 'Aucune image de timbre dans cet album.', 'Dieses Album enthält keine Briefmarkenbilder.', 'Não há imagens de selos neste álbum.'],
    statusNoLetterStamps: ['No stamps found in these letters.', '这些信件中没有找到邮票。', '這些信件中沒有找到郵票。', 'これらの手紙に切手は見つかりませんでした。', '이 편지들에서 우표를 찾지 못했습니다.', 'No se encontraron sellos en estas cartas.', 'Aucun timbre trouvé dans ces lettres.', 'In diesen Briefen wurden keine Briefmarken gefunden.', 'Nenhum selo encontrado nessas cartas.'],
    statusTimeout: ['Timed out waiting for the next letter.', '等待下一封信超时。', '等待下一封信逾時。', '次の手紙の読み込みがタイムアウトしました。', '다음 편지를 기다리다가 시간이 초과되었습니다.', 'Se agotó la espera de la siguiente carta.', 'Délai dépassé pour la lettre suivante.', 'Zeitüberschreitung beim nächsten Brief.', 'Tempo esgotado ao aguardar a próxima carta.'],
    statusSafetyLimit: ['Stopped after too many letters.', '信件数量超过安全上限，已停止。', '信件數量超過安全上限，已停止。', '手紙の件数が安全上限を超えたため停止しました。', '편지 수가 안전 한도를 넘어 중지했습니다.', 'Se detuvo al superar el límite de cartas.', 'Arrêt après dépassement du nombre maximal de lettres.', 'Wegen zu vieler Briefe gestoppt.', 'Interrompido após exceder o limite de cartas.'],
    statusNoContext: ['Open a letter or stamp album first.', '请先打开信件或邮票册。', '請先開啟信件或郵票冊。', '先に手紙または切手アルバムを開いてください。', '먼저 편지나 우표 앨범을 여세요.', 'Abra una carta o álbum primero.', 'Ouvrez d’abord une lettre ou un album.', 'Öffnen Sie zuerst einen Brief oder ein Album.', 'Abra uma carta ou álbum primeiro.'],
    statusAccountRequired: ['Enter your pen name first.', '请先填写笔名。', '請先填寫筆名。', '先にペンネームを入力してください。', '먼저 필명을 입력하세요.', 'Escriba primero su seudónimo.', 'Saisissez d’abord votre pseudonyme.', 'Geben Sie zuerst Ihr Pseudonym ein.', 'Digite primeiro seu pseudônimo.'],
    statusSettingsNotSaved: ['Settings could not be saved in this browser.', '无法在此浏览器保存设置。', '無法在此瀏覽器儲存設定。', 'このブラウザーに設定を保存できません。', '이 브라우저에 설정을 저장할 수 없습니다.', 'No se pudo guardar la configuración en este navegador.', 'Impossible d’enregistrer les paramètres dans ce navigateur.', 'Einstellungen konnten in diesem Browser nicht gespeichert werden.', 'Não foi possível salvar as configurações neste navegador.'],
    statusProgressNotSaved: ['The download started, but export progress could not be saved in this browser.', '下载已开始，但无法在此浏览器保存导出进度。', '下載已開始，但無法在此瀏覽器儲存匯出進度。', 'ダウンロードは開始しましたが、このブラウザーに出力の進捗を保存できませんでした。', '다운로드는 시작됐지만 브라우저에 내보내기 진행 상태를 저장하지 못했습니다.', 'La descarga comenzó, pero no se pudo guardar el progreso en este navegador.', 'Le téléchargement a commencé, mais la progression n’a pas pu être enregistrée dans ce navigateur.', 'Der Download wurde gestartet, aber der Exportfortschritt konnte in diesem Browser nicht gespeichert werden.', 'O download começou, mas não foi possível salvar o progresso da exportação neste navegador.'],
    statusArchiveUnavailable: ['The local archive is unavailable; this download was not saved there.', '本地存档不可用；本次下载未存入其中。', '本機存檔無法使用；本次下載未存入其中。', 'ローカル保存を利用できず、今回の内容は保存されませんでした。', '로컬 보관함을 사용할 수 없어 이번 다운로드는 저장되지 않았습니다.', 'El archivo local no está disponible; esta descarga no se guardó allí.', 'L’archive locale est indisponible ; ce téléchargement n’y a pas été enregistré.', 'Das lokale Archiv ist nicht verfügbar; dieser Download wurde dort nicht gespeichert.', 'O arquivo local está indisponível; este download não foi salvo nele.'],
    statusAccountDetectionFailed: ['Could not detect your pen name. Set it in the gear menu before exporting.', '无法自动识别笔名，请在导出前到齿轮菜单中填写。', '無法自動辨識筆名，請在匯出前到齒輪選單中填寫。', 'ペンネームを自動検出できませんでした。出力前に設定してください。', '필명을 자동으로 찾지 못했습니다. 내보내기 전에 설정에서 입력하세요.', 'No se pudo detectar tu seudónimo. Configúralo antes de exportar.', 'Impossible de détecter votre pseudonyme. Définissez-le avant l’export.', 'Der Benutzername wurde nicht erkannt. Bitte vor dem Export in den Einstellungen eintragen.', 'Não foi possível detectar seu nome. Defina-o nas configurações antes de exportar.'],
    statusError: ['Export stopped', '导出已停止', '匯出已停止', '出力を停止しました', '내보내기가 중지되었습니다', 'Exportación detenida', 'Export arrêté', 'Export gestoppt', 'Exportação interrompida'],
    warningDirect: ['Your browser may ask to allow multiple downloads.', '浏览器可能要求允许多个文件下载。', '瀏覽器可能要求允許下載多個檔案。', '複数のダウンロードの許可が必要な場合があります。', '여러 파일 다운로드 허용이 필요할 수 있습니다.', 'El navegador puede pedir permiso para varias descargas.', 'Le navigateur peut demander l’autorisation de téléchargements multiples.', 'Der Browser fragt möglicherweise nach mehreren Downloads.', 'O navegador pode pedir permissão para vários downloads.'],
    confirmDirect: ['Did all files download successfully? Mark this batch exported?', '所有文件都下载成功了吗？将本批次标记为已导出？', '所有檔案都下載成功了嗎？將本批次標記為已匯出？', 'すべて保存できましたか？今回を出力済みにしますか？', '모든 파일을 받으셨나요? 이번 내보내기를 완료로 표시할까요?', '¿Se descargaron todos los archivos? ¿Marcar como exportado?', 'Tous les fichiers sont-ils téléchargés ? Marquer comme exportés ?', 'Wurden alle Dateien gespeichert? Als exportiert markieren?', 'Todos os arquivos foram baixados? Marcar como exportado?'],
    confirmClear: ['Delete this account’s local letter archive?', '删除该账号的本地信件存档？', '刪除此帳號的本機信件存檔？', 'このアカウントのローカル保存を削除しますか？', '이 계정의 로컬 편지 보관함을 삭제할까요?', '¿Borrar el archivo local de esta cuenta?', 'Supprimer l’archive locale de ce compte ?', 'Lokales Archiv dieses Kontos löschen?', 'Excluir o arquivo local desta conta?'],
    confirmRestore: ['Replace this account’s local letter archive with the selected backup?', '用所选备份替换该账号的本地信件存档？', '使用所選備份取代此帳號的本機信件存檔？', '選択したバックアップでこのアカウントのローカル保存を置き換えますか？', '선택한 백업으로 이 계정의 로컬 편지 보관함을 교체할까요?', '¿Reemplazar el archivo local de esta cuenta con la copia seleccionada?', 'Remplacer l’archive locale de ce compte par la sauvegarde sélectionnée ?', 'Lokales Archiv dieses Kontos durch die ausgewählte Sicherung ersetzen?', 'Substituir o arquivo local desta conta pelo backup selecionado?'],
    statusUsingArchive: ['Using local letter archive…', '正在使用本地信件存档…', '正在使用本機信件存檔…', 'ローカル保存の手紙を使用中…', '로컬 편지 보관함 사용 중…', 'Usando el archivo local…', 'Utilisation de l’archive locale…', 'Lokales Briefarchiv wird verwendet…', 'Usando o arquivo local…'],
    archiveChoiceHint: ['A complete local copy is available. Reuse it to avoid reading every letter again. Fetch all letters again only if the copy is incomplete or attachments failed to download. Attachments are downloaded again either way.', '已有完整本地副本。建议复用，避免再次逐封读取。仅当内容不全或附件下载失败时才重新获取全部信件。两种方式都会重新下载附件。', '已有完整本機副本。建議重複使用，避免再次逐封讀取。僅在內容不全或附件下載失敗時才重新取得全部信件。兩種方式都會重新下載附件。', '完全なローカルコピーがあります。手紙の再読み込みを避けるにはこれを使ってください。内容不足や添付ファイルの失敗時だけすべて再取得してください。添付ファイルはどちらも再ダウンロードします。', '완전한 로컬 복사본이 있습니다. 편지를 다시 읽지 않으려면 이를 사용하세요. 내용이 누락되거나 첨부 파일에 실패한 경우에만 모두 다시 가져오세요. 첨부 파일은 어느 쪽이든 다시 다운로드합니다.', 'Hay una copia local completa. Úsela para evitar releer todas las cartas. Vuelva a obtenerlas solo si faltan contenidos o fallaron adjuntos. Los adjuntos se descargan de nuevo en ambos casos.', 'Une copie locale complète est disponible. Utilisez-la pour éviter de relire toutes les lettres. Ne récupérez tout qu’en cas de contenu manquant ou d’échec des pièces jointes. Celles-ci sont retéléchargées dans les deux cas.', 'Eine vollständige lokale Kopie ist vorhanden. Verwenden Sie sie, um erneutes Lesen aller Briefe zu vermeiden. Laden Sie nur bei fehlenden Inhalten oder fehlgeschlagenen Anhängen alles neu. Anhänge werden in beiden Fällen erneut geladen.', 'Há uma cópia local completa. Use-a para evitar reler todas as cartas. Busque tudo novamente apenas se faltar conteúdo ou se os anexos falharam. Os anexos são baixados novamente em ambos os casos.'],
    useArchive: ['Use local archive', '使用本地存档', '使用本機存檔', 'ローカル保存を使う', '로컬 보관함 사용', 'Usar archivo local', 'Utiliser l’archive locale', 'Lokales Archiv verwenden', 'Usar arquivo local'],
    fetchAllAgain: ['Fetch all letters again', '重新获取全部信件', '重新取得全部信件', 'すべての手紙を再取得', '모든 편지 다시 가져오기', 'Volver a obtener todas las cartas', 'Récupérer toutes les lettres', 'Alle Briefe erneut laden', 'Buscar todas as cartas novamente'],
    statusStampTarget: ['Export will download stamps from the open collection.', '本次将导出当前打开的邮票收藏。', '本次將匯出目前開啟的郵票收藏。', '開いている切手コレクションを出力します。', '열려 있는 우표 컬렉션을 내보냅니다.', 'Se exportarán los sellos de la colección abierta.', 'Les timbres de la collection ouverte seront exportés.', 'Die Briefmarken der geöffneten Sammlung werden exportiert.', 'Os selos da coleção aberta serão exportados.'],
    confirmStampExport: ['Export the stamps in the open Stamp Collection instead of letters?', '当前打开的是邮票收藏。要导出其中的邮票而不是信件吗？', '目前開啟的是郵票收藏。要匯出其中的郵票而不是信件嗎？', '手紙ではなく、開いている切手コレクションを出力しますか？', '편지 대신 열려 있는 우표 컬렉션을 내보내시겠습니까?', '¿Exportar los sellos de la colección abierta en lugar de las cartas?', 'Exporter les timbres de la collection ouverte au lieu des lettres ?', 'Briefmarken der geöffneten Sammlung statt Briefe exportieren?', 'Exportar os selos da coleção aberta em vez das cartas?'],
    statusStampProgress: ['Downloading stamps…', '正在下载邮票…', '正在下載郵票…', '切手をダウンロード中…', '우표 다운로드 중…', 'Descargando sellos…', 'Téléchargement des timbres…', 'Briefmarken werden geladen…', 'Baixando selos…'],
    statusZipProgress: ['Compressing ZIP…', '正在压缩 ZIP…', '正在壓縮 ZIP…', 'ZIP を圧縮中…', 'ZIP 압축 중…', 'Comprimiendo ZIP…', 'Compression du ZIP…', 'ZIP wird komprimiert…', 'Compactando ZIP…'],
  };
  const translations = Object.fromEntries(SUPPORTED_LOCALES.map((locale, i) => [locale,
    Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[i]]))]));
  function t(locale, key) { return (translations[locale] || translations.en)[key] || translations.en[key] || key; }
  const api = { SUPPORTED_LOCALES, translations, t };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Letter renderers for HTML, EPUB, and TXT. GPL-3.0-only. */
(function (root) {
  'use strict';
  const i18n = typeof module !== 'undefined' && module.exports ? require('./i18n') : root.SEP;
  const DEFAULT_ACCENT = '#b88700';
  const tr = (locale, key) => i18n.t(locale || 'en', key);
  const escapeXml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const normalizeAccent = value => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : DEFAULT_ACCENT;
  const localHref = path => String(path || '').split('/').map(encodeURIComponent).join('/');
  const ofLetter = (assets, letter) => assets.filter(asset => asset.letterId === letter.id);
  const assetOfType = (assets, type) => assets.find(asset => asset.type === type);

  function mediaMarkup(asset, epub = false, locale = 'en') {
    const href = escapeXml(localHref(asset.path));
    const label = escapeXml(asset.alt || asset.type || tr(locale, 'archiveAttachments'));
    if (['picture', 'stamp', 'avatar'].includes(asset.type)) {
      if (epub && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(asset.path)) {
        return `<p class="letter-media">${label}: ${escapeXml(asset.path)}</p>`;
      }
      return `<figure class="letter-media"><img src="${href}" alt="${label}"${epub ? ' />' : '>'}</figure>`;
    }
    if (epub && asset.type === 'voice' && !/\.(?:mp3|m4a)$/i.test(asset.path)) {
      return `<p class="letter-media">${label}: ${escapeXml(asset.path)}</p>`;
    }
    if (asset.type === 'voice' || asset.type === 'video') {
      const tag = asset.type === 'voice' ? 'audio' : 'video';
      const source = `<source src="${href}"${epub ? ' />' : '>'}`;
      return `<div class="letter-media"><${tag} controls="controls">${source}${label}</${tag}></div>`;
    }
    return epub ? `<p class="letter-media">${label}: ${escapeXml(asset.path)}</p>`
      : `<p class="letter-media"><a href="${href}">${label}</a></p>`;
  }

  function letterMarkup(letter, assets, index, epub = false, locale = 'en') {
    const own = ofLetter(assets, letter);
    const stamp = assetOfType(own, 'stamp');
    const avatar = assetOfType(own, 'avatar');
    const attachments = own.filter(asset => asset !== stamp && asset !== avatar);
    const epubImage = asset => !epub || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(asset.path);
    const stampHtml = stamp ? epubImage(stamp)
      ? `<img class="letter-stamp" src="${escapeXml(localHref(stamp.path))}" alt="${escapeXml(tr(locale, 'archiveStamp'))}"${epub ? ' />' : '>'}`
      : `<span class="letter-stamp">${escapeXml(tr(locale, 'archiveStamp'))}: ${escapeXml(stamp.path)}</span>` : '';
    const avatarHtml = avatar && epubImage(avatar) ? `<img class="letter-avatar" src="${escapeXml(localHref(avatar.path))}" alt=""${epub ? ' />' : '>'}` : '';
    const body = escapeXml(letter.body || '');
    const br = epub ? '<br />' : '<br>';
    return `<article class="letter-card" id="letter-${index + 1}" data-letter-index="${index}" data-author="${escapeXml(letter.author || tr(locale, 'archiveUnknown'))}" data-date="${escapeXml(letter.date || tr(locale, 'archiveUnknown'))}">
      <header class="letter-header"><span class="letter-label">${escapeXml(tr(locale, 'archiveLetter'))} ${index + 1}</span>${stampHtml}</header>
      <div class="letter-body" dir="auto">${body}</div>
      ${attachments.length ? `<section class="letter-attachments" aria-label="${escapeXml(tr(locale, 'archiveAttachments'))}">${attachments.map(asset => mediaMarkup(asset, epub, locale)).join('')}</section>` : ''}
      <footer class="letter-footer">${avatarHtml}<div><strong>${escapeXml(letter.author || tr(locale, 'archiveUnknown'))}</strong>${br}${escapeXml(letter.date || tr(locale, 'archiveUnknown'))}${br}${escapeXml(letter.location || '')}</div></footer>
    </article>`;
  }

  function contents(letters, buttons = false, locale = 'en') {
    return letters.map((letter, index) => {
      const title = `${letter.date || tr(locale, 'archiveUnknown')} · ${letter.author || tr(locale, 'archiveUnknown')}`;
      return buttons ? `<button type="button" data-index="${index}">${escapeXml(title)}</button>`
        : `<a href="#letter-${index + 1}">${escapeXml(title)}</a>`;
    }).join('');
  }

  function slowlyContents(letters, locale) {
    return letters.map((letter, index) => {
      const body = [...String(letter.body || '').replace(/\s+/g, ' ').trim()];
      const preview = body.slice(0, 300).join('') + (body.length > 300 ? '...' : '');
      return `<button type="button" data-index="${index}"><span class="slowly-list-date">${escapeXml(letter.date || tr(locale, 'archiveUnknown'))}</span>
        <strong>${escapeXml(letter.author || tr(locale, 'archiveUnknown'))}</strong><span class="slowly-list-preview">${escapeXml(preview)}</span></button>`;
    }).join('');
  }

  function turnButtons(locale) {
    return `<div class="turn-buttons"><button type="button" data-turn="newer" aria-label="${escapeXml(tr(locale, 'archiveNewer'))}">&#x2039;</button><button type="button" data-turn="older" aria-label="${escapeXml(tr(locale, 'archiveOlder'))}">&#x203a;</button></div>`;
  }

  function summaryCard(letter, assets, index, gallery = false, locale = 'en') {
    const stamp = assetOfType(ofLetter(assets, letter), 'stamp');
    const stampHtml = stamp ? `<img src="${escapeXml(localHref(stamp.path))}" alt="${escapeXml(tr(locale, 'archiveStamp'))}" draggable="false">` : '<span class="stamp-placeholder" aria-hidden="true">✉</span>';
    const preview = escapeXml(String(letter.body || '').replace(/\s+/g, ' ').slice(0, 150));
    return `<a href="#letter-${index + 1}" class="summary-card${gallery ? ' gallery-card' : ''}" data-open="${index}" draggable="false">
      ${stampHtml}<span class="summary-date">${escapeXml(letter.date || tr(locale, 'archiveUnknown'))}</span>
      <strong>${escapeXml(letter.author || tr(locale, 'archiveUnknown'))}</strong><span class="summary-preview">${preview}</span>
    </a>`;
  }

  function albumIndex(letters, assets, locale) {
    const cards = letters.flatMap((letter, index) => ofLetter(assets, letter)
      .filter(asset => asset.type === 'picture' || asset.type === 'voice')
      .map(asset => {
        const thumbnail = asset.type === 'picture'
          ? `<img src="${escapeXml(localHref(asset.path))}" alt="${escapeXml(asset.alt || tr(locale, 'archiveAttachments'))}" loading="lazy">`
          : '<span class="album-audio-icon" aria-hidden="true">♫</span>';
        const date = String(letter.date || tr(locale, 'archiveUnknown')).replace('T', ' ');
        return `<button type="button" class="album-item" data-index="${index}">${thumbnail}<span class="album-caption"><span>${escapeXml(date)}</span><strong>${escapeXml(letter.author || tr(locale, 'archiveUnknown'))}</strong></span></button>`;
      })).join('');
    return `<section class="album-index"><h2>${escapeXml(tr(locale, 'archiveAttachments'))}</h2>${cards ? `<div class="album-grid">${cards}</div>` : `<p>${escapeXml(tr(locale, 'archiveNoMedia'))}</p>`}</section>`;
  }

  function archiveCss(accent) {
    return `:root{--accent:${normalizeAccent(accent)};color-scheme:light}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f4f6f8;color:#27323a;font:16px/1.65 system-ui,-apple-system,sans-serif}button,a{font:inherit}a{color:var(--accent)}button{cursor:pointer}.sep-archive{min-height:100vh}.archive-header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #dfe4e8;padding:.7rem max(1rem,calc((100vw - 1180px)/2));display:flex;gap:1rem;align-items:center;justify-content:space-between}.archive-header h1{font-size:1.15rem;margin:0;color:var(--accent)}.archive-main{max-width:1180px;margin:auto;padding:1.5rem;display:grid;grid-template-columns:260px minmax(0,1fr);gap:1.5rem}.contents{position:sticky;top:5rem;align-self:start;max-height:calc(100vh - 6rem);overflow:auto;background:#fff;border:1px solid #e1e5e8;padding:1rem}.contents a,.contents button{display:block;width:100%;text-align:left;padding:.45rem;border:0;background:none;color:#334;text-decoration:none;border-bottom:1px solid #edf0f1}.contents button[aria-current="true"]{color:var(--accent);font-weight:700}.mobile-contents{display:none}.letter-card{max-width:830px;margin:0 auto 2rem;background:#fff;box-shadow:0 3px 16px #1a263018;border:1px solid #e5e9ec}.letter-header{min-height:112px;padding:1rem 1.5rem;display:flex;justify-content:space-between;align-items:flex-start}.letter-label{color:#71818b;font-size:.8rem;font-weight:700}.letter-stamp{width:100px;height:100px;object-fit:contain}.letter-body{padding:1.5rem 2rem 2.5rem;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}.letter-attachments{padding:0 2rem 1.5rem}.letter-media{margin:1rem 0}.letter-media img{max-width:100%;height:auto}.letter-media audio,.letter-media video{max-width:100%}.letter-footer{border-top:1px solid #e9edf0;padding:1rem 2rem;display:flex;align-items:center;gap:1rem;color:#65727b;font-size:.9rem}.letter-footer strong{color:var(--accent)}.letter-avatar{width:48px;height:48px;border-radius:50%;object-fit:cover}.turn-buttons{display:flex;gap:.4rem}.turn-buttons button,.menu-button,.dialog-close{border:1px solid #ccd4d9;background:#fff;border-radius:.4rem;padding:.25rem .75rem;color:var(--accent)}.turn-buttons button:disabled{opacity:.4;cursor:default}.sep-slowly .archive-main{display:block;max-width:900px}.sep-slowly .contents{display:none}.sep-sidebar .archive-main{grid-template-columns:280px minmax(0,1fr)}.sep-slowly.is-enhanced .letter-card,.sep-sidebar.is-enhanced .letter-card{display:none}.sep-slowly.is-enhanced .letter-card.active,.sep-sidebar.is-enhanced .letter-card.active{display:block}.sep-timeline .archive-main,.sep-gallery .archive-main{display:block;max-width:1200px}.sep-timeline .contents,.sep-gallery .contents{display:none}.card-track{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory;padding:1rem .25rem 2rem;touch-action:pan-x pan-y}.summary-card{flex:0 0 240px;text-align:left;display:flex;flex-direction:column;gap:.5rem;background:#fff;border:1px solid #e1e5e8;box-shadow:0 2px 10px #0001;padding:1rem;scroll-snap-align:start;color:inherit}.summary-card img,.stamp-placeholder{width:100%;height:135px;object-fit:contain}.summary-card strong{color:var(--accent)}.summary-date{font-size:.8rem;color:#667}.summary-preview{font-size:.85rem;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem}.gallery-card{width:100%;min-width:0}.sep-timeline.is-enhanced .fallback-letters,.sep-gallery.is-enhanced .fallback-letters{display:none}.reading-dialog{width:min(860px,92vw);max-width:none;max-height:90vh;border:0;padding:3rem 1rem 1rem;background:#f4f6f8;box-shadow:0 20px 60px #0005;overflow:auto}.reading-dialog::backdrop{background:#10182099}.reading-dialog .letter-card{margin-bottom:0}.dialog-close{position:sticky;top:-2.5rem;float:right;z-index:2}.sep-continuous .letter-card{scroll-margin-top:5rem}@media(max-width:700px){.archive-main,.sep-sidebar .archive-main{display:block;padding:.7rem}.contents{display:none}.mobile-contents{display:block;background:#fff;padding:.5rem 1rem;margin-bottom:1rem}.mobile-contents a,.mobile-contents button{display:block;width:100%;text-align:left}.letter-body{padding:1rem 1.25rem 2rem}.letter-footer{padding:1rem 1.25rem}.reading-dialog{width:95vw;height:95vh;max-height:95vh;padding:2.5rem .25rem .25rem}.archive-header{padding:.6rem 1rem}}@media print{.archive-header,.contents,.mobile-contents,.card-track,.gallery-grid,.reading-dialog{display:none!important}.archive-main{display:block}.letter-card{display:block!important;box-shadow:none;break-after:page}}`;
  }

  const interactionScript = `(function(){
    var root=document.querySelector('.sep-archive');if(!root)return;
    var layout=root.getAttribute('data-layout');
    var articles=Array.from(root.querySelectorAll('.fallback-letters > .letter-card,.letter-list > .letter-card'));
    var current=articles.length-1;
    function show(index){if(index<0||index>=articles.length)return;current=index;
      articles.forEach(function(article,i){article.classList.toggle('active',i===current);});
      var meta=root.querySelector('[data-current-meta]');if(meta)meta.textContent=articles[current].getAttribute('data-date')+' · '+articles[current].getAttribute('data-author');
      root.querySelectorAll('[data-index]').forEach(function(item){item.setAttribute('aria-current',Number(item.getAttribute('data-index'))===current?'true':'false');});
      root.querySelectorAll('[data-turn]').forEach(function(button){button.disabled=button.getAttribute('data-turn')==='newer'?current===articles.length-1:current===0;});
      if(articles[current])articles[current].scrollIntoView({block:'nearest'});
    }
    if(layout==='slowly'||layout==='album'||layout==='sidebar'){
      root.classList.add('is-enhanced');
      if(layout!=='sidebar')root.classList.add('is-listing');
      show(current);
      root.querySelectorAll('[data-index]').forEach(function(item){item.addEventListener('click',function(){root.classList.remove('is-listing');show(Number(item.getAttribute('data-index')));});});
      var listButton=root.querySelector('[data-list]');
      if(listButton)listButton.addEventListener('click',function(){root.classList.add('is-listing');root.scrollIntoView({block:'start'});});
      root.querySelectorAll('[data-turn]').forEach(function(button){button.addEventListener('click',function(){show(current+(button.getAttribute('data-turn')==='newer'?1:-1));});});
      document.addEventListener('keydown',function(event){
        var target=event.target;
        if(event.altKey||event.ctrlKey||event.metaKey||(layout!=='sidebar'&&root.classList.contains('is-listing'))||target.isContentEditable||(target.closest&&target.closest('input,textarea,select,[contenteditable]')))return;
        if(event.key==='ArrowLeft'){show(current+1);event.preventDefault();}
        if(event.key==='ArrowRight'){show(current-1);event.preventDefault();}
      });
    }
    if(layout==='timeline'||layout==='gallery'){
      var dialog=root.querySelector('.reading-dialog');if(!dialog||typeof dialog.showModal!=='function')return;
      var content=dialog.querySelector('.dialog-content');var opener=null;
      root.querySelectorAll('[data-open]').forEach(function(card){card.addEventListener('click',function(event){if(root.dataset.dragged==='true'){event.preventDefault();return;}event.preventDefault();opener=card;content.replaceChildren(articles[Number(card.getAttribute('data-open'))].cloneNode(true));dialog.showModal();});});
      dialog.querySelector('.dialog-close').addEventListener('click',function(){dialog.close();});
      dialog.addEventListener('close',function(){if(opener)opener.focus();});
      root.classList.add('is-enhanced');
      var track=root.querySelector('.card-track');
      if(track){var down=false,startX=0,startScroll=0;
        track.addEventListener('dragstart',function(event){event.preventDefault();});
        track.addEventListener('pointerdown',function(event){if(event.pointerType!=='mouse')return;down=true;startX=event.clientX;startScroll=track.scrollLeft;root.dataset.dragged='false';track.setPointerCapture?.(event.pointerId);});
        track.addEventListener('pointermove',function(event){if(!down)return;var delta=event.clientX-startX;if(Math.abs(delta)>6)root.dataset.dragged='true';track.scrollLeft=startScroll-delta;});
        track.addEventListener('pointerup',function(){down=false;setTimeout(function(){root.dataset.dragged='false';},0);});
        track.addEventListener('pointercancel',function(){down=false;root.dataset.dragged='false';});
        track.addEventListener('lostpointercapture',function(){if(down){down=false;root.dataset.dragged='false';}});
        track.addEventListener('wheel',function(event){if(track.scrollWidth<=track.clientWidth)return;var delta=Math.abs(event.deltaY)>Math.abs(event.deltaX)?event.deltaY:event.deltaX;var old=track.scrollLeft;track.scrollLeft+=delta;if(track.scrollLeft!==old)event.preventDefault();},{passive:false});
      }
    }
  })();`;

  const slowlyIndexCss = `.sep-slowly .slowly-index{max-width:900px;margin:auto;background:#fff;border:1px solid #e1e5e8;padding:1.25rem}.slowly-index h2{margin:.2rem 0 1rem;color:var(--accent)}.slowly-index nav{display:grid;gap:.4rem}.slowly-index button{display:block;width:100%;padding:.75rem 1rem;text-align:left;color:#334;background:#fff;border:1px solid #e1e5e8;border-radius:.4rem}.slowly-index button:hover,.slowly-index button:focus-visible{border-color:var(--accent)}.slowly-index button strong,.slowly-list-date,.slowly-list-preview{display:block}.slowly-index button strong{color:var(--accent)}.slowly-list-date{font-size:.85rem;color:#667}.slowly-list-preview{max-width:14em;margin-top:.35rem;font-size:.95rem;line-height:1.5;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}.sep-slowly .list-button{border:1px solid #ccd4d9;border-radius:.4rem;background:#fff;color:var(--accent);padding:.25rem .75rem}.sep-slowly.is-enhanced:not(.is-listing) .slowly-index{display:none}.sep-slowly.is-enhanced.is-listing .letter-list,.sep-slowly.is-enhanced.is-listing [data-current-meta],.sep-slowly.is-enhanced.is-listing .turn-buttons,.sep-slowly.is-enhanced.is-listing .list-button{display:none}@media print{.sep-slowly .slowly-index,.sep-slowly .list-button{display:none!important}.sep-slowly.is-enhanced.is-listing .letter-list{display:block!important}}`;
  const slowlyGridCss = `.slowly-index nav{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}.slowly-index button{min-width:0}.slowly-list-preview{min-height:7.5em;max-height:7.5em}@media(max-width:540px){.slowly-index nav{grid-template-columns:1fr}}`;
  const albumCss = `.sep-album .archive-main{display:block;max-width:1100px}.sep-album .album-index{background:#fff;border:1px solid #e1e5e8;padding:1.25rem}.album-index h2{margin:.2rem 0 1rem;color:var(--accent)}.album-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1rem}.album-item{min-width:0;display:flex;flex-direction:column;overflow:hidden;padding:0;text-align:left;background:#fff;border:1px solid #e1e5e8;border-radius:.5rem;color:#27323a}.album-item img,.album-audio-icon{display:grid;place-items:center;width:100%;height:160px;object-fit:cover;background:#f3f5f8}.album-audio-icon{font-size:4rem;color:var(--accent)}.album-caption{display:grid;gap:.25rem;padding:.65rem .8rem;font-size:.85rem}.album-caption strong{color:var(--accent)}.album-item:hover,.album-item:focus-visible{border-color:var(--accent)}.sep-album .list-button{border:1px solid #ccd4d9;border-radius:.4rem;background:#fff;color:var(--accent);padding:.25rem .75rem}.sep-album.is-enhanced .letter-card{display:none}.sep-album.is-enhanced .letter-card.active{display:block}.sep-album.is-enhanced:not(.is-listing) .album-index{display:none}.sep-album.is-enhanced.is-listing .letter-list,.sep-album.is-enhanced.is-listing [data-current-meta],.sep-album.is-enhanced.is-listing .turn-buttons,.sep-album.is-enhanced.is-listing .list-button{display:none}@media print{.sep-album .album-index,.sep-album .list-button{display:none!important}.sep-album.is-enhanced.is-listing .letter-list{display:block!important}}`;

  function renderHtmlArchive(letters, assets, options = {}) {
    const allowed = ['slowly', 'album', 'continuous', 'sidebar', 'timeline', 'gallery'];
    const layout = allowed.includes(options.htmlLayout) ? options.htmlLayout : 'slowly';
    const locale = i18n.SUPPORTED_LOCALES.includes(options.locale) ? options.locale : 'en';
    const title = letters[0]?.friendName || letters[0]?.friendId || tr(locale, 'archiveTitle');
    const cards = letters.map((letter, index) => letterMarkup(letter, assets, index, false, locale)).join('\n');
    const toc = `<nav class="contents" aria-label="${escapeXml(tr(locale, 'archiveLetters'))}">${contents(letters, layout === 'sidebar', locale)}</nav>`;
    const mobileToc = `<details class="mobile-contents"><summary>${escapeXml(tr(locale, 'archiveLetters'))}</summary>${contents(letters, layout === 'sidebar', locale)}</details>`;
    const firstMeta = letters.at(-1);
    const meta = firstMeta ? `${firstMeta.date || tr(locale, 'archiveUnknown')} · ${firstMeta.author || tr(locale, 'archiveUnknown')}` : '';
    const header = `<header class="archive-header"><h1>${escapeXml(title)}</h1>${['slowly', 'album', 'sidebar'].includes(layout) ? `${layout !== 'sidebar' ? `<button type="button" class="list-button" data-list="true">${escapeXml(tr(locale, layout === 'album' ? 'archiveAttachments' : 'archiveLetters'))}</button>` : ''}<span data-current-meta>${escapeXml(meta)}</span>${turnButtons(locale)}` : ''}</header>`;
    let main;
    if (layout === 'timeline' || layout === 'gallery') {
      const summaries = letters.map((letter, index) => summaryCard(letter, assets, index, layout === 'gallery', locale)).join('');
      const summaryArea = layout === 'timeline' ? `<div class="card-track" tabindex="0">${summaries}</div>`
        : `<div class="gallery-grid">${summaries}</div>`;
      main = `<main class="archive-main">${summaryArea}<div class="fallback-letters">${cards}</div>
        <dialog class="reading-dialog" aria-label="${escapeXml(tr(locale, 'archiveLetter'))}"><button type="button" class="dialog-close" aria-label="${escapeXml(tr(locale, 'close'))}">×</button><div class="dialog-content"></div></dialog></main>`;
    } else {
      const slowlyIndex = `<section class="slowly-index"><h2>${escapeXml(tr(locale, 'archiveLetters'))}</h2><nav aria-label="${escapeXml(tr(locale, 'archiveLetters'))}">${slowlyContents(letters, locale)}</nav></section>`;
      main = `<main class="archive-main">${layout === 'slowly' ? slowlyIndex : layout === 'album' ? albumIndex(letters, assets, locale) : toc + mobileToc}<div class="letter-list">${cards}</div></main>`;
    }
    const printOverrides = '@media print{.sep-timeline.is-enhanced .fallback-letters,.sep-gallery.is-enhanced .fallback-letters{display:block!important}}';
    return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(title)} — ${escapeXml(tr(locale, 'archiveTitle'))}</title><style>${archiveCss(options.accent)}${slowlyIndexCss}${slowlyGridCss}${albumCss}${printOverrides}</style></head>
      <body><div class="sep-archive sep-${layout}" data-layout="${layout}">${header}${main}</div><script>${interactionScript}</script></body></html>`;
  }

  function renderHtmlPreview(options = {}) {
    const letters = [1, 2, 3].map(index => ({
      id: `preview-${index}`, friendId: 'preview', friendName: 'Preview conversation',
      author: `Sender ${index}`, date: `2026-01-0${index}`, location: 'Sample city',
      body: `Placeholder letter ${index}.\nThis preview contains no account information.`, index,
    }));
    const sampleAssets = [{ letterId: 'preview-1', type: 'picture', path: 'preview-image.svg', alt: 'Sample image' },
      { letterId: 'preview-2', type: 'voice', path: 'preview-audio.mp3', alt: 'Sample audio' }];
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><rect width="640" height="400" fill="#e8eef2"/><circle cx="475" cy="105" r="48" fill="#f2c25b"/><path d="M0 340 180 150 320 290 420 205 640 400H0" fill="#7da5a2"/></svg>');
    const samples = 800;
    const wav = new Uint8Array(44 + samples).fill(128, 44);
    const header = new DataView(wav.buffer);
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
      for (let index = 0; index < 4; index++) wav[offset + index] = value.charCodeAt(index);
    }
    header.setUint32(4, 36 + samples, true);
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, 8000, true);
    header.setUint32(28, 8000, true);
    header.setUint16(32, 1, true);
    header.setUint16(34, 8, true);
    header.setUint32(40, samples, true);
    const audio = `data:audio/wav;base64,${btoa(String.fromCharCode(...wav))}`;
    return renderHtmlArchive(letters, sampleAssets, {
      htmlLayout: options.htmlLayout, accent: options.accent, locale: options.locale,
    }).replaceAll('src="preview-image.svg"', `src="${image}"`)
      .replaceAll('src="preview-audio.mp3"', `src="${audio}"`);
  }

  function renderEpubChapter(letter, assets, options = {}) {
    const locale = options.locale || 'en';
    const title = `${letter.author || tr(locale, 'archiveUnknown')} — ${letter.date || tr(locale, 'archiveUnknown')}`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="und" lang="und"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css" /></head><body><h1>${escapeXml(title)}</h1>${letterMarkup(letter, assets, (letter.index || 1) - 1, true, locale)}</body></html>`;
  }

  function renderEpubCss(accent) {
    return `body{font-family:serif;line-height:1.65;color:#222}h1,.letter-footer strong{color:${normalizeAccent(accent)}}.letter-card{margin:1em 0}.letter-header{min-height:5em}.letter-stamp{width:5em;float:right}.letter-body{white-space:pre-wrap;line-height:1.7;clear:both}.letter-footer{border-top:1px solid #aaa;margin-top:2em;padding-top:1em}.letter-avatar{width:3em;height:3em;float:left;margin-right:1em}.letter-media img{max-width:100%;height:auto}`;
  }

  function renderTxt(letter, assets, options = {}) {
    const locale = options.locale || 'en';
    const header = `${letter.author || tr(locale, 'archiveUnknown')}\n${letter.date || tr(locale, 'archiveUnknown')}${letter.location ? `\n${letter.location}` : ''}`;
    const own = ofLetter(assets, letter);
    const stamp = own.find(asset => asset.type === 'stamp');
    const avatar = own.find(asset => asset.type === 'avatar');
    const attachments = own.filter(asset => asset.type !== 'stamp' && asset.type !== 'avatar');
    const details = [
      ...(stamp ? [`${tr(locale, 'archiveStamp')}: ${stamp.path}`] : []),
      ...(avatar ? [`${tr(locale, 'archiveAvatar')}: ${avatar.path}`] : []),
      ...(attachments.length ? [`${tr(locale, 'archiveAttachments')}:\n${attachments.map(asset => `- ${asset.path}`).join('\n')}`] : []),
    ];
    return `${header}\n\n${letter.body || ''}${details.length ? `\n\n${details.join('\n')}` : ''}\n`;
  }

  const api = { normalizeAccent, escapeXml, localHref, renderHtmlArchive, renderHtmlPreview, renderEpubChapter, renderEpubCss, renderTxt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Cancellable ZIP generation. GPL-3.0-only. */
(function (root) {
  'use strict';
  const cancelled = () => Object.assign(new Error('Export cancelled'), { code: 'statusCancelled' });
  function generateZipBlob(zip, options, onProgress = () => {}, signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (typeof zip.generateInternalStream !== 'function') {
      return zip.generateAsync({ ...options, type: 'blob' }, onProgress);
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = zip.generateInternalStream({ ...options, type: 'uint8array' });
      let settled = false;
      const finish = (error, blob) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(blob);
      };
      const onAbort = () => {
        stream.pause();
        finish(cancelled());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (chunk, meta) => {
        if (signal?.aborted) return onAbort();
        chunks.push(chunk);
        onProgress(meta);
      }).on('error', error => finish(error))
        .on('end', () => finish(null, new Blob(chunks, { type: options.mimeType || 'application/zip' })));
      if (signal?.aborted) onAbort();
      else stream.resume();
    });
  }
  const api = { generateZipBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* EPUB 3 package builder for Slowly letters. GPL-3.0-only. */
(function (root) {
  'use strict';
  const formats = typeof module !== 'undefined' && module.exports ? require('./formats') : root.SEP;
  const i18n = typeof module !== 'undefined' && module.exports ? require('./i18n') : root.SEP;
  const zipper = typeof module !== 'undefined' && module.exports ? require('./zip') : root.SEP;

  function mediaType(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4',
      ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
      mp4: 'video/mp4', webm: 'video/webm',
      pdf: 'application/pdf' })[ext] || 'application/octet-stream';
  }

  async function buildEpub(zip, letters, assets, options = {}, onProgress = () => {}) {
    if (!letters.length) throw new Error('Cannot build an empty EPUB');
    const esc = formats.escapeXml;
    const locale = i18n.SUPPORTED_LOCALES.includes(options.locale) ? options.locale : 'en';
    const title = `${i18n.t(locale, 'archiveTitle')} — ${letters[0].friendName || letters[0].friendId || 'correspondence'}`;
    const identifier = `urn:slowly-export-pro:${encodeURIComponent(letters[0].friendId || 'friend')}:${encodeURIComponent(letters[0].id)}:${encodeURIComponent(letters.at(-1).id)}`;
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', createFolders: false });
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    const chapters = letters.map((letter, index) => ({ letter, index, path: `letter-${index + 1}.xhtml`, id: `chapter-${index + 1}` }));
    const navigation = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${locale}" lang="${locale}"><head><title>${esc(i18n.t(locale, 'archiveContents'))}</title><link rel="stylesheet" type="text/css" href="styles.css" /></head><body><nav epub:type="toc" id="toc"><h1>${esc(i18n.t(locale, 'archiveContents'))}</h1><ol>${chapters.map(({ letter, path }) => `<li><a href="${path}">${esc(`${letter.date || i18n.t(locale, 'archiveUnknown')} · ${letter.author || i18n.t(locale, 'archiveUnknown')}`)}</a></li>`).join('')}</ol></nav></body></html>`;
    zip.file('OEBPS/nav.xhtml', navigation);
    zip.file('OEBPS/styles.css', formats.renderEpubCss(options.accent));
    for (const { letter, index, path } of chapters) {
      const own = assets.filter(asset => asset.letterId === letter.id)
        .map(asset => ({ ...asset, path: `assets/${asset.path}` }));
      zip.file(`OEBPS/${path}`, formats.renderEpubChapter({ ...letter, index: index + 1 }, own, options));
    }
    const uniqueAssets = [...new Map(assets.map(asset => [asset.path, asset])).values()];
    uniqueAssets.forEach(asset => zip.file(`OEBPS/assets/${asset.path}`, asset.blob));
    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="css" href="styles.css" media-type="text/css"/>',
      ...chapters.map(({ path, id }) => `<item id="${id}" href="${path}" media-type="application/xhtml+xml"/>`),
      ...uniqueAssets.map((asset, index) => `<item id="asset-${index + 1}" href="${esc(formats.localHref(`assets/${asset.path}`))}" media-type="${mediaType(asset.path)}"/>`),
    ].join('');
    const spine = chapters.map(({ id }) => `<itemref idref="${id}"/>`).join('');
    const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${esc(identifier)}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>und</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
    zip.file('OEBPS/content.opf', opf);
    onProgress({ phase: 'zip', percent: 0 });
    const blob = await zipper.generateZipBlob(zip, { compression: 'DEFLATE', mimeType: 'application/epub+zip' },
      meta => onProgress({ phase: 'zip', percent: Math.round(meta.percent) }), options.signal);
    onProgress({ phase: 'zip', percent: 100 });
    return blob;
  }

  const api = { buildEpub, mediaType };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Letter and stamp download packages. GPL-3.0-only. */
(function (root) {
  'use strict';
  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.SEP;
  const formats = typeof module !== 'undefined' && module.exports ? require('./formats') : root.SEP;
  const epub = typeof module !== 'undefined' && module.exports ? require('./epub') : root.SEP;
  const zipper = typeof module !== 'undefined' && module.exports ? require('./zip') : root.SEP;
  const mdBlob = value => new Blob([value], { type: 'text/markdown;charset=utf-8' });
  const cancelled = () => Object.assign(new Error('Export cancelled'), { code: 'statusCancelled' });

  function nameLetters(letters, template, format = 'markdown') {
    const extension = ({ markdown: 'md', html: 'html', epub: 'html', txt: 'txt' })[format];
    if (!extension) throw new Error(`Unknown letter format: ${format}`);
    const used = new Set();
    return letters.map((letter, i) => {
      let filename = core.renderFilename(template, letter, letter.index || i + 1, extension);
      const base = filename.slice(0, -extension.length - 1);
      let suffix = 2;
      while (used.has(filename.toLowerCase())) filename = `${base} (${suffix++}).${extension}`;
      used.add(filename.toLowerCase());
      return { ...letter, filename };
    });
  }

  async function collectAssets(plans, fetchAsset, onProgress = () => {}, signal) {
    const found = [];
    const warnings = [];
    const downloaded = new Map();
    for (const [index, asset] of plans.entries()) {
      if (signal?.aborted) throw cancelled();
      onProgress({ phase: 'asset', current: index + 1, total: plans.length, type: asset.type });
      try {
        let blob = downloaded.get(asset.url);
        if (!blob) {
          blob = await fetchAsset(asset.url);
          downloaded.set(asset.url, blob);
        }
        if (!blob || !blob.size) throw new Error('empty response');
        const prefix = await blob.slice(0, 256).text();
        const svg = core.extensionFromUrl(asset.url, asset.type) === 'svg'
          && /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix);
        if ((/^(?:text\/[^\s;]+|application\/(?:json|problem\+json|xhtml\+xml|xml))(?:;|$)/i.test(blob.type)
              && !(/^(?:text\/xml|application\/xml)(?:;|$)/i.test(blob.type) && svg))
            || /^(?:\uFEFF|\s)*(?:<!doctype\s+html\b|<html\b|\{\s*"|\[\s*\{)/i.test(prefix)
            || ((!blob.type || blob.type === 'application/octet-stream')
              && /^[\t\n\r\x20-\x7e]+$/.test(prefix)
              && !/^\s*(?:<svg\b|<\?xml\b|%PDF-)/i.test(prefix))) {
          throw new Error('Error response instead of asset');
        }
        found.push({ ...asset, blob });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
        warnings.push(`Asset ${asset.url}: ${error?.message || error}`);
      }
    }
    return { found, warnings };
  }

  async function zipBlob(zip, onProgress, signal) {
    onProgress({ phase: 'zip', percent: 0 });
    const blob = await zipper.generateZipBlob(zip, {}, meta =>
      onProgress({ phase: 'zip', percent: Math.round(meta.percent) }), signal);
    onProgress({ phase: 'zip', percent: 100 });
    return blob;
  }

  async function buildLetterExport(JSZip, letters, options, fetchAsset, onProgress = () => {}) {
    const format = options.format || 'markdown';
    const mode = options.mode || 'zip';
    const layout = options.layout || 'root';
    const named = nameLetters(letters, options.template, format);
    const plans = format === 'txt' ? core.planTxtAssetPaths(named)
      : core.planAssetPaths(named, format === 'epub' ? 'root' : layout);
    const { found, warnings } = await collectAssets(plans, fetchAsset, onProgress, options.signal);
    const uniqueFound = [...new Map(found.map(asset => [asset.path, asset])).values()];
    onProgress({ phase: 'render', total: letters.length });
    for (const letter of named) {
      if (!core.dateFields(letter.date).valid) warnings.push(`Letter ${letter.id}: date could not be parsed`);
    }
    const downloads = [];
    const friendName = core.cleanFilename(named[0]?.friendName || named[0]?.friendId || 'correspondence');
    if (format === 'html') {
      const zip = new JSZip();
      zip.file('index.html', formats.renderHtmlArchive(named, found, options));
      uniqueFound.forEach(asset => zip.file(asset.path, asset.blob));
      downloads.push({ name: `Slowly-${friendName}-letters-html.zip`, blob: await zipBlob(zip, onProgress, options.signal) });
      return { downloads, warnings, complete: warnings.length === 0, count: letters.length };
    }
    if (format === 'txt') {
      const zip = new JSZip();
      named.forEach(letter => zip.file(letter.filename, formats.renderTxt(letter, found, options)));
      uniqueFound.forEach(asset => zip.file(asset.path, asset.blob));
      downloads.push({ name: `Slowly-${friendName}-letters-txt.zip`, blob: await zipBlob(zip, onProgress, options.signal) });
      return { downloads, warnings, complete: warnings.length === 0, count: letters.length };
    }
    if (format === 'epub') {
      downloads.push({ name: `Slowly-${friendName}-letters.epub`, blob: await epub.buildEpub(new JSZip(), named, found, options, onProgress) });
      return { downloads, warnings, complete: warnings.length === 0, count: letters.length };
    }
    const markdown = named.map(letter => ({
      name: letter.filename,
      text: core.renderMarkdown(letter, options.style || 'simple', found.filter(asset => asset.letterId === letter.id)),
    }));
    if (mode === 'single') {
      const combined = markdown.map(item => item.text).join('\n---\n\n');
      downloads.push({ name: `Slowly-${friendName}-letters.md`, blob: mdBlob(combined) });
      if (found.length) {
        const zip = new JSZip();
        uniqueFound.forEach(asset => zip.file(asset.path, asset.blob));
        downloads.push({ name: 'assets.zip', blob: await zipBlob(zip, onProgress, options.signal) });
      }
    } else if (mode === 'direct') {
      markdown.forEach(item => downloads.push({ name: item.name, blob: mdBlob(item.text) }));
      if (layout === 'root') {
        uniqueFound.forEach(asset => downloads.push({ name: asset.path, blob: asset.blob }));
      } else if (found.length) {
        const zip = new JSZip();
        uniqueFound.forEach(asset => zip.file(asset.path, asset.blob));
        downloads.push({ name: 'assets.zip', blob: await zipBlob(zip, onProgress, options.signal) });
      }
    } else if (mode === 'zip') {
      const zip = new JSZip();
      markdown.forEach(item => zip.file(item.name, item.text));
      uniqueFound.forEach(asset => zip.file(asset.path, asset.blob));
      downloads.push({ name: `Slowly-${friendName}-letters.zip`, blob: await zipBlob(zip, onProgress, options.signal) });
    } else {
      throw new Error(`Unknown output mode: ${mode}`);
    }
    return { downloads, warnings, complete: warnings.length === 0, count: letters.length };
  }

  async function buildStampExport(JSZip, stamps, fetchImage, filename, onProgress = () => {}, signal) {
    if (!stamps.length) throw Object.assign(new Error('No stamp images found'), { code: 'statusNoStamps' });
    const zip = new JSZip();
    const warnings = [];
    const manifest = [];
    const used = new Set();
    for (const [index, stamp] of stamps.entries()) {
      if (signal?.aborted) throw cancelled();
      onProgress({ phase: 'stamp', current: index + 1, total: stamps.length, id: stamp.id });
      let blob;
      let source = '';
      const failures = [];
      for (const url of [...new Set([stamp.highResUrl, stamp.url].filter(Boolean))]) {
        try {
          const candidate = await fetchImage(url);
          if (!await validStampImage(candidate, url)) throw new Error('invalid image response');
          blob = candidate;
          source = url;
          break;
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
          blob = undefined;
          failures.push(error?.message || String(error));
        }
      }
      if (!blob) {
        warnings.push(`Stamp ${stamp.id}: image could not be downloaded (${failures.join('; ')})`);
        continue;
      }
      const stem = core.cleanFilename(stamp.id || 'stamp');
      const ext = core.extensionFromUrl(source, 'stamp');
      let path = `${stem}.${ext}`;
      let n = 2;
      while (used.has(path.toLowerCase())) path = `${stem} (${n++}).${ext}`;
      used.add(path.toLowerCase());
      zip.file(path, blob);
      manifest.push({ id: stamp.id, title: stamp.title || '', description: stamp.description || '',
        unlockedAt: stamp.unlockedAt || '', album: stamp.album || '', source, savedAs: path });
    }
    if (!manifest.length) return { downloads: [], warnings, complete: false, count: 0 };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const album = core.cleanFilename(stamps[0]?.album || 'stamps');
    onProgress({ phase: 'zip', percent: 0, total: stamps.length });
    const zipBlob = await zipper.generateZipBlob(zip, {}, meta =>
      onProgress({ phase: 'zip', percent: Math.round(meta.percent), total: stamps.length }), signal);
    onProgress({ phase: 'zip', percent: 100, total: stamps.length });
    return { downloads: [{ name: filename || `Slowly-${album}-stamps.zip`, blob: zipBlob }],
      warnings, complete: warnings.length === 0, count: manifest.length };
  }

  async function validStampImage(blob, url) {
    if (!blob?.size || !blob.slice || !blob.arrayBuffer) return false;
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const ext = core.extensionFromUrl(url, 'stamp');
    if (ext === 'png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
    if (ext === 'jpg' || ext === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (ext === 'gif') return String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8';
    if (ext === 'webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (ext === 'avif') return String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
      && ['avif', 'avis'].includes(String.fromCharCode(...bytes.slice(8, 12)));
    return /^image\//.test(blob.type || '');
  }

  async function buildLetterStampExport(JSZip, letters, fetchImage, onProgress, signal) {
    const urls = [...new Set(letters.map(letter => letter.stampUrl).filter(Boolean))];
    if (!urls.length) throw Object.assign(new Error('No stamps found in these letters'), { code: 'statusNoLetterStamps' });
    const stamps = urls.map((url, index) => {
      let id;
      try { id = decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '')); }
      catch { id = `stamp-${index + 1}`; }
      return { id, title: id, url, highResUrl: url, album: 'letter-stamps' };
    });
    return buildStampExport(JSZip, stamps, fetchImage, 'Slowly-letter-stamps.zip', onProgress, signal);
  }

  const api = { nameLetters, buildLetterExport, buildStampExport, buildLetterStampExport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEP = Object.assign(root.SEP || {}, api);
})(globalThis);


/* Browser controller for Slowly Export Pro. GPL-3.0-only. */
(function (root) {
  'use strict';
  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.SEP;
  const dom = typeof module !== 'undefined' && module.exports ? require('./dom') : root.SEP;
  const storage = typeof module !== 'undefined' && module.exports ? require('./storage') : root.SEP;
  const output = typeof module !== 'undefined' && module.exports ? require('./output') : root.SEP;
  const formats = typeof module !== 'undefined' && module.exports ? require('./formats') : root.SEP;
  const i18n = typeof module !== 'undefined' && module.exports ? require('./i18n') : root.SEP;
  const SCRIPT_VERSION = '0.8.4';

  function exportError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function collectLetters({ readCurrent, goOlder, checkpoint = '', all = false, signal, onLetter = () => {} }) {
    const letters = [];
    const seen = new Set();
    for (let count = 0; count < 10000; count++) {
      if (signal?.aborted) throw exportError('statusCancelled', 'Export cancelled');
      const letter = await readCurrent();
      if (!letter?.id || seen.has(letter.id)) throw exportError('statusNavigation', 'Letter navigation did not advance');
      if (!all && checkpoint && letter.id === checkpoint) return { letters, status: 'checkpoint' };
      seen.add(letter.id);
      letters.push(letter);
      await onLetter(letter, letters.length);
      if (signal?.aborted) throw exportError('statusCancelled', 'Export cancelled');
      if (!(await goOlder(letter))) {
        if (!all && checkpoint) throw exportError('statusMissingCheckpoint', 'Previous export checkpoint was not found');
        return { letters, status: 'oldest' };
      }
    }
    throw exportError('statusSafetyLimit', 'Safety limit reached while reading letters');
  }

  function availableDirection(newer, older) {
    return newer && older ? 'both' : newer ? 'newer' : older ? 'older' : 'single';
  }

  async function moveToEnd(readCurrent, navigate, signal, onMove = () => {}) {
    const seen = new Set();
    for (let count = 0; count < 10000; count++) {
      if (signal?.aborted) throw exportError('statusCancelled', 'Export cancelled');
      const letter = await readCurrent();
      if (!letter?.id || seen.has(letter.id)) throw exportError('statusNavigation', 'Letter navigation did not advance');
      seen.add(letter.id);
      onMove(count + 1);
      if (!(await navigate(letter))) return;
    }
    throw exportError('statusSafetyLimit', 'Safety limit reached while moving to the end');
  }

  async function collectFromPosition({ readCurrent, goOlder, goNewer, available, direction, atEnd,
    checkpoint = '', previousTotal = 0, all = false, signal, onLetter = () => {}, onMove = () => {} }) {
    if (available === 'single') {
      const letter = await readCurrent();
      if (signal?.aborted) throw exportError('statusCancelled', 'Export cancelled');
      if (!letter?.id) throw exportError('statusNavigation', 'Letter could not be read');
      if (!all && checkpoint && checkpoint !== letter.id) throw exportError('statusMissingCheckpoint', 'Previous export checkpoint was not found');
      if (!all && checkpoint === letter.id) return { letters: [], newestId: letter.id, indexOffset: previousTotal, complete: true };
      await onLetter(letter, 1);
      return { letters: [letter], newestId: letter.id, indexOffset: 0, complete: true };
    }
    if (!['older', 'newer', 'both'].includes(available)) throw exportError('statusNavigation', 'Unknown letter direction');
    if (available === 'both' && (!['older', 'newer'].includes(direction) || !['stop', 'reverse'].includes(atEnd))) {
      throw exportError('statusNavigation', 'Choose a direction and end behavior');
    }
    const firstDirection = available === 'both' ? direction : available;
    const firstNavigate = firstDirection === 'older' ? goOlder : goNewer;
    const partial = available === 'both' && atEnd === 'stop';
    if (available === 'both' && atEnd === 'reverse') {
      await moveToEnd(readCurrent, firstNavigate, signal, onMove);
      const sweepDirection = firstDirection === 'older' ? 'newer' : 'older';
      const sweep = await collectLetters({ readCurrent, goOlder: sweepDirection === 'older' ? goOlder : goNewer,
        all: true, signal, onLetter });
      const chronological = sweepDirection === 'older' ? sweep.letters.reverse() : sweep.letters;
      return selectChronological(chronological, checkpoint, all);
    }
    const sweep = await collectLetters({ readCurrent, goOlder: firstNavigate,
      checkpoint: firstDirection === 'older' && !partial ? checkpoint : '',
      all: firstDirection === 'newer' || partial || all, signal, onLetter });
    const chronological = firstDirection === 'older' ? sweep.letters.reverse() : sweep.letters;
    if (partial) return { letters: chronological, newestId: '', indexOffset: 0, complete: false };
    if (firstDirection === 'older' && !all && checkpoint) {
      return { letters: chronological, newestId: chronological.at(-1)?.id || checkpoint,
        indexOffset: previousTotal, complete: true };
    }
    return selectChronological(chronological, checkpoint, all);
  }

  function selectChronological(chronological, checkpoint, all) {
    const newestId = chronological.at(-1)?.id || '';
    if (all || !checkpoint) return { letters: chronological, newestId, indexOffset: 0, complete: true };
    const checkpointIndex = chronological.findIndex(letter => letter.id === checkpoint);
    if (checkpointIndex < 0) throw exportError('statusMissingCheckpoint', 'Previous export checkpoint was not found');
    return { letters: chronological.slice(checkpointIndex + 1), newestId,
      indexOffset: checkpointIndex + 1, complete: true };
  }

  function shouldAdvanceCheckpoint(kind, complete, confirmed) {
    return kind === 'letters' && complete && confirmed;
  }

  function scanProgress(kind, exportAll, progress) {
    const all = exportAll || kind === 'fill' || kind === 'letter-stamps';
    return { checkpoint: all ? '' : progress.checkpoint,
      previousTotal: all ? 0 : progress.total, all };
  }

  function eligibleCachedLetters(rows, progress, currentLetterId, hasNewer = false) {
    if (!progress?.checkpoint || !Number.isInteger(progress.total) || progress.total < 1) return null;
    if (hasNewer || currentLetterId !== progress.checkpoint) return null;
    const indexed = rows.filter(row => Number.isInteger(row.index) && row.index > 0);
    const byIndex = new Map(indexed.map(row => [row.index, row]));
    if (rows.length !== progress.total || indexed.length !== progress.total || byIndex.size !== progress.total
        || byIndex.get(progress.total)?.id !== progress.checkpoint) return null;
    const ordered = Array.from({ length: progress.total }, (_, index) => byIndex.get(index + 1));
    return ordered.every(Boolean) ? ordered : null;
  }

  function reusableArchive(rows, progresses, currentLetterId, hasNewer = false) {
    for (const progress of progresses) {
      const letters = eligibleCachedLetters(rows, progress, currentLetterId, hasNewer);
      if (letters) return { letters, progress };
    }
    const indexed = rows.filter(row => Number.isInteger(row.index) && row.index > 0);
    const last = indexed.find(row => row.index === indexed.length);
    const progress = { checkpoint: last?.id || '', total: indexed.length };
    const letters = eligibleCachedLetters(rows, progress, currentLetterId, hasNewer);
    if (letters) return { letters, progress };
    return null;
  }

  function indexArchiveLetters(letters) {
    return letters.map((letter, index) => ({ ...letter, index: index + 1 }));
  }

  function freshScanNavigation(available, navigation) {
    return available === 'both'
      ? { direction: navigation?.direction || 'newer', atEnd: 'reverse' }
      : navigation;
  }

  function requiresDownloadConfirmation(kind, count) {
    return kind === 'letters' && count > 1;
  }

  function safeWriteSettings(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  function showLetterActions(letterId, stampContext) {
    return Boolean(letterId) && stampContext?.type !== 'collection';
  }

  function quickExportPlan(letterId, stampContext, newer, older) {
    if (stampContext?.type === 'collection') return { kind: 'stamps' };
    if (letterId) return { kind: 'letters',
      ...(newer && older ? { navigation: { direction: 'newer', atEnd: 'reverse' } } : {}) };
    return stampContext ? { kind: 'stamps' } : null;
  }

  function matchReplyAppearance(exportButton, gearButton, replyButton, computedStyle) {
    if (!replyButton || typeof computedStyle !== 'function') return false;
    const rect = replyButton.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = computedStyle(replyButton);
    exportButton.style.width = `${rect.width}px`;
    exportButton.style.height = '48px';
    exportButton.style.fontSize = '1.25rem';
    exportButton.style.fontWeight = '400';
    gearButton.style.width = '48px';
    gearButton.style.height = '48px';
    for (const property of ['color', 'fontFamily', 'lineHeight', 'boxShadow']) {
      if (style[property]) exportButton.style[property] = style[property];
    }
    if (style.backgroundColor && style.backgroundColor !== 'transparent'
        && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      exportButton.style.backgroundColor = style.backgroundColor;
      gearButton.style.backgroundColor = style.backgroundColor;
    }
    if (style.color) gearButton.style.color = style.color;
    return true;
  }

  function clampWidgetPosition(x, y, viewportWidth, viewportHeight, width, height) {
    return { x: Math.max(0, Math.min(x, viewportWidth - width)),
      y: Math.max(0, Math.min(y, viewportHeight - height)) };
  }
  function moveWidget(launcher, panel, x, y, viewportWidth, viewportHeight) {
    const launchRect = launcher.getBoundingClientRect();
    const measuredPanel = panel.getBoundingClientRect();
    const panelRect = { width: measuredPanel.width || 380, height: measuredPanel.height || 520 };
    const position = clampWidgetPosition(x, y, viewportWidth, viewportHeight, launchRect.width, launchRect.height);
    launcher.style.right = 'auto';
    launcher.style.left = `${position.x}px`;
    launcher.style.top = `${position.y}px`;
    panel.style.right = 'auto';
    panel.style.left = `${Math.max(0, Math.min(position.x + launchRect.width - panelRect.width, viewportWidth - panelRect.width))}px`;
    const below = position.y + launchRect.height + 8;
    const belowSpace = viewportHeight - below;
    const aboveSpace = position.y - 8;
    const placeBelow = belowSpace >= aboveSpace;
    const availableHeight = Math.min(520, Math.max(0, placeBelow ? belowSpace : aboveSpace));
    panel.style.maxHeight = `${availableHeight}px`;
    panel.style.top = `${placeBelow ? below : Math.max(0, position.y - availableHeight - 8)}px`;
    return position;
  }

  function isActionDisabled(action, running, cancellable = true) {
    if (action === 'archive-choice') return false;
    return action === 'cancel' ? !running || !cancellable : running;
  }

  function nextLetterReady(previous, next, previousNavigation = '', nextNavigation = '') {
    if (!next?.id || next.id === previous.id) return false;
    return `${next.date}|${next.author}|${next.body}` !== `${previous.date}|${previous.author}|${previous.body}`
      || Boolean(nextNavigation && nextNavigation !== '|' && previousNavigation !== nextNavigation);
  }

  function formatControls(format) {
    return { mode: format === 'markdown', layout: format === 'markdown' || format === 'html',
      style: format === 'markdown', htmlLayout: format === 'html',
      accent: format === 'html' || format === 'epub' };
  }

  function filenamePreview(format, template) {
    const extension = format === 'txt' ? 'txt' : format === 'markdown' ? 'md' : 'html';
    const name = core.renderFilename(template,
      { date: '2026-11-08T14:03:00', author: 'Alice', location: 'Taipei' }, 7, extension);
    return format === 'html' || format === 'epub' ? name.slice(0, -5) : name;
  }

  const SETTINGS_KEY = 'slowly-export-pro.settings.v1';
  const PROGRESS_PREFIX = 'slowly-export-pro.progress.v1.';
  const DEFAULT_SETTINGS = {
    locale: 'en', accountKey: 'me', template: core.DEFAULT_TEMPLATE,
    mode: 'zip', layout: 'root', style: 'simple', format: 'markdown', htmlLayout: 'slowly',
    accent: '#b88700', cache: false, exportAll: false,
  };
  function browserLocale() {
    const lang = (root.navigator?.language || 'en').toLowerCase();
    if (lang.startsWith('zh')) return /hant|tw|hk|mo/.test(lang) ? 'zh-TW' : 'zh-CN';
    if (lang.startsWith('pt')) return 'pt-BR';
    return i18n.SUPPORTED_LOCALES.find(x => lang.startsWith(x.toLowerCase())) || 'en';
  }
  function loadSettings() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
      const input = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      const loaded = { ...DEFAULT_SETTINGS, locale: browserLocale() };
      for (const [key, values] of Object.entries({ mode: ['zip', 'single', 'direct'],
        layout: ['root', 'assets', 'category'], style: ['simple', 'rich', 'compact'],
        format: ['markdown', 'html', 'epub', 'txt'],
        htmlLayout: ['slowly', 'album', 'continuous', 'sidebar', 'timeline', 'gallery'] })) {
        if (values.includes(input[key])) loaded[key] = input[key];
      }
      if (i18n.SUPPORTED_LOCALES.includes(input.locale)) loaded.locale = input.locale;
      if (typeof input.accountKey === 'string') loaded.accountKey = input.accountKey.trim() || 'me';
      if (typeof input.template === 'string') loaded.template = input.template;
      for (const key of ['cache', 'exportAll']) if (typeof input[key] === 'boolean') loaded[key] = input[key];
      loaded.accent = formats.normalizeAccent(input.accent);
      if (Number.isFinite(input.widgetPosition?.x) && Number.isFinite(input.widgetPosition?.y)) {
        loaded.widgetPosition = { x: input.widgetPosition.x, y: input.widgetPosition.y };
      }
      return loaded;
    }
    catch { return { ...DEFAULT_SETTINGS, locale: browserLocale() }; }
  }
  let settings;
  let panel;
  let statusNode;
  let archiveStatusNode;
  let statusMessage = '';
  let statusWarning = false;
  let quickButton;
  let settingsButton;
  let launcherNode;
  let busy = false;
  let taskCancellable = true;
  let aborter;
  let lastContext = '';
  let settingsError = false;
  let pendingNavigation = null;
  let pendingArchiveChoice = null;
  let beginWidgetDrag;
  let suppressDragClick = false;
  const tr = key => i18n.t(settings.locale, key);
  const saveSettings = () => {
    let saved = false;
    try { saved = safeWriteSettings(root.localStorage, SETTINGS_KEY, settings); }
    catch { /* localStorage is unavailable */ }
    settingsError = !saved;
    if (!saved) setStatus(tr('statusSettingsNotSaved'), true);
  };
  const progressKey = (accountKey, friendId, format = 'markdown') => `${PROGRESS_PREFIX}${encodeURIComponent(accountKey)}.${encodeURIComponent(friendId)}${format === 'markdown' ? '' : `.${encodeURIComponent(format)}`}`;
  function readProgress(accountKey, friendId, format) {
    try {
      const value = JSON.parse(root.localStorage.getItem(progressKey(accountKey, friendId, format)) || 'null');
      return value && typeof value.checkpoint === 'string' && Number.isSafeInteger(value.total) && value.total >= 0
        ? { checkpoint: value.checkpoint, total: value.total } : { checkpoint: '', total: 0 };
    }
    catch { return { checkpoint: '', total: 0 }; }
  }
  function writeProgress(accountKey, friendId, format, newestId, total) {
    try {
      root.localStorage.setItem(progressKey(accountKey, friendId, format), JSON.stringify({ checkpoint: newestId, total, savedAt: new Date().toISOString() }));
      return true;
    } catch { return false; }
  }
  function createArchive(accountKey) { return storage.createStore(storage.createIndexedDBBackend(root.indexedDB), accountKey); }

  function el(tag, text, className) {
    const node = root.document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function setStatus(message, warning = false) {
    statusMessage = message;
    statusWarning = warning;
    if (statusNode) {
      statusNode.textContent = message;
      statusNode.classList.toggle('sep-status-error', warning);
      statusNode.setAttribute('role', warning ? 'alert' : 'status');
    }
    if (panel) {
      panel.classList.remove('sep-error-flash');
      if (warning) {
        void panel.offsetWidth;
        panel.classList.add('sep-error-flash');
      }
    }
  }
  function setBusy(value) {
    busy = value;
    if (panel) panel.querySelectorAll('button[data-action], input, select').forEach(control => {
      control.disabled = isActionDisabled(control.dataset?.action || 'setting', value, taskCancellable);
    });
    if (quickButton) quickButton.disabled = value;
  }
  function field(labelKey, control, container = panel) {
    const label = el('label', tr(labelKey), 'sep-field');
    label.append(control);
    container.append(label);
    return control;
  }
  function choice(labelKey, key, values, container = panel) {
    const select = el('select');
    select.dataset.setting = key;
    for (const [value, title] of values) {
      const option = el('option', title);
      option.value = value;
      select.append(option);
    }
    select.value = settings[key];
    select.addEventListener('change', () => {
      settings[key] = select.value;
      saveSettings();
      if (key === 'locale') {
        quickButton.textContent = tr('quickExport');
        settingsButton.title = tr('settings');
        settingsButton.setAttribute('aria-label', tr('settings'));
      }
      if (key === 'locale' || key === 'format') renderPanel(key);
    });
    return field(labelKey, select, container);
  }
  function checkbox(labelKey, key) {
    const input = el('input');
    input.type = 'checkbox';
    input.checked = settings[key];
    input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); });
    const label = el('label', null, 'sep-check');
    label.append(input, root.document.createTextNode(` ${tr(labelKey)}`));
    panel.append(label);
  }
  function button(key, action, callback, container = panel) {
    const node = el('button', tr(key), 'sep-button');
    node.type = 'button';
    node.dataset.action = action;
    node.addEventListener('click', callback);
    container.append(node);
    return node;
  }
  function openHtmlPreview() {
    const html = formats.renderHtmlPreview({
      htmlLayout: settings.htmlLayout, accent: settings.accent, locale: settings.locale,
    });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const opened = root.open(url, '_blank');
    if (!opened) {
      URL.revokeObjectURL(url);
      setStatus(tr('statusPreviewBlocked'), true);
      return;
    }
    opened.opener = null;
    root.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function renderNavigationPanel() {
    if (pendingNavigation.step === 'intro') {
      panel.append(el('p', tr('middleLetterPrompt')));
      button('navigateManually', 'manual', () => { pendingNavigation = null; panel.hidden = true; });
      button('continueFromMiddle', 'continue', () => { pendingNavigation.step = 'options'; renderPanel(); });
      Array.from(panel.querySelectorAll('button[data-action], input, select'))
        .find(control => control.dataset?.action === 'continue')?.focus();
      return;
    }
    panel.append(el('p', tr('middleLetterOptions')));
    const direction = el('select');
    direction.dataset.setting = 'direction';
    for (const [value, key] of [['older', 'directionOlder'], ['newer', 'directionNewer']]) {
      const option = el('option', tr(key)); option.value = value; direction.append(option);
    }
    const endBehavior = el('select');
    for (const [value, key] of [['stop', 'endStop'], ['reverse', 'endReverse']]) {
      const option = el('option', tr(key)); option.value = value; endBehavior.append(option);
    }
    endBehavior.value = 'reverse';
    field('directionLabel', direction);
    field('endBehaviorLabel', endBehavior);
    panel.append(el('small', tr('reverseWarning')));
    button('startExport', 'start', () => {
      const kind = pendingNavigation.kind;
      const plan = { direction: direction.value, atEnd: endBehavior.value };
      pendingNavigation = null;
      renderPanel();
      runLetters(kind, plan);
    });
    button('cancel', 'dismiss', () => { pendingNavigation = null; renderPanel(); });
    direction.focus();
  }
  function resolveArchiveChoice(source) {
    if (!pendingArchiveChoice) return;
    const resolve = pendingArchiveChoice;
    pendingArchiveChoice = null;
    renderPanel();
    if (source === null) setStatus(tr('statusReady'));
    resolve(source);
  }
  function chooseArchiveSource() {
    return new Promise(resolve => {
      pendingArchiveChoice = resolve;
      panel.hidden = false;
      renderPanel();
    });
  }
  function renderArchiveChoicePanel() {
    panel.append(el('p', tr('archiveChoiceHint')));
    const local = button('useArchive', 'archive-choice', () => resolveArchiveChoice('cache'));
    button('fetchAllAgain', 'archive-choice', () => resolveArchiveChoice('refresh'));
    button('close', 'archive-choice', () => resolveArchiveChoice(null));
    local.focus?.();
  }
  function renderPanel(focusSetting = '') {
    if (!panel) return;
    panel.replaceChildren();
    statusNode = null;
    archiveStatusNode = null;
    const heading = el('div', null, 'sep-heading');
    if (beginWidgetDrag) heading.addEventListener('pointerdown', beginWidgetDrag);
    heading.append(el('strong', tr('title')));
    const close = el('button', '×', 'sep-close');
    close.type = 'button';
    close.title = tr('close');
    close.setAttribute('aria-label', tr('close'));
    close.addEventListener('click', () => {
      if (pendingArchiveChoice) resolveArchiveChoice(null);
      pendingNavigation = null; panel.hidden = true;
    });
    heading.append(close);
    panel.append(heading);
    statusNode = el('p', statusMessage || (settingsError ? tr('statusSettingsNotSaved') : tr('statusReady')), 'sep-status');
    statusNode.classList.toggle('sep-status-error', statusWarning || settingsError);
    statusNode.setAttribute('role', statusWarning || settingsError ? 'alert' : 'status');
    panel.append(statusNode);
    if (settingsError && !statusMessage) setStatus(tr('statusSettingsNotSaved'), true);
    if (pendingArchiveChoice) { renderArchiveChoicePanel(); setBusy(busy); return; }
    if (pendingNavigation) { renderNavigationPanel(); setBusy(busy); return; }
    choice('language', 'locale', i18n.SUPPORTED_LOCALES.map(locale => [locale, ({ en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', 'pt-BR': 'Português (Brasil)' })[locale]]));
    const account = el('input');
    account.type = 'text'; account.value = settings.accountKey;
    account.placeholder = 'me';
    account.addEventListener('change', () => {
      settings.accountKey = account.value.trim();
      archiveStatusNode?.replaceChildren();
      saveSettings();
    });
    field('localAccount', account);
    panel.append(el('small', tr('accountHint')));
    const template = el('input');
    template.type = 'text'; template.value = settings.template;
    template.readOnly = true;
    template.dataset.setting = 'template';
    const preview = el('small', '', 'sep-preview');
    const updatePreview = () => {
      settings.template = template.value;
      saveSettings();
      const stemOnly = settings.format === 'html' || settings.format === 'epub';
      preview.textContent = `${tr(stemOnly ? 'assetNamePreview' : 'filenamePreview')}: ${filenamePreview(settings.format, settings.template)}`;
    };
    template.addEventListener('input', updatePreview);
    field(settings.format === 'html' || settings.format === 'epub' ? 'assetFilenameTemplate' : 'filenameTemplate', template);
    template.setSelectionRange(template.value.length, template.value.length);
    const templateButtons = el('div', null, 'sep-template-buttons');
    const editTemplate = (fragment, deleteSelection = false) => {
      const start = Number.isInteger(template.selectionStart) ? template.selectionStart : template.value.length;
      const end = Number.isInteger(template.selectionEnd) ? template.selectionEnd : start;
      const from = deleteSelection && start === end ? Math.max(0, start - 1) : start;
      template.value = template.value.slice(0, from) + fragment + template.value.slice(end);
      const cursor = from + fragment.length;
      template.focus();
      template.setSelectionRange(cursor, cursor);
      updatePreview();
    };
    const templateButton = (label, fragment, title = label) => {
      const control = el('button', label, 'sep-template-button');
      control.type = 'button'; control.dataset.action = 'template';
      control.title = title; control.setAttribute('aria-label', title);
      control.addEventListener('pointerdown', event => event.preventDefault());
      control.addEventListener('click', () => editTemplate(fragment));
      templateButtons.append(control);
    };
    for (const [key, label] of [['date', 'templateDate'], ['time', 'templateTime'],
      ['index', 'templateIndex'], ['author', 'templateAuthor'], ['location', 'templateLocation']]) {
      templateButton(tr(label), `{${key}}`);
    }
    for (const fragment of [' ', '-', '(', ')']) templateButton(fragment === ' ' ? '␣' : fragment, fragment);
    const deleteButton = el('button', '⌫', 'sep-template-button');
    deleteButton.type = 'button'; deleteButton.dataset.action = 'template';
    deleteButton.title = tr('templateDelete'); deleteButton.setAttribute('aria-label', tr('templateDelete'));
    deleteButton.addEventListener('pointerdown', event => event.preventDefault());
    deleteButton.addEventListener('click', () => editTemplate('', true));
    templateButtons.append(deleteButton);
    const clearButton = el('button', tr('templateClear'), 'sep-template-button');
    clearButton.type = 'button'; clearButton.dataset.action = 'template';
    clearButton.addEventListener('pointerdown', event => event.preventDefault());
    clearButton.addEventListener('click', () => {
      template.value = '';
      template.focus(); template.setSelectionRange(0, 0);
      updatePreview();
    });
    templateButtons.append(clearButton);
    panel.append(templateButtons);
    panel.append(preview);
    updatePreview();
    choice('outputFormat', 'format', [['markdown', tr('formatMarkdown')], ['html', tr('formatHtml')],
      ['epub', tr('formatEpub')], ['txt', tr('formatTxt')]]);
    const controls = formatControls(settings.format);
    if (controls.mode) choice('outputMode', 'mode', [['zip', tr('modeZip')], ['single', tr('modeSingle')], ['direct', tr('modeDirect')]]);
    if (controls.layout) choice('assetLayout', 'layout', [['root', tr('layoutRoot')], ['assets', tr('layoutAssets')], ['category', tr('layoutCategory')]]);
    if (controls.style) choice('style', 'style', [['simple', tr('styleSimple')], ['rich', tr('styleRich')], ['compact', tr('styleCompact')]]);
    if (controls.htmlLayout) {
      const row = el('div', null, 'sep-layout-row');
      choice('htmlLayout', 'htmlLayout', [['slowly', tr('layoutSlowly')],
        ['album', tr('layoutAlbum')],
        ['continuous', tr('layoutContinuous')], ['sidebar', tr('layoutSidebar')],
        ['timeline', tr('layoutTimeline')], ['gallery', tr('layoutGallery')]], row);
      const previewButton = el('button', tr('previewHtml'), 'sep-preview-button');
      previewButton.type = 'button'; previewButton.dataset.action = 'preview';
      previewButton.addEventListener('click', openHtmlPreview);
      row.append(previewButton);
      panel.append(row);
    }
    if (controls.accent) {
      const accent = el('input'); accent.type = 'color'; accent.value = settings.accent;
      accent.addEventListener('input', () => { settings.accent = formats.normalizeAccent(accent.value); saveSettings(); });
      field('accentColor', accent);
    }
    if (settings.format !== 'markdown') panel.append(el('small', tr(`formatHint${settings.format[0].toUpperCase()}${settings.format.slice(1)}`)));
    checkbox('cache', 'cache');
    panel.append(el('small', tr('cacheHint')));
    checkbox('exportAll', 'exportAll');
    panel.append(el('small', tr('exportAllHint')));
    const letter = core.parseLetterId(root.location.href);
    const stampContext = dom.detectStampContext(root.document, root.location);
    if (showLetterActions(letter, stampContext)) {
      button('exportLetters', 'letters', () => runLetters('letters'));
      button('exportLetterStamps', 'letter-stamps', () => runLetters('letter-stamps'));
    }
    if (stampContext) button('exportStamps', 'stamps', runStamps);
    if (!letter && !stampContext) panel.append(el('small', tr('statusNoContext')));
    const cancel = button('cancel', 'cancel', () => aborter?.abort());
    cancel.disabled = !busy;
    const archiveArea = el('details', null, 'sep-archive-area');
    archiveArea.open = false;
    archiveArea.append(el('summary', tr('archiveManagement')));
    if (showLetterActions(letter, stampContext)) button('fillArchive', 'fill', () => runLetters('fill'), archiveArea);
    button('viewArchiveStatus', 'archive-status', () => viewArchiveStatus(archiveStatusNode), archiveArea);
    archiveStatusNode = el('div', null, 'sep-archive-status');
    archiveStatusNode.setAttribute('aria-live', 'polite');
    archiveArea.append(archiveStatusNode);
    button('backupArchive', 'backup', backupArchive, archiveArea);
    button('restoreArchive', 'restore', restoreArchive, archiveArea);
    button('clearArchive', 'clear', clearArchive, archiveArea);
    panel.append(archiveArea);
    const credit = el('footer', null, 'sep-credit');
    credit.append(el('div', `Slowly Export Pro ${SCRIPT_VERSION} ${new Date().getFullYear()}`));
    const attribution = el('div');
    attribution.append(el('span', tr('creditPrefix')));
    const original = el('span', 'Slowly Export');
    attribution.append(original, el('span', tr('creditSuffix')));
    credit.append(attribution);
    panel.append(credit);
    setBusy(busy);
    if (focusSetting) Array.from(panel.querySelectorAll('button[data-action], input, select'))
      .find(control => control.dataset.setting === focusSetting)?.focus();
  }

  function ensureAccount() {
    if (!settings.accountKey.trim()) throw exportError('statusAccountRequired', 'My pen name is required');
  }
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = el('a');
    anchor.href = url;
    anchor.download = name;
    root.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function autoAccountLabel(doc, viewportWidth, currentSettings, persist, wait = delay) {
    if (currentSettings.accountKey !== 'me') return false;
    const trigger = dom.findAccountMenuTrigger(doc, viewportWidth);
    if (!trigger) return null;
    const wasOpen = Boolean(dom.accountMenu(trigger));
    if (!wasOpen) trigger.click();
    let label = '';
    for (let attempt = 0; attempt < 5 && !label; attempt++) {
      label = dom.readAccountLabelFromMenu(trigger);
      if (!label) await wait(100);
    }
    if (!wasOpen && dom.accountMenu(trigger)) trigger.click();
    if (!label || currentSettings.accountKey !== 'me') return false;
    currentSettings.accountKey = label;
    persist();
    return true;
  }
  function navigationSignature() {
    const newer = dom.getNewerLetterLink(root.document);
    const older = dom.getOlderLetterLink(root.document);
    return `${newer?.getAttribute('href') || newer?.href || ''}|${older?.getAttribute('href') || older?.href || ''}`;
  }
  async function goLetter(previous, direction) {
    const link = direction === 'older' ? dom.getOlderLetterLink(root.document) : dom.getNewerLetterLink(root.document);
    if (!link) return false;
    const started = Date.now();
    const previousNavigation = navigationSignature();
    let changedNavigation = '';
    let changedAt = 0;
    link.click();
    while (Date.now() - started < 20000) {
      if (aborter?.signal.aborted) throw exportError('statusCancelled', 'Export cancelled');
      await delay(250);
      const nextId = core.parseLetterId(root.location.href);
      if (!nextId || nextId === previous.id) continue;
      try {
        const next = dom.readLetter(root.document, root.location);
        if (nextLetterReady(previous, next)) return true;
        const currentNavigation = navigationSignature();
        if (nextLetterReady(previous, next, previousNavigation, currentNavigation)) {
          if (changedNavigation !== currentNavigation) {
            changedNavigation = currentNavigation;
            changedAt = Date.now();
          } else if (Date.now() - changedAt >= 1000) return true;
        }
      } catch { /* wait for the new letter DOM */ }
    }
    throw exportError('statusTimeout', 'Timed out waiting for the next letter');
  }
  const goOlder = previous => goLetter(previous, 'older');
  const goNewer = previous => goLetter(previous, 'newer');
  async function fetchAsset(url) {
    const response = await fetch(url, { signal: aborter?.signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }
  function reportStampProgress(event) {
    if (event.phase === 'stamp') {
      setStatus(`${tr('statusStampProgress')} ${event.current}/${event.total}`);
      console.info('[Slowly Export Pro] stamp', event.current, '/', event.total, event.id);
    } else if (event.phase === 'zip') {
      setStatus(`${tr('statusZipProgress')} ${event.percent}%`);
    }
  }
  function reportLetterProgress(event) {
    if (event.phase === 'asset') setStatus(`${tr('statusAssetProgress')} ${event.current}/${event.total}`);
    else if (event.phase === 'render') setStatus(`${tr('statusRendering')} ${event.total}`);
    else if (event.phase === 'zip') setStatus(`${tr('statusZipProgress')} ${event.percent}%`);
  }
  async function runTask(action, cancellable = true) {
    if (busy) return;
    archiveStatusNode?.replaceChildren();
    taskCancellable = cancellable;
    aborter = new AbortController();
    setBusy(true);
    try { await action(); }
    catch (error) { setStatus(`${tr('statusError')}: ${error?.code ? tr(error.code) : error?.message || error}`, true); }
    finally { setBusy(false); aborter = null; taskCancellable = true; }
  }
  async function runLetters(kind, navigation) {
    if (busy) return;
    const initialDirection = availableDirection(Boolean(dom.getNewerLetterLink(root.document)),
      Boolean(dom.getOlderLetterLink(root.document)));
    if (initialDirection === 'both' && !navigation) {
      pendingNavigation = { kind, step: 'intro' };
      renderPanel();
      return;
    }
    return runTask(async () => {
      ensureAccount();
      const options = { ...settings };
      const accountKey = options.accountKey.trim();
      const friendId = core.parseFriendId(root.location.href);
      if (!friendId || !core.parseLetterId(root.location.href)) throw exportError('statusNoContext', 'No letter is open');
      if (kind === 'fill' && !options.cache) throw exportError('statusEnableCache', 'Enable the local archive first');
      const progress = readProgress(accountKey, friendId, options.format);
      let scan = scanProgress(kind, options.exportAll, progress);
      const available = availableDirection(Boolean(dom.getNewerLetterLink(root.document)),
        Boolean(dom.getOlderLetterLink(root.document)));
      let store = options.cache && kind !== 'letter-stamps' ? createArchive(accountKey) : null;
      let archive = null;
      let archiveWarning = false;
      if (store && kind === 'letters') {
        setStatus(tr('statusCheckingArchive'));
        try {
          const progressCandidates = [progress, readProgress(accountKey, friendId, 'archive'), ...['markdown', 'html', 'epub', 'txt']
            .filter(format => format !== options.format)
            .map(format => readProgress(accountKey, friendId, format))];
          archive = reusableArchive(await store.list(friendId), progressCandidates,
            core.parseLetterId(root.location.href), Boolean(dom.getNewerLetterLink(root.document)));
        }
        catch (error) {
          console.warn('[Slowly Export Pro] Local archive unavailable:', error);
          store = null;
          archiveWarning = true;
        }
      }
      const source = archive ? await chooseArchiveSource() : 'refresh';
      if (!source) return;
      const useCache = source === 'cache';
      if (archive && !useCache) scan = { checkpoint: '', previousTotal: 0, all: true };
      const scanNavigation = archive && !useCache ? freshScanNavigation(available, navigation) : navigation;
      setStatus(tr(useCache ? 'statusUsingArchive' : 'statusScanning'));
      const result = useCache ? { letters: archive.letters, newestId: archive.progress.checkpoint, indexOffset: 0, complete: true }
        : await collectFromPosition({
        readCurrent: () => dom.readLetter(root.document, root.location),
        goOlder, goNewer, available,
        direction: scanNavigation?.direction, atEnd: scanNavigation?.atEnd,
        ...scan, signal: aborter.signal,
        onMove: count => setStatus(`${tr('statusSeekingEnd')} ${count}`),
        onLetter: async (letter, count) => {
          setStatus(`${tr('statusScanning')} ${count}`);
        },
        });
      if (kind === 'fill') {
        if (!result.complete) { setStatus(tr('statusPartial'), true); return; }
        const indexed = indexArchiveLetters(result.letters);
        if (store) {
          setStatus(`${tr('statusSavingArchive')} ${indexed.length}/${indexed.length}`);
          await store.replaceFriend(friendId, indexed);
        }
        if (indexed.length && !writeProgress(accountKey, friendId, 'archive', indexed.at(-1).id, indexed.length)) {
          setStatus(`${tr('statusArchiveDone')} ${tr('statusProgressNotSaved')}`, true);
          return;
        }
        setStatus(`${tr('statusArchiveDone')} ${result.letters.length}${result.complete ? '' : ` ${tr('statusPartial')}`}`);
        return;
      }
      if (!result.letters.length) {
        setStatus(`${tr('statusNoNew')}${archiveWarning ? ` ${tr('statusArchiveUnavailable')}` : ''}`, archiveWarning);
        return;
      }
      const letters = result.letters.map((letter, i) => ({
        ...letter, index: result.indexOffset + i + 1,
      }));
      if (store && !useCache && kind === 'letters' && result.complete) {
        try {
          setStatus(`${tr('statusSavingArchive')} ${letters.length}/${letters.length}`);
          if (result.indexOffset === 0) await store.replaceFriend(friendId, letters);
          else await store.putMany(letters);
        }
        catch (error) {
          console.warn('[Slowly Export Pro] Could not update local archive:', error);
          archiveWarning = true;
        }
      }
      setStatus(tr('statusBuilding'));
      if (typeof root.JSZip !== 'function') throw new Error('JSZip is not loaded');
      const packageResult = kind === 'letter-stamps'
          ? await output.buildLetterStampExport(root.JSZip, letters, fetchAsset, reportStampProgress, aborter.signal)
          : await output.buildLetterExport(root.JSZip, letters, { ...options, signal: aborter.signal }, fetchAsset, reportLetterProgress);
      if (aborter.signal.aborted) throw exportError('statusCancelled', 'Export cancelled');
      for (const [index, file] of packageResult.downloads.entries()) {
        setStatus(`${tr('statusStartingDownloads')} ${index + 1}/${packageResult.downloads.length}`);
        downloadBlob(file.name, file.blob);
      }
      if (!packageResult.complete) {
        setStatus(`${tr('statusError')}: ${packageResult.warnings.join('; ')}${archiveWarning ? ` ${tr('statusArchiveUnavailable')}` : ''}`, true);
        return;
      }
      if (requiresDownloadConfirmation(kind, packageResult.downloads.length)
          && !root.confirm(`${tr('warningDirect')}\n${tr('confirmDirect')}`)) {
        setStatus(tr('warningDirect'), true);
        return;
      }
      if (result.complete && shouldAdvanceCheckpoint(kind, packageResult.complete, true)
          && !writeProgress(accountKey, friendId, options.format, result.newestId, result.indexOffset + letters.length)) {
        setStatus(`${tr('statusDone')} ${letters.length} ${tr('statusProgressNotSaved')}${archiveWarning ? ` ${tr('statusArchiveUnavailable')}` : ''}`, true);
        return;
      }
      setStatus(`${tr('statusDone')} ${kind === 'letter-stamps' ? packageResult.count : letters.length}${result.complete ? '' : ` ${tr('statusPartial')}`}${archiveWarning ? ` ${tr('statusArchiveUnavailable')}` : ''}`, archiveWarning);
    });
  }
  async function runStamps() {
    return runTask(async () => {
      const context = dom.detectStampContext(root.document, root.location);
      if (!context) throw exportError('statusNoContext', 'No stamp album is open');
      const stamps = dom.readStampItems(context);
      if (!stamps.length) throw exportError('statusNoStamps', 'No stamp images found in the current album');
      setStatus(`${tr('statusBuilding')} ${stamps.length}`);
      if (typeof root.JSZip !== 'function') throw new Error('JSZip is not loaded');
      const result = await output.buildStampExport(root.JSZip, stamps, fetchAsset, undefined, reportStampProgress, aborter.signal);
      if (aborter.signal.aborted) throw exportError('statusCancelled', 'Export cancelled');
      result.downloads.forEach(file => downloadBlob(file.name, file.blob));
      setStatus(result.complete ? `${tr('statusDone')} ${result.count}` : `${tr('statusError')}: ${result.warnings.join('; ')}`, !result.complete);
    });
  }
  async function backupArchive() {
    return runTask(async () => {
      ensureAccount();
      setStatus(tr('statusBackingUp'));
      const json = await createArchive(settings.accountKey.trim()).backup();
      downloadBlob('Slowly-Export-Pro-archive.json', new Blob([json], { type: 'application/json' }));
      setStatus(tr('statusDone'));
    }, false);
  }
  async function viewArchiveStatus(target) {
    return runTask(async () => {
      ensureAccount();
      const summary = storage.summarizeArchive(await createArchive(settings.accountKey.trim()).all());
      target.replaceChildren();
      const line = value => target.append(el('div', value, 'sep-archive-status-line'));
      line(`${summary.letterCount} ${tr('archiveLettersCount')} · ${summary.friendCount} ${tr('archivePenPals')} · ${summary.attachmentCount} ${tr('archiveAttachmentsCount')}`);
      if (!summary.friends.length) line(tr('archiveEmpty'));
      for (const friend of summary.friends) {
        const name = friend.friendName === friend.friendId ? friend.friendName : `${friend.friendName} (${friend.friendId})`;
        line(`${name} · ${friend.letterCount} ${tr('archiveLettersCount')} · ${friend.attachmentCount} ${tr('archiveAttachmentsCount')}`);
        const types = friend.attachmentTypes.map(({ type, count }) => `${type === 'picture' ? tr('archiveTypePicture') : type === 'voice' ? tr('archiveTypeVoice') : type === 'video' ? tr('archiveTypeVideo') : type}: ${count}`).join(' · ');
        line(`${types || tr('archiveNoAttachments')} · ${tr('archiveOldest')}: ${friend.oldestDate || tr('archiveUnknown')} · ${tr('archiveNewest')}: ${friend.newestDate || tr('archiveUnknown')}`);
      }
    }, false);
  }
  async function restoreArchive() {
    if (busy) return;
    try { ensureAccount(); }
    catch (error) { setStatus(error.code ? tr(error.code) : error.message, true); return; }
    const accountKey = settings.accountKey.trim();
    const input = el('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!root.confirm(tr('confirmRestore'))) return;
      runTask(async () => {
        setStatus(tr('statusRestoring'));
        await createArchive(accountKey).restore(await file.text());
        setStatus(tr('statusArchiveDone'));
      }, false);
    }, { once: true });
    input.click();
  }
  async function clearArchive() {
    if (busy) return;
    try { ensureAccount(); }
    catch (error) { setStatus(error.code ? tr(error.code) : error.message, true); return; }
    if (!root.confirm(tr('confirmClear'))) return;
    return runTask(async () => {
      setStatus(tr('statusClearingArchive'));
      await createArchive(settings.accountKey.trim()).clearAll();
      setStatus(tr('statusArchiveDone'));
    }, false);
  }
  function injectStyle() {
    if (root.document.getElementById('sep-style')) return;
    const style = el('style'); style.id = 'sep-style';
    style.textContent = `
 #sep-launcher{position:fixed;right:20px;top:140px;z-index:2147483646;display:flex;align-items:center;gap:8px;touch-action:none}
 #sep-launcher button{background:#ffc300;color:#212529;border:0;cursor:grab;font:400 1.25rem/1.5 'Open Sans',sans-serif;box-shadow:0 3px 12px #0003}#sep-export.btn.btn-reply{position:static;right:auto;bottom:auto;border-radius:999px;padding:.375rem 30px;height:48px;font-size:1.25rem;font-weight:400}#sep-settings.sep-gear{position:static;border-radius:50%;width:48px;height:48px;padding:0;display:grid;place-items:center;line-height:1}#sep-settings svg{width:28px;height:28px;display:block}#sep-launcher button:disabled{opacity:.55;cursor:default}
#sep-panel{position:fixed;right:20px;top:196px;z-index:2147483647;width:min(380px,calc(100vw - 20px));max-height:min(520px,calc(100vh - 20px));overflow:auto;background:#fff;color:#1c2a35;padding:16px;border:1px solid #cad6df;border-radius:12px;box-shadow:0 8px 30px #0004;font:14px/1.4 sans-serif}
 @keyframes sep-error-pulse{0%,100%{border-color:#cad6df;box-shadow:0 8px 30px #0004}50%{border-color:#c62828;box-shadow:0 0 0 4px #c6282866,0 8px 30px #0004}}#sep-panel.sep-error-flash{animation:sep-error-pulse .65s ease-in-out 2}@media(prefers-reduced-motion:reduce){#sep-panel.sep-error-flash{animation:none;border-color:#c62828;box-shadow:0 0 0 3px #c6282866}}
#sep-panel[hidden]{display:none}#sep-panel .sep-heading{position:sticky;top:0;z-index:3;display:flex;justify-content:space-between;align-items:center;font-size:18px;margin-bottom:8px;background:#fff;cursor:move;touch-action:none}
#sep-panel .sep-close{border:0;background:transparent;font-size:22px;cursor:pointer}#sep-panel .sep-field{display:block;margin:9px 0 3px;font-weight:600}
#sep-panel .sep-field input,#sep-panel .sep-field select{display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border:1px solid #acbdc9;border-radius:5px;color:#1c2a35;background:#fff}
#sep-panel .sep-template-buttons{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 3px}#sep-panel .sep-template-button{padding:4px 7px;border:1px solid #acbdc9;border-radius:5px;background:#f5f8fa;color:#1c2a35;cursor:pointer}#sep-panel .sep-template-button:focus-visible{outline:2px solid #795900;outline-offset:2px}#sep-panel .sep-template-button:disabled{opacity:.55;cursor:default}
 #sep-panel .sep-layout-row{display:flex;align-items:end;gap:8px}#sep-panel .sep-layout-row .sep-field{flex:1;min-width:0}#sep-panel .sep-preview-button{flex:none;padding:7px 9px;border:1px solid #bc9a00;border-radius:5px;background:#fff9d8;color:#212529;cursor:pointer}#sep-panel .sep-preview-button:disabled{opacity:.55;cursor:default}
#sep-panel .sep-check{display:block;margin:10px 0}#sep-panel small{display:block;color:#526579;font-size:11px}#sep-panel .sep-preview{word-break:break-all}
#sep-panel .sep-button{display:block;width:100%;margin:7px 0;padding:8px;border:1px solid #bc9a00;border-radius:6px;background:#ffc300;color:#212529;cursor:pointer}
#sep-panel .sep-archive-status{font-size:12px;line-height:1.5;overflow-wrap:anywhere}#sep-panel .sep-archive-status-line{padding:4px 2px;border-bottom:1px solid #e1e5e8}
 #sep-panel .sep-button:disabled{opacity:.55;cursor:default}#sep-panel .sep-status{position:sticky;top:33px;z-index:2;margin:8px 0 12px;padding:8px 10px;background:#edf4f8;color:#173c5b;border-radius:6px;white-space:pre-wrap;word-break:break-word}#sep-panel .sep-status-error{background:#fff0f0;color:#a22626}#sep-panel .sep-archive-area{margin-top:14px;border-top:1px solid #d6e0e6;padding-top:10px}#sep-panel .sep-archive-area summary{cursor:pointer;font-weight:700;color:#334b5c;padding:6px 2px}#sep-panel .sep-archive-area .sep-button{background:#fff8d5}#sep-panel .sep-credit{margin:16px 0 0;padding-top:9px;border-top:1px solid #e2e9ed;font-size:11px;color:#526579}#sep-panel .sep-credit a{margin-left:4px;color:#795900}`;
    root.document.head.append(style);
  }
  function quickExport() {
    if (suppressDragClick) { suppressDragClick = false; return; }
    if (busy) return;
    panel.hidden = false;
    renderPanel();
    refreshWidgetPlacement();
    const letterId = core.parseLetterId(root.location.href);
    const stampContext = dom.detectStampContext(root.document, root.location);
    const plan = quickExportPlan(letterId, stampContext,
      Boolean(dom.getNewerLetterLink(root.document)), Boolean(dom.getOlderLetterLink(root.document)));
    if (!plan) { setStatus(tr('statusNoContext'), true); return; }
    if (letterId && stampContext?.type === 'collection') {
      setStatus(tr('statusStampTarget'));
      if (!root.confirm(tr('confirmStampExport'))) return;
    }
    if (plan.kind === 'stamps') runStamps();
    else runLetters('letters', plan.navigation);
  }
  function refreshWidgetPlacement() {
    if (!launcherNode?.getBoundingClientRect || !panel?.getBoundingClientRect) return;
    const rect = launcherNode.getBoundingClientRect();
    moveWidget(launcherNode, panel, rect.left, rect.top, root.innerWidth, root.innerHeight);
  }
  function start() {
    if (!root.document?.body || root.document.getElementById('sep-launcher')) return;
    let firstRun = false;
    try { firstRun = root.localStorage.getItem(SETTINGS_KEY) === null; }
    catch { /* storage unavailable; keep the default label */ }
    settings = loadSettings();
    injectStyle();
    const launcher = el('div'); launcher.id = 'sep-launcher';
    launcherNode = launcher;
    quickButton = el('button', tr('quickExport'), 'btn btn-reply'); quickButton.id = 'sep-export'; quickButton.type = 'button';
    quickButton.addEventListener('click', quickExport);
    settingsButton = el('button', null, 'sep-gear'); settingsButton.id = 'sep-settings'; settingsButton.type = 'button';
    settingsButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M10 1.5h4l.55 2.45 1.7.7 2.12-1.34 2.82 2.82-1.34 2.12.7 1.7L23 10.5v3l-2.45.55-.7 1.7 1.34 2.12-2.82 2.82-2.12-1.34-1.7.7L14 22.5h-4l-.55-2.45-1.7-.7-2.12 1.34-2.82-2.82 1.34-2.12-.7-1.7L1 13.5v-3l2.45-.55.7-1.7-1.34-2.12 2.82-2.82 2.12 1.34 1.7-.7z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>';
    settingsButton.title = tr('settings'); settingsButton.setAttribute('aria-label', tr('settings'));
    settingsButton.addEventListener('click', () => {
      if (suppressDragClick) { suppressDragClick = false; return; }
      if (pendingArchiveChoice) { resolveArchiveChoice(null); panel.hidden = true; return; }
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { renderPanel(); refreshWidgetPlacement(); }
    });
    launcher.append(quickButton, settingsButton);
    panel = el('section'); panel.id = 'sep-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Slowly Export Pro');
    root.document.body.append(launcher, panel);
    beginWidgetDrag = event => {
      if (event.button > 0 || event.isPrimary === false || event.target?.closest?.('.sep-close')) return;
      const fromLauncher = event.target === launcher || event.target?.parentElement === launcher
        || Boolean(event.target?.closest?.('#sep-launcher'));
      const rect = launcher.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const onMove = next => {
        const dx = next.clientX - startX;
        const dy = next.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        if (fromLauncher) suppressDragClick = true;
        settings.widgetPosition = moveWidget(launcher, panel, rect.left + dx, rect.top + dy,
          root.innerWidth, root.innerHeight);
        next.preventDefault?.();
      };
      const onEnd = () => {
        root.document.removeEventListener('pointermove', onMove);
        root.document.removeEventListener('pointerup', onEnd);
        root.document.removeEventListener('pointercancel', onEnd);
        if (moved) {
          saveSettings();
          root.setTimeout(() => { suppressDragClick = false; }, 0);
        }
      };
      root.document.addEventListener('pointermove', onMove);
      root.document.addEventListener('pointerup', onEnd);
      root.document.addEventListener('pointercancel', onEnd);
    };
    launcher.addEventListener('pointerdown', beginWidgetDrag);
    if (Number.isFinite(settings.widgetPosition?.x) && Number.isFinite(settings.widgetPosition?.y)) {
      moveWidget(launcher, panel, settings.widgetPosition.x, settings.widgetPosition.y,
        root.innerWidth, root.innerHeight);
    }
    const syncReply = () => {
      const reply = root.document.querySelector?.('.letter-actions .btn.btn-reply');
      if (reply) matchReplyAppearance(quickButton, settingsButton, reply, root.getComputedStyle?.bind(root));
    };
    syncReply();
    if (firstRun) {
      let detecting = false;
      let detectionTimer;
      let missingAttempts = 0;
      let menuFailures = 0;
      let stopped = false;
      const stopDetection = () => {
        if (!stopped) root.clearInterval(detectionTimer);
        stopped = true;
      };
      const tryAccount = async () => {
        if (stopped) return;
        if (settings.accountKey !== 'me') { stopDetection(); return; }
        if (busy || detecting) return;
        detecting = true;
        try {
          const found = await autoAccountLabel(root.document, root.innerWidth, settings, () => {
            saveSettings();
            if (!panel.hidden) renderPanel();
          });
          if (found) stopDetection();
          else if (found === null) missingAttempts++;
          else menuFailures++;
        } catch { menuFailures++; }
        finally {
          if (missingAttempts >= 30 || menuFailures >= 3) {
            stopDetection();
            setStatus(tr('statusAccountDetectionFailed'), true);
          }
          detecting = false;
        }
      };
      detectionTimer = root.setInterval(tryAccount, 2000);
      root.setTimeout(tryAccount, 0);
    }
    root.setInterval(() => {
      syncReply();
      const context = `${root.location.pathname}|${dom.detectStampContext(root.document, root.location)?.type || ''}`;
      if (context !== lastContext) { lastContext = context; if (!panel.hidden && !busy) renderPanel(); }
    }, 1000);
  }

  const api = { collectLetters, collectFromPosition, availableDirection, formatControls, filenamePreview, loadSettings, autoAccountLabel, eligibleCachedLetters, reusableArchive, freshScanNavigation, matchReplyAppearance, chooseArchiveSource, shouldAdvanceCheckpoint, scanProgress, quickExportPlan, requiresDownloadConfirmation, safeWriteSettings, showLetterActions,
    isActionDisabled, nextLetterReady, progressKey, readProgress, writeProgress, indexArchiveLetters,
    clampWidgetPosition, moveWidget, start };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.SEP = Object.assign(root.SEP || {}, api);
    if (root.document?.body) start();
    else root.document?.addEventListener('DOMContentLoaded', start, { once: true });
  }
})(globalThis);
