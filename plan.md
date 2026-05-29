# Pebblegram Link Crash, Emoji, Reactions, and Reliability Plan

## Current Goal

Fix the full app crash triggered by links in chat text, undo the over-heavy emoji
sanitizer side effects, restore useful emoji/reaction affordances, and then do a
focused review for connection speed, session reliability, performance, and memory
headroom.

This plan is the working file for the `main-release` tree.

## Ground Truth

- Handoff: `docs/emoji-safety-handoff.md`
- Primary watch app: `src/c/Pebblegram.c`
- Phone-side PebbleKit JS: `src/pkjs/index.js`
- Telegram/GramJS adapter: `src/pkjs/pgjs/telegram.js`
- Bridge/test mirror: `tools/bridge.py`
- Current local tree already has modified files. Do not discard existing local
  work without checking it first.

## Phase 1: Link Crash Fix

Priority: highest.

Status: implementation complete; automated checks passed. Needs live/on-device
confirmation with a real chat containing links.

Make every watch-bound text path safe for long or formatted links. The previous
working behavior was:

```text
https://example.com/path?query=1 -> [Link] example.com
www.example.com/path -> [Link] example.com
```

Tasks:

- [done] Add an explicit link-shortening sanitizer for watch-bound text.
- [done] Route chat previews through the watch text sanitizer instead of the
  lighter generic clamp path.
- [done] Mirror link shortening in the Python bridge sanitizer.
- [done] Verify link shortening runs before text is sent to the watch for chat previews,
  message rows, reply context, full-text view, bridge output, and notification-ish
  payloads.
- [done] Keep only the domain after `[Link]`; strip scheme, path, query, fragment, and
  trailing punctuation where practical.
- [done] Make repeated links, links inside long tokens, bare domains, and `www.`
  links safe.
- [done] Keep text short enough for the watch and avoid letting giant slash-separated
  tokens or URLs pass through unchanged.
- [done] Mirror behavior in `tools/bridge.py` so bridge testing matches app behavior.

Acceptance checks:

- [manual] A chat containing a long URL no longer crashes the app.
- [done] The rendered watch text keeps useful context: `[Link] domain.com`.
- [done] Link shortening works in preview, bubble body, quoted/reply text, and full-text
  view.

## Phase 2: Emoji Sanitizer Refinement

Priority: high.

Status: implementation complete; automated checks passed. Needs live/on-device
confirmation with real unsupported emoji.

The unsupported emoji sanitizer should prevent crashes without turning useful
emoji into the generic literal `:emoji:` whenever we can do better.

Tasks:

- [done] Preserve Pebble-supported emoji/glyphs as glyphs.
- [done] Convert known unsupported emoji to meaningful aliases, for example:
  - `🐴` -> `:horse:`
  - `🍆` -> `:eggplant:`
  - `✉️` / `✉` -> `:envelope:`
- [done] Use `:emoji:` only for unsupported emoji with no known alias.
- [done] Avoid aggressive blanket pruning or replacement that removes useful context.
- [done] Sanitize reaction-summary text before sending it to the watch.
- [done] Keep variation selectors and unsupported presentation forms from reaching the
  watch in crash-prone forms.
- [done] Keep the JS sanitizer and Python bridge sanitizer aligned.
- [done] Prefer a compact alias table that is easy to audit and does not bloat the watch
  binary.

Acceptance checks:

- Supported emoji still render as glyphs.
- Known unsupported emoji render as meaningful names.
- Unknown unsupported emoji safely render as `:emoji:`.
- No unsupported raw emoji sequence known to crash PebbleOS reaches the watch.

## Phase 3: Sticker and Custom Emoji Names

Priority: medium-high.

Status: implementation complete; automated checks passed. Needs live/on-device
confirmation with real stickers/custom emoji.

If GramJS exposes sticker/custom emoji names or alt text, use that to preserve
context instead of showing only a generic sticker label.

Tasks:

- [done] Use Context7 GramJS docs before changing this path.
- [done] Inspect GramJS message document attributes for stickers and custom emoji.
- [done] Prefer metadata in this order when available:
  - sticker/custom emoji `alt`
  - `emoticon`
  - `emoji`
  - short name/title-like fields if exposed by GramJS
  - current fallback text
- [done] Pass the chosen sticker/custom emoji label through the same watch-safe text
  sanitizer.
- [done] Keep a stable fallback such as `[Sticker] not shown` when no useful metadata is
  exposed.

Acceptance checks:

- Sticker/custom emoji with exposed emoji or name show useful context.
- Unsupported sticker/custom emoji glyphs do not crash the watch.
- Missing metadata keeps the existing safe fallback behavior.

## Phase 4: Reaction List and Emoji Send Menu

Priority: medium.

Status: implementation complete; build passed. Needs live/on-device confirmation
for the restored reaction grid and new-message emoji flow.

Undo the over-pruned reaction menu and add emoji-only sending to the new-message
flow.

Tasks:

- [done] Restore the richer reaction list that existed before the aggressive pruning,
  as long as every visible reaction has a JS-side Telegram mapping.
- [done] Keep the remove reaction option.
- [done] If Telegram rejects a reaction, fail gracefully and refresh/status without
  destabilizing the app.
- [done] Add `Emoji Reply` under `Canned Message` in the no-selected-message menu.
- [done] Reuse the existing emoji grid for both reply and new-message flows.
- [done] When opened from a selected message, send the chosen emoji as a reply.
- [done] When opened from the no-selected-message menu, send the chosen emoji as a new
  outgoing message.

Acceptance checks:

- New-message menu includes an emoji-only send path.
- Reply emoji still replies to the selected message.
- Reaction menu options map correctly to Telegram reactions or fail safely.
- No menu layout regressions on small screens.

## Phase 5: Connection and Session Reliability Review

Priority: after crash/text fixes are stable.

Review and improve the areas most likely to cause slow connection establishment,
frequent logout, and unreliable reconnects.

Tasks:

- Use Context7 GramJS docs for current session, reconnect, and client lifecycle
  guidance.
- Review session save/load behavior after auth, reconnect, and app restart.
- Check handling of auth/session errors such as revoked, unregistered, duplicated,
  expired, or stale auth keys.
- Look for parallel `ready()` / connect calls that can race each other.
- Review keepalive timing, backoff, timeout handling, and phone-offline behavior.
- Avoid avatar/media prefetch blocking initial chat availability.
- Add lightweight timing/status logging around connect, auth restore, chat list
  load, update subscription, and first message load.

Acceptance checks:

- Startup reaches usable chat list faster or has clear timing evidence for the
  remaining bottleneck.
- Reconnect after phone sleep/network loss is more reliable.
- App restart does not unnecessarily log the user out.
- Connection failures produce clear status instead of appearing frozen.

## Phase 6: Performance and Memory Review

Priority: after reliability review, unless a fix needs memory headroom earlier.

Goal: create room for features without repeatedly shrinking the photo buffer.

Tasks:

- Compare current memory-sensitive constants and binary size against the 3.0 main
  release baseline.
- Audit large C-side static strings/tables, especially emoji/reaction/menu data.
- Audit JS bundle size and duplicated sanitizer/mapping tables.
- Check image/photo buffer size and avoid reducing it unless measurements prove
  it is necessary.
- Prefer compact token mappings where the watch can send small ASCII tokens and
  JS can hold larger Telegram/API strings.
- Identify low-risk string/table savings before cutting user-visible media
  quality.

Acceptance checks:

- Any proposed photo buffer reduction includes a measured reason.
- Memory savings are documented with before/after size numbers.
- Feature additions do not silently regress image handling.

## Rocq Use

Use Rocq only for small, pure sanitizer invariants where it helps:

- Link shortening never expands a URL into an unbounded long string.
- Known emoji aliases are preferred over the generic fallback.
- Unsupported raw emoji sequences do not pass through the watch-bound sanitizer.

Do not try to model the whole Pebble app in Rocq.

## Validation Commands

Run these as appropriate while implementing:

```sh
node --check src/pkjs/index.js
node --check src/pkjs/pgjs/telegram.js
python3 -m py_compile tools/bridge.py
```

Also build the PBW from `main-release` after code changes.

Latest Phase 1 run:

- [done] `node --check src/pkjs/index.js`
- [done] `node --check src/pkjs/pgjs/telegram.js`
- [done] `python3 -m py_compile tools/bridge.py`
- [done] JS sanitizer smoke test for `https://`, `www.`, bare domains, repeated
  links, punctuation, and slash-separated non-links.
- [done] Python bridge sanitizer smoke test for matching link cases.
- [done] `pebble build` with WSL Node on PATH.

Latest Phase 2-4 run:

- [done] `node --check src/pkjs/index.js`
- [done] `node --check src/pkjs/pgjs/telegram.js`
- [done] `python3 -m py_compile tools/bridge.py`
- [done] JS/Python emoji sanitizer smoke tests for known aliases, supported
  glyphs, and generic fallback.
- [done] Sticker/custom emoji metadata smoke test.
- [done] Rocq sanitizer invariant model for known aliases versus generic
  fallback.
- [done] `pebble build` with WSL Node on PATH.
- [done] Copied build to `I:\My Drive\Pebblegram.pbw`.

Latest crash hardening run:

- [done] Reproduced the pasted Android stack trace through the JS watch text
  sanitizer.
- [done] Stopped bare-domain link shortening from treating Java package names
  like `java.lang` and `com.android...` as links.
- [done] Collapsed stack-frame lines into `[trace]` and shortened dense
  package/class tokens before they reach PebbleOS text rendering.
- [done] Mirrored the stack-trace sanitizer in `tools/bridge.py`.
- [done] Added C-side UTF-8 trimming after quote/forward context composition.
- [done] `node --check src/pkjs/index.js`
- [done] `node --check src/pkjs/pgjs/telegram.js`
- [done] `python3 -m py_compile tools/bridge.py`
- [done] Exact stack-trace sanitizer smoke test.
- [done] `pebble build` with WSL Node on PATH.
- [done] Copied build to `I:\My Drive\Pebblegram.pbw`.

## Manual Test Matrix

- Chat message with one long `https://` URL.
- Chat message with one `www.` URL.
- Chat message with multiple URLs.
- Chat message with URL plus punctuation.
- Reply quote containing a URL.
- Full-text view containing a URL.
- Supported emoji-only message.
- Known unsupported emoji-only message.
- Mixed text plus unsupported emoji.
- Sticker/custom emoji with exposed alt/name metadata.
- Sticker/custom emoji with no exposed metadata.
- Emoji-only new outgoing message from the new-message menu.
- Emoji reply from selected-message reply menu.
- Reaction send, reaction replace, and reaction remove.
- App restart and reconnect after phone/network sleep.

## Working Notes

- Do not throw away the existing local modifications in `main-release`.
- Prioritize app stability over restoring every possible emoji immediately.
- Keep watch-side UI changes compact; memory pressure is real.
- Prefer fixing sanitization at the phone/bridge boundary so the C watch app only
  receives safe, short text.
