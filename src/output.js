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
