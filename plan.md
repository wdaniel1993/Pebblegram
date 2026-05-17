# Pebblegram 2.6 Release Plan

## Current Goal

Build 2.5 on top of the stable 2.4 mainline release. The 2.5 target is sending
message reactions while keeping the 2.4 live refresh, media preview, pinned chat,
and image-loading stability intact.

## Stable Base

- `main` now carries the stable 2.4 build.
- `build/Pebblegram-2.4.0-stable.pbw` is the current rollback/release PBW.
- 2.4 includes view-only reactions, GIF/MP4/video still previews, webpage
  previews, pinned chat ordering, live chat-list refresh, and selected-row
  preservation during chat-list refresh.

## 2.5 Implemented

- Added a selected-message `React` action using the existing custom action menu.
- Added a compact fixed reaction set: Like, Heart, Laugh, Wow, Sad, Angry, and
  Remove.
- Added a `send_reaction` watch-to-JS command using existing AppMessage fields.
- Added a GramJS `messages.SendReaction` backend path with standard
  `ReactionEmoji` reactions.
- Successful reaction sends return a `reacted` event and refresh the active chat
  so the displayed reaction state can confirm the action.
- Kept existing reaction display rendering unchanged.
- Trimmed large-screen retained message text to keep Gabbro under the app
  footprint limit.

## Validation

- Send each built-in reaction to incoming and outgoing messages.
- Replace an existing reaction with a different reaction.
- Clear/remove a reaction if Telegram's API supports an empty reaction request
  cleanly in this bundled GramJS version; otherwise defer reaction removal.
- Confirm the active chat refreshes without moving the selected message.
- Confirm live incoming messages and image loading still work after sending a
  reaction.
- Build on all platforms and keep Gabbro under the app footprint limit.
- Use `build/Pebblegram-2.5.0-experimental.pbw` for tester builds.

## Tabled: Extended Reaction Grid

Keep the compact 2.5 reaction list as the current release candidate scope. The
longer emoji reaction picker is desirable, but it should be implemented after
the compact sender has been tested because the watch app is already close to the
Gabbro footprint limit.

Implementation plan:

- Keep the current first-level reaction list for the most common reactions.
- Add a `More...` item that opens a grid picker modeled after Pebble's emoji
  reply UI.
- Prefer extending the existing custom action sheet first so behavior stays
  consistent across supported SDK targets. Evaluate native
  `ActionMenuLevelDisplayModeThin` only if it reduces code size and behaves well
  on Aplite, Basalt, Chalk, Diorite, Emery, and Gabbro.
- Navigate the grid row-major. Up/down should move through rows, select should
  send the highlighted reaction, and back should return to the compact reaction
  list.
- Keep the selected row near the middle of the screen while scrolling. Clamp the
  final rows so the grid stops with the bottom row visible instead of revealing
  blank space.
- Store a compact reaction catalog. The C side should send small ASCII tokens or
  indexes, and the JS side should map those tokens to Telegram reaction emoji.
  This keeps UTF-8 strings and reaction metadata out of the footprint-sensitive
  watch binary as much as possible.
- Build the catalog from Telegram-supported reaction emoji, then verify which
  glyphs Pebble actually renders in emulator screenshots. Remove blank or broken
  glyphs from the grid before shipping.
- Re-check Gabbro size after each step. If the grid does not fit, trim older UI
  strings or replace the compact reaction submenu with a shared grid renderer
  rather than carrying both implementations.

## 2.x Testing Plan

Keep testing simple for the rest of the 2.x cycle: emulator confidence first,
then real-account validation.

- Add a lightweight current-architecture PGJS mock mode for emulator smoke
  testing. It should use deterministic fixtures and implement only the backend
  behavior needed for UI confidence: chats, messages, older-message paging,
  live incoming updates, reactions, pinned/unread state, avatars, media
  placeholders, and image preview byte responses.
- Use emulator mock mode for quick iteration on action menus, reaction picker
  behavior, selected-row preservation, pinned chats, unread updates, media
  labels, image lifecycle behavior, and screenshots.
- Drive emulator checks with the Pebble tools: build, install to an emulator,
  send button presses, and capture screenshots for visual verification.
- Use the real Telegram account for live testing and release confidence. This
  remains the source of truth for auth, real reactions, live message updates,
  media downloads, link previews, pinned chats, profile photos, and edge cases.
- Do not add Telegram Test DC, dummy-account, or legacy bridge-server testing to
  the main workflow unless a future bug specifically requires it.

## 2.6 Reply and Forward Phase

Build reply and forward context into chat bubbles using a compact Telegram-style
quote strip adapted for the Pebble display.

- Add per-message reply/forward metadata to the watch payload: reply sender,
  reply text, forward source, and forward text/detail.
