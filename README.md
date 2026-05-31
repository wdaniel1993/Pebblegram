# Pebblegram

Pebblegram brings Telegram to Pebble watches with a PebbleKit JS Telegram client. The watch app gives you a fast inbox, readable message threads, inline photo previews, canned replies, and dictation replies without a separate companion service.

![Chat list](store/screenshots/01-emery-chat-list.png)
![Messages](store/screenshots/02-emery-messages.png)
![Photo message](store/screenshots/03-emery-photo-message.png)
![Actions](store/screenshots/04-emery-action-list.png)

## Download

- [Download Pebblegram 3.2 PBW](https://github.com/TomBolger/Pebblegram/releases/download/v3.2.0/Pebblegram.pbw)

## What It Does

- Shows recent Telegram chats with unread state and message previews
- Opens one-on-one chats, regular groups, and pinned/foldered chat lists
- Displays incoming and outgoing chat bubbles
- Loads inline photo previews, GIF/video still previews, and text link previews
- Sends replies with Pebble dictation
- Sends replies with the Emery touch keyboard
- Sends configurable canned replies
- Sends emoji replies
- Sends, updates, and removes Telegram reactions
- Replies to, forwards, edits, and deletes messages from the watch
- Loads older messages on demand
- Keeps open chats and the chat list refreshed while the app is running
- Supports Basalt, Diorite, Emery, and Gabbro builds
- Includes a black-and-white optimized Diorite image path
- Includes round-screen layout handling for Gabbro

## Changes Since 3.1

Pebblegram 3.2 is the current live Telegram build.

- Raised Emery photo previews to a 30 KB payload ceiling with higher-resolution phone-side preparation for sharper small text.
- Added the Emery touch keyboard for composing short replies directly on the watch.
- Kept the keyboard compact with bordered keys, one-key shift, symbol mode, and optimistic outgoing bubbles that become the sent message when Telegram confirms delivery.
- Made message deletes update the open chat in place instead of reloading the whole thread.
- Fixed portrait photo previews on Emery so tall images use the safe packed-image path on the first load instead of failing once, retrying, or rendering as a blank block.
- Updated the bundled release PBW and GitHub release download for 3.2.

## Quick Start

1. Install [Pebblegram 3.2 PBW](https://github.com/TomBolger/Pebblegram/releases/download/v3.2.0/Pebblegram.pbw) with the Pebble/Rebble mobile app.
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
- `src/pkjs/config.html`: Pebble settings page
- `src/pkjs/pgjs/`: Telegram client, auth, settings storage, and image processing
- `resources/images/menu_icon.png`: launcher/app-list icon bundled into the PBW
- `store/screenshots/`: store listing screenshots
- `release/`: packaged PBW

## Security Notes

- Do not commit `.env`, `.env.*`, Telegram session files, generated personal PBWs, ngrok configs, or account tokens.
- Public release builds must not embed a personal Telegram API ID or API hash.
- Telegram API ID/hash are required by Telegram's MTProto API. The public PBW does not embed a personal API ID/hash.

## Status

Pebblegram 3.2 is the current direct Telegram build. The core flows work, but this is still community software for an unsupported watch platform.
