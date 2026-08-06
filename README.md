# Pebblegram

Pebblegram brings Telegram to Pebble watches with a PebbleKit JS Telegram client. The watch app gives you a fast inbox, readable message threads, inline photo previews, canned replies, and dictation replies without a separate companion service.

![Chat list](store/screenshots/01-emery-chat-list.png)
![Messages](store/screenshots/02-emery-messages.png)
![Photo message](store/screenshots/03-emery-photo-message.png)
![Actions](store/screenshots/04-emery-action-list.png)

## Download

- [Download Pebblegram 3.5 PBW](https://github.com/TomBolger/Pebblegram/releases/download/v3.5.0/Pebblegram.pbw)

## What It Does

- Shows recent Telegram chats with unread state and message previews
- Opens one-on-one chats, regular groups, and pinned/foldered chat lists
- Displays incoming and outgoing chat bubbles
- Loads inline photo previews, GIF/video still previews, and text link previews
- Sends replies with Pebble dictation
- Sends configurable canned replies
- Sends emoji replies
- Sends, updates, and removes Telegram reactions
- Replies to, forwards, edits, and deletes messages from the watch
- Plays incoming voice messages on watches with speakers (Emery, Gabbro)
- Loads older messages on demand
- Keeps open chats and the chat list refreshed while the app is running
- Supports Basalt, Diorite, Emery, and Gabbro builds
- Includes a black-and-white optimized Diorite image path
- Includes round-screen layout handling for Gabbro

## Voice Messages

Incoming voice messages play as audio on watches with speakers (Emery, Gabbro). The phone-side PebbleKit JS fetches the voice file over MTProto, decodes OGG Opus to 8 kHz mono 16-bit PCM, and streams it to the watch in small chunks over AppMessage; the watch plays the stream through its speaker API with a play/stop pill in the chat UI.

- Playback requires a watch speaker (Emery, Gabbro). Basalt and Diorite build fine but have no speaker, so playback is a silent no-op there.
- Recording from the watch is not yet available — it depends on an upstream PebbleOS on-device audio recording API that has not shipped.

## Changes Since 3.3

Pebblegram 3.5 is the current live Telegram build.

- Reworked resident message and chat-list text storage to reduce fixed RAM use.
- Made the chat list appear progressively so the UI becomes usable much sooner on launch.
- Deferred nonessential startup work until the first visible chats are drawn.
- Raised media size and quality limits, especially on Emery and Gabbro.
- Added screenshot-aware photo contrast handling for both dark and light app screenshots.
- Improved tall-photo navigation so entering and panning through long images is consistent.
- Disabled the experimental Emery touch keyboard to reclaim RAM for media and speed.
- Updated the bundled release PBW and GitHub release download for 3.5.

## Quick Start

1. Install [Pebblegram 3.5 PBW](https://github.com/TomBolger/Pebblegram/releases/download/v3.5.0/Pebblegram.pbw) with the Pebble/Rebble mobile app.
2. Open Pebblegram settings in the Pebble mobile app.
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

Build the bundled Telegram client:

```sh
npm install
npm run build:pgjs-gramjs
```

For local testing with embedded API credentials, keep them in an ignored environment file such as `.env.pgjs.local`, then source it before building the bundle. Do not commit personal API credentials, Telegram sessions, or generated PBWs that contain credentials.

## Project Structure

- `src/c/Pebblegram.c`: watch UI, AppMessage handling, scrolling, image decoding, actions, dictation
- `src/pkjs/index.js`: PebbleKit JS runtime and watch communication
- `src/pkjs/pebblegram-voice.js`: voice message decoding (OGG Opus → PCM) and streaming
- `pgjs/config.html`: self-hosted settings page (served from GitHub Pages; voice picker, credentials, canned replies) — the app's configuration URL points here, so `src/pkjs/config.html` (upstream's emulator page) is legacy
- `src/pkjs/pgjs/`: Telegram client, auth, settings storage, and image processing
- `resources/images/menu_icon.png`: launcher/app-list icon bundled into the PBW
- `store/screenshots/`: store listing screenshots
- `release/`: packaged PBW

## Security Notes

- Do not commit `.env`, `.env.*`, Telegram session files, generated personal PBWs, ngrok configs, or account tokens.
- Public release builds must not embed a personal Telegram API ID or API hash.
- Telegram API ID/hash are required by Telegram's MTProto API. The public PBW does not embed a personal API ID/hash.

## Status

Pebblegram 3.5 is the current direct Telegram build. The core flows work, but this is still community software for an unsupported watch platform.
