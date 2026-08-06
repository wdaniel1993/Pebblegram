/*
 * pebblegram-voice.js — Voice message decoding + streaming (Phase A).
 *
 * Resides on the phone side (PebbleKit JS). Listens for incoming voice
 * messages (Telegram `mediaVoice` OGG Opus), downloads them, decodes to
 * PCM, optionally resamples to a PebbleOS SpeakerPcmFormat, and streams
 * the PCM to the watch over AppMessage as a chunked `voice_start` /
 * `voice` / `voice_done` sequence.
 *
 * Decoder is pluggable. Production decoder: `opus-decoder`
 * (eshaz/wasm-audio-decoders, MIT) vendored as `pgjs/vendor/opus-decoder.es5.js`
 * (ES5 transpile — the SDK webpack 1.x cannot parse the original modern
 * bundle). WASM is embedded (yenc), no fetch needed. `StubOpusDecoder`
 * remains as a fallback for WebViews without WebAssembly; it emits silence.
 *
 * Chunking math (see package.json messageKeys): APP_INBOX_SIZE on the
 * watch is 2KB. We cap each voice chunk at 800 bytes of raw PCM data
 * so the surrounding envelope (Type, MessageId, Index, VoiceSeq,
 * VoiceTransferId) fits in the remaining ~1.2KB. 800 bytes of 8kHz
 * 16-bit PCM = 50ms of audio per chunk.
 *
 * Reuse the existing image-transfer framing conventions where possible
 * (Type as the message discriminator, Index as byte offset, a
 * monotonically increasing transfer id to cancel stale streams, and a
 * matching done marker).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PebblegramVoice = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- PCM framing constants ------------------------------------------------
  // Match SpeakerPcmFormat values from coredevices/PebbleOS
  // include/pbl/services/speaker/speaker_pcm_format.h.
  var PCM_FORMAT = {
    '8kHz_8bit': 0,
    '16kHz_8bit': 1,
    '8kHz_16bit': 2,
    '16kHz_16bit': 3
  };

  // Default target: 16kHz 16-bit signed mono. 32KB/s — the emery speaker
  // (and its OS resampler) handles this fine and it doubles the audible
  // bandwidth vs 8kHz (4kHz Nyquist), which matters once the resampler
  // stops aliasing. Chunk stays 800B (25ms @ 16kHz) so AppMessage framing
  // and the C spill buffer are untouched.
  var DEFAULT_PCM_FORMAT = '16kHz_16bit';
  var DEFAULT_SAMPLE_RATE = 16000;
  var DEFAULT_BIT_DEPTH = 16;

  // 800 bytes of 16-bit PCM = 400 samples = 50ms @ 8kHz, 25ms @ 16kHz.
  // Under APP_INBOX_SIZE (2048) once envelope fields are accounted for.
  var DEFAULT_VOICE_CHUNK_BYTES = 800;

  // ~1.9 MB upper bound on a single voice stream = 60s of 16kHz 16-bit PCM
  // (32 KB/s at 16kHz_16bit). Telegram voice notes are typically 1-60s; 60s
  // of Opus is ~120KB on the wire but decodes to ~1.9MB PCM. Larger
  // messages get truncated. The watch buffers one stream at a time; JS
  // streams chunks with backpressure from speaker_stream_write, so size is
  // not a transport problem — this cap is only a sanity bound.
  var DEFAULT_VOICE_MAX_BYTES = 1920000;

  // ---- Anti-aliased windowed-sinc resampler --------------------------------
  // The old resampleLinear() had NO low-pass: decimating 24/48kHz audio to
  // 8/16kHz folds every component above the output Nyquist back into the
  // audible band as inharmonic noise — the crackle heard on the watch
  // speaker. This windowed-sinc (Blackman) low-pass runs BEFORE the
  // decimation step, so out-of-band energy is attenuated ~-70dB instead of
  // aliased. Cost: ~64 taps × output samples — trivial for phone JS.
  function resampleSinc(input, inputRate, outputRate) {
    if (!input || !input.length || inputRate === outputRate) {
      return input ? input.slice() : new Float32Array(0);
    }
    var ratio = inputRate / outputRate;
    var outLength = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(outLength);
    // Low-pass cutoff just below the output Nyquist (normalized to input
    // rate). 0.45×outputRate leaves a small transition band so the sinc
    // kernel stays well-behaved.
    var fc = 0.45 * outputRate / inputRate;
    var taps = 64;                  // kernel length (32 each side)
    var half = taps / 2;
    // Blackman window coefficients (constant, computed once).
    var window = new Float32Array(taps);
    for (var n = 0; n < taps; n++) {
      var x = 2 * Math.PI * n / (taps - 1);
      window[n] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    }
    var twoPiFc = 2 * Math.PI * fc;
    for (var i = 0; i < outLength; i++) {
      var center = i * ratio;
      var base = Math.floor(center);
      var acc = 0;
      var wsum = 0;
      for (var k = 0; k < taps; k++) {
        var idx = base - half + k;
        if (idx < 0 || idx >= input.length) {
          continue;
        }
        var t = center - idx;
        // sinc(t) = sin(2π·fc·t) / (π·t); at t≈0 the limit is 2·fc.
        var s = (Math.abs(t) < 1e-9) ? (2 * fc) : (Math.sin(twoPiFc * t) / (Math.PI * t));
        var w = s * window[k];
        acc += input[idx] * w;
        wsum += w;
      }
      out[i] = wsum > 0 ? acc / wsum : 0;
    }
    return out;
  }

  // Linear-interpolation fallback (upsampling only; kept for compatibility).
  // Do NOT use for downsampling — it aliases (the crackle bug).
  function resampleLinear(input, inputRate, outputRate) {
    if (!input || !input.length || inputRate === outputRate) {
      return input ? input.slice() : new Float32Array(0);
    }
    var ratio = inputRate / outputRate;
    var outLength = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(outLength);
    for (var i = 0; i < outLength; i++) {
      var srcIdx = i * ratio;
      var lo = Math.floor(srcIdx);
      var hi = Math.min(lo + 1, input.length - 1);
      var frac = srcIdx - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
  }

  // Convert float32 in [-1, 1] to 16-bit signed little-endian PCM bytes.
  function floatToPcm16LE(samples) {
    var bytes = new Uint8Array(samples.length * 2);
    var view = new DataView(bytes.buffer);
    for (var i = 0; i < samples.length; i++) {
      var clipped = samples[i] > 1 ? 1 : (samples[i] < -1 ? -1 : samples[i]);
      var s = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
      view.setInt16(i * 2, s, true);
    }
    return bytes;
  }

  // Convert float32 in [-1, 1] to 8-bit signed PCM bytes.
  function floatToPcm8(samples) {
    var bytes = new Uint8Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      var clipped = samples[i] > 1 ? 1 : (samples[i] < -1 ? -1 : samples[i]);
      bytes[i] = clipped < 0 ? Math.round(clipped * 128) : Math.round(clipped * 127);
    }
    return bytes;
  }

  // ---- Decoder interface ---------------------------------------------------
  // A decoder takes OGG Opus bytes and yields chunks of float32 PCM at
  // the native decoder sample rate (typically 24k or 48k). It must
  // expose `inputSampleRate` and `channels` for the resampler.
  function StubOpusDecoder(options) {
    this.inputSampleRate = 48000;
    this.channels = 1;
    this.opusBytes = null;
  }
  StubOpusDecoder.prototype.feed = function (opusBytes) {
    this.opusBytes = opusBytes;
  };
  // Returns a Float32Array of PCM samples at inputSampleRate. The stub
  // emits 1s of silence so the framing pipeline is testable without a
  // real decoder. Replace with `opus-decoder` for production.
  StubOpusDecoder.prototype.decodeAll = function () {
    if (!this.opusBytes) {
      return Promise.resolve(new Float32Array(0));
    }
    // Estimate duration from OGG Opus size assuming 16kbps: bytes * 8 / 16000.
    var seconds = Math.min(60, Math.max(1, this.opusBytes.length * 8 / 16000));
    return Promise.resolve(new Float32Array(Math.floor(seconds * this.inputSampleRate)));
  };
  StubOpusDecoder.prototype.close = function () {
    this.opusBytes = null;
  };

  // FfmpegOpusDecoder shells out to the local ffmpeg binary. Used by the
  // Node test harness (`tools/test-voice.js`) to exercise the real
  // decode → resample → chunk path against a real OGG Opus file. Not for
  // production PKJS (no child_process / no shell).
  function FfmpegOpusDecoder(options) {
    options = options || {};
    this.inputSampleRate = 48000;
    this.channels = 1;
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.opusBytes = null;
  }
  FfmpegOpusDecoder.prototype.feed = function (opusBytes) {
    this.opusBytes = opusBytes;
  };
  FfmpegOpusDecoder.prototype.decodeAll = function () {
    if (!this.opusBytes) {
      return Promise.resolve(new Float32Array(0));
    }
    var spawn = require('child_process').spawn;
    return new Promise(function (resolve, reject) {
      var proc = spawn(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ac', '1',
        '-ar', String(this.inputSampleRate),
        'pipe:1'
      ]);
      var chunks = [];
      var stderr = '';
      proc.stdout.on('data', function (c) { chunks.push(c); });
      proc.stderr.on('data', function (c) { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code !== 0) {
          reject(new Error('ffmpeg exit ' + code + ': ' + stderr));
          return;
        }
        var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
        var merged = Buffer.concat(chunks, total);
        // ffmpeg emits host-endian f32le; align to 4 bytes.
        var usable = total - (total % 4);
        var float32 = new Float32Array(merged.buffer, merged.byteOffset, usable / 4);
        resolve(float32);
      });
      proc.stdin.on('error', function () { /* EPIPE on close */ });
      proc.stdin.end(Buffer.from(this.opusBytes));
    }.bind(this));
  };
  FfmpegOpusDecoder.prototype.close = function () {
    this.opusBytes = null;
  };

  // ---- OGG demuxer ---------------------------------------------------------
  // Telegram voice notes are OGG Opus. opus-decoder's decodeFrames() takes
  // raw Opus packets, so we must demux the OGG container: walk pages, follow
  // the segment table (lacing values; 255 = continuation, <255 = packet end).
  // Single-pass, stateful across pages (packets may span page boundaries).
  // Returns an array of Uint8Array packets (OpusHead/OpusTags included —
  // the decoder ignores non-audio packets).
  function oggDemuxPackets(bytes) {
    if (!bytes || bytes.length < 27) {
      return [];
    }
    var packets = [];
    var offset = 0;
    var n = bytes.length;
    var partial = null;  // { start, len } of a packet spanning pages
    while (offset + 27 <= n) {
      if (bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 ||
          bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53) {
        break;  // "OggS" magic — stop on corruption/truncation
      }
      var segCount = bytes[offset + 26];
      var segTableStart = offset + 27;
      if (segTableStart + segCount > n) {
        break;
      }
      var payloadStart = segTableStart + segCount;
      var segSum = 0;
      for (var i = 0; i < segCount; i++) {
        segSum += bytes[segTableStart + i];
      }
      if (payloadStart + segSum > n) {
        break;  // truncated page payload
      }
      var cursor = payloadStart;
      for (var s = 0; s < segCount; s++) {
        var lacing = bytes[segTableStart + s];
        if (partial) {
          // Continue a packet that began on a previous page.
          partial.len += lacing;
          if (lacing < 255) {
            packets.push(bytes.subarray(partial.start, partial.start + partial.len));
            partial = null;
          }
          // If lacing === 255, keep accumulating across more segments/pages.
        } else {
          partial = { start: cursor, len: lacing };
          if (lacing < 255) {
            packets.push(bytes.subarray(cursor, cursor + lacing));
            partial = null;
          }
        }
        cursor += lacing;
      }
      offset = payloadStart + segSum;
    }
    return packets;
  }
  // WasmOpusDecoder wraps opus-decoder (eshaz/wasm-audio-decoders). The
  // WASM binary is embedded in the vendored bundle (yenc/base91-encoded),
  // so no fetch/fs is required — WebAssembly.compile + instantiate only.
  // The phone's WebView (WKWebView/Android WebView) supports WebAssembly.
  // NOTE: the vendored file is the ES5 transpile (opus-decoder.es5.js) —
  // the SDK's webpack 1.x cannot parse the original modern-syntax min.js.
  function WasmOpusDecoder(options) {
    options = options || {};
    this.opusBytes = null;
    this.decoder = null;
    this.readyPromise = null;
    this.inputSampleRate = 48000;
    this.channels = 1;
    this._lib = require('./pgjs/vendor/opus-decoder.es5.js');
    var self = this;
    // opus-decoder exports { OpusDecoder, OpusDecoderWebWorker } via UMD.
    var Ctor = (this._lib && (this._lib.OpusDecoder || this._lib.default)) || null;
    if (!Ctor) {
      throw new Error('opus-decoder library missing OpusDecoder export');
    }
    this.decoder = new Ctor({ channels: 1 });
    this.readyPromise = Promise.resolve(this.decoder.ready).then(function() {
      if (self.decoder && self.decoder.sampleRate) {
        self.inputSampleRate = self.decoder.sampleRate;
      }
      return self;
    });
  }
  WasmOpusDecoder.prototype.feed = function (opusBytes) {
    this.opusBytes = opusBytes;
  };
  WasmOpusDecoder.prototype.decodeAll = function () {
    if (!this.opusBytes || !this.opusBytes.length) {
      return Promise.resolve(new Float32Array(0));
    }
    var self = this;
    return this.readyPromise.then(function() {
      // Demux OGG → raw Opus packets, then decode all frames at once.
      // decodeFrames returns { channelData: Float32Array[], samplesDecoded,
      // sampleRate, errors } — take channel 0 (mono stream).
      var packets = oggDemuxPackets(self.opusBytes);
      if (!packets || !packets.length) {
        return new Float32Array(0);
      }
      // Strip OGG Opus header packets (OpusHead "OpS", OpusTags "OpT").
      // The first packet is OpusHead (magic 0x4f 0x70 0x75 0x73 0x48 —
      // "OpusH"); the second is OpusTags. Feeding them to decodeFrames
      // produces OPUS_INVALID_PACKET errors (harmless but noisy).
      var audio = [];
      for (var i = 0; i < packets.length; i++) {
        var p = packets[i];
        if (p.length >= 8 && p[0] === 0x4f && p[1] === 0x70 &&
            p[2] === 0x75 && p[3] === 0x73 && p[4] === 0x48) {
          continue;  // OpusHead
        }
        if (p.length >= 8 && p[0] === 0x4f && p[1] === 0x70 &&
            p[2] === 0x75 && p[3] === 0x73 && p[4] === 0x54) {
          continue;  // OpusTags
        }
        audio.push(p);
      }
      if (!audio.length) {
        return new Float32Array(0);
      }
      var result = self.decoder.decodeFrames(audio);
      var channelData = result && result.channelData;
      var mono = (channelData && channelData[0]) || new Float32Array(0);
      return mono;
    });
  };
  WasmOpusDecoder.prototype.close = function () {
    this.opusBytes = null;
    if (this.decoder && this.decoder.free) {
      try { this.decoder.free(); } catch (err) { /* already freed */ }
      this.decoder = null;
    }
  };

  function createDecoder(options) {
    if (options && options.driver === 'ffmpeg') {
      return new FfmpegOpusDecoder(options);
    }
    // Production: WASM Opus decoder (opus-decoder, embedded in the bundle —
    // no fetch needed; WebAssembly is available in the phone's WebView).
    // Fall back to the silence stub only if WebAssembly is missing.
    try {
      if (typeof WebAssembly !== 'undefined' && WebAssembly.instantiate) {
        return new WasmOpusDecoder(options);
      }
    } catch (err) {
      // Fall through to the stub if WASM cannot be used.
    }
    return new StubOpusDecoder(options);
  }

  // ---- AppMessage framing ---------------------------------------------------
  // Slice PCM bytes into voice_start + voice[] + voice_done frames.
  // Returns an array of payloads ready to hand to `Pebble.sendAppMessage`.
  //
  // params:
  //   messageKeys  — { Type, MessageId, Index, VoiceToken, VoiceSize,
  //                   VoiceDuration, VoiceSampleRate, VoiceFormat,
  //                   VoiceData, VoiceSeq, VoiceTransferId, VoiceDone }
  //   token        — string token (Telegram message id)
  //   transferId   — int, monotonically increasing per stream
  //   pcmBytes     — Uint8Array, already at the target sample rate / depth
  //   meta         — { sampleRate, format (PCM format int), durationMs }
  //   chunkBytes   — int, max PCM bytes per chunk (default 800)
  function buildVoiceFrames(messageKeys, token, transferId, pcmBytes, meta, chunkBytes) {
    chunkBytes = chunkBytes || DEFAULT_VOICE_CHUNK_BYTES;
    meta = meta || {};
    var frames = [];
    var start = {};
    start[messageKeys.Type] = 'voice_start';
    start[messageKeys.MessageId] = String(token);
    start[messageKeys.VoiceToken] = String(token);
    start[messageKeys.VoiceTransferId] = transferId;
    start[messageKeys.VoiceSize] = pcmBytes.length;
    start[messageKeys.VoiceSampleRate] = meta.sampleRate || DEFAULT_SAMPLE_RATE;
    start[messageKeys.VoiceFormat] = typeof meta.format === 'number'
      ? meta.format : PCM_FORMAT[meta.formatName || DEFAULT_PCM_FORMAT];
    start[messageKeys.VoiceDuration] = meta.durationMs || 0;
    frames.push(start);

    for (var offset = 0; offset < pcmBytes.length; offset += chunkBytes) {
      var slice = pcmBytes.subarray(offset, Math.min(offset + chunkBytes, pcmBytes.length));
      var data = [];
      for (var i = 0; i < slice.length; i++) {
        data.push(slice[i]);
      }
      var frame = {};
      frame[messageKeys.Type] = 'voice';
      frame[messageKeys.MessageId] = String(token);
      frame[messageKeys.VoiceToken] = String(token);
      frame[messageKeys.VoiceTransferId] = transferId;
      frame[messageKeys.Index] = offset;
      frame[messageKeys.VoiceSeq] = offset;
      frame[messageKeys.VoiceData] = data;
      frames.push(frame);
    }

    var done = {};
    done[messageKeys.Type] = 'voice_done';
    done[messageKeys.MessageId] = String(token);
    done[messageKeys.VoiceToken] = String(token);
    done[messageKeys.VoiceTransferId] = transferId;
    done[messageKeys.VoiceDone] = 1;
    frames.push(done);
    return frames;
  }

  // ---- Public API -----------------------------------------------------------
  // createStreamer wires the decoder + framing into a single function that
  // takes raw OGG Opus bytes and the per-message metadata, and returns the
  // array of AppMessage payloads to send.
  function createStreamer(options) {
    options = options || {};
    var decoderFactory = options.decoderFactory || createDecoder;
    var formatName = options.formatName || DEFAULT_PCM_FORMAT;
    var targetRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
    var bitDepth = options.bitDepth || DEFAULT_BIT_DEPTH;
    var chunkBytes = options.chunkBytes || DEFAULT_VOICE_CHUNK_BYTES;
    var maxBytes = options.maxBytes || DEFAULT_VOICE_MAX_BYTES;

    if (PCM_FORMAT[formatName] === undefined) {
      throw new Error('pebblegram-voice: unknown PCM format ' + formatName);
    }

    return function streamOpus(messageKeys, token, transferId, opusBytes, meta) {
      if (!(opusBytes && opusBytes.length)) {
        return Promise.resolve(null);
      }
      var decoder = decoderFactory(options.decoder || {});
      decoder.feed(opusBytes);
      return decoder.decodeAll().then(function (float32) {
        var resampled = resampleSinc(float32, decoder.inputSampleRate, targetRate);
        var pcmBytes = bitDepth === 16 ? floatToPcm16LE(resampled) : floatToPcm8(resampled);
        if (pcmBytes.length > maxBytes) {
          // Truncate rather than drop. Watch will still play; the tail
          // is clipped. The Meta `durationMs` can be used to warn the
          // user that the message is long.
          pcmBytes = pcmBytes.subarray(0, maxBytes);
        }
        return buildVoiceFrames(messageKeys, token, transferId, pcmBytes, {
          sampleRate: targetRate,
          format: PCM_FORMAT[formatName],
          formatName: formatName,
          durationMs: (meta && meta.durationMs) || 0
        }, chunkBytes);
      }).then(function (frames) {
        decoder.close();
        return frames;
      }, function (err) {
        decoder.close();
        throw err;
      });
    };
  }

  return {
    PCM_FORMAT: PCM_FORMAT,
    DEFAULT_PCM_FORMAT: DEFAULT_PCM_FORMAT,
    DEFAULT_SAMPLE_RATE: DEFAULT_SAMPLE_RATE,
    DEFAULT_BIT_DEPTH: DEFAULT_BIT_DEPTH,
    DEFAULT_VOICE_CHUNK_BYTES: DEFAULT_VOICE_CHUNK_BYTES,
    DEFAULT_VOICE_MAX_BYTES: DEFAULT_VOICE_MAX_BYTES,
    resampleSinc: resampleSinc,
    resampleLinear: resampleLinear,
    floatToPcm16LE: floatToPcm16LE,
    floatToPcm8: floatToPcm8,
    StubOpusDecoder: StubOpusDecoder,
    FfmpegOpusDecoder: FfmpegOpusDecoder,
    WasmOpusDecoder: WasmOpusDecoder,
    oggDemuxPackets: oggDemuxPackets,
    createDecoder: createDecoder,
    buildVoiceFrames: buildVoiceFrames,
    createStreamer: createStreamer
  };
}));
