# Pebblegram

Pebblegram brings Telegram to Pebble watches with a PebbleKit JS Telegram client. The watch app gives you a fast inbox, readable message threads, inline photo previews, canned replies, and dictation replies without a separate companion service.

![Chat list](store/screenshots/01-emery-chat-list.png)
![Messages](store/screenshots/02-emery-messages.png)
![Photo message](store/screenshots/03-emery-photo-message.png)
![Actions](store/screenshots/04-emery-action-list.png)

## Download

- [Download the Pebble app PBW](release/Pebblegram.pbw)

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
- Loads older messages on demand
- Keeps open chats and the chat list refreshed while the app is running
- Supports Basalt, Diorite, Emery, and Gabbro builds
- Includes a black-and-white optimized Diorite image path
- Includes round-screen layout handling for Gabbro

## Changes Since 2.3

Pebblegram 2.8 is the current live Telegram build.

- Added message actions for replies, forwards, edits, deletes, full-text viewing, quote/context viewing, and Go to Bottom navigation.
- Added Telegram reactions with a Pebble-safe reaction picker, separate emoji-reply picker, and reaction refresh/verification after Telegram send errors.
- Improved live refresh so chat-list previews and unread state update while open chats preserve selection, scroll position, and resident message rows.
- Reworked older/newer paging so foreground page loads preempt background work, recover cleanly from stalls, and no longer leave the watch stuck on Loading Older.
- Hardened photo loading for photo-heavy chats, including foreground-only message photo preparation, cancellation of obsolete phone-side image work, per-image loading status, persistent image-cache LRU refresh, and one decoded message photo resident on the watch.
- Fixed tall-photo handling on Emery/Gabbro without tiling or excessive padding by using tall-specific Telegram photo candidates and compact watch-safe encoding.
- Treated webpage/link previews as text rows on the watch so repo/share links do not enter the image preview path.
- Improved auth/session recovery for duplicated or revoked Telegram auth keys and removed redundant startup connection attempts.
- Limited Telegram login-code requests to one per phone number every five minutes and added a saved-session backup to reduce accidental login loss.
- Added a mock backend stress timeline for emulator testing of media, reactions, paging, replies, and long mixed histories.
- Updated the app menu icon and bundled release PBW for 2.8.

## Quick Start

1. Install [release/Pebblegram.pbw](release/Pebblegram.pbw) with the Pebble/Rebble mobile app.
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

Pebblegram 2.8 is the current direct Telegram build. The core flows work, but this is still community software for an unsupported watch platform.
