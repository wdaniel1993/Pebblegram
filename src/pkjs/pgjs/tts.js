/*
 * tts.js — edge-tts (Microsoft Edge Read-Aloud) synthesis for Pebblegram.
 *
 * Free neural TTS over WebSocket — no API key. The phone WebView's native
 * WebSocket is used (no custom headers needed; the WebView's own browser
 * User-Agent is accepted). Verified protocol (2026-08-06):
 *
 *   1. WS connect to the readaloud endpoint with TrustedClientToken +
 *      ConnectionId + Sec-MS-GEC (SHA-256 of Windows-ticks + token).
 *   2. Send speech.config JSON (outputFormat = audio-24khz-48kbitrate-mono-mp3).
 *   3. Send SSML frame with <voice name="..."> text.
 *   4. Binary frames = MP3 chunks; terminate on text frame "Path:turn.end".
 *   5. Decode MP3 -> 24kHz float32 (mpg123-decoder, vendored ES5) ->
 *      channel 0 (edge-tts "mono" is joint-stereo MP3, both channels equal)
 *      -> resample 24k->8k -> PCM16 -> buildVoiceFrames (voice channel).
 *
 * The C watch side needs NO new plumbing: TTS audio rides the existing
 * voice_start / voice / voice_done AppMessage stream.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./shims/crypto'),
      require('./vendor/mp3-decoder.es5.js'),
      require('../pebblegram-voice')
    );
  } else {
    root.PebblegramTts = factory(null, null, null);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (cryptoShim, mp3Lib, voiceModule) {
  'use strict';

  var TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  var WIN_EPOCH = 11644473600;  // seconds between 1601-01-01 and 1970-01-01
  var OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
  var DEFAULT_VOICE = 'en-US-JennyNeural';

  // TTS output is 24kHz; the watch channel is 8kHz 16-bit mono.
  var TARGET_SAMPLE_RATE = 8000;
  // 60s of 8kHz 16-bit PCM — same cap as voice notes.
  var MAX_PCM_BYTES = 960000;
  // Long messages would take minutes to speak; cap text length (~1 min
  // of speech ≈ 250-300 chars for English at a natural pace).
  var MAX_TEXT_CHARS = 600;

  // ---- helpers ---------------------------------------------------------

  function sha256Hex(input) {
    if (!cryptoShim || !cryptoShim.createHash) {
      throw new Error('tts: crypto shim not available (need createHash sha256)');
    }
    var h = cryptoShim.createHash('sha256');
    h.update(input);
    var digest = h.digest();  // Buffer
    var hex = '';
    for (var i = 0; i < digest.length; i++) {
      var b = digest[i].toString(16);
      hex += b.length === 1 ? '0' + b : b;
    }
    return hex.toUpperCase();
  }

  function windowsTicks(nowMs) {
    // 100-ns intervals since 1601-01-01, rounded DOWN to the nearest 5 min
    // (the service accepts a stale token; floor is the documented pattern).
    var seconds = Math.floor(nowMs / 1000) + WIN_EPOCH;
    var floored = Math.floor(seconds / 300) * 300;
    return floored * 1e7;
  }

  function uuid() {
    // RFC4122 v4 — good enough for ConnectionId/RequestId.
    var s = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        s += '-';
      } else if (i === 14) {
        s += '4';
      } else if (i === 19) {
        s += '89ab'[Math.floor(Math.random() * 4)];
      } else {
        s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
      }
    }
    return s;
  }

  function rfc1123(nowMs) {
    // e.g. "Thu, 06 Aug 2026 12:00:00 GMT" — the service accepts any
    // reasonable date; we derive it from UTC fields manually to avoid
    // toUTCString quirks in old WebViews.
    var d = new Date(nowMs || Date.now());
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return days[d.getUTCDay()] + ', ' + pad(d.getUTCDate()) + ' ' +
      months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' +
      pad(d.getUTCSeconds()) + ' GMT';
  }

  function buildConfigFrame() {
    return 'X-Timestamp:' + rfc1123() + '\r\n' +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"' + OUTPUT_FORMAT + '"}}}}\r\n';
  }

  function buildSsmlFrame(text, voiceName, requestId) {
    var escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return 'X-RequestId:' + requestId + '\r\n' +
      'Content-Type:application/ssml+xml\r\n' +
      'X-Timestamp:' + rfc1123() + '\r\n' +
      'Path:ssml\r\n\r\n' +
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
      'xml:lang="en-US"><voice name="' + voiceName + '">' +
      '<prosody pitch="+0Hz" rate="+0%" volume="+0%">' +
      escaped + '</prosody></voice></speak>\r\n';
  }

  // ---- WS client -------------------------------------------------------

  // synthesize(text, voiceName) -> Promise<Uint8Array mp3Bytes>
  // Uses the WebView's native WebSocket (global WebSocket).
  function synthesize(text, voiceName, options) {
    options = options || {};
    text = String(text || '').slice(0, MAX_TEXT_CHARS);
    voiceName = voiceName || DEFAULT_VOICE;
    if (!text) {
      return Promise.reject(new Error('tts: empty text'));
    }
    var WS = (typeof WebSocket !== 'undefined') ? WebSocket :
      (options.WebSocket || null);
    if (!WS) {
      return Promise.reject(new Error('tts: WebSocket not available'));
    }
    var connectionId = uuid();
    var requestId = uuid();
    var ticks = windowsTicks(Date.now());
    var token = sha256Hex(String(ticks) + TRUSTED_CLIENT_TOKEN);
    var url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/' +
      'readaloud/edge/v1?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN +
      '&ConnectionId=' + connectionId +
      '&Sec-MS-GEC=' + token +
      '&Sec-MS-GEC-Version=1-143.0.3650.75';
    // In the phone WebView, the NATIVE WebSocket is used (it sends the
    // browser UA automatically — the service requires it). In Node tests,
    // inject a wsFactory that returns a header-capable socket with a
    // browser-like UA (native Node WebSocket cannot set headers → 1006).
    var wsFactory = options.wsFactory || function (u) {
      return new WS(u);
    };

    return new Promise(function (resolve, reject) {
      var ws;
      var chunks = [];
      var total = 0;
      var settled = false;
      var timer = setTimeout(function () {
        finish(null, new Error('tts: synthesis timed out'));
      }, options.timeoutMs || 30000);

      function finish(mp3, err) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          ws && ws.close();
        } catch (e) { /* already closed */ }
        if (err) {
          reject(err);
        } else {
          resolve(mp3);
        }
      }

      try {
        ws = wsFactory(url);
        // CRITICAL: native WebSocket defaults to binaryType='blob' — Blob
        // reads are ASYNC, so Path:turn.end can arrive before the blobs
        // are read (→ "empty synthesis"). ArrayBuffer delivers binary
        // frames synchronously; both the WebView and the ws package
        // support setting it before open.
        if (ws && typeof ws.binaryType === 'string') {
          ws.binaryType = 'arraybuffer';
        }
      } catch (e) {
        finish(null, e);
        return;
      }

      ws.onopen = function () {
        try {
          ws.send(buildConfigFrame());
          ws.send(buildSsmlFrame(text, voiceName, requestId));
        } catch (e) {
          finish(null, e);
        }
      };

      ws.onmessage = function (event) {
        var data = event && event.data;
        if (typeof data === 'string') {
          // Metadata text frame; end-of-stream marker.
          if (data.indexOf('Path:turn.end') >= 0) {
            var mp3 = new Uint8Array(total);
            var offset = 0;
            for (var i = 0; i < chunks.length; i++) {
              mp3.set(chunks[i], offset);
              offset += chunks[i].length;
            }
            finish(mp3, null);
          }
          return;
        }
        // Binary frame (Blob or ArrayBuffer or Uint8Array) = MP3 data.
        if (data instanceof ArrayBuffer) {
          var arr = new Uint8Array(data);
          chunks.push(arr);
          total += arr.length;
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          var reader = new FileReader();
          reader.onload = function () {
            var b = new Uint8Array(reader.result);
            chunks.push(b);
            total += b.length;
          };
          reader.onerror = function () {
            finish(null, new Error('tts: blob read failed'));
          };
          reader.readAsArrayBuffer(data);
        } else if (data && data.byteLength !== undefined) {
          var u = new Uint8Array(data.buffer || data, data.byteOffset || 0,
                                 data.byteLength || data.length);
          chunks.push(u);
          total += u.length;
        }
      };

      ws.onerror = function () {
        finish(null, new Error('tts: websocket error'));
      };

      ws.onclose = function (event) {
        // Normal close only happens after turn.end; anything earlier is a
        // failure (e.g. close 1007 unsupported format, 1006 no UA).
        if (!settled) {
          finish(null, new Error('tts: websocket closed (' +
                                 (event && event.code !== undefined ? event.code : '?') + ')'));
        }
      };
    });
  }

  // ---- MP3 -> PCM ------------------------------------------------------

  // decodeMp3(mp3Bytes) -> Promise<Float32Array> at 24kHz, mono (ch0).
  function decodeMp3(mp3Bytes, options) {
    options = options || {};
    var Ctor = (mp3Lib && mp3Lib.MPEGDecoder) ||
      (options.library && options.library.MPEGDecoder);
    if (!Ctor) {
      return Promise.reject(new Error('tts: MP3 decoder not available'));
    }
    var decoder;
    try {
      decoder = new Ctor({ channels: 1 });
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(decoder.ready).then(function () {
      var result = decoder.decode(mp3Bytes);
      var channelData = result && result.channelData;
      var mono = (channelData && channelData[0]) || new Float32Array(0);
      return mono;
    }).then(function (mono) {
      try {
        decoder.free();
      } catch (e) { /* already freed */ }
      return mono;
    }, function (err) {
      try {
        decoder.free();
      } catch (e) { /* already freed */ }
      throw err;
    });
  }

  // ---- Full pipeline ---------------------------------------------------

  // speakFrames(messageKeys, token, transferId, text, voiceName, options)
  // -> Promise<Array<AppMessage payload>> — the exact same shape as
  // pebblegramVoice.createStreamer()() so index.js can sendToWatch() them.
  function speakFrames(messageKeys, token, transferId, text, voiceName, options) {
    options = options || {};
    var voice = voiceModule || options.voice;
    if (!voice) {
      return Promise.reject(new Error('tts: voice module not available'));
    }
    return synthesize(text, voiceName, options).then(function (mp3) {
      if (!mp3 || !mp3.length) {
        throw new Error('tts: empty synthesis');
      }
      return decodeMp3(mp3, options);
    }).then(function (float32) {
      if (!float32 || !float32.length) {
        throw new Error('tts: empty decode');
      }
      var resampled = voice.resampleLinear(float32, 24000, TARGET_SAMPLE_RATE);
      var pcmBytes = voice.floatToPcm16LE(resampled);
      if (pcmBytes.length > MAX_PCM_BYTES) {
        pcmBytes = pcmBytes.subarray(0, MAX_PCM_BYTES);
      }
      var meta = {
        sampleRate: TARGET_SAMPLE_RATE,
        format: voice.PCM_FORMAT['8kHz_16bit'],
        formatName: '8kHz_16bit',
        durationMs: Math.round(pcmBytes.length / 16)
      };
      return voice.buildVoiceFrames(messageKeys, token, transferId, pcmBytes, meta);
    });
  }

  return {
    TRUSTED_CLIENT_TOKEN: TRUSTED_CLIENT_TOKEN,
    DEFAULT_VOICE: DEFAULT_VOICE,
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    MAX_PCM_BYTES: MAX_PCM_BYTES,
    sha256Hex: sha256Hex,
    windowsTicks: windowsTicks,
    rfc1123: rfc1123,
    uuid: uuid,
    buildConfigFrame: buildConfigFrame,
    buildSsmlFrame: buildSsmlFrame,
    synthesize: synthesize,
    decodeMp3: decodeMp3,
    speakFrames: speakFrames
  };
}));