- Fetch reply and forward context from Telegram/GramJS when normalizing messages,
  using already-loaded rows first and fetching referenced reply messages when
  necessary.
- Seed the PGJS mock backend with deterministic reply and forward rows so the UI
  can be tested without a Telegram account.
- Render a small quote/details area at the top of each bubble, above the message
  body and below the sender name, with tight text limits for Gabbro and other
  footprint-sensitive targets.
- Add a selected-message Reply action that opens a reply submenu with Dictate,
  Canned Message, and Emoji Reply.
- Reuse the existing reaction emoji grid for Emoji Reply, sending the chosen emoji
  as a reply message instead of as a Telegram reaction.
- Move the regular new-message canned sending path under Canned Message as part
  of the same menu flow, preserving the existing compose behavior for unselected
  bubbles.
- Add View Reply/View Forward actions for selected bubbles with context, reusing
  the full-message viewer so long quoted/forwarded text can be read without
  jumping away from the current chat position.


## 2.6 Streaming and Sticker Stabilization Phase

Move the latest 2.6 work onto testing/mock-backend first, then prove the UI
against deterministic dummy data before carrying fixes back to the live Telegram
branch.

- Keep the testing branch in mock backend mode so emulator loops do not depend
  on Telegram login or the phone network state.
- [done] Add a deterministic mock sticker row and image payload so sticker
  rendering can be tested without a live account. Emery visual verification is
  still blocked by the local QEMU handshake hanging before install.
- [done] Replace the initial/older fixed whole-window message load with a
  streaming timeline protocol: open the chat view immediately, deliver the
  newest row first, then prepend older rows without replacing the entire list.
- [done] Tune the timeline as a bottom-anchored surface: latest bubbles should
  appear at the bottom immediately, short chats should sit at the bottom rather
  than the top, and the user should be able to scroll as soon as the first row
  arrives.
- [done] Add directional prefetch/eviction: keep a smaller resident watch
  window of 12 bubbles, fetch larger 80-message phone/backend pages into a
  600-row phone-side cache, warm media thumbnails ahead of time, and feed the
  watch only the nearest rows it can render smoothly.
- [done] Replace the watch-side older/newer prepend/append merge shim with a
  phone-owned viewport replacement. The watch now treats older/newer fetches as
  complete tiny windows and restores the selected bubble by id and pixel offset.
- [done] Tighten the viewport to 8 resident messages with 6-row directional
  windows, anchored on the selected message so loading is proactive but biased
  toward the direction of travel.
- [done] Add a deterministic Numbered Scroll Test chat with messages #1-#50
  alternating sender direction so scroll paging can be visually audited without
  guessing which row moved.
- [done] Decouple media loading from selection movement: selecting or passing a
  picture no longer cancels unrelated media work or prioritizes that row as a
  cursor target. Image scheduling is visible-only, does not recalc/clamp the
  chat layout, and will not start another image while the bitmap cache is full,
  avoiding visible load/evict loops between adjacent media rows.
- [done] Send both selected-anchor and window-boundary ids for older/newer
  paging. The phone fetches beyond the current boundary but slices a contiguous
  8-row window around the selected message, biased by travel direction.
- [done] Start a directional load on every up/down message movement, not only at
  the wall, and pause at the wall while the offscreen replacement window loads.
- [done] Slow hold-to-scroll repeat timing to reduce accidental wall hits while
  the phone is still delivering the next window.
- [done] Stage replacement windows offscreen and swap them only at
  messages_done, preventing empty/partial resident lists and avoiding the
  temporary "No messages loaded" state while the phone is slow.
- [done] Preserve the selected bubble's pixel position when image transfers
  complete so offscreen media loading cannot pull the visible viewport around.
- [done] Mirror older loading with newer-message paging so down scrolling does
  not warp back to the newest message after a long upward scroll.
- [done] Make silent prefetch actually silent on the phone side and watch side
  so background loads do not show Loading Older/Newer or repaint every streamed
  row while the user is scrolling.
- [done] Tune scrolling for smooth but snappy movement: 4 animation steps with
  shorter frame intervals, plus earlier prefetch at five rows from either edge.

- [done] Add a long mock stress chat with mixed message lengths, reactions,
  replies, forwards, stickers, photos, and older-message pages for scroll tests.
- [done] Constrain sticker/photo preview drawing to the bubble text column so
  large sticker images cannot clip out of the bubble or off screen.
- [done] Apply the same streaming approach to chat list launch: load only enough
  for the first selectable chat, then stream the rest downward.
- [done] During older/newer loading, keep the originally selected edge bubble
  pinned by pixel offset, avoid queued scroll intent, and move at most one
  deliberate row after the incoming rows are selectable rather than teleporting.
- [done] Add stale-request protection so queued rows from a previous chat
  selection or a backed-out chat cannot reopen or corrupt the current view.
