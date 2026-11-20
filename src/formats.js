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
