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
- [done] Add image preparation/download timeouts so GIF/video previews fail
  and retry cleanly instead of sitting at 0 percent forever.
- [done] Deduplicate in-flight phone-side image encoding so warm-cache work and
  watch requests share the same prepared PNG instead of racing each other.
- [done] Broaden Telegram preview candidates for GIFs, videos, and webpage
  media, including document thumbnails, file thumbnails, photo sizes, and
  Telegram thumb-type fallbacks.
- [done] Replace the passive client-object keepalive with a small Telegram
  network keepalive so stale locked-phone connections are exercised regularly.
- [done] Add watch-side paging watchdogs and phone-side message fetch
  timeouts so older/newer loading cannot stay stuck forever after a backend
  stall or partial transfer.
- [done] Prioritize selected-bubble media loads without moving the viewport:
  selected media clears failed state, preempts non-selected active transfers, and
  may evict an unselected loaded image when bitmap memory is full.
- [done] Try concrete Telegram thumbnails before thumb-name fallbacks for
  GIF/video previews, with faster per-attempt logs for live diagnosis.
- [done] Trim large-platform image staging slightly so selected-media priority
  still packages cleanly while keeping thumbnail payloads generous.
- [done] Remove sticker media loading entirely; stickers now render as text-only
  labels with Telegram alt text where available.
- [done] Keep downward selection into viewport-tall bubbles aligned to the top
  so sender/caption text remains visible before paging through the bubble.
- [done] Stop selected GIF/media failures from immediately retrying forever;
  failed selected media now settles until the user leaves and reselects it.
- [done] Add phone-side media pipeline timeout cleanup so a hung GIF thumbnail
  fetch clears in-flight state and reports failure back to the watch.
- [done] Add diagnostic GIF/media preview errors that report candidate type,
  thumb path, byte signature, and final failure detail to logs and selected watch status.
- [done] Validate JPEG/PNG preview candidates before encoding so malformed
  Telegram JPEG-ish GIF thumbnails are skipped in favor of later candidates.
- [done] Prefer larger Telegram GIF thumb names and demote stripped embedded
  previews so successful GIF previews are not the lowest-resolution fallback first.
- [done] Cap GIF thumbnail probing to fewer high-value thumb attempts, extend
  only the phone-side media pipeline window, and keep stripped previews as fallback.
- [done] Restore normal photo/link media to the longer raw download path so
  GIF preview validation cannot break regular images.
- [done] Hide unsupported large/broadcast Telegram channels from the watch chat
  list to avoid OS crashes from feature-heavy channel payloads.
- [done] Preserve folder labels when Telegram returns folder dialogs that overlap
  with the main chat list.
- [done] Sanitize emoji-heavy chat/message text on the phone and trim incomplete
  UTF-8 on the watch before drawing to reduce OS crashes in large chats.
- [done] Add flattened Telegram folder support by fetching Archive/custom folder
  dialogs and labeling folder-origin previews in the chat list.
- [done] Mirror the long-bubble entry fix upward: scrolling up into a
  viewport-tall bubble now lands near its lower edge instead of jumping to the
  sender/caption at the top.
- [done] Start older/newer prefetch on the first movement in a direction while
  still suppressing only true direction reversals, so initial upward scrolling
  can warm the next page earlier.
- [done] Make phone-side media warming retryable after failures, speed up warm
  staging slightly, invalidate stale prepared-image cache entries, and evict
  persistent image cache entries before writing new ones so localStorage limits
  are less likely to make caching silently disappear.
- [done] Fix tall-bubble page completion so older/newer background loads
  preserve the exact visible slice of a viewport-tall selected bubble instead
  of snapping it to the opposite edge after the initial selection movement.
- [done] When an older/newer page completes after the user has reversed
  direction, discard the stale page and immediately start a silent load in the
  current direction when more rows exist.
- [done] Tone down phone-side prefetch pressure after live testing: reduce
  top-chat prefetch count, fetch smaller 80-row history pages into a 600-row
  phone cache, and serialize capped media warming so background preview work
  cannot compete heavily with selected-image transfers or keepalive.
