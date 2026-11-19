import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';

/**
 * Splits an ICY (Shoutcast/Icecast) stream into pure audio bytes and
 * "StreamTitle" metadata blocks that are interleaved every `metaint` bytes.
 */
class IcyDemuxer extends Transform {
  constructor(metaint, onMetadata, encoding) {
    super();
    this.metaint = metaint;
    this.onMetadata = onMetadata;
    this.encoding = encoding;
    this.audioRemaining = metaint;
    this.metaLength = null;
    this.metaChunks = [];
    this.metaRead = 0;
  }

  _transform(chunk, _enc, callback) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.audioRemaining > 0) {
        const n = Math.min(this.audioRemaining, chunk.length - offset);
        this.push(chunk.subarray(offset, offset + n));
        offset += n;
        this.audioRemaining -= n;
      } else if (this.metaLength === null) {
        this.metaLength = chunk[offset++] * 16;
        this.metaChunks = [];
        this.metaRead = 0;
        if (this.metaLength === 0) {
          this.metaLength = null;
          this.audioRemaining = this.metaint;
        }
      } else {
        const n = Math.min(this.metaLength - this.metaRead, chunk.length - offset);
        this.metaChunks.push(chunk.subarray(offset, offset + n));
        offset += n;
        this.metaRead += n;
        if (this.metaRead === this.metaLength) {
          this.#emitMetadata(Buffer.concat(this.metaChunks));
          this.metaLength = null;
          this.audioRemaining = this.metaint;
        }
      }
    }
    callback();
  }

  #emitMetadata(buf) {
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;
    const text = decodeText(buf.subarray(0, end), this.encoding);
    const match = /StreamTitle='(.*?)';(?=\s*\w+=|\s*$)/s.exec(text) ?? /StreamTitle='(.*?)';/s.exec(text);
    if (match) {
      try {
        this.onMetadata?.(match[1].trim());
      } catch {
        // never let a listener break the audio stream
      }
    }
  }
}

function decodeText(buf, encoding) {
  if (encoding && encoding !== 'auto') {
    return new TextDecoder(encoding).decode(buf);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Many Eastern European stations still send cp1251 titles.
    return new TextDecoder('windows-1251').decode(buf);
  }
}

/**
 * Opens a radio stream over HTTP(S), following redirects.
 * Resolves with { stream, headers, close } where `stream` yields raw audio only.
 */
export function openIcyStream(url, { onMetadata, timeoutMs = 15_000, userAgent, metadataEncoding = 'auto', maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        reject(new Error(`Invalid stream URL: ${target}`));
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(parsed, {
        headers: {
          'Icy-MetaData': '1',
          'User-Agent': userAgent,
          Accept: '*/*',
        },
      });

      // Idle-socket timeout: catches both slow connects and mid-stream stalls.
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Stream stalled for ${timeoutMs / 1000}s`)));

      req.once('error', (err) => reject(err));
      req.once('response', (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          req.destroy();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          attempt(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          req.destroy();
          reject(new Error(`Stream responded with HTTP ${status}`));
          return;
        }

        const metaint = Number.parseInt(res.headers['icy-metaint'] ?? '', 10);
        let stream = res;
        if (Number.isFinite(metaint) && metaint > 0) {
          stream = res.pipe(new IcyDemuxer(metaint, onMetadata, metadataEncoding));
          res.once('error', (err) => stream.destroy(err));
          res.once('aborted', () => stream.destroy(new Error('Stream aborted')));
        }

        resolve({
          stream,
          headers: res.headers,
          close: () => {
            req.destroy();
            if (stream !== res) stream.destroy();
          },
        });
      });
    };
    attempt(url, maxRedirects);
  });
}
