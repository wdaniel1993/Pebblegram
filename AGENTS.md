# AGENTS.md — Pebblegram (voice-messages fork)

Agent guide for working in this repo. Covers the revival-era PebbleOS build,
the voice-message feature protocol, and the pitfalls that cost real time.

## What this is

Pebblegram v3.5 (upstream: `TomBolger/Pebblegram`) — a Telegram client for
Pebble smartwatches: C watch app (`src/c/Pebblegram.c`) ↔ AppMessage ↔
PebbleKit JS on the phone (`src/pkjs/`) running GramJS (MTProto, user
session; no companion app). This branch (`feature/voice-messages`) adds
voice-message **playback** (Phase A).

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
  `gramjs.bundle.js`, `codecs.bundle.js`, `shims/`). Runtime: legacy WebView,
  `target: es2015`, shims for crypto/fs/net/tls/stream/events/util/path/os/
  assert/constants/socks/websocket. **No native fetch, no fs, no
  child_process** → codecs must be WASM/asm.js or pure JS. `codecs.bundle.js`
  = JPEG/UPNG only; audio decoding (Opus) is added separately
  (candidate: `opus-decoder` eshaz/wasm-audio-decoders, MIT, ~200KB).
- **Message keys:** `package.json` → `pebble.messageKeys` (single source of
  truth). Voice keys: `VoiceToken, VoiceDuration, VoiceSize, VoiceSampleRate,
  VoiceFormat, VoiceData, VoiceSeq, VoiceTransferId, VoiceDone, VoiceError,
  VoiceAction`.
- **Test bridge:** `tools/bridge.py` — mock HTTP backend (no credentials) or
  Telethon mode via `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`/`TELEGRAM_PHONE`.
  Mirror the watch↔phone contract there when adding message types.

## Voice-message protocol (Phase A, playback)

1. JS fetches voice file via GramJS → decodes **OGG Opus → 8kHz mono s16 PCM**
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

- **Phase A (playback) — DONE, compiles clean on all 4 platforms.**
  JS side verified by `tools/test-voice.js` (22/22, real ffmpeg OGG Opus →
  8kHz s16 → 800B frames, 0.3% drift). C side reviewed + SDK-built; on-device
  playback verification pending (watch hardware).
- **Threaded bot chats (Telegram "threads" mode) — implemented.** JS detects
  thread-mode chats (history = roots with `MessageReplies` counts), sends
  `ThreadList` rows; watch renders a thread list (sender + preview + » count),
  SELECT opens a thread via `open_thread` → `getMessages(chatId, {replyTo:
  root})` (GetReplies), BACK returns to the list. Thread-scoped pagination via
  `ThreadId` on older/newer; sends inside a thread reply to the root. Flat
  chats untouched (detection requires `thread_replies > 0` on the first page).
  On-device verification pending (Daniel's threaded bot chats).
- **Phase B (recording)** — blocked on upstream
  `coredevices/PebbleOS` **#1641** (on-device Speex recording + SDK API;
  `audio_recording_list()`/`audio_recording_transcribe()`). After it lands:
  watch records Speex → PKJS decodes → encodes OGG Opus → GramJS send.
  Do not design Phase B around mic capture until #1641 ships.
- Open PR-stage questions: drain-timer cadence needs hardware measurement;
  voice_start format-mismatch policy; voice+image coexistence under RAM
  pressure.
- Upstream issue/PR: draft in `docs/upstream-issue.md`; post the issue only
  after Phase A proves out on hardware, linking this branch.

## Git workflow

- `origin` = upstream `TomBolger/Pebblegram` (read-only; PRs go there).
- `fork` = `wdaniel1993/Pebblegram` — push target for this branch.
- Work on `feature/voice-messages`. Rebase-friendly; keep commits small and
  message-verified.
- Design/status notes: `docs/voice-messages-design.md` (keep in sync when
  facts change).