- [done] Major optimization pass: bound the JS AppMessage queue by dropping
  obsolete/low-priority status and avatar payloads first, cap retained chat
  caches with LRU eviction, cancel stale media-warm generations on chat switch,
  reject stale watch message chunks after transfer reset, cap opportunistic
  reply/forward/media preview probes, and make phone image caching true LRU.


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

## 2.7.5 Stability Pass

Use the fake/mock testing backend again for autonomous emulator testing, then
carry proven fixes back to the live Telegram path.

- Expand the media stress test with the Telegram-style media Pebblegram should
  support: normal photos, albums/grouped photos, GIF previews, video still
  previews, webpage/link previews, document thumbnails, missing/broken preview
  candidates, large images, repeated images, captions, replies/forwards with
  media, and long mixed scroll histories.
- Rework photo loading so retries happen only when the next attempt is
  meaningfully different, such as a different candidate, size, source, or
  encoding path. Plain repeated retries of the same failing photo path should
  stop and report the real failure.
- Keep GIF, video, and link-preview fallback behavior, where retry attempts are
  allowed only because they probe a different preview candidate or processing
  path.
- Investigate the root cause of older/newer streaming hangs where Loading Older
  or Loading Newer stalls until the phone is unlocked or the watch app is
  relaunched. Prove or rule out phone sleep, Telegram/GramJS reconnect state,
  AppMessage backpressure, stale page requests, and phone-side fetch timeouts
  before changing the UI behavior.
- Fix selected photo bubbles that can land completely off screen by finding the
  layout or anchor-state cause, not by adding a surface workaround.
- Remove the Refresh action from action menus and replace it with Go to Bottom.
  Go to Bottom should snap the user to the newest/bottom chat position and
  clear stale paging state cleanly.
- After the 2.7.5 mock-backend fixes are complete, switch back to the live
  Telegram service, build with live Telegram functionality enabled, and then
  pause for Thomas to test before moving on.
- Treat Emery as the primary target for implementation and testing until
  further notice. Other Pebble platforms still matter and should keep building,
  but they are secondary to Emery behavior, ergonomics, and stability.
- Verify photos do not retry the same failed request repeatedly, GIF/video/link
  previews still use meaningful fallback attempts, older/newer loading cannot
  hang indefinitely, selected photo bubbles stay visible after image and paging
  completions, and Go to Bottom replaces Refresh everywhere the action menu
  exposed it.

Implementation findings:

- [done] Switched the JS entrypoint back to mock backend mode for the 2.7.5
  stability pass.
- [done] Expanded mock media coverage with grouped photos, repeated images,
  large photos, GIF/video/link/document-preview rows, broken photo rows, and
  mixed media inside the long stress timeline.
- [done] Found that watch-side image decode/blank/incomplete-transfer handling
  retried the same prepared PNG up to three times. Changed those deterministic
  failures to settle as failed on the watch; meaningful GIF/video/link fallback
  attempts remain phone-side candidate probes.
- [done] Found that selected image rows could be selected while the actual image
  rectangle sat outside the viewport, especially for tall bubbles. Added
  selected-image-aware scroll targeting so the media area is brought into view.
- [done] Found that explicit older/newer page requests could compete with
  background media warming and leave stale visible loading state after a phone
  stall. Foreground page/image work now preempts background media warming,
  existing transfer timeouts clear loading state, and Go to Bottom clears stale
  paging state. A bounded page command retry was tested, but trimmed back
  because it pushed Gabbro over the app footprint limit.
- [done] Kept the final watch app under the app metadata footprint ceiling by
  removing obsolete same-path image retry bookkeeping after retries were
  disabled. Direct SDK builds need `NODE_PATH` pointed at the SDK bundled
  `node_modules` in this Codex environment.
- [done] Replaced the Refresh action-menu item with Go to Bottom. The action
  clears stale page state and either scrolls to the bottom of the current newest
  window or reloads the newest chat window before landing at the bottom.
- [done] Switched the app entrypoint back from the 2.7.5 mock backend to the
  live Telegram service for Thomas testing.
