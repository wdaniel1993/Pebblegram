# AGENTS.md — Pebblegram (voice-messages fork)

Agent guide for working in this repo. Covers the revival-era PebbleOS build,
the voice-message feature protocol, and the pitfalls that cost real time.

## What this is

Pebblegram v3.5 (upstream: `TomBolger/Pebblegram`) — a Telegram client for
Pebble smartwatches: C watch app (`src/c/Pebblegram.c`) ↔ AppMessage ↔
PebbleKit JS on the phone (`src/pkjs/`) running **teleproto** (MTProto, layer
228, user session; migrated from GramJS 2026-08-05; no companion app). This
repo (fork `wdaniel1993/Pebblegram`) is the **Pebblegram AI** fork —
voice-message playback, threaded bot chats, TTS "Speak Message", teleproto
engine, self-hosted settings page on GitHub Pages, and the AI-focused
rebrand. All work happens on `main`.

**License: upstream has NO license file. Never publish a fork as a standalone
project. Contribute via issue first, then PR upstream.**

## Quick start (verified on Eve / macOS, 2026-08-04)

```sh
# One-time deps (macOS)
brew install node libpng
uv tool install pebble-tool        # pebble CLI → ~/.local/bin/pebble
pebble sdk install latest          # SDK 4.17 + arm-none-eabi toolchain + QEMU

# Build (all 4 platforms: basalt, diorite, emery, gabbro; ~4s)
pebble build                       # → build/pebblegram.pbw (gitignored)

# Verify JS (hermetic, needs ffmpeg on PATH)
node tools/test-voice.js           # 22/22 — voice framing end-to-end
node --check src/pkjs/pebblegram-voice.js   # syntax gate
```

Install on device: `pebble install --emulator basalt` (QEMU) or
`pebble install --cloudpebble` (real watch via rePebble app Dev Connect).

## Architecture

- **Watch app (C):** `src/c/Pebblegram.c` (~6k lines, single file). UI layers,
  AppMessage inbox (`APP_INBOX_SIZE = 2048`, line ~24), image + voice
  streaming state machines. `include/` + `build/include/` are generated.
- **Phone side (PKJS):** `src/pkjs/index.js` (dispatcher) + `pgjs/`
  (`telegram.js`, `backend.js`, `auth.js`, `cache.js`, `image.js`,
  `gramjs.bundle.js` (teleproto engine bundle), `codecs.bundle.js`,
  `shims/`, `vendor/` (ES5-vendored decoders), `tts.js`). Runtime: legacy
  WebView, `target: es2015`, shims for crypto/fs/net/tls/stream/events/
  util/path/os/assert/constants/socks/websocket. **No native fetch, no
  global `require`, no child_process** — codecs must be WASM/asm.js or pure
  JS; node builtins (`buffer`/`crypto`) are webpack EXTERNALS and must never
  be touched at runtime (see TTS section). `codecs.bundle.js` = JPEG/UPNG
  only; audio decoding (Opus, MP3) is vendored separately (`opus-decoder`,
  `mpg123-decoder` — eshaz/wasm-audio-decoders family, ES5-transpiled).
- **Message keys:** `package.json` → `pebble.messageKeys` (single source of
  truth). Voice keys: `VoiceToken, VoiceDuration, VoiceSize, VoiceSampleRate,
  VoiceFormat, VoiceData, VoiceSeq, VoiceTransferId, VoiceDone, VoiceError,
  VoiceAction`. TTS: `tts_status` rides `Type`/`MessageId`/`Text`.
- **Test bridge:** `tools/bridge.py` — mock HTTP backend (no credentials) or
  Telethon mode via `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`/`TELEGRAM_PHONE`.
  Mirror the watch↔phone contract there when adding message types.

## Voice-message protocol (Phase A, playback — DONE, user-confirmed)

