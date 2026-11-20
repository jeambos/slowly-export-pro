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