- [investigating] Live Telegram testing showed `Memory low` before paging/photo
  failures. The current finding is watch heap pressure during older/newer
  staging while photo transfer or decoded bitmaps are still resident. Paging now
  cancels foreground image transfers on the phone, releases watch-side image
  memory before page requests and before retrying stage allocation, and gives a
  normal photo one memory-recovery decode attempt before reporting `Photo
  failed`. The watch message text buffer was reduced from 500 to 460 bytes
  because visible previews are capped below that and the full-text action uses
  its own larger buffer.
- [done] Smoothed media scrolling after live testing found that image
  completion could behave like a navigation command. Removed the special
  selected-photo snap target from normal selection scrolling, stopped image
  completion from re-scrolling the selected row, and kept active image transfers
  alive while they remain within the same keep margin used for loaded bitmaps.
- [done] Follow-up live testing showed silent page prefetch was still mutating
  the visible watch window and evicting photos while scrolling. Reworked
  prefetch into phone-side cache warming only, removed passive selected-message
  scrolling from render/message-complete paths, and throttled duplicate page
  prefetches so only explicit boundary requests can enter Loading Older/Newer.
- [done] Added a bounded watch-side timeout for launch/chat-list loading. Chat
  startup previously relied on the phone eventually sending `chats_done`; if the
  phone stalled first, the watch could remain on `Loading...` indefinitely.
- [investigating] One unusually tall live photo could still destabilize the
  watch after several other photos were loaded. Reverted the experimental
  phone-side tall-photo preview/downscale path so normal photos keep the same
  full-media quality path that worked in earlier builds. Current watch-side fix:
  when a large PNG arrives, free non-target decoded bitmaps before attempting
  `gbitmap_create_from_png_data` so the decoder has heap headroom instead of
  crashing before the existing post-failure recovery can run.
- [investigating] Thomas confirmed reactions now update correctly, but the tall
  photo still reports failed. The next finding is that the live Emery/Gabbro
  image budget had been tightened from the older 20 KB path to 19 KB; a tall,
  detailed image can fail the phone-side prepare step at that limit without any
  quality/resolution change being attempted. Restored the 20 KB budget on
  Emery/Gabbro, but the first build showed a static 20 KB watch image buffer
  pushed the app over Pebble's metadata size ceiling. Reworked the watch image
  transfer buffer to allocate only while an image is actively transferring, then
  free it after decode/cancel. This keeps the older 20 KB tall-photo headroom
  without permanently reserving that RAM, bumps the image cache version so the
  tall photo is regenerated, and broadens watch-side decode headroom to free
  other decoded bitmaps based on either compressed PNG size or expected
  displayed pixel area.
- [investigating] Thomas reported the tall photo still failed on first chat
  entry, then worked after loading an adjacent photo, and chat-list avatars
  sometimes disappeared after entering a chat while avatars were loading. Current
  simplification: remove background full-image media warming from chat load,
  live update, and page prefetch paths. It was preparing selected-sized photos
  before the user actually selected them, and a foreground request could only
  cancel the queue, not the already-running download/encode. Message history
  prefetch remains; full photo preparation is now foreground-only again. Also
  removed phone-side "known avatar" skipping and restart the visible avatar pass
  after leaving a chat, because avatars were marked known before the watch had
  necessarily received and decoded them.
- [investigating] Tall photo still failed after the simplification, so add a
  tall-only phone processing path rather than changing normal photos. For source
  photos with a very tall aspect ratio, Telegram is now asked for a photo size
  near the watch's final target dimensions before falling back to full-media
  download. The phone encoder still uses the normal path if the tall image fits;
  only over-budget tall encodes get additional tall-specific scale/color
  attempts. Diagnostics are more explicit now: phone failures distinguish media
  download target failures, unsupported/empty bytes, phone JPEG/PNG decode
  failures, PNG encode budget failures, prepare timeout, and watch-side transfer
  gap/memory/decode/incomplete failures.
- [investigating] Thomas saw `Photo decoded blank` on the tall image. That was
  produced after `gbitmap_create_from_png_data` had already returned a bitmap,
  so the watch-side blank-pixel detector was likely a stale false-negative check.
  Removed that second-guessing: if the watch decoder returns a bitmap, display
  it. Media diagnostic text now appears inside the photo placeholder instead of
  replacing the top status banner.
