# Pebblegram 2.5 Release Plan

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

## Later Releases

- 2.6: Reply/quote display and quote navigation.
- 2.7: Notification launch/deep-link behavior, if the Pebble app and phone
  notification stack expose enough control.

## Earmarked for v3.0

- Full reply quote navigation remains v3.0 scope if 2.6 exposes backend or watch
  memory constraints that make it too large for a minor release.
- Notification suppression remains v3.0 research because Pebblegram likely
  cannot suppress notifications generated by the separate Telegram phone app.
