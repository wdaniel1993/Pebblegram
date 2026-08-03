# Voice Messages on Pebble — Technical Design (Pebblegram)

Status: Draft · Owner: Eve (orchestrator) + coder profile · Target: PR to TomBolger/Pebblegram

## Goal

Bring Telegram voice messages to Pebblegram on the revival watches (Time 2 / `emery`, Round 2 / `gabbro` — both have mic + speaker):

- **Phase A — Playback**: hear incoming voice messages on the watch speaker (no firmware dependency, buildable today).
- **Phase B — Recording**: record a voice message into the watch mic and send it as a Telegram voice message (depends on PebbleOS mic API, in flight as coredevices/PebbleOS #1641).

## Architecture recap

```
Watch app (C, src/c/Pebblegram.c)  ←AppMessage→  PebbleKit JS on phone (src/pkjs/*)
                                                    └─ GramJS (MTProto, user session) ←→ Telegram
```

No separate companion app. PKJS runs inside the official Pebble/Rebble mobile app. Telegram voice messages are **OGG Opus**; the new PebbleOS recording API uses **Speex**.

## Phase A — Playback (no firmware dep)

### Phone side (PKJS)
1. GramJS already surfaces `mediaVoice` on messages. Download via `client.downloadMedia(message.voice)` → OGG Opus bytes.
2. Decode Opus → PCM. Constraints: PKJS is the Pebble app's legacy JS engine (old WebView/JSCore — verify actual feature level; GramJS already uses typed arrays + promises heavily, so ES2015-ish is safe; **WASM availability must be verified** — if unavailable, use an asm.js/pure-JS Opus decoder, e.g. libopus.js asm.js build or opus-recorder's decoder path).
3. Resample to the watch's supported `SpeakerPcmFormat` (verify `src/fw/applib/ui/speaker.h` → `speaker_pcm_format.h` in coredevices/PebbleOS for supported rates; likely 8k/16k/22.05k variants — pick the lowest common rate to save bandwidth; watch is mono).
4. Stream PCM to the watch as a chunked AppMessage sequence (new message type + keys, see below).

### Watch side (C)
1. New incoming message type `voice` with a bubble affordance ("▶ play").
2. AppMessage keys: `VoiceSeq` (u16), `VoiceData` (byte blob), `VoiceDone`, `VoiceCancel`.
3. On first chunk: `speaker_stream_open(SpeakerPcmFormat, volume)`; write each chunk with `speaker_stream_write` (respect partial-write return); on `VoiceDone`: `speaker_stream_close`.
4. AppMessage per-message size limit applies (historic ~2.4KB inbox cap — verify current limit in the revival SDK); voice at 8 kHz mono 16-bit = 16 KB/s → ~10-20 msg/s worst case; acceptable, but keep chunks as large as the transport allows and consider a small ring buffer + `app_message_set_outbox_sent`-style flow control on the JS side.
5. UI: playing indicator, stop control (`speaker_stop`), skip/next.

### Protocol notes
- Reuse the existing bridge protocol conventions (`Type`, `index`, `token` fields; see `docs/phase1.md` bridge contract) so `tools/bridge.py` mock mode can be extended for testing.
- Voice messages have a duration in MTProto (`mediaVoice.duration`) — use it for the bubble.

## Phase B — Recording (after PebbleOS #1641 lands)

Upstream status (2026-08-03): julpel8's PR "voice: add on-device audio recording with playback and SDK API" — rebased, being merged by jplexer/ericmigi. Provides: on-device mic recording (Speex, PFS storage), playback, `audio_recording_list()`, `audio_recording_transcribe()`, ownership enforcement. Eric explicitly asked for "an easy to use companion pkjs side that receives/decodes/streams audio from watch" — our integration becomes the reference implementation.

### Watch side (C)
1. Compose menu gains "Voice message" (in addition to dictation).
2. Record via the new `audio_recording_*` API (Speex, stored on-device; works offline).
3. Stream the recording to the phone over AppMessage in chunks (new keys: `RecSeq`, `RecData`, `RecDone`).
4. Fallback UX: if transport to PKJS isn't available in the merged API, use `audio_recording_transcribe()` for text-only flow (no change to existing dictation path).

### Phone side (PKJS)
1. Receive Speex chunks → decode Speex → PCM (pure-JS speex decoder exists, lightweight).
2. Encode PCM → **OGG Opus** (Telegram voice requirement). Opus *encode* in JS is heavier than decode — verify feasibility in PKJS (opus-recorder encoder, asm.js); if too heavy for the runtime, options: (a) encode in a small native helper, (b) check MTProto acceptance of non-Opus audio as `sendVoice` — Telegram requires OGG Opus for voice notes; `sendAudio` (file) is the fallback but renders as a music/file message, not a voice bubble.
3. Send via GramJS `sendFile(chat, {voice: ...})`.

## Open questions / risks

- **PKJS runtime limits**: WASM? fetch? bundle size headroom (gramjs.bundle.js already large)? — verify before committing to a decoder strategy.
- **Opus encoder in JS** (Phase B) — feasibility/speed on a phone WebView.
- **AppMessage throughput** for 16 KB/s PCM streaming — verify current message-size cap in the revival SDK.
- **Speaker format matrix** — confirm supported `SpeakerPcmFormat` on emery vs gabbro.
- **Battery**: speaker + streaming on a watch — keep playback chunked and stop-on-idle.
- **No license in repo** — we do NOT publish a fork; all work lands as PRs upstream (open issue first, then PR).

## PR sequencing

1. Issue on TomBolger/Pebblegram (draft in `docs/upstream-issue.md`) describing Phase A + B.
2. PR 1: Phase A playback (no firmware dependency).
3. After #1641 merges + SDK release: PR 2, Phase B recording.

## Key references

- PebbleOS speaker API: `coredevices/PebbleOS` `src/fw/applib/ui/speaker.h` (speaker_play_notes / speaker_stream_open / write / close) — public since 2026.
- Mic API in flight: `coredevices/PebbleOS` issue #1641 (PR by julpel8), related: #719 (raw audio API), #789 (mic → PKJS).
- Pebblegram: TomBolger/Pebblegram v3.5.0, `src/c/Pebblegram.c`, `src/pkjs/pgjs/telegram.js` (GramJS), `tools/bridge.py` (mock bridge).