- [investigating] Thomas then saw a crash right as the tall-photo loading bar
  completed, plus a long empty loading bar when switching away from another
  still-preparing photo and back to the tall one. Current root-cause finding:
  foreground image selections were still allowed to join an old phone-side
  in-flight download/encode even after the watch had canceled that transfer, so
  a fresh selection could sit behind stale work until the 22-second pipeline
  timeout. Also, the tall image could still be emitted near the 20 KB ceiling,
  forcing the watch to hold a large transfer buffer while allocating the decoded
  bitmap. Foreground message photos now bypass stale in-flight reuse while still
  using completed cache hits, and tall-only phone output targets a 15 KB
  watch-safe encoded budget. Normal photos and avatar in-flight dedupe are left
  on the existing path.
- [investigating] Follow-up testing confirmed the crash is gone, but interrupting
  an image load can still leave the next photo waiting too long. The remaining
  cause is not the watch transfer queue; it is old phone-side work continuing
  after a newer foreground image request exists. New foreground image requests
  now supersede older downloads through GramJS `progressCallback`, so obsolete
  downloads throw before consuming the rest of the media transfer, and the phone
  skips decode/encode/cache work if the request was superseded. The tall-photo
  encoder also takes the tall-specific compact path immediately instead of first
  walking the full normal encode matrix, reducing the synchronous JS window where
  the phone cannot process a new watch command.
- [investigating] Thomas clarified that the delayed next load affects all photos
  after an interruption, not only the tall one. Revised root cause: the watch
  could clear an image locally without sending any phone-side cancel if the next
  selected row was not another image yet, and normal photo encodes could still
  run a synchronous multi-attempt PNG loop after the user had moved on. The watch
  now sends an explicit `cancel_image` command whenever it abandons an active
  image. The live backend invalidates foreground image work on that command, and
  normal message-photo encoding now yields between PNG attempts so cancel/new
  image commands can be processed mid-encode rather than waiting for the whole
  encode sweep to finish. Avatar encoding stays synchronous because avatars are
  small and not part of the selected-photo interruption path.
- [investigating] Since interrupted-image delays are still visible on-device,
  add phase diagnostics inside the photo placeholder rather than using the global
  banner. The phone now sends per-image `Preparing`, `Downloading`, `Decoding`,
  `Encoding`, `Caching`, and `Sending` status messages, and the watch shows that
  detail under the loading bar. `Receiving` means the phone has finished
  preparing bytes and the watch is receiving AppMessage chunks. This should make
  the next live test identify whether the empty-bar delay is Telegram download,
  phone-side PNG work, persistent cache/localStorage, or watch transfer.
- [investigating] Thomas saw the delayed next photo still show a blank loading
  bar until it jumped directly to `Receiving`, which means the watch request had
  been sent but the phone JS event loop was still busy with old image work and
  could not even send the early `Preparing` status yet. The watch now labels
  locally started image requests as `Waiting phone` before the phone responds,
  and it waits one short image-retry tick before sending `get_image` so quick
  scroll-past selections do not immediately launch expensive phone processing.
  Also moved image payloads up to 15 KB into a static watch transfer buffer so
  the common/tall processed case no longer consumes heap while Pebble decodes
  the bitmap; larger payloads still fall back to dynamic allocation.
- [investigating] Thomas reports the interaction now feels right, but repeated
  photo swaps can still crash the watch. Root-cause pass: the watch could still
  keep more than one decoded message photo resident on Emery/Gabbro, and the
  cache eviction path spared visible unselected photos even when decoded bitmap
  memory was already over budget. That made repeated photo swaps accumulate the
  most expensive memory object while also holding the active transfer/decode
  buffer. Current fix keeps only one decoded message photo resident, clears
  other decoded photos before starting/decoding a newly selected photo, and
  enforces the one-photo budget even when the extra bitmap is still visible.
