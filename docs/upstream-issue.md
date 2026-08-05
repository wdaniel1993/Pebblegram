# Issue draft — for TomBolger/Pebblegram

> Copy/paste into a new GitHub issue. Adjust tone as needed before posting.

---

## Voice message support: playback now, recording after PebbleOS #1641

**Feature request**

The revival watches (Time 2 / emery, Round 2 / gabbro) ship with mic + speaker. Pebblegram is text-first: incoming voice messages render as something to ignore, and composing is dictation-only. Voice messages are the one big Telegram affordance missing.

### Proposal — two phases

**Phase A: Playback (no firmware dependency, can land now)**
- Incoming `mediaVoice` → download via GramJS → decode OGG Opus → PCM in the PKJS runtime
- Stream PCM to the watch over AppMessage (chunked, new message keys `VoiceSeq`/`VoiceData`/`VoiceDone`)
- Play on the watch speaker via the new public `speaker_stream_open/write/close` API (PebbleOS `applib/ui/speaker.h`)
- UI: voice bubble with ▶ play / ■ stop, duration from MTProto

**Phase B: Recording (after PebbleOS mic API lands)**
- PebbleOS issue coredevices/PebbleOS#1641 ("voice: add on-device audio recording with playback and SDK API", PR by julpel8, in review) will expose on-device mic recording (Speex) to apps
- Compose menu gains "Voice message": record on watch → stream Speex to PKJS → decode → encode OGG Opus → send via GramJS `sendFile(voice)`
- This doubles as the "companion pkjs side that receives/decodes/streams audio from watch" that @ericmigi asked for in #1641

### Why now
- Speaker API is public since the 2026 SDK; the mic side is actively being merged upstream
- Voice playback alone needs zero firmware changes — it can ship as a self-contained PR

### Offer
Happy to implement both phases and submit PRs. Phase A first, Phase B once #1641 is merged and the SDK release includes it.

_Context: hardware specs — Time 2: 2 mics + speaker; Round 2: mic + speaker. Speaker was added "primarily for apps that benefit from audio output, like a ChatGPT or other AI agent app" — voice messages are the natural first consumer._
