# Emoji Safety Handoff

Date: 2026-05-29

## Context

The 3.0 release can crash when opening a chat containing an unsupported standalone emoji. The reproduced case was Telegram's large standalone envelope emoji (`✉️` / `✉`), which Pebblegram passed through to PebbleOS text rendering.

The fix is intended for `main`, not the experimental `pgkb` branch.

## Worktree State

- Main-release worktree: `/mnt/c/Users/tombo/Documents/Pebblegram/main-release`
- Branch: `main`, tracking `origin/main`
- Changed files:
  - `src/c/Pebblegram.c`
  - `src/pkjs/index.js`
  - `src/pkjs/pgjs/telegram.js`
  - `tools/bridge.py`
- The original repo checkout at `/mnt/c/Users/tombo/Documents/Pebblegram/experimental` remains on `pgkb`.
- Accidental emoji-safety edits in `experimental/src/pkjs/index.js` and `experimental/tools/bridge.py` were reverted.
- `experimental/src/c/Pebblegram.c` still has unrelated pre-existing `pgkb` touch-keyboard changes and was left untouched.

## Behavior Changes

### Incoming Message Display

`src/pkjs/index.js` now normalizes watch-bound text before it is sent to the Pebble app.

Supported PebbleOS emoji are preserved. Unsupported emoji are converted to readable aliases or `:emoji:`. This protects chat list previews, message text, reply context text, and full-message text because they already flow through `clampText()` / `watchText()`.

Examples verified:

- `✉️` -> `:envelope:`
- `✉` -> `:envelope:`
- `❤️` -> `❤`
- `⭐️` -> `⭐`
- `👍`, `😂`, `⌚`, `✅`, `😃` remain emoji
- `🙂` -> `:emoji:`

`tools/bridge.py` mirrors this sanitizer for helper/hosted mode, including mock messages and Telethon-backed previews/messages.

### Reaction Grid

`src/c/Pebblegram.c` now separates reaction choices from emoji reply choices.

The reaction grid is pruned to a conservative intersection of Telegram standard reactions and PebbleOS-supported glyphs:

`👍 👎 ❤ 🎉 🤩 😱 😁 😢 💩 🤮 🥰 🤬`

Plus `Remove`.

Removed from reactions because they were not in the conservative Telegram standard reaction set, not Pebble-supported, or both:

`🤣 😭 😍 😘 😎 😳 😬 😐 😴 😇 😈 👌 👏 🙏 👀 💔 💋 🔥`

Note: Telegram's broader reaction ecosystem changes with Premium/custom emoji and chat settings. This grid intentionally avoids offering arbitrary emoji as reactions because Telegram may reject them or silently revert them.

### Emoji Reply Grid

Emoji replies are plain message text, not Telegram reactions. The reply grid was expanded to a compact PebbleOS-supported test subset while staying below app size limits.

It includes the previous common replies plus additional Pebble-supported test glyphs:

`⌚ ✅ ✨ ❗ ⭐ 💯 🤗 🤝 🤩 🤪 🤬 🥰 🥺`

This is intentionally not the full PebbleOS emoji list because adding the full list to the C app pushed older platform packaging over the metadata size limit.

### Reaction Token Mapping

`src/pkjs/pgjs/telegram.js` and `src/pkjs/index.js` now understand these new reaction tokens:

- `star_struck` -> `🤩`
- `smiling_hearts` -> `🥰`
- `symbols_mouth` -> `🤬`

Existing token mappings remain for the retained reaction grid entries.

## Verification Performed

Commands run from `/mnt/c/Users/tombo/Documents/Pebblegram/main-release`:

- JavaScript syntax checks:
  - `node --check src/pkjs/index.js`
  - `node --check src/pkjs/pgjs/telegram.js`
- Python syntax check:
  - `python3 -m py_compile tools/bridge.py`
- Behavior smoke checks:
  - watch text normalization cases listed above
  - bridge normalization cases listed above
  - reaction grid tokens match expected list
  - every reaction grid token except `remove` has a Telegram mapping
- `pebble build`:
  - C compiled and linked for gabbro, emery, diorite, and basalt.
  - Full packaging did not complete because the local SDK requires a Linux `node` binary for webpack and this environment only has Windows `node.exe`.
  - Earlier attempt with the full emoji reply list also exceeded metadata size; this was fixed by trimming the reply grid.

## Remaining Notes

- A full `pebble build` should be rerun in an environment with Linux `node` available on `PATH`.
- If broader Telegram reaction support is desired later, prefer fetching `messages.getAvailableReactions` / chat-specific reaction settings and intersecting dynamically with the Pebble display allowlist.
- The display sanitizer and helper sanitizer currently duplicate emoji lists. Consider centralizing/generating both from one source if this grows.

## Reference Sources

- PebbleOS emoji support: https://developer.repebble.com/guides/app-resources/system-fonts/
- Telegram reactions API: https://core.telegram.org/api/reactions