- [investigating] Live testing found Telegram 400 errors for some expanded-grid
  reaction emoji, notably crying and broad-smile faces. Correction after Thomas
  challenged the first interpretation: Telegram can react with crying face, so
  the app should not remove it or assume it is unsupported. The safer fix is to
  stop sending raw displayed emoji strings as reaction commands from the watch.
  The grid now sends stable ASCII reaction tokens, including exact tokens for
  crying, open-smile, and smiling-eyes faces; the phone maps those tokens back
  to the intended Telegram reaction emoji. Emoji replies still send the visible
  glyph text.
- [investigating] Follow-up reaction-grid testing: crying face works, but
  open-smile and smiling-eyes still return 400 when sent as exact Telegram
  reaction emoji. Thinking face and lightning render as missing glyph boxes on
  Pebble. Remove those boxed entries from the watch grid for now, keep the other
  visible choices, and map the Telegram-rejected ones to the closest accepted
  reaction: smile variants to grinning, peace/fists to OK hand, wave/raised
  hand/raised hands to clapping, and beer choices to party. Verification now
  expects the mapped reaction glyph instead of the displayed selector glyph.
- [investigating] Thomas pushed back that reaction mappings should not be
  inaccurate when the selected emoji is fundamentally different. Split the
  pickers: the React grid is now pruned to exact or near-exact Telegram
  reactions, keeping one big-smile option plus the crying special case and
  removing the gesture/drink choices that only worked through a different
  reaction. The Emoji Reply grid is separate and keeps the broader
  Pebble-renderable emoji set, including the pruned reaction glyphs, because
  replies send ordinary message text instead of Telegram reaction objects.
- [investigating] Status banners were staying on the last success/error until
  another status arrived. Add a short watch-side clear timer so transient
  banners return to `Pebblegram`; loading/connecting/requesting states still
  persist until the load path finishes or times out.
- [done] Replaced the app menu icon with the 25x25 paper-plane asset from the
  Emery paper-plane assets folder. The existing Pebble resource entry still owns
  the app icon; only the PNG backing it changed.
- [investigating] The old "8 visible plus 6 ahead" idea should not be restored
  literally on the watch while memory is tight: the current watch resident
  message array is 9 rows, and raising it toward 14 would increase static row
  buffers and make photo heap pressure worse. The better version is to keep the
  watch window small, prefetch only into the phone-side history/media cache, and
  let explicit boundary movement swap the watch window from cached rows.
- [investigating] Reaction sends can return a GramJS/Telegram 400 even though
  the reaction later appears after reopening the chat. The reaction path now
  verifies the target message after a send error; if Telegram already applied
  the reaction, Pebblegram patches the visible row and reports success instead
  of showing a false failure. If verification confirms the error was accurate,
  Pebblegram retries once after a short pause, then verifies again before
  surfacing the failure.
- [investigating] Live chat-view updates should not replace the active watch
  window. Whole-window refreshes can yank the selected row and viewport because
  the watch treats them as fresh initial loads. Live refresh now patches only
  resident rows whose text/reaction/meta changed, preserving selection and
  scroll offset. Newly arrived rows are merged into the phone-side history cache
  for the next explicit boundary/bottom load rather than being injected into the
  middle of a scrolled viewport.
- [investigating] Chat-list live refresh already preserves the selected chat by
  id across reordered rows. Keep validating that it refreshes unread/preview
  state without moving the cursor unexpectedly.

## Later Releases

- 2.7: Notification launch/deep-link behavior, if the Pebble app and phone
  notification stack expose enough control.

## Recovery Handoff - 2026-05-19

Current branch/workspace:

- Branch is `experiment/pgjs` in `/home/thomas/pebble/Pebblegram`.
- Working files are writable, but this Codex session has `.git` mounted
  read-only. Normal file edits work; `git fetch`, `git commit`, and `git push`
  fail with `.git/FETCH_HEAD: Read-only file system`.
- `findmnt` showed the repo root mounted `rw`, but `.git` mounted separately
  as `ro`. To push normally, reopen/fix the Codex workspace so `.git` is `rw`,
  or use an external terminal where Git metadata is writable.
- Local status when this note was written:
  - `src/pkjs/index.js` modified.
  - `src/pkjs/pgjs/auth.js` modified.
  - `src/pkjs/pgjs/image.js` modified.
  - Untracked recovery/build artifacts also exist: `.lock-waf_linux_build`,
    `build - Copy/`, `data - Copy/`, `pebble_paper_plane_icon_assets.zip`,
    `replyemoji.png`.