1. JS fetches voice file via teleproto → decodes **OGG Opus → 8kHz mono s16 PCM**
   → builds 800B frames → streams over AppMessage as
   `VoiceData` + `VoiceSeq` (monotonic from 0) + `VoiceTransferId`;
   `VoiceDone` terminates. Chunk envelope also carries `Type`, `MessageId`,
   `VoiceToken`, `Index`.
2. Watch: `voice_start` (from `VoiceToken`/`VoiceDuration`) opens
   `speaker_stream_open(format, volume)` → bool; each chunk is written via
   `speaker_stream_write` → **uint32 bytes-written (backpressure!)**. Partial
   writes spill to `s_voice_spill`; `schedule_voice_drain_retry()` re-feeds
   via app timer. `voice_poll` timer tracks playback progress.
3. Cancel/stop: `cancel_voice` AppMessage or UI stop →
   `cancel_active_voice()` = `speaker_stop()` + `reset_voice_transfer_state()`.
   UI: voice pill bubble ("Play 0:05"), `ActionItemPlayVoice` /
   `ActionItemStopVoice`.
4. JS dispatcher commands: `sendVoice`, `get_voice`, `cancel_voice`,
   `cancelAllQueuedTransfers`; `messagePayload` carries
   `voice_token`/`voice_duration_ms`.

## TTS "Speak Message" (v1.0.10→v1.0.18, DONE, user-confirmed working)

- Action: message menu → "Speak Message" (HAS_SPEAKER-gated, text-only
  messages); streams over the SAME voice channel (voice_start/voice/
  voice_done) — zero new C plumbing beyond the status pill.
- **Backend selection by UA (`speakFrames` in `pgjs/tts.js`):** `Edg/` in the
  WebView UA → edge-tts WebSocket (neural voices); anything else → **Google
  Translate TTS over XHR** (`translate.google.com/translate_tts`, any UA,
  free, no key, chunked at 180 chars, concatenated MP3s decode gap-free).
  Direct XHR first, `api.allorigins.win` CORS proxy fallback. edge-tts can
  NEVER work from a stock Android/iOS WebView (it rejects non-Edge UAs with
  close 1006 and the native WebSocket cannot set headers) — don't "fix" this.
- **WebView landmines (each cost a version):** (1) node builtins
  (`buffer`/`crypto`/`child_process`) are webpack EXTERNALS emitted as bare
  `require("buffer")` — touching them at runtime throws `require is not
  defined`; TTS's sha256 is Buffer-free (`cryptoShim.sha256Hex`, pure-JS
  js-sha256). (2) WebSocket `binaryType` defaults to `blob` (async reads) —
  set `'arraybuffer'` AND wait pending FileReader reads before assembling
  MP3s. (3) Never settle on `ws.onerror` — browsers follow with `onclose`
  carrying the diagnostic code.
- C-side status pill: Synthesizing (live stage labels via `tts_status`
  AppMessage) → "Speaking 0:03 / 0:12" + progress bar → readable 2-line
  error ("Speak failed: <detail>", 12s). 30s stall → "stuck at <stage>".
- v1.0.18: "Stop Speaking" action replaces "Speak Message" while a
  synthesis/playback is in flight (same `cancel_voice` path).
- Voices: settings page voice picker (7 edge-tts voices; on the Google
  backend the choice selects the language). Default `en-US-JennyNeural`.

### Verified facts (SDK 4.17 headers, 2026-08)

- `SpeakerPcmFormat`: `8kHz_8bit`=0, `16kHz_8bit`=1, `8kHz_16bit`=2,
  `16kHz_16bit`=3 — all mono signed. Chosen stream format: **8kHz_16bit**
  (16KB/s, intelligible, fits transport + ring buffer).
- OS PCM ring buffer default: 8KB (`PCM_STREAM_DEFAULT_SIZE_BYTES`).
- 800B chunks at 8kHz_16bit ≈ 50ms audio per message; image streaming uses
  500B chunks.

