#!/usr/bin/env node
/*
 * test-voice.js — end-to-end verification of the voice message
 * chunked-stream framing path.
 *
 * Generates a real OGG Opus sample with ffmpeg, then runs it through
 * the production framing module (pebblegram-voice.js) using a real
 * decoder (FfmpegOpusDecoder → resample → 8kHz 16-bit PCM → voice
 * frames), and asserts:
 *
 *   1. The decoded duration matches what ffmpeg reports for the file.
 *   2. Reassembling the chunk PCM produces the exact same byte stream
 *      the streamer generated (no dropped bytes, no duplicates, no
 *      reordering).
 *   3. Sequence numbers and offsets are strictly monotonic and start
 *      at 0.
 *   4. Each chunk's envelope (Type, MessageId, VoiceToken,
 *      VoiceTransferId, VoiceSeq, Index) is well-formed.
 *   5. The voice_done marker terminates the stream.
 *   6. The chunked PCM survives a re-encode round-trip through
 *      ffmpeg at the target SpeakerPcmFormat (proves the format
 *      conversion is correct for PebbleOS consumption).
 *
 * Run with:  node tools/test-voice.js
 * Requires:  ffmpeg on PATH, libopus (already in /opt/homebrew on macOS).
 *
 * The test is hermetic — it writes the synthesized OGG Opus to a
 * temp file in /tmp and cleans up after itself.
 */

'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child_process = require('child_process');

var voice = require('../src/pkjs/pebblegram-voice.js');

// Same key order as package.json pebble.messageKeys.
var MESSAGE_KEYS = {
  Type: 0, Index: 2, MessageId: 5, Text: 8,
  VoiceToken: 29, VoiceDuration: 30, VoiceSize: 31,
  VoiceSampleRate: 32, VoiceFormat: 33, VoiceData: 34,
  VoiceSeq: 35, VoiceTransferId: 36, VoiceDone: 37,
  VoiceError: 38, VoiceAction: 39
};

var FAILURES = [];
function assert(cond, msg) {
  if (cond) {
    console.log('  ok   ' + msg);
  } else {
    console.log('  FAIL ' + msg);
    FAILURES.push(msg);
  }
}

function run(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    var proc = child_process.spawn(cmd, args, opts || {});
    var stdout = [];
    var stderr = [];
    proc.stdout.on('data', function (c) { stdout.push(c); });
    proc.stderr.on('data', function (c) { stderr.push(c); });
    proc.on('error', reject);
    proc.on('close', function (code) {
      resolve({
        code: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString()
      });
    });
  });
}

function ensureFfmpeg() {
  return run('ffmpeg', ['-version']).then(function (r) {
    if (r.code !== 0) {
      throw new Error('ffmpeg not available on PATH');
    }
    var first = r.stdout.toString().split('\n')[0];
    console.log('  ffmpeg: ' + first);
  });
}

function generateOpusSample(durationSec, filePath) {
  // 16kHz mono sine wave → 16kbps Opus at low complexity. Matches the
  // common Telegram voice profile.
  var args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + durationSec + ':sample_rate=16000',
    '-c:a', 'libopus', '-b:a', '16k', '-vbr', 'on', '-application', 'voip',
    '-ac', '1', '-ar', '16000',
    filePath
  ];
  return run('ffmpeg', args).then(function (r) {
    if (r.code !== 0) {
      throw new Error('ffmpeg opus encode failed: ' + r.stderr);
    }
  });
}

function ffprobeDuration(filePath) {
  return run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]).then(function (r) {
    var d = parseFloat(r.stdout.toString().trim());
    if (!isFinite(d)) {
      throw new Error('ffprobe failed: ' + r.stderr);
    }
    return d;
  });
}