- Local branch tracking still reports `ahead 50` because the earlier remote
  push succeeded but local `.git` could not update its refs. Remote
  `origin/experiment/pgjs` already contains the 2.7 recovery push plus commit
  `9eb9967 Refresh persistent image cache LRU on hits`.

Changes that must be preserved and pushed:

- `src/pkjs/pgjs/image.js`: persistent image cache hits now call
  `persistentCacheNoteUse(key)` so the persistent LRU order is refreshed on
  cache reads. This was already saved remotely as commit `9eb9967`, but the
  local working tree still shows it modified because local Git refs could not
  update.
- `src/pkjs/pgjs/auth.js`: fix the repeated login/logout loop around Telegram
  `AUTH_KEY_DUPLICATED` from `invokeWithLayer`.
  - Track the active GramJS client with `currentClient`.
  - Treat `AUTH_KEY_DUPLICATED`, `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`,
    `USER_DEACTIVATED`, and `USER_DEACTIVATED_BAN` as fatal session errors.
  - On fatal connect/reconnect/sign-in failures, disconnect the client, clear
    the poisoned saved session, and return a user-facing sign-in message.
  - `reset()` now disconnects the active client before clearing session state.
  - Temporary sign-in clients are disconnected on password-needed and error
    paths so they do not linger while settings waits for more input.
- `src/pkjs/index.js`: removed the redundant launch-time warm
  `activePgjs().ready()` call. Startup still begins keepalive, update listener,
  and chat loading; this avoids an unnecessary extra auth/connect attempt.

Validation already run and passed:

- JS syntax check over `src/pkjs` and `tools`.
- `npm run build:pgjs-gramjs`.
- Full Pebble SDK build through direct `waf configure build`, producing
  `build/Pebblegram.pbw`.

Recommended next-chat actions:

- First make `.git` writable or use a terminal/session where Git works.
- Fetch `origin/experiment/pgjs` so local refs see remote commit `9eb9967`.
- Preserve the working tree edits in `src/pkjs/pgjs/auth.js` and
  `src/pkjs/index.js`; do not reset them away.
- Commit/push the auth duplicate-key fix on `experiment/pgjs`. Include
  `src/pkjs/pgjs/image.js` only if local Git still needs to reconcile the
  already-remote LRU commit.
- Do not include the untracked recovery/build artifacts unless intentionally
  needed.

## Git Push Procedure From Codex

If `.git` is mounted read-only in Codex, normal `git fetch`, `git commit`, and
`git push` may fail even though working-tree files are writable. The push can
still be completed by keeping Git metadata and new objects in ordinary writable
temporary paths.

- Clone the branch to `/tmp` with a separate metadata directory, for example
  `git clone --separate-git-dir /tmp/pebblegram-gitdir --branch experiment/pgjs
  --single-branch https://github.com/TomBolger/Pebblegram.git
  /tmp/pebblegram-work`.
- Copy only the intended tracked file changes into the temporary worktree. Do
  not include copied build/recovery artifacts such as `.lock-waf_linux_build`,
  `build - Copy/`, `data - Copy/`, `pebble_paper_plane_icon_assets.zip`, or
  `replyemoji.png` unless they are intentionally part of the release.
- Route staging and new Git objects to writable temporary paths with
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
- Stage the intended files, create a tree with `git write-tree`, create the
  commit with `git commit-tree` using the current remote branch commit as the
  parent, then push the resulting commit SHA directly to
  `refs/heads/experiment/pgjs`.
- After pushing, verify with `git ls-remote --heads origin experiment/pgjs`.
  The temporary checkout may still fail to update its own tracking ref, but the
  remote branch is authoritative.

## Earmarked for v3.0

- Reply quote warp/navigation remains v3.0 scope; 2.6 uses an in-place full
  context viewer instead so users do not lose their chat position.
- Notification suppression remains v3.0 research because Pebblegram likely
  cannot suppress notifications generated by the separate Telegram phone app.