## Pitfalls (each cost real debugging time)

- **NEVER commit `src/c/message_keys.auto.h`.** pebble-tool generates
  `build/include/message_keys.auto.h` from `package.json` `pebble.messageKeys`
  at build time. A committed copy in `src/c/` shadows it via quoted-include
  order → enum-vs-extern redeclaration errors. Keep keys in `package.json`
  only. (`tools/gen-message-keys.py` exists for SDK-less review contexts.)
- **basalt/diorite stub the entire speaker API to `(0)`** (SDK header
  macros). Voice code compiles there but playback silently no-ops; expect
  `unused-variable` warnings on those targets — silence with `(void)p;`
  comments, don't "fix" the logic. Real playback targets: emery, gabbro.
- **PKJS has no fetch/fs/child_process** — don't design around them.
- Telegram voice must be **OGG Opus** for voice bubbles; `sendAudio` renders
  as a file bubble. Voice recording (Phase B) = Speex on watch → encode OGG
  Opus in PKJS (the heaviest link — verify feasibility before promising).
- Watch RAM is tight (basalt heap ~18KB free after this app). Match existing
  streaming patterns; keep buffers tiny.
- Secrets: never commit API ID/hash, sessions, or personal PBWs
  (`data/` holds `.env.example` only; `.env` is gitignored).

## Project state

- **Phase A (playback) — DONE, compiles clean on all 4 platforms, works
  on-device (Daniel confirmed).** JS verified by `tools/test-voice.js`
  (22/22, real ffmpeg OGG Opus → 8kHz s16 → 800B frames, 0.3% drift) +
  `scripts/verify-voice-pipeline-real.js` (real decode, peak 0.2265).
- **TTS "Speak Message" — DONE, works on-device (Daniel: "Works well!").**
  Google TTS backend for stock WebViews (UA-based selection), edge-tts for
  Edge UAs. Status pill + stage tracer + Stop Speaking. See TTS section.
- **Threaded bot chats (Telegram "threads" mode) — DONE, works on-device
  (Daniel confirmed "It works.").** MenuLayer thread list from
  `messages.getForumTopics` (detection + list), SELECT opens a thread via
  `open_thread`, BACK returns, "New chat" row creates a topic via
  `CreateForumTopic` + auto-opens it. Thread-scoped pagination via
  `ThreadId` on older/newer. Flat chats untouched. Keys:
  `ThreadCount/ThreadId/ThreadList`. Full wire contract:
  `references/threaded-bot-chats.md` (skill).
- **Media downloads (photos/voice/avatars) — DONE, works (v1.0.8 fs-shim
  fix).** Root cause was teleproto `closeWriter()` `instanceof fs.WriteStream`
  with `fs` aliased to an empty shim.
- **Phase B (recording)** — blocked on upstream
  `coredevices/PebbleOS` **#1641** (on-device Speex recording + SDK API;
  `audio_recording_list()`/`audio_recording_transcribe()`). After it lands:
  watch records Speex → PKJS decodes → encodes OGG Opus → teleproto send.
  Do not design Phase B around mic capture until #1641 ships.
- Backlog: long-press SELECT info screens (Daniel-approved design: chat
  details in chat list, message details in message view); full-screen debug
  overlay (Daniel-proposed; corner overlay removed at v1.0.3, `debug_info`
  APP_LOG channel retained).
- Upstream issue/PR: draft in `docs/upstream-issue.md`; post the issue only
  after Phase A proves out on hardware, linking this repo.

## Git workflow

- `origin` = upstream `TomBolger/Pebblegram` (read-only; PRs go there).
- `fork` = `wdaniel1993/Pebblegram` — push target; **work directly on `main`**
  (feature branch merged 2026-08-06). Settings page served from `main` via
  GitHub Pages (`pgjs/config.html`). Keep commits small and message-verified.
- Design/status notes: `docs/voice-messages-design.md` (keep in sync when
  facts change).
