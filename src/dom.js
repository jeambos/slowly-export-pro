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
