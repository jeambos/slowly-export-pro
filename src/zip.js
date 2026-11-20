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
