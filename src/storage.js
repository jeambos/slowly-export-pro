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