- [done] Revisit the phone connection loop for sleep/off-phone conditions: keep
  command retries conservative, reconnect cached Telegram clients when they go
  stale, run a gentle keepalive while the JS side is active, avoid queue storms
  while the phone is unavailable, and surface a clear status instead of looking
  frozen.
- [done] Remove the obsolete prepend/append merge staging, negative-scroll blank
  spacer, queued edge-scroll counters, and non-started refresh replacement path;
  keep only a simple offscreen replacement buffer for atomic viewport swaps.
- [done] Text-only scrolling pass: background older/newer page commits now
  preserve the currently selected row at its current pixel position, drop stale
  staged windows that no longer contain that row, and stop moving the selection
  when a load finishes.
- [done] Directional edge anchoring for text-only scrolling: upward motion
  pins the selected bubble to the top while older rows load beneath it; downward
  motion pins the selected bubble to the bottom while newer rows load above it.
- [done] Replace the temporary virtual-padding scroll workaround with balanced
  phone-side message windows, keeping a small offscreen buffer in the scroll
  direction while leaving enough real rows on-screen to avoid blank gaps and
  misplaced compose/new-message UI.
- [done] Smooth direction changes: normal selection steps no longer hard-snap
  to the opposite edge, the first click after reversing direction suppresses
  prefetch, and late page completions from the old direction are discarded.
- [done] Preserve photo bitmap/request state across staged message-window swaps
  and stop image scheduling from sweeping cached photos merely because messages
  paged in; loaded photos are evicted only when making room for another photo.


## 2.7 Longer Message Text Phase

Increase message text capacity after the 2.6 streaming/paging work reduced the
resident watch window to eight bubbles. Keep timeline bubbles capped to roughly
one screen of text per platform, while allowing the full-message and quote
viewer paths to fetch substantially longer text.

- [done] Bump app version to 2.7.0.
- [done] Raise watch-side stored message text from 300 to 500 characters.
- [done] Raise full-message/context viewer text from 700 to 1200 characters.
- [done] Keep chat bubble previews bounded by platform-sized screenful caps: 132
  chars on smaller rectangular platforms and 220 chars on larger displays.
- [done] Raise the JS message window budget to match the larger per-row text
  buffers without abandoning the dynamic 8-row resident window.

## 2.7 Media Reliability Review

Review and simplify the media-loading path after the 2.6 scrolling overhaul, with
the goal of making photos, stickers, GIF stills, video stills, and link previews
load predictably from live Telegram while using the phone as the heavy cache and
preparation layer.

- [done] Increase the resident watch message window from 8 to 9 rows and the
  phone-side older/newer page size from 80 to 120 rows, with a 1000-row phone
  history cache, so scrolling has more cushion before hitting an edge.
- [done] Extend the image transfer stall timeout and drop obsolete queued media
  or message-transfer payloads so a canceled/failed chunk cannot wedge the
  bridge.
- [done] Add image preparation/download timeouts so GIF/video/sticker previews
  fail and retry cleanly instead of sitting at 0 percent forever.
- [done] Deduplicate in-flight phone-side image encoding so warm-cache work and
  watch requests share the same prepared PNG instead of racing each other.
- [done] Broaden Telegram preview candidates for stickers, GIFs, videos, and
  webpage media, including document thumbnails, file thumbnails, photo sizes,
  and Telegram thumb-type fallbacks.
- [done] Replace the passive client-object keepalive with a small Telegram
  network keepalive so stale locked-phone connections are exercised regularly.
- [done] Add watch-side paging watchdogs and phone-side message fetch
  timeouts so older/newer loading cannot stay stuck forever after a backend
  stall or partial transfer.


## 2.6 Validation

- In mock mode, confirm reply quote strips render for incoming and outgoing
  messages and keep image/reaction layout stable.
- In mock mode, confirm forward detail strips render and truncate cleanly.
- In mock mode, confirm sent and received replies/forwards, including references
  to much older messages, can open their full context from the selected-message
  action menu.
- From a selected bubble, send a dictated reply, canned reply, and emoji reply,
  then confirm the new outgoing message references the selected message.
- From the compose target, confirm canned message sending still works through the
  new menu flow.
- Confirm normal Telegram/GramJS message loading includes reply/forward context
  without breaking reactions, media placeholders, older-message paging, or live
  refresh.
- Build on all configured platforms and keep Gabbro under the app footprint
  limit.

## Later Releases

- 2.7: Notification launch/deep-link behavior, if the Pebble app and phone
  notification stack expose enough control.

## Earmarked for v3.0

- Reply quote warp/navigation remains v3.0 scope; 2.6 uses an in-place full
  context viewer instead so users do not lose their chat position.
- Notification suppression remains v3.0 research because Pebblegram likely
  cannot suppress notifications generated by the separate Telegram phone app.
