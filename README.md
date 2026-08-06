# Pebblegram AI

Pebblegram AI is Daniel Wallner's fork of [Pebblegram](https://github.com/TomBolger/Pebblegram) (v3.5) — a Telegram client for Pebble smartwatches with a PebbleKit JS client that runs entirely on the phone (no companion service). The fork adds voice-message playback, threaded bot chats, text-to-speech ("Speak Message"), a maintained MTProto engine (teleproto), and a self-hosted settings page.

The watch app gives you a fast inbox, readable message threads, inline photo previews, canned replies, emoji replies, reactions, and dictation replies.

![Chat list](store/screenshots/01-emery-chat-list.png)
![Messages](store/screenshots/02-emery-messages.png)
![Photo message](store/screenshots/03-emery-photo-message.png)
![Actions](store/screenshots/04-emery-action-list.png)

> **License:** upstream has NO license file. This fork is not published as a standalone project; changes are intended to flow back upstream (issue first, then PR).

## Download

- Upstream release: [Pebblegram 3.5 PBW](https://github.com/TomBolger/Pebblegram/releases/download/v3.5.0/Pebblegram.pbw)
- Fork builds: `pebblegram-vX.Y.Z.pbw` files at the repo root (current: **v1.0.19**)

## What It Does

- Shows recent Telegram chats with unread state and message previews
- Opens one-on-one chats, regular groups, and pinned/foldered chat lists
- Displays incoming and outgoing chat bubbles
- Loads inline photo previews, GIF/video still previews, and text link previews
- **Plays incoming voice messages** on watches with speakers (Emery Time 2, Gabbro Round 2) — OGG Opus decoded on the phone, streamed as PCM to the watch speaker
- **Speak Message (TTS)**: reads any text message aloud through the watch speaker, with a live status pill (stage labels, progress bar, readable errors) and a Stop Speaking action
- **Threaded bot chats**: forum-topic detection, thread list, open/reply inside threads, "New chat" topic creation
- Sends replies with Pebble dictation
- Sends configurable canned replies
- Sends emoji replies
- Sends, updates, and removes Telegram reactions
- Replies to, forwards, edits, and deletes messages from the watch
- Loads older messages on demand
- Keeps open chats and the chat list refreshed while the app is running
- Supports Basalt, Diorite, Emery, and Gabbro builds
- Includes a black-and-white optimized Diorite image path
- Includes round-screen layout handling for Gabbro

## Fork highlights

### Voice messages (done, working on-device)
Incoming voice messages play as audio on watches with speakers (Emery, Gabbro). The phone-side PebbleKit JS fetches the voice file over MTProto, decodes OGG Opus to 8 kHz mono 16-bit PCM, and streams it to the watch in small chunks over AppMessage; the watch plays the stream through its speaker API with a play/stop pill in the chat UI. Basalt/Diorite build fine but have no speaker, so playback is a silent no-op there (UI compiled out via `HAS_SPEAKER`).

### Speak Message — text-to-speech (done, working on-device)
- Message menu → **Speak Message** reads any text message aloud through the watch speaker; **Stop Speaking** replaces it while a speech is in flight.
- **Engine auto-selection by User-Agent:** Edge-flavored WebViews use edge-tts (neural voices over WebSocket); everything else (stock Android/iOS WebViews — the normal case) uses **Google Translate TTS over XHR** (any UA, free, no key; long texts chunked at 180 chars and concatenated with zero gap).
- Live status pill: `Synthesizing… → Decoding audio… → Speaking 0:03 / 0:12` + progress bar; errors show the full reason for 12s.
- Voice picker in the settings page (7 voices; on the Google backend the choice selects the language).

### Threaded bot chats (done, working on-device)
- Telegram forum-topic ("threads") chats are detected via `messages.getForumTopics` and rendered as a **MenuLayer list** (topic title + last message + » count), with a "New chat" row that creates a topic via `CreateForumTopic` and auto-opens it.
- SELECT opens a thread, BACK returns to the topic list; pagination and replies are thread-scoped.
- Flat chats are untouched.

### Engine: teleproto (MTProto layer 228)
- Migrated from the unmaintained GramJS (layer 198) to the maintained teleproto fork (2026-08-05). Same session format, all 28 client methods Pebblegram uses verified.
- Requires the pure-JS crypto shim (the WebView has no native crypto): SHA-1/256/512, HMAC, PBKDF2, AES-CTR/CBC.
- **WebView landmines solved along the way:** node builtins (`buffer`/`crypto`) are webpack EXTERNALS in the SDK build — touching them at runtime throws `require is not defined` (TTS's SHA-256 is Buffer-free); WebSocket `binaryType` defaults to `blob` (async reads can drop audio — harden with pending-read tracking); media downloads crashed on `instanceof fs.WriteStream` with an empty fs shim (fixed with a real `WriteStream` shim class).

### Settings page — self-hosted (GitHub Pages)
- The configuration page is served from `https://wdaniel1993.github.io/Pebblegram/pgjs/config.html` (`pgjs/config.html` in this repo) — it ships independently of the PBW and can be fixed without a watch reinstall.
- Handles API credentials, login code / two-step password stages (with a stale-session notice + logout path), canned replies, and the TTS voice picker.
- The bundled `src/pkjs/config.html` is upstream's legacy emulator page.

### Known limits
- Recording voice from the watch is not yet available — it depends on an upstream PebbleOS on-device audio recording API (coredevices/PebbleOS #1641) that has not shipped.
- Google Translate TTS is an unofficial endpoint (could break or rate-limit someday); a self-hosted relay would be the robust long-term fix.

## Quick Start

1. Install the PBW with the Pebble/Rebble mobile app.
2. Open Pebblegram settings in the Pebble mobile app (loads the self-hosted page).
3. Enter your Telegram API ID, API hash, and phone number.
4. Save once to request a Telegram login code.
5. Reopen settings, enter the login code, and save again.
6. If Telegram asks for two-step verification, reopen settings, enter your Telegram cloud password, and save again.

Create Telegram API credentials at [my.telegram.org/apps](https://my.telegram.org/apps).

## Development

Install the Pebble SDK/tooling, then build:

```sh
pebble build
```

Build the bundled Telegram client (teleproto):

```sh
npm install
npm run build:pgjs-gramjs
```

For local testing with embedded API credentials, keep them in an ignored environment file such as `.env.pgjs.local`, then source it before building the bundle. Do not commit personal API credentials, Telegram sessions, or generated PBWs that contain credentials.

## Project Structure

- `src/c/Pebblegram.c`: watch UI, AppMessage handling, scrolling, image decoding, actions, dictation, voice playback, TTS status pill
- `src/pkjs/index.js`: PebbleKit JS runtime and watch communication
- `src/pkjs/pebblegram-voice.js`: voice message decoding (OGG Opus → PCM) and streaming
- `src/pkjs/pgjs/`: Telegram client (teleproto), auth, settings storage, image processing, `tts.js` (TTS client), `shims/` (pure-JS crypto/fs/etc.), `vendor/` (ES5-vendored decoders)
- `pgjs/config.html`: self-hosted settings page (served from GitHub Pages)
- `resources/images/menu_icon.png`: launcher/app-list icon bundled into the PBW
- `store/screenshots/`: store listing screenshots
- `release/`: packaged PBW
- `docs/`: design notes, upstream issue draft, phase-1 bridge docs

## Security Notes

- Do not commit `.env`, `.env.*`, Telegram session files, generated personal PBWs, ngrok configs, or account tokens.
- Public release builds must not embed a personal Telegram API ID or API hash.
- Telegram API ID/hash are required by Telegram's MTProto API. The public PBW does not embed a personal API ID/hash.

## Status

**Pebblegram AI v1.0.19** is the current build. Voice playback, TTS, threaded chats, and media downloads all work on-device. Remaining: long-press info screens (chat details / message details) and a full-screen debug overlay are planned; Phase B (voice recording) awaits PebbleOS #1641.
