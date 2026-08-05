/*
 * pebblegram-voice.js — Voice message decoding + streaming (Phase A).
 *
 * Resides on the phone side (PebbleKit JS). Listens for incoming voice
 * messages (Telegram `mediaVoice` OGG Opus), downloads them, decodes to
 * PCM, optionally resamples to a PebbleOS SpeakerPcmFormat, and streams
 * the PCM to the watch over AppMessage as a chunked `voice_start` /
 * `voice` / `voice_done` sequence.
 *
 * Decoder is pluggable. The default exported factory returns a
 * `StubOpusDecoder` that emits silence; the production integration
 * is expected to wire in `opus-decoder` (eshaz/wasm-audio-decoders,
 * ~200KB, streaming WebAssembly) — see docs/voice-messages-design.md.
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

  // Default target: 8kHz 16-bit signed mono. 16KB/s, fits comfortably in
  // 2KB AppMessage chunks while keeping speaker output intelligible for
  // voice. Set to '16kHz_16bit' if a particular watch is verified to keep
  // up with 32KB/s (emery/gabbro with strong BLE signal).
  var DEFAULT_PCM_FORMAT = '8kHz_16bit';
  var DEFAULT_SAMPLE_RATE = 8000;
  var DEFAULT_BIT_DEPTH = 16;

  // 800 bytes of 16-bit PCM = 400 samples = 50ms @ 8kHz, 25ms @ 16kHz.
  // Under APP_INBOX_SIZE (2048) once envelope fields are accounted for.
  var DEFAULT_VOICE_CHUNK_BYTES = 800;

  // 20 KB upper bound on a single voice stream. Telegram voice notes
  // are typically 5-60s at 16kbps Opus; 20KB of 8kHz 16-bit PCM ~= 10s
  // of audio. Larger messages get truncated unless the caller raises
  // this. The watch only buffers one stream at a time; we free the
  // previous one's state when a new one starts.
  var DEFAULT_VOICE_MAX_BYTES = 20000;

  // ---- Linear-interpolation resampler --------------------------------------
  // Cheap and good enough for speech band-limited to ~4kHz (8kHz output).
  // For 16kHz output the source is typically already at 24-48kHz, so
  // interpolation is still safe — voice is band-limited by Opus to
  // ~8kHz regardless of source sample rate.
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

  function createDecoder(options) {
    if (options && options.driver === 'ffmpeg') {
      return new FfmpegOpusDecoder(options);
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
        var resampled = resampleLinear(float32, decoder.inputSampleRate, targetRate);
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
    resampleLinear: resampleLinear,
    floatToPcm16LE: floatToPcm16LE,
    floatToPcm8: floatToPcm8,
    StubOpusDecoder: StubOpusDecoder,
    FfmpegOpusDecoder: FfmpegOpusDecoder,
    createDecoder: createDecoder,
    buildVoiceFrames: buildVoiceFrames,
    createStreamer: createStreamer
  };
}));
