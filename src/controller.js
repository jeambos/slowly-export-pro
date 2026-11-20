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
