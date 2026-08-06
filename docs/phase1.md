# Pebblegram Phase 1

Pebblegram is currently built as a Time 2 (`emery`) watch app plus a thin
PebbleKit JS transport and a local HTTP bridge.

## What Works

- Time 2 chat list with Telegram-style white rows and blue selection.
- Group chat history with incoming and outgoing bubbles.
- Sender names above incoming group messages.
- Smooth-ish scroll controls with Up and Down.
- Select opens an action menu with dictation, canned reply, delete, and refresh.
- Canned replies have a confirmation screen before sending.
- Bridge protocol supports chat list, message list, send, delete, and read-on-open.
- Image messages have an inline placeholder and `image_token` field so image
  previews can be added without changing the watch/bridge contract.

## Start The Mock Bridge

```sh
python3 tools/bridge.py --mode mock --host 127.0.0.1 --port 8765
```

## Build And Install

```sh
pebble build
pebble install --emulator emery build/Pebblegram.pbw
```

If the emulator is showing another app, press Back to the launcher, select
Pebblegram, and press Select.

## Telegram Mode

Telegram mode is wired behind the same bridge API, but it requires Telethon:

```sh
python3 -m pip install telethon
export TELEGRAM_API_ID=12345
export TELEGRAM_API_HASH=your_api_hash
export TELEGRAM_PHONE=+15551234567
python3 tools/bridge.py --mode telegram --host 127.0.0.1 --port 8765
```

On first run, Telethon may ask for the Telegram login code in the terminal and
will save a local session file. Phase 1 intentionally filters to regular group
chats and supergroups. Private chats, channels, stories, reactions, and secret
chats are out of scope.

## Settings

The app's settings page is **self-hosted at `pgjs/config.html`** and served from
GitHub Pages (`https://wdaniel1993.github.io/Pebblegram/pgjs/config.html`) —
that URL is baked into `src/pkjs/index.js` as `TELEGRAM_SETTINGS_PAGE_URL`, so
the page ships independently of the PBW and can be fixed without a watch
reinstall. It handles credentials, the login-code/password stages, canned
replies, and the TTS voice picker.

`src/pkjs/config.html` is the upstream emulator page (bridge URL + canned
replies for `pebble emu-app-config`):

```sh
pebble emu-app-config --emulator emery --file src/pkjs/config.html
```

The page itself is static HTML and is ready for the Core Devices app flow.
