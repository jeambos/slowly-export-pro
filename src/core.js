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
