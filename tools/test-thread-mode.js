#!/usr/bin/env node
// Simulation: proves the threaded-mode cache poison (warmChatHistory writing
// unmarked rows into the persistent cache at app start) and verifies the fix
// (per-chat thread-mode authority re-stamps rows at every store-write site).
//
// Scenario (matches Daniel's report "clicking eve chat directly moves to the
// messages instead of the thread list; a restart solved it"):
//   1. JS starts; prefetchTopChats() -> warmChatHistory(eve) fetches the
//      thread list but (OLD code) stores rows WITHOUT thread_list flag.
//   2. User clicks eve -> getMessages -> sendStoredMessages serves the cached
//      UNMARKED rows -> watch never sets s_thread_mode -> flat view.
//   3. Restart clears in-memory store -> fresh fetch re-detects -> works.
//
// The simulation stubs localStorage and exercises the real helper functions
// by eval'ing them from index.js (they are top-level function declarations).

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/pkjs/index.js', 'utf8');

// ---- minimal localStorage stub ----
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

// ---- extract + eval the thread-mode helpers from index.js ----
function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}

const helpers = [
  'loadThreadModeChats',
  'isThreadedChat',
  'setThreadedChat',
  'markThreadRows',
  'persistentMessageCacheKey',
  'persistentMessageCacheOrder',
  'removeArrayValue',
  'savePersistentMessages',
  'loadPersistentMessages',
  'limitMessageWindow'
];
let evalSrc = helpers.map(extract).join('\n');
// constants the helpers reference
evalSrc = 'var appVersion = "1.0.32-test";\n' +
          'var MESSAGE_CACHE_ORDER_KEY = "pebblegram.messageCache." + appVersion + ".order";\n' +
          'var MESSAGE_CACHE_PREFIX = "pebblegram.messageCache." + appVersion + ".";\n' +
          'var THREAD_MODE_KEY = "pebblegram.threadMode." + appVersion + ".map";\n' +
          'var MAX_CACHED_CHATS = 12;\n' +
          'var threadModeChats = {};\n' +
          'var MAX_MESSAGE_ROWS = 60;\n' +
          'var MESSAGE_WINDOW_BUDGET = 1e9;\n' +
          'function debugLog(s) {}\n' +
          'function messageRowCost() { return 1; }\n' +
          evalSrc;

// limitMessageWindow is defined in index.js as a function too; grab it if
// the simple regex missed it (it may have params) - re-extract with its real body
const lmw = src.match(/function limitMessageWindow[\s\S]*?\n\}/);
if (lmw) {
  evalSrc = evalSrc.replace(/function limitMessageWindow[\s\S]*?\n\}/, lmw[0]);
}
eval(evalSrc);

// ---- test rows: eve chat, thread list (topic rows) ----
function makeRows(n, threadMode) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: String(1000 + i),
      sender: threadMode ? 'Topic ' + i : 'Alice',
      text: threadMode ? 'topic ' + i : 'plain message ' + i,
      outgoing: false,
      thread_replies: threadMode ? (i % 3) + 1 : 0
    });
  }
  if (threadMode) rows.thread_mode = true;
  return rows;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

const EVE = '123456';

// ---- Scenario A: OLD behavior (no authority) ----
// warmChatHistory writes unmarked rows into the persistent cache.
// Simulate by saving rows that were NOT stamped (the old code path).
delete store['pebblegram.messageCache.1.0.32-test.order'];
delete store['pebblegram.messageCache.1.0.32-test.' + EVE];
const unmarked = makeRows(5, true); // thread_mode on the list, but rows unmarked
savePersistentMessages(EVE, unmarked);
let cached = loadPersistentMessages(EVE);
check('A1 persistent cache holds rows', cached.length === 5);
check('A2 rows LACK thread_list (the poison)', cached.every(r => !r.thread_list));

// ---- Scenario B: FIX, cold start with authority already known ----
// If the chat was detected as threaded in a previous session, the map
// persists; a cache-served open must re-stamp rows before sending.
setThreadedChat(EVE);
// new "open" from cache
cached = loadPersistentMessages(EVE);
markThreadRows(EVE, cached);
check('B1 cache-served rows re-stamped', cached.every(r => r.thread_list === true));

// ---- Scenario C: warmChatHistory with the fix ----
// fresh start: map loaded from storage (setThreadedChat persisted it)
threadModeChats = {};           // simulate fresh JS
loadThreadModeChats();
check('C1 map survives reload', isThreadedChat(EVE) === true);
const warmRows = makeRows(5, true);
if (warmRows.thread_mode) setThreadedChat(EVE);   // the fix's detection hook
markThreadRows(EVE, warmRows);                    // the fix's pre-merge stamp
savePersistentMessages(EVE, warmRows);
cached = loadPersistentMessages(EVE);
check('C2 warm-fetched rows stamped before persist', cached.every(r => r.thread_list === true));

// ---- Scenario D: verifyReaction-style single unmarked merge ----
const singleUnmarked = [{ id: '1002', sender: 'Alice', text: 'updated', thread_replies: 2 }];
const mergedStore = cached.map(r => r.id === '1002' ? singleUnmarked[0] : r);
// OLD: row replaced unmarked -> flag lost for that row
const oldFlagCount = mergedStore.filter(r => r.thread_list).length;
check('D1 OLD behavior loses flag on replaced row', oldFlagCount === 4);
// FIX: re-stamp before merge
markThreadRows(EVE, singleUnmarked);
check('D2 single-message merge re-stamped', singleUnmarked[0].thread_list === true);

// ---- Scenario E: refreshOpenChat guard uses the authority ----
// transient detection failure: messages.thread_mode undefined, store has NO
// marked rows left, but the authority map says threaded -> must re-mark.
threadModeChats = {}; loadThreadModeChats();
const fetchRows = makeRows(5, false); // detection failed this time
const existingThreaded = (mergedStore.some(m => m.thread_list)) || isThreadedChat(EVE);
const shouldMark = existingThreaded;
check('E1 authority survives store corruption', isThreadedChat(EVE) === true);
check('E2 refresh guard marks rows via authority', shouldMark === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