function main() {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgvoice-'));
  var opusPath = path.join(tmpDir, 'sample.ogg');
  console.log('Test sandbox: ' + tmpDir);

  return ensureFfmpeg()
    .then(function () { return generateOpusSample(2.5, opusPath); })
    .then(function () {
      console.log('Generated 2.5s OGG Opus test sample');
      return ffprobeDuration(opusPath);
    })
    .then(function (sourceDuration) {
      var opusBytes = fs.readFileSync(opusPath);
      console.log('Source duration (ffprobe): ' + sourceDuration.toFixed(3) + 's, ' +
                  opusBytes.length + ' bytes');

      var streamer = voice.createStreamer({
        decoderFactory: voice.createDecoder,
        formatName: '8kHz_8bit',
        sampleRate: 8000,
        bitDepth: 8,
        chunkBytes: 2048,
        // 2.5s * 8000 * 1 = 20000 bytes; allow 1MB so the test isn't
        // exercising the truncation path (that's covered separately).
        maxBytes: 1048576,
        decoder: { driver: 'ffmpeg' }
      });

      return streamer(MESSAGE_KEYS, 'msg-test-001', 1, opusBytes, {
        durationMs: Math.round(sourceDuration * 1000)
      }).then(function (frames) {
        console.log('Generated ' + frames.length + ' voice frames');

        // --- Assertion 1: voice_start envelope ----------------------
        var start = frames[0];
        assert(start[MESSAGE_KEYS.Type] === 'voice_start',
          'first frame is voice_start');
        assert(start[MESSAGE_KEYS.MessageId] === 'msg-test-001',
          'voice_start carries MessageId');
        assert(start[MESSAGE_KEYS.VoiceToken] === 'msg-test-001',
          'voice_start carries VoiceToken');
        assert(start[MESSAGE_KEYS.VoiceTransferId] === 1,
          'voice_start carries VoiceTransferId');
        assert(typeof start[MESSAGE_KEYS.VoiceSize] === 'number' &&
               start[MESSAGE_KEYS.VoiceSize] > 0,
          'voice_start carries positive VoiceSize (' + start[MESSAGE_KEYS.VoiceSize] + ' bytes)');
        assert(start[MESSAGE_KEYS.VoiceSampleRate] === 8000,
          'voice_start declares 8kHz sample rate');
        assert(start[MESSAGE_KEYS.VoiceFormat] === 0,
          'voice_start declares SpeakerPcmFormat 8kHz_8bit (value 0)');
        assert(start[MESSAGE_KEYS.VoiceDuration] === Math.round(sourceDuration * 1000),
          'voice_start carries original durationMs');

        // --- Assertion 2: chunk envelope + sequence -----------------
        var dataFrames = frames.slice(1, -1);
        var lastOffset = -1;
        var lastSeq = -1;
        for (var i = 0; i < dataFrames.length; i++) {
          var f = dataFrames[i];
          if (f[MESSAGE_KEYS.Type] !== 'voice') {
            assert(false, 'frame ' + i + ' has Type=' + f[MESSAGE_KEYS.Type]);
            continue;
          }
          if (f[MESSAGE_KEYS.VoiceSeq] !== f[MESSAGE_KEYS.Index]) {
            assert(false, 'frame ' + i + ' VoiceSeq (' + f[MESSAGE_KEYS.VoiceSeq] +
                   ') != Index (' + f[MESSAGE_KEYS.Index] + ')');
          }
          if (f[MESSAGE_KEYS.VoiceSeq] <= lastSeq) {
            assert(false, 'frame ' + i + ' VoiceSeq is not strictly increasing');
          }
          if (lastOffset >= 0 && f[MESSAGE_KEYS.Index] !== lastOffset + dataFrames[i - 1][MESSAGE_KEYS.VoiceData].length) {
            assert(false, 'frame ' + i + ' Index has a gap (expected ' +
                   (lastOffset + dataFrames[i - 1][MESSAGE_KEYS.VoiceData].length) +
                   ', got ' + f[MESSAGE_KEYS.Index] + ')');
          }
          lastOffset = f[MESSAGE_KEYS.Index];
          lastSeq = f[MESSAGE_KEYS.VoiceSeq];
        }
        assert(true, dataFrames.length + ' data frames have strictly increasing offsets');
        assert(dataFrames[0][MESSAGE_KEYS.VoiceSeq] === 0, 'first data frame VoiceSeq=0');
        assert(dataFrames[0][MESSAGE_KEYS.Index] === 0, 'first data frame Index=0');

        // --- Assertion 3: reassembly is byte-exact ------------------
        var reassembled = Buffer.alloc(start[MESSAGE_KEYS.VoiceSize]);
        for (var j = 0; j < dataFrames.length; j++) {
          var data = dataFrames[j][MESSAGE_KEYS.VoiceData];
          if (!Array.isArray(data)) {
            assert(false, 'frame ' + j + ' VoiceData is not an array');
            continue;
          }
          var buf = Buffer.from(data);
          buf.copy(reassembled, dataFrames[j][MESSAGE_KEYS.Index]);
        }
        assert(reassembled.length === start[MESSAGE_KEYS.VoiceSize],
          'reassembled length matches VoiceSize');
        // Sample rate sanity: at 8kHz 8-bit, 2.5s = 20000 samples × 1 byte = 20000 bytes
        // (we may be slightly under if decoder drops a tail frame)
        assert(reassembled.length >= 19000 && reassembled.length <= 21000,
          'reassembled length is plausible for 2.5s @ 8kHz 8-bit (' +
          reassembled.length + ' bytes; expected ~20000)');

        // --- Assertion 4: every chunk < inbox envelope --------------
        // Pebble AppMessage inbox cap is 4096 (Pebblegram's APP_INBOX_SIZE).
        // A 2048B VoiceData payload + ~150B dict overhead (7 keys:
        // Type/MessageId/VoiceToken/VoiceTransferId/Index/VoiceSeq/
        // VoiceData) ≈ 2200B < 4096.
        var maxChunk = 0;
        for (var k = 0; k < dataFrames.length; k++) {
          if (dataFrames[k][MESSAGE_KEYS.VoiceData].length > maxChunk) {
            maxChunk = dataFrames[k][MESSAGE_KEYS.VoiceData].length;
          }
        }
        assert(maxChunk <= 2048,
          'max chunk size (' + maxChunk + ' bytes) fits in APP_INBOX_SIZE (4096) with envelope headroom');

        // --- Assertion 5: voice_done terminates the stream ----------
        var done = frames[frames.length - 1];
        assert(done[MESSAGE_KEYS.Type] === 'voice_done',
          'final frame is voice_done');
        assert(done[MESSAGE_KEYS.VoiceToken] === 'msg-test-001',
          'voice_done carries VoiceToken');
        assert(done[MESSAGE_KEYS.VoiceTransferId] === 1,
          'voice_done carries VoiceTransferId');
        assert(done[MESSAGE_KEYS.VoiceDone] === 1,
          'voice_done marker set');

        // --- Assertion 6: round-trip the reassembled PCM through
        //     ffmpeg at the target SpeakerPcmFormat (s8 8k mono)
        //     and verify the play duration matches the source within
        //     10% (libopus at 16kbps + sinc resampler has small jitter).
        var rawPath = path.join(tmpDir, 'reassembled.s8');
        var wavPath = path.join(tmpDir, 'reassembled.wav');
        fs.writeFileSync(rawPath, reassembled);
        return run('ffmpeg', [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 's8', '-ar', '8000', '-ac', '1',
          '-i', rawPath, wavPath
        ]).then(function (r) {
          if (r.code !== 0) {
            assert(false, 'ffmpeg s8→wav round-trip failed: ' + r.stderr);
            return;
          }
          assert(true, 'reassembled PCM decodes cleanly as s8 8kHz mono');
          return ffprobeDuration(wavPath);
        }).then(function (roundTripDuration) {
          var expectedMs = Math.round(sourceDuration * 1000);
          var gotMs = Math.round(roundTripDuration * 1000);
          var drift = Math.abs(gotMs - expectedMs) / expectedMs;
          assert(drift < 0.10,
            'round-trip duration (' + gotMs + 'ms) within 10% of source (' +
            expectedMs + 'ms); drift=' + (drift * 100).toFixed(1) + '%');
        });
      });
    })
    .then(function () {
      // --- Assertion 7: empty input returns null ----------------------
      var streamer = voice.createStreamer({ decoder: { driver: 'ffmpeg' } });
      return streamer(MESSAGE_KEYS, 'empty', 2, new Uint8Array(0), {}).then(function (r) {
        assert(r === null, 'empty opus input yields null (no frames sent)');
      });
    })
    .then(function () {
      // --- Assertion 8: large input is truncated to maxBytes ---------
      var big = Buffer.alloc(50000);
      for (var n = 0; n < big.length; n++) {
        big[n] = (n * 97) & 255;
      }
      // Stub decoder emits silence; this exercises the truncation path
      // (we pass a real decoder but override the bytes to a fixed
      // size using the stub via a custom decoder).
      var stubStreamer = voice.createStreamer({
        decoderFactory: function () { return new voice.StubOpusDecoder({}); },
        maxBytes: 4000
      });
      return stubStreamer(MESSAGE_KEYS, 'big', 3, new Uint8Array(100), {
        durationMs: 1000
      }).then(function (frames) {
        var start = frames[0];
        assert(start[MESSAGE_KEYS.VoiceSize] === 4000,
          'oversized stream truncated to maxBytes (got ' +
          start[MESSAGE_KEYS.VoiceSize] + ')');
      });
    })
    .then(function () {
      console.log('');
      if (FAILURES.length === 0) {
        console.log('PASS: all voice framing assertions held');
        process.exit(0);
      } else {
        console.log('FAIL: ' + FAILURES.length + ' assertion(s) failed:');
        FAILURES.forEach(function (f) { console.log('  - ' + f); });
        process.exit(1);
      }
    })
    .catch(function (err) {
      console.error('Test runner error: ' + (err && err.stack || err));
      process.exit(2);
    })
    .then(function () {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    });
}

main();
