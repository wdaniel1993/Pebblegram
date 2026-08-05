var MessageKeys = require('message_keys');
var pgjsBackend = require('./pgjs/backend');
var pebblegramVoice = require('./pebblegram-voice');

var DEBUG_LOGS = false;
var TELEGRAM_SETTINGS_PAGE_URL = 'https://tombolger.github.io/Pebblegram/pgjs/config.html';
var MAX_ROWS = 20;
var MAX_SEND_QUEUE = 80;
var MAX_CACHED_CHATS = 12;
var INITIAL_MESSAGE_ROWS = 9;
var OLDER_MESSAGE_ROWS = 7;
var NEWER_MESSAGE_ROWS = 7;
var MESSAGE_PAGE_FETCH_ROWS = 80;
var PHONE_MESSAGE_CACHE_ROWS = 600;
var MAX_MESSAGE_ROWS = 9;
var MESSAGE_EDGE_BUFFER_ROWS = 4;
var MAX_MESSAGE_TEXT = 460;
var MAX_CONTEXT_VIEW_TEXT = 1200;
var MESSAGE_WINDOW_BUDGET = 5400;
var IMAGE_SIZE = 120;
var IMAGE_WIDTH = 130;
var IMAGE_COLORS = 64;
var IMAGE_MAX_BYTES = 10000;
var IMAGE_MAX_PIXELS = 36000;
var IMAGE_CHUNK_SIZE = 500;
var AVATAR_SIZE = 28;
var AVATAR_COLORS = 16;
var AVATAR_MAX_BYTES = 3000;
var AVATAR_CHUNK_SIZE = 500;
var AVATAR_ROWS = MAX_ROWS;
var VOICE_DOWNLOAD_TIMEOUT_MS = 60000;
var VOICE_DECODE_TIMEOUT_MS = 15000;
// 8kHz 16-bit = 16KB/s; default chunk = 50ms of audio (800 bytes).
// Keep the value in sync with pebblegram-voice.js DEFAULT_VOICE_CHUNK_BYTES.
var VOICE_CHUNK_BYTES = 800;
var PREFETCH_CHAT_COUNT = 4;
var sendQueue = [];
var sending = false;
var messageStore = {};
var messageStoreNewest = {};
var messageHistoryStore = {};
var oldestComplete = {};
var newestComplete = {};
var prefetching = {};
var pagePrefetching = {};
var chatCacheOrder = [];
var pgjs = null;
var currentChatId = null;
var currentChatSignature = '';
var currentThreadId = null;
var chatLoadPromise = null;
var messageLoadPromises = {};
var newerLoadPromises = {};
var threadLoadPromises = {};
var updateRefreshTimer = null;
var updatesStarted = false;
var connectionKeepaliveTimer = null;
var chatListStale = false;
var avatarChats = [];
var avatarIndex = 0;
var avatarTimer = null;
var imageTransferSeq = 0;
var avatarTransferSeq = 0;
var imageRequestSeq = 0;
var imageTransferActive = false;
var voiceTransferSeq = 0;
var voiceRequestSeq = 0;
var voiceTransferActive = false;
var cancelledVoiceTransferSeq = 0;
var messageStreamSeq = 0;
var messageStreamTimer = null;
var topPrefetchSeq = 0;
var sendFailureDelay = 250;
var cancelledImageTransferSeq = 0;
var watchReady = false;
var phonePrewarmStarted = false;
var postFirstPaintStarted = false;
var postFirstPaintTimer = null;
var deferredStartupChats = null;
var launchStartedAt = Date.now();
var IMAGE_PREPARE_TIMEOUT_MS = 25000;
var MESSAGE_FETCH_TIMEOUT_MS = 25000;
var MESSAGE_CACHE_ORDER_KEY = 'pebblegram.messageCache.v4.order';
var MESSAGE_CACHE_PREFIX = 'pebblegram.messageCache.v4.';

function getSetting(name, fallback) {
  var value = localStorage.getItem(name);
  return value === null || value === '' ? fallback : value;
}

function cannedReplies() {
  return getSetting('cannedReplies', 'Yes|No|On my way|Call you later|Thanks');
}

function settingsPageUrl() {
  return activePgjs().settingsPageUrl(TELEGRAM_SETTINGS_PAGE_URL);
}

function activePgjs() {
  if (!pgjs) {
    pgjs = pgjsBackend.create({
      cannedReplies: cannedReplies,
      status: status
    });
  }
  return pgjs;
}

function wakePhoneBackend() {
  withTimeout(activePgjs().ready(), 'wake timed out', 10000).catch(function(err) {
    debugLog('Phone wake failed: ' + (err && err.message ? err.message : err));
  });
}

function configureForPlatform() {
  var info = null;
  try {
    info = Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
  } catch (e) {
    info = null;
  }
  if (info && info.platform === 'emery') {
    INITIAL_MESSAGE_ROWS = 9;
    OLDER_MESSAGE_ROWS = 7;
    NEWER_MESSAGE_ROWS = 7;
    MAX_MESSAGE_ROWS = 9;
    MAX_MESSAGE_TEXT = 460;
    MAX_CONTEXT_VIEW_TEXT = 1200;
    MESSAGE_WINDOW_BUDGET = 5400;
    IMAGE_SIZE = 198;
    IMAGE_WIDTH = 198;
    IMAGE_MAX_BYTES = 40000;
    IMAGE_MAX_PIXELS = 56000;
    IMAGE_CHUNK_SIZE = 500;
  } else if (info && info.platform === 'gabbro') {
    INITIAL_MESSAGE_ROWS = 9;
    OLDER_MESSAGE_ROWS = 7;
    NEWER_MESSAGE_ROWS = 7;
    MAX_MESSAGE_ROWS = 9;
    MAX_MESSAGE_TEXT = 460;
    MAX_CONTEXT_VIEW_TEXT = 1200;
    MESSAGE_WINDOW_BUDGET = 5400;
    IMAGE_SIZE = 144;
    IMAGE_WIDTH = 152;
    IMAGE_MAX_BYTES = 23000;
    IMAGE_MAX_PIXELS = 40000;
    IMAGE_CHUNK_SIZE = 500;
  } else if (info && info.platform === 'diorite') {
    IMAGE_SIZE = 108;
    IMAGE_WIDTH = 112;
    IMAGE_COLORS = 4;
    IMAGE_MAX_BYTES = 8500;
    IMAGE_MAX_PIXELS = 24000;
    AVATAR_SIZE = 24;
    AVATAR_COLORS = 4;
    AVATAR_MAX_BYTES = 2200;
  } else if (info && info.platform === 'basalt') {
    IMAGE_SIZE = 108;
    IMAGE_WIDTH = 116;
    IMAGE_COLORS = 16;
    IMAGE_MAX_BYTES = 9500;
    IMAGE_MAX_PIXELS = 27000;
  }
}

function debugLog(message) {
  if (DEBUG_LOGS) {
    console.log(message);
  }
}

function logDuration(label, startedAt) {
  if (DEBUG_LOGS) {
    console.log(label + ' took ' + (Date.now() - startedAt) + 'ms');
  }
}

function logLaunch(label) {
  if (DEBUG_LOGS) {
    console.log('launch +' + (Date.now() - launchStartedAt) + 'ms ' + label);
  }
}

function timed(label, promise) {
  if (!DEBUG_LOGS) {
    return promise;
  }
  var startedAt = Date.now();
  return promise.then(function(value) {
    logDuration(label, startedAt);
    return value;
  }, function(err) {
    logDuration(label + ' failed', startedAt);
    throw err;
  });
}

function withTimeout(promise, label, timeoutMs) {
  var timer = null;
  var timeoutPromise = new Promise(function(resolve, reject) {
    timer = setTimeout(function() {
      reject(new Error(label));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).then(function(value) {
    clearTimeout(timer);
    return value;
  }, function(err) {
    clearTimeout(timer);
    throw err;
  });
}

function prewarmPhoneBackend() {
  if (phonePrewarmStarted) {
    return;
  }
  phonePrewarmStarted = true;
  logLaunch('telegram prewarm start');
  timed('telegram prewarm', activePgjs().ready()).then(function() {
    logLaunch('telegram prewarm ready');
  }).catch(function(err) {
    phonePrewarmStarted = false;
    debugLog('Phone prewarm failed: ' + (err && err.message ? err.message : err));
  });
}

prewarmPhoneBackend();

// AppMessage delivery is serialized. Older phones can drop messages if image
// chunks and rows are pushed in parallel.
function payloadType(payload) {
  return payload && payload[MessageKeys.Type];
}

function isLowPriorityPayload(payload) {
  var type = payloadType(payload);
  return type === 'status' || isAvatarTransferPayload(payload);
}

function trimSendQueueFor(payload) {
  var start = sending ? 1 : 0;
  var index;
  while (sendQueue.length >= MAX_SEND_QUEUE) {
    index = -1;
    for (var i = start; i < sendQueue.length; i += 1) {
      if (isObsoleteQueuedPayload(sendQueue[i]) || isLowPriorityPayload(sendQueue[i].payload)) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      sendQueue.splice(index, 1);
    } else if (isLowPriorityPayload(payload)) {
      return false;
    } else {
      return true;
    }
  }
  return true;
}

function sendToWatch(payload) {
  if (!trimSendQueueFor(payload)) {
    return;
  }
  sendQueue.push({payload: payload, queuedAt: DEBUG_LOGS ? Date.now() : 0});
  flushQueue();
}

function isAvatarTransferPayload(payload) {
  var type = payloadType(payload);
  return type === 'avatar_start' || type === 'avatar' || type === 'avatar_done';
}

function isImageTransferPayload(payload) {
  var type = payloadType(payload);
  return type === 'image_start' || type === 'image' || type === 'image_done' ||
    type === 'image_error' || type === 'image_status';
}

function isVoiceTransferPayload(payload) {
  var type = payloadType(payload);
  return type === 'voice_start' || type === 'voice' || type === 'voice_done' ||
    type === 'voice_error' || type === 'voice_status';
}

function isMessageTransferPayload(payload) {
  var type = payloadType(payload);
  return type === 'messages_start' || type === 'message' || type === 'message_prepend' || type === 'message_append' || type === 'messages_done';
}

function pruneQueuedPayloads(match) {
  var write = 0;
  for (var read = 0; read < sendQueue.length; read += 1) {
    if ((read === 0 && sending) || !match(sendQueue[read].payload)) {
      sendQueue[write] = sendQueue[read];
      write += 1;
    }
  }
  sendQueue.length = write;
}

function cancelQueuedMessageTransfers() {
  messageStreamSeq += 1;
  if (messageStreamTimer) {
    clearTimeout(messageStreamTimer);
    messageStreamTimer = null;
  }
  pruneQueuedPayloads(isMessageTransferPayload);
}

function cancelQueuedImageTransfers() {
  imageRequestSeq += 1;
  cancelledImageTransferSeq = imageTransferSeq;
  imageTransferActive = false;
  if (pgjs && typeof pgjs.cancelImageRequests === 'function') {
    pgjs.cancelImageRequests();
  }
  pruneQueuedPayloads(isImageTransferPayload);
}

function cancelQueuedVoiceTransfers() {
  voiceRequestSeq += 1;
  cancelledVoiceTransferSeq = voiceTransferSeq;
  voiceTransferActive = false;
  if (pgjs && typeof pgjs.cancelVoiceRequests === 'function') {
    pgjs.cancelVoiceRequests();
  }
  pruneQueuedPayloads(isVoiceTransferPayload);
}

// Cancel every in-flight image + voice transfer. Used on chat change
// and chat teardown so a stale stream from the previous chat can't
// land in the new one.
function cancelAllQueuedTransfers() {
  cancelQueuedImageTransfers();
  cancelQueuedVoiceTransfers();
}

function transferId(payload) {
  if (!payload) {
    return 0;
  }
  if (isVoiceTransferPayload(payload)) {
    return payload[MessageKeys.VoiceTransferId] || 0;
  }
  return payload[MessageKeys.ImageTransferId] || 0;
}

function isObsoleteQueuedPayload(entry) {
  var payload = entry && entry.payload;
  var id = transferId(payload);
  if (!payload) {
    return true;
  }
  if (isImageTransferPayload(payload)) {
    return id > 0 && id <= cancelledImageTransferSeq;
  }
  if (isVoiceTransferPayload(payload)) {
    return id > 0 && id <= cancelledVoiceTransferSeq;
  }
  if (isMessageTransferPayload(payload)) {
    return id > 0 && id < messageStreamSeq;
  }
  return false;
}

function cancelQueuedAvatarTransfers() {
  if (avatarTimer) {
    clearTimeout(avatarTimer);
    avatarTimer = null;
  }
  pruneQueuedPayloads(isAvatarTransferPayload);
}

function flushQueue() {
  while (sendQueue.length > 0 && isObsoleteQueuedPayload(sendQueue[0])) {
    sendQueue.shift();
  }
  if (sending || sendQueue.length === 0) {
    return;
  }
  sending = true;
  var entry = sendQueue[0];
  Pebble.sendAppMessage(entry.payload, function() {
    sendFailureDelay = 250;
    if (DEBUG_LOGS && (entry.payload[MessageKeys.Type] === 'image_done' ||
        entry.payload[MessageKeys.Type] === 'chats_done' ||
        entry.payload[MessageKeys.Type] === 'messages_done' ||
        entry.payload[MessageKeys.Type] === 'voice_done')) {
      logDuration('AppMessage ' + entry.payload[MessageKeys.Type] + ' queue', entry.queuedAt);
    }
    if (entry.payload[MessageKeys.Type] === 'image_done' ||
        entry.payload[MessageKeys.Type] === 'image_error') {
      imageTransferActive = false;
    }
    if (entry.payload[MessageKeys.Type] === 'voice_done' ||
        entry.payload[MessageKeys.Type] === 'voice_error') {
      voiceTransferActive = false;
    }
    sendQueue.shift();
    sending = false;
    flushQueue();
  }, function(error) {
    entry.attempts = (entry.attempts || 0) + 1;
    sending = false;
    debugLog('sendAppMessage failed: ' + JSON.stringify(error));
    if (isObsoleteQueuedPayload(entry) || (entry.attempts >= 6 && (isImageTransferPayload(entry.payload) || isAvatarTransferPayload(entry.payload) || isVoiceTransferPayload(entry.payload)))) {
      if (sendQueue[0] === entry) {
        sendQueue.shift();
      }
      if (isImageTransferPayload(entry.payload)) {
        imageTransferActive = false;
      }
      if (isVoiceTransferPayload(entry.payload)) {
        voiceTransferActive = false;
      }
      sendFailureDelay = 250;
      flushQueue();
      return;
    }
    setTimeout(flushQueue, sendFailureDelay);
    sendFailureDelay = Math.min(5000, Math.floor(sendFailureDelay * 1.6));
  });
}

function status(text) {
  if (!watchReady) {
    debugLog('Status before watch ready: ' + text);
    return;
  }
  var payload = {};
  payload[MessageKeys.Type] = 'status';
  payload[MessageKeys.Status] = text;
  sendToWatch(payload);
}

function sendSettings() {
  var payload = {};
  payload[MessageKeys.Type] = 'settings';
  payload[MessageKeys.CannedReplies] = cannedReplies();
  sendToWatch(payload);
}

function error(text) {
  var payload = {};
  payload[MessageKeys.Type] = 'error';
  payload[MessageKeys.Error] = text;
  sendToWatch(payload);
}

function done(kind, count, transferId, flag) {
  var payload = {};
  payload[MessageKeys.Type] = kind;
  payload[MessageKeys.Count] = count;
  if (transferId) {
    payload[MessageKeys.ImageTransferId] = transferId;
  }
  if (flag) {
    payload[MessageKeys.Text] = flag;
  }
  sendToWatch(payload);
}

function promiseError(prefix, err) {
  var message = err && err.message ? err.message : String(err || 'unknown error');
  debugLog(prefix + ': ' + message);
  error(prefix + ': ' + message);
}

var WATCH_EMOJI_ALIASES = [
  // Only aliases for glyphs the PebbleOS emoji font cannot render (checked
  // against EMOJI_*.pbf from the coredevices/PebbleOS repo). Everything else
  // renders as a real glyph — see WATCH_SUPPORTED_EMOJI below, which is
  // generated from the same font.
  ['\u00a9\ufe0f', ':copyright:'],
  ['\u00a9', ':copyright:'],
  ['\u00ae\ufe0f', ':registered:'],
  ['\u00ae', ':registered:'],
  ['\u2122\ufe0f', ':tm:'],
  ['\u2122', ':tm:']
];

var WATCH_SUPPORTED_EMOJI = [
  '\u2192', '\u231a', '\u231b', '\u2328', '\u23cf', '\u23e9',
  '\u23ea', '\u23eb', '\u23ec', '\u23ed', '\u23ee', '\u23ef',
  '\u23f0', '\u23f1', '\u23f2', '\u23f3', '\u23f8', '\u23f9',
  '\u23fa', '\u25aa', '\u25ab', '\u25b6', '\u25ba', '\u25c0',
  '\u25fb', '\u25fc', '\u25fd', '\u25fe', '\u2600', '\u2601',
  '\u2602', '\u2603', '\u2604', '\u2605', '\u260e', '\u2611',
  '\u2614', '\u2615', '\u2618', '\u261d', '\u2620', '\u2622',
  '\u2623', '\u2626', '\u262a', '\u262e', '\u262f', '\u2638',
  '\u2639', '\u263a', '\u2640', '\u2642', '\u2648', '\u2649',
  '\u264a', '\u264b', '\u264c', '\u264d', '\u264e', '\u264f',
  '\u2650', '\u2651', '\u2652', '\u2653', '\u265f', '\u2660',
  '\u2663', '\u2665', '\u2666', '\u2668', '\u267b', '\u267e',
  '\u267f', '\u2692', '\u2693', '\u2694', '\u2695', '\u2696',
  '\u2697', '\u2699', '\u269b', '\u269c', '\u26a0', '\u26a1',
  '\u26a7', '\u26aa', '\u26ab', '\u26b0', '\u26b1', '\u26bd',
  '\u26be', '\u26c4', '\u26c5', '\u26c8', '\u26ce', '\u26cf',
  '\u26d1', '\u26d3', '\u26d4', '\u26e9', '\u26ea', '\u26f0',
  '\u26f1', '\u26f2', '\u26f3', '\u26f4', '\u26f5', '\u26f7',
  '\u26f8', '\u26f9', '\u26fa', '\u26fd', '\u2702', '\u2705',
  '\u2708', '\u2709', '\u270a', '\u270b', '\u270c', '\u270d',
  '\u270f', '\u2712', '\u2714', '\u2716', '\u271d', '\u2721',
  '\u2728', '\u2733', '\u2734', '\u2744', '\u2747', '\u274c',
  '\u274e', '\u2753', '\u2754', '\u2755', '\u2757', '\u2763',
  '\u2764', '\u2795', '\u2796', '\u2797', '\u27a1', '\u27b0',
  '\u27bf', '\u2b05', '\u2b06', '\u2b07', '\u2b1b', '\u2b1c',
  '\u2b50', '\u2b55', '\ud83c\udd70', '\ud83c\udd71', '\ud83c\udd7e', '\ud83c\udd7f',
  '\ud83c\udd8e', '\ud83c\udd91', '\ud83c\udd92', '\ud83c\udd93', '\ud83c\udd94', '\ud83c\udd95',
  '\ud83c\udd96', '\ud83c\udd97', '\ud83c\udd98', '\ud83c\udd99', '\ud83c\udd9a', '\ud83c\udde6',
  '\ud83c\udde7', '\ud83c\udde8', '\ud83c\udde9', '\ud83c\uddea', '\ud83c\uddeb', '\ud83c\uddec',
  '\ud83c\udded', '\ud83c\uddee', '\ud83c\uddef', '\ud83c\uddf0', '\ud83c\uddf1', '\ud83c\uddf2',
  '\ud83c\uddf3', '\ud83c\uddf4', '\ud83c\uddf5', '\ud83c\uddf6', '\ud83c\uddf7', '\ud83c\uddf8',
  '\ud83c\uddf9', '\ud83c\uddfa', '\ud83c\uddfb', '\ud83c\uddfc', '\ud83c\uddfd', '\ud83c\uddfe',
  '\ud83c\uddff', '\ud83c\ude01', '\ud83c\ude02', '\ud83c\ude1a', '\ud83c\ude2f', '\ud83c\ude32',
  '\ud83c\ude33', '\ud83c\ude34', '\ud83c\ude35', '\ud83c\ude36', '\ud83c\ude37', '\ud83c\ude38',
  '\ud83c\ude39', '\ud83c\ude3a', '\ud83c\ude50', '\ud83c\ude51', '\ud83c\udf00', '\ud83c\udf01',
  '\ud83c\udf02', '\ud83c\udf03', '\ud83c\udf04', '\ud83c\udf05', '\ud83c\udf06', '\ud83c\udf07',
  '\ud83c\udf08', '\ud83c\udf09', '\ud83c\udf0a', '\ud83c\udf0b', '\ud83c\udf0c', '\ud83c\udf0d',
  '\ud83c\udf0e', '\ud83c\udf0f', '\ud83c\udf10', '\ud83c\udf11', '\ud83c\udf12', '\ud83c\udf13',
  '\ud83c\udf14', '\ud83c\udf15', '\ud83c\udf16', '\ud83c\udf17', '\ud83c\udf18', '\ud83c\udf19',
  '\ud83c\udf1a', '\ud83c\udf1b', '\ud83c\udf1c', '\ud83c\udf1d', '\ud83c\udf1e', '\ud83c\udf1f',
  '\ud83c\udf20', '\ud83c\udf21', '\ud83c\udf24', '\ud83c\udf25', '\ud83c\udf26', '\ud83c\udf27',
  '\ud83c\udf28', '\ud83c\udf29', '\ud83c\udf2a', '\ud83c\udf2b', '\ud83c\udf2c', '\ud83c\udf2d',
  '\ud83c\udf2e', '\ud83c\udf2f', '\ud83c\udf30', '\ud83c\udf31', '\ud83c\udf32', '\ud83c\udf33',
  '\ud83c\udf34', '\ud83c\udf35', '\ud83c\udf36', '\ud83c\udf37', '\ud83c\udf38', '\ud83c\udf39',
  '\ud83c\udf3a', '\ud83c\udf3b', '\ud83c\udf3c', '\ud83c\udf3d', '\ud83c\udf3e', '\ud83c\udf3f',
  '\ud83c\udf40', '\ud83c\udf41', '\ud83c\udf42', '\ud83c\udf43', '\ud83c\udf44', '\ud83c\udf45',
  '\ud83c\udf46', '\ud83c\udf47', '\ud83c\udf48', '\ud83c\udf49', '\ud83c\udf4a', '\ud83c\udf4b',
  '\ud83c\udf4c', '\ud83c\udf4d', '\ud83c\udf4e', '\ud83c\udf4f', '\ud83c\udf50', '\ud83c\udf51',
  '\ud83c\udf52', '\ud83c\udf53', '\ud83c\udf54', '\ud83c\udf55', '\ud83c\udf56', '\ud83c\udf57',
  '\ud83c\udf58', '\ud83c\udf59', '\ud83c\udf5a', '\ud83c\udf5b', '\ud83c\udf5c', '\ud83c\udf5d',
  '\ud83c\udf5e', '\ud83c\udf5f', '\ud83c\udf60', '\ud83c\udf61', '\ud83c\udf62', '\ud83c\udf63',
  '\ud83c\udf64', '\ud83c\udf65', '\ud83c\udf66', '\ud83c\udf67', '\ud83c\udf68', '\ud83c\udf69',
  '\ud83c\udf6a', '\ud83c\udf6b', '\ud83c\udf6c', '\ud83c\udf6d', '\ud83c\udf6e', '\ud83c\udf6f',
  '\ud83c\udf70', '\ud83c\udf71', '\ud83c\udf72', '\ud83c\udf73', '\ud83c\udf74', '\ud83c\udf75',
  '\ud83c\udf76', '\ud83c\udf77', '\ud83c\udf78', '\ud83c\udf79', '\ud83c\udf7a', '\ud83c\udf7b',
  '\ud83c\udf7c', '\ud83c\udf7d', '\ud83c\udf7e', '\ud83c\udf7f', '\ud83c\udf80', '\ud83c\udf81',
  '\ud83c\udf82', '\ud83c\udf83', '\ud83c\udf84', '\ud83c\udf85', '\ud83c\udf86', '\ud83c\udf87',
  '\ud83c\udf88', '\ud83c\udf89', '\ud83c\udf8a', '\ud83c\udf8b', '\ud83c\udf8c', '\ud83c\udf8d',
  '\ud83c\udf8e', '\ud83c\udf8f', '\ud83c\udf90', '\ud83c\udf91', '\ud83c\udf92', '\ud83c\udf93',
  '\ud83c\udf96', '\ud83c\udf97', '\ud83c\udf99', '\ud83c\udf9a', '\ud83c\udf9b', '\ud83c\udf9e',
  '\ud83c\udf9f', '\ud83c\udfa0', '\ud83c\udfa1', '\ud83c\udfa2', '\ud83c\udfa3', '\ud83c\udfa4',
  '\ud83c\udfa5', '\ud83c\udfa6', '\ud83c\udfa7', '\ud83c\udfa8', '\ud83c\udfa9', '\ud83c\udfaa',
  '\ud83c\udfab', '\ud83c\udfac', '\ud83c\udfad', '\ud83c\udfae', '\ud83c\udfaf', '\ud83c\udfb0',
  '\ud83c\udfb1', '\ud83c\udfb2', '\ud83c\udfb3', '\ud83c\udfb4', '\ud83c\udfb5', '\ud83c\udfb6',
  '\ud83c\udfb7', '\ud83c\udfb8', '\ud83c\udfb9', '\ud83c\udfba', '\ud83c\udfbb', '\ud83c\udfbc',
  '\ud83c\udfbd', '\ud83c\udfbe', '\ud83c\udfbf', '\ud83c\udfc0', '\ud83c\udfc1', '\ud83c\udfc2',
  '\ud83c\udfc3', '\ud83c\udfc4', '\ud83c\udfc5', '\ud83c\udfc6', '\ud83c\udfc7', '\ud83c\udfc8',
  '\ud83c\udfc9', '\ud83c\udfca', '\ud83c\udfcb', '\ud83c\udfcc', '\ud83c\udfcd', '\ud83c\udfce',
  '\ud83c\udfcf', '\ud83c\udfd0', '\ud83c\udfd1', '\ud83c\udfd2', '\ud83c\udfd3', '\ud83c\udfd4',
  '\ud83c\udfd5', '\ud83c\udfd6', '\ud83c\udfd7', '\ud83c\udfd8', '\ud83c\udfd9', '\ud83c\udfda',
  '\ud83c\udfdb', '\ud83c\udfdc', '\ud83c\udfdd', '\ud83c\udfde', '\ud83c\udfdf', '\ud83c\udfe0',
  '\ud83c\udfe1', '\ud83c\udfe2', '\ud83c\udfe3', '\ud83c\udfe4', '\ud83c\udfe5', '\ud83c\udfe6',
  '\ud83c\udfe7', '\ud83c\udfe8', '\ud83c\udfe9', '\ud83c\udfea', '\ud83c\udfeb', '\ud83c\udfec',
  '\ud83c\udfed', '\ud83c\udfee', '\ud83c\udfef', '\ud83c\udff0', '\ud83c\udff3', '\ud83c\udff4',
  '\ud83c\udff5', '\ud83c\udff7', '\ud83c\udff8', '\ud83c\udff9', '\ud83c\udffa', '\ud83c\udffb',
  '\ud83c\udffc', '\ud83c\udffd', '\ud83c\udffe', '\ud83c\udfff', '\ud83d\udc00', '\ud83d\udc01',
  '\ud83d\udc02', '\ud83d\udc03', '\ud83d\udc04', '\ud83d\udc05', '\ud83d\udc06', '\ud83d\udc07',
  '\ud83d\udc08', '\ud83d\udc09', '\ud83d\udc0a', '\ud83d\udc0b', '\ud83d\udc0c', '\ud83d\udc0d',
  '\ud83d\udc0e', '\ud83d\udc0f', '\ud83d\udc10', '\ud83d\udc11', '\ud83d\udc12', '\ud83d\udc13',
  '\ud83d\udc14', '\ud83d\udc15', '\ud83d\udc16', '\ud83d\udc17', '\ud83d\udc18', '\ud83d\udc19',
  '\ud83d\udc1a', '\ud83d\udc1b', '\ud83d\udc1c', '\ud83d\udc1d', '\ud83d\udc1e', '\ud83d\udc1f',
  '\ud83d\udc20', '\ud83d\udc21', '\ud83d\udc22', '\ud83d\udc23', '\ud83d\udc24', '\ud83d\udc25',
  '\ud83d\udc26', '\ud83d\udc27', '\ud83d\udc28', '\ud83d\udc29', '\ud83d\udc2a', '\ud83d\udc2b',
  '\ud83d\udc2c', '\ud83d\udc2d', '\ud83d\udc2e', '\ud83d\udc2f', '\ud83d\udc30', '\ud83d\udc31',
  '\ud83d\udc32', '\ud83d\udc33', '\ud83d\udc34', '\ud83d\udc35', '\ud83d\udc36', '\ud83d\udc37',
  '\ud83d\udc38', '\ud83d\udc39', '\ud83d\udc3a', '\ud83d\udc3b', '\ud83d\udc3c', '\ud83d\udc3d',
  '\ud83d\udc3e', '\ud83d\udc3f', '\ud83d\udc40', '\ud83d\udc41', '\ud83d\udc42', '\ud83d\udc43',
  '\ud83d\udc44', '\ud83d\udc45', '\ud83d\udc46', '\ud83d\udc47', '\ud83d\udc48', '\ud83d\udc49',
  '\ud83d\udc4a', '\ud83d\udc4b', '\ud83d\udc4c', '\ud83d\udc4d', '\ud83d\udc4e', '\ud83d\udc4f',
  '\ud83d\udc50', '\ud83d\udc51', '\ud83d\udc52', '\ud83d\udc53', '\ud83d\udc54', '\ud83d\udc55',
  '\ud83d\udc56', '\ud83d\udc57', '\ud83d\udc58', '\ud83d\udc59', '\ud83d\udc5a', '\ud83d\udc5b',
  '\ud83d\udc5c', '\ud83d\udc5d', '\ud83d\udc5e', '\ud83d\udc5f', '\ud83d\udc60', '\ud83d\udc61',
  '\ud83d\udc62', '\ud83d\udc63', '\ud83d\udc64', '\ud83d\udc65', '\ud83d\udc66', '\ud83d\udc67',
  '\ud83d\udc68', '\ud83d\udc69', '\ud83d\udc6a', '\ud83d\udc6b', '\ud83d\udc6c', '\ud83d\udc6d',
  '\ud83d\udc6e', '\ud83d\udc6f', '\ud83d\udc70', '\ud83d\udc71', '\ud83d\udc72', '\ud83d\udc73',
  '\ud83d\udc74', '\ud83d\udc75', '\ud83d\udc76', '\ud83d\udc77', '\ud83d\udc78', '\ud83d\udc79',
  '\ud83d\udc7a', '\ud83d\udc7b', '\ud83d\udc7c', '\ud83d\udc7d', '\ud83d\udc7e', '\ud83d\udc7f',
  '\ud83d\udc80', '\ud83d\udc81', '\ud83d\udc82', '\ud83d\udc83', '\ud83d\udc84', '\ud83d\udc85',
  '\ud83d\udc86', '\ud83d\udc87', '\ud83d\udc88', '\ud83d\udc89', '\ud83d\udc8a', '\ud83d\udc8b',
  '\ud83d\udc8c', '\ud83d\udc8d', '\ud83d\udc8e', '\ud83d\udc8f', '\ud83d\udc90', '\ud83d\udc91',
  '\ud83d\udc92', '\ud83d\udc93', '\ud83d\udc94', '\ud83d\udc95', '\ud83d\udc96', '\ud83d\udc97',
  '\ud83d\udc98', '\ud83d\udc99', '\ud83d\udc9a', '\ud83d\udc9b', '\ud83d\udc9c', '\ud83d\udc9d',
  '\ud83d\udc9e', '\ud83d\udc9f', '\ud83d\udca0', '\ud83d\udca1', '\ud83d\udca2', '\ud83d\udca3',
  '\ud83d\udca4', '\ud83d\udca5', '\ud83d\udca6', '\ud83d\udca7', '\ud83d\udca8', '\ud83d\udca9',
  '\ud83d\udcaa', '\ud83d\udcab', '\ud83d\udcac', '\ud83d\udcad', '\ud83d\udcae', '\ud83d\udcaf',
  '\ud83d\udcb0', '\ud83d\udcb1', '\ud83d\udcb2', '\ud83d\udcb3', '\ud83d\udcb4', '\ud83d\udcb5',
  '\ud83d\udcb6', '\ud83d\udcb7', '\ud83d\udcb8', '\ud83d\udcb9', '\ud83d\udcba', '\ud83d\udcbb',
  '\ud83d\udcbc', '\ud83d\udcbd', '\ud83d\udcbe', '\ud83d\udcbf', '\ud83d\udcc0', '\ud83d\udcc1',
  '\ud83d\udcc2', '\ud83d\udcc3', '\ud83d\udcc4', '\ud83d\udcc5', '\ud83d\udcc6', '\ud83d\udcc7',
  '\ud83d\udcc8', '\ud83d\udcc9', '\ud83d\udcca', '\ud83d\udccb', '\ud83d\udccc', '\ud83d\udccd',
  '\ud83d\udcce', '\ud83d\udccf', '\ud83d\udcd0', '\ud83d\udcd1', '\ud83d\udcd2', '\ud83d\udcd3',
  '\ud83d\udcd4', '\ud83d\udcd5', '\ud83d\udcd6', '\ud83d\udcd7', '\ud83d\udcd8', '\ud83d\udcd9',
  '\ud83d\udcda', '\ud83d\udcdb', '\ud83d\udcdc', '\ud83d\udcdd', '\ud83d\udcde', '\ud83d\udcdf',
  '\ud83d\udce0', '\ud83d\udce1', '\ud83d\udce2', '\ud83d\udce3', '\ud83d\udce4', '\ud83d\udce5',
  '\ud83d\udce6', '\ud83d\udce7', '\ud83d\udce8', '\ud83d\udce9', '\ud83d\udcea', '\ud83d\udceb',
  '\ud83d\udcec', '\ud83d\udced', '\ud83d\udcee', '\ud83d\udcef', '\ud83d\udcf0', '\ud83d\udcf1',
  '\ud83d\udcf2', '\ud83d\udcf3', '\ud83d\udcf4', '\ud83d\udcf5', '\ud83d\udcf6', '\ud83d\udcf7',
  '\ud83d\udcf8', '\ud83d\udcf9', '\ud83d\udcfa', '\ud83d\udcfb', '\ud83d\udcfc', '\ud83d\udcfd',
  '\ud83d\udcff', '\ud83d\udd00', '\ud83d\udd01', '\ud83d\udd02', '\ud83d\udd03', '\ud83d\udd04',
  '\ud83d\udd05', '\ud83d\udd06', '\ud83d\udd07', '\ud83d\udd08', '\ud83d\udd09', '\ud83d\udd0a',
  '\ud83d\udd0b', '\ud83d\udd0c', '\ud83d\udd0d', '\ud83d\udd0e', '\ud83d\udd0f', '\ud83d\udd10',
  '\ud83d\udd11', '\ud83d\udd12', '\ud83d\udd13', '\ud83d\udd14', '\ud83d\udd15', '\ud83d\udd16',
  '\ud83d\udd17', '\ud83d\udd18', '\ud83d\udd19', '\ud83d\udd1a', '\ud83d\udd1b', '\ud83d\udd1c',
  '\ud83d\udd1d', '\ud83d\udd1e', '\ud83d\udd1f', '\ud83d\udd20', '\ud83d\udd21', '\ud83d\udd22',
  '\ud83d\udd23', '\ud83d\udd24', '\ud83d\udd25', '\ud83d\udd26', '\ud83d\udd27', '\ud83d\udd28',
  '\ud83d\udd29', '\ud83d\udd2a', '\ud83d\udd2b', '\ud83d\udd2c', '\ud83d\udd2d', '\ud83d\udd2e',
  '\ud83d\udd2f', '\ud83d\udd30', '\ud83d\udd31', '\ud83d\udd32', '\ud83d\udd33', '\ud83d\udd34',
  '\ud83d\udd35', '\ud83d\udd36', '\ud83d\udd37', '\ud83d\udd38', '\ud83d\udd39', '\ud83d\udd3a',
  '\ud83d\udd3b', '\ud83d\udd3c', '\ud83d\udd3d', '\ud83d\udd49', '\ud83d\udd4a', '\ud83d\udd4b',
  '\ud83d\udd4c', '\ud83d\udd4d', '\ud83d\udd4e', '\ud83d\udd50', '\ud83d\udd51', '\ud83d\udd52',
  '\ud83d\udd53', '\ud83d\udd54', '\ud83d\udd55', '\ud83d\udd56', '\ud83d\udd57', '\ud83d\udd58',
  '\ud83d\udd59', '\ud83d\udd5a', '\ud83d\udd5b', '\ud83d\udd5c', '\ud83d\udd5d', '\ud83d\udd5e',
  '\ud83d\udd5f', '\ud83d\udd60', '\ud83d\udd61', '\ud83d\udd62', '\ud83d\udd63', '\ud83d\udd64',
  '\ud83d\udd65', '\ud83d\udd66', '\ud83d\udd67', '\ud83d\udd6f', '\ud83d\udd70', '\ud83d\udd73',
  '\ud83d\udd74', '\ud83d\udd75', '\ud83d\udd76', '\ud83d\udd77', '\ud83d\udd78', '\ud83d\udd79',
  '\ud83d\udd7a', '\ud83d\udd87', '\ud83d\udd8a', '\ud83d\udd8b', '\ud83d\udd8c', '\ud83d\udd8d',
  '\ud83d\udd90', '\ud83d\udd95', '\ud83d\udd96', '\ud83d\udda4', '\ud83d\udda5', '\ud83d\udda8',
  '\ud83d\uddb1', '\ud83d\uddb2', '\ud83d\uddbc', '\ud83d\uddc2', '\ud83d\uddc3', '\ud83d\uddc4',
  '\ud83d\uddd1', '\ud83d\uddd2', '\ud83d\uddd3', '\ud83d\udddc', '\ud83d\udddd', '\ud83d\uddde',
  '\ud83d\udde1', '\ud83d\udde3', '\ud83d\udde8', '\ud83d\uddef', '\ud83d\uddf3', '\ud83d\uddfa',
  '\ud83d\uddfb', '\ud83d\uddfc', '\ud83d\uddfd', '\ud83d\uddfe', '\ud83d\uddff', '\ud83d\ude00',
  '\ud83d\ude01', '\ud83d\ude02', '\ud83d\ude03', '\ud83d\ude04', '\ud83d\ude05', '\ud83d\ude06',
  '\ud83d\ude07', '\ud83d\ude08', '\ud83d\ude09', '\ud83d\ude0a', '\ud83d\ude0b', '\ud83d\ude0c',
  '\ud83d\ude0d', '\ud83d\ude0e', '\ud83d\ude0f', '\ud83d\ude10', '\ud83d\ude11', '\ud83d\ude12',
  '\ud83d\ude13', '\ud83d\ude14', '\ud83d\ude15', '\ud83d\ude16', '\ud83d\ude17', '\ud83d\ude18',
  '\ud83d\ude19', '\ud83d\ude1a', '\ud83d\ude1b', '\ud83d\ude1c', '\ud83d\ude1d', '\ud83d\ude1e',
  '\ud83d\ude1f', '\ud83d\ude20', '\ud83d\ude21', '\ud83d\ude22', '\ud83d\ude23', '\ud83d\ude24',
  '\ud83d\ude25', '\ud83d\ude26', '\ud83d\ude27', '\ud83d\ude28', '\ud83d\ude29', '\ud83d\ude2a',
  '\ud83d\ude2b', '\ud83d\ude2c', '\ud83d\ude2d', '\ud83d\ude2e', '\ud83d\ude2f', '\ud83d\ude30',
  '\ud83d\ude31', '\ud83d\ude32', '\ud83d\ude33', '\ud83d\ude34', '\ud83d\ude35', '\ud83d\ude36',
  '\ud83d\ude37', '\ud83d\ude38', '\ud83d\ude39', '\ud83d\ude3a', '\ud83d\ude3b', '\ud83d\ude3c',
  '\ud83d\ude3d', '\ud83d\ude3e', '\ud83d\ude3f', '\ud83d\ude40', '\ud83d\ude41', '\ud83d\ude42',
  '\ud83d\ude43', '\ud83d\ude44', '\ud83d\ude45', '\ud83d\ude46', '\ud83d\ude47', '\ud83d\ude48',
  '\ud83d\ude49', '\ud83d\ude4a', '\ud83d\ude4b', '\ud83d\ude4c', '\ud83d\ude4d', '\ud83d\ude4e',
  '\ud83d\ude4f', '\ud83d\ude80', '\ud83d\ude81', '\ud83d\ude82', '\ud83d\ude83', '\ud83d\ude84',
  '\ud83d\ude85', '\ud83d\ude86', '\ud83d\ude87', '\ud83d\ude88', '\ud83d\ude89', '\ud83d\ude8a',
  '\ud83d\ude8b', '\ud83d\ude8c', '\ud83d\ude8d', '\ud83d\ude8e', '\ud83d\ude8f', '\ud83d\ude90',
  '\ud83d\ude91', '\ud83d\ude92', '\ud83d\ude93', '\ud83d\ude94', '\ud83d\ude95', '\ud83d\ude96',
  '\ud83d\ude97', '\ud83d\ude98', '\ud83d\ude99', '\ud83d\ude9a', '\ud83d\ude9b', '\ud83d\ude9c',
  '\ud83d\ude9d', '\ud83d\ude9e', '\ud83d\ude9f', '\ud83d\udea0', '\ud83d\udea1', '\ud83d\udea2',
  '\ud83d\udea3', '\ud83d\udea4', '\ud83d\udea5', '\ud83d\udea6', '\ud83d\udea7', '\ud83d\udea8',
  '\ud83d\udea9', '\ud83d\udeaa', '\ud83d\udeab', '\ud83d\udeac', '\ud83d\udead', '\ud83d\udeae',
  '\ud83d\udeaf', '\ud83d\udeb0', '\ud83d\udeb1', '\ud83d\udeb2', '\ud83d\udeb3', '\ud83d\udeb4',
  '\ud83d\udeb5', '\ud83d\udeb6', '\ud83d\udeb7', '\ud83d\udeb8', '\ud83d\udeb9', '\ud83d\udeba',
  '\ud83d\udebb', '\ud83d\udebc', '\ud83d\udebd', '\ud83d\udebe', '\ud83d\udebf', '\ud83d\udec0',
  '\ud83d\udec1', '\ud83d\udec2', '\ud83d\udec3', '\ud83d\udec4', '\ud83d\udec5', '\ud83d\udecb',
  '\ud83d\udecc', '\ud83d\udecd', '\ud83d\udece', '\ud83d\udecf', '\ud83d\uded0', '\ud83d\uded1',
  '\ud83d\uded2', '\ud83d\uded5', '\ud83d\uded6', '\ud83d\uded7', '\ud83d\udedc', '\ud83d\udedd',
  '\ud83d\udede', '\ud83d\udedf', '\ud83d\udee0', '\ud83d\udee1', '\ud83d\udee2', '\ud83d\udee3',
  '\ud83d\udee4', '\ud83d\udee5', '\ud83d\udee9', '\ud83d\udeeb', '\ud83d\udeec', '\ud83d\udef0',
  '\ud83d\udef3', '\ud83d\udef4', '\ud83d\udef5', '\ud83d\udef6', '\ud83d\udef7', '\ud83d\udef8',
  '\ud83d\udef9', '\ud83d\udefa', '\ud83d\udefb', '\ud83d\udefc', '\ud83d\udfe0', '\ud83d\udfe1',
  '\ud83d\udfe2', '\ud83d\udfe3', '\ud83d\udfe4', '\ud83d\udfe5', '\ud83d\udfe6', '\ud83d\udfe7',
  '\ud83d\udfe8', '\ud83d\udfe9', '\ud83d\udfea', '\ud83d\udfeb', '\ud83d\udff0', '\ud83e\udd0c',
  '\ud83e\udd0d', '\ud83e\udd0e', '\ud83e\udd0f', '\ud83e\udd10', '\ud83e\udd11', '\ud83e\udd12',
  '\ud83e\udd13', '\ud83e\udd14', '\ud83e\udd15', '\ud83e\udd16', '\ud83e\udd17', '\ud83e\udd18',
  '\ud83e\udd19', '\ud83e\udd1a', '\ud83e\udd1b', '\ud83e\udd1c', '\ud83e\udd1d', '\ud83e\udd1e',
  '\ud83e\udd1f', '\ud83e\udd20', '\ud83e\udd21', '\ud83e\udd22', '\ud83e\udd23', '\ud83e\udd24',
  '\ud83e\udd25', '\ud83e\udd26', '\ud83e\udd27', '\ud83e\udd28', '\ud83e\udd29', '\ud83e\udd2a',
  '\ud83e\udd2b', '\ud83e\udd2c', '\ud83e\udd2d', '\ud83e\udd2e', '\ud83e\udd2f', '\ud83e\udd30',
  '\ud83e\udd31', '\ud83e\udd32', '\ud83e\udd33', '\ud83e\udd34', '\ud83e\udd35', '\ud83e\udd36',
  '\ud83e\udd37', '\ud83e\udd38', '\ud83e\udd39', '\ud83e\udd3a', '\ud83e\udd3c', '\ud83e\udd3d',
  '\ud83e\udd3e', '\ud83e\udd3f', '\ud83e\udd40', '\ud83e\udd41', '\ud83e\udd42', '\ud83e\udd43',
  '\ud83e\udd44', '\ud83e\udd45', '\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49', '\ud83e\udd4a',
  '\ud83e\udd4b', '\ud83e\udd4c', '\ud83e\udd4d', '\ud83e\udd4e', '\ud83e\udd4f', '\ud83e\udd50',
  '\ud83e\udd51', '\ud83e\udd52', '\ud83e\udd53', '\ud83e\udd54', '\ud83e\udd55', '\ud83e\udd56',
  '\ud83e\udd57', '\ud83e\udd58', '\ud83e\udd59', '\ud83e\udd5a', '\ud83e\udd5b', '\ud83e\udd5c',
  '\ud83e\udd5d', '\ud83e\udd5e', '\ud83e\udd5f', '\ud83e\udd60', '\ud83e\udd61', '\ud83e\udd62',
  '\ud83e\udd63', '\ud83e\udd64', '\ud83e\udd65', '\ud83e\udd66', '\ud83e\udd67', '\ud83e\udd68',
  '\ud83e\udd69', '\ud83e\udd6a', '\ud83e\udd6b', '\ud83e\udd6c', '\ud83e\udd6d', '\ud83e\udd6e',
  '\ud83e\udd6f', '\ud83e\udd70', '\ud83e\udd71', '\ud83e\udd72', '\ud83e\udd73', '\ud83e\udd74',
  '\ud83e\udd75', '\ud83e\udd76', '\ud83e\udd77', '\ud83e\udd78', '\ud83e\udd79', '\ud83e\udd7a',
  '\ud83e\udd7b', '\ud83e\udd7c', '\ud83e\udd7d', '\ud83e\udd7e', '\ud83e\udd7f', '\ud83e\udd80',
  '\ud83e\udd81', '\ud83e\udd82', '\ud83e\udd83', '\ud83e\udd84', '\ud83e\udd85', '\ud83e\udd86',
  '\ud83e\udd87', '\ud83e\udd88', '\ud83e\udd89', '\ud83e\udd8a', '\ud83e\udd8b', '\ud83e\udd8c',
  '\ud83e\udd8d', '\ud83e\udd8e', '\ud83e\udd8f', '\ud83e\udd90', '\ud83e\udd91', '\ud83e\udd92',
  '\ud83e\udd93', '\ud83e\udd94', '\ud83e\udd95', '\ud83e\udd96', '\ud83e\udd97', '\ud83e\udd98',
  '\ud83e\udd99', '\ud83e\udd9a', '\ud83e\udd9b', '\ud83e\udd9c', '\ud83e\udd9d', '\ud83e\udd9e',
  '\ud83e\udd9f', '\ud83e\udda0', '\ud83e\udda1', '\ud83e\udda2', '\ud83e\udda3', '\ud83e\udda4',
  '\ud83e\udda5', '\ud83e\udda6', '\ud83e\udda7', '\ud83e\udda8', '\ud83e\udda9', '\ud83e\uddaa',
  '\ud83e\uddab', '\ud83e\uddac', '\ud83e\uddad', '\ud83e\uddae', '\ud83e\uddaf', '\ud83e\uddb0',
  '\ud83e\uddb1', '\ud83e\uddb2', '\ud83e\uddb3', '\ud83e\uddb4', '\ud83e\uddb5', '\ud83e\uddb6',
  '\ud83e\uddb7', '\ud83e\uddb8', '\ud83e\uddb9', '\ud83e\uddba', '\ud83e\uddbb', '\ud83e\uddbc',
  '\ud83e\uddbd', '\ud83e\uddbe', '\ud83e\uddbf', '\ud83e\uddc0', '\ud83e\uddc1', '\ud83e\uddc2',
  '\ud83e\uddc3', '\ud83e\uddc4', '\ud83e\uddc5', '\ud83e\uddc6', '\ud83e\uddc7', '\ud83e\uddc8',
  '\ud83e\uddc9', '\ud83e\uddca', '\ud83e\uddcb', '\ud83e\uddcc', '\ud83e\uddcd', '\ud83e\uddce',
  '\ud83e\uddcf', '\ud83e\uddd0', '\ud83e\uddd1', '\ud83e\uddd2', '\ud83e\uddd3', '\ud83e\uddd4',
  '\ud83e\uddd5', '\ud83e\uddd6', '\ud83e\uddd7', '\ud83e\uddd8', '\ud83e\uddd9', '\ud83e\uddda',
  '\ud83e\udddb', '\ud83e\udddc', '\ud83e\udddd', '\ud83e\uddde', '\ud83e\udddf', '\ud83e\udde0',
  '\ud83e\udde1', '\ud83e\udde2', '\ud83e\udde3', '\ud83e\udde4', '\ud83e\udde5', '\ud83e\udde6',
  '\ud83e\udde7', '\ud83e\udde8', '\ud83e\udde9', '\ud83e\uddea', '\ud83e\uddeb', '\ud83e\uddec',
  '\ud83e\udded', '\ud83e\uddee', '\ud83e\uddef', '\ud83e\uddf0', '\ud83e\uddf1', '\ud83e\uddf2',
  '\ud83e\uddf3', '\ud83e\uddf4', '\ud83e\uddf5', '\ud83e\uddf6', '\ud83e\uddf7', '\ud83e\uddf8',
  '\ud83e\uddf9', '\ud83e\uddfa', '\ud83e\uddfb', '\ud83e\uddfc', '\ud83e\uddfd', '\ud83e\uddfe',
  '\ud83e\uddff', '\ud83e\ude70', '\ud83e\ude71', '\ud83e\ude72', '\ud83e\ude73', '\ud83e\ude74',
  '\ud83e\ude75', '\ud83e\ude76', '\ud83e\ude77', '\ud83e\ude78', '\ud83e\ude79', '\ud83e\ude7a',
  '\ud83e\ude7b', '\ud83e\ude7c', '\ud83e\ude80', '\ud83e\ude81', '\ud83e\ude82', '\ud83e\ude83',
  '\ud83e\ude84', '\ud83e\ude85', '\ud83e\ude86', '\ud83e\ude87', '\ud83e\ude88', '\ud83e\ude90',
  '\ud83e\ude91', '\ud83e\ude92', '\ud83e\ude93', '\ud83e\ude94', '\ud83e\ude95', '\ud83e\ude96',
  '\ud83e\ude97', '\ud83e\ude98', '\ud83e\ude99', '\ud83e\ude9a', '\ud83e\ude9b', '\ud83e\ude9c',
  '\ud83e\ude9d', '\ud83e\ude9e', '\ud83e\ude9f', '\ud83e\udea0', '\ud83e\udea1', '\ud83e\udea2',
  '\ud83e\udea3', '\ud83e\udea4', '\ud83e\udea5', '\ud83e\udea6', '\ud83e\udea7', '\ud83e\udea8',
  '\ud83e\udea9', '\ud83e\udeaa', '\ud83e\udeab', '\ud83e\udeac', '\ud83e\udead', '\ud83e\udeae',
  '\ud83e\udeaf', '\ud83e\udeb0', '\ud83e\udeb1', '\ud83e\udeb2', '\ud83e\udeb3', '\ud83e\udeb4',
  '\ud83e\udeb5', '\ud83e\udeb6', '\ud83e\udeb7', '\ud83e\udeb8', '\ud83e\udeb9', '\ud83e\udeba',
  '\ud83e\udebb', '\ud83e\udebc', '\ud83e\udebd', '\ud83e\udebf', '\ud83e\udec0', '\ud83e\udec1',
  '\ud83e\udec2', '\ud83e\udec3', '\ud83e\udec4', '\ud83e\udec5', '\ud83e\udece', '\ud83e\udecf',
  '\ud83e\uded0', '\ud83e\uded1', '\ud83e\uded2', '\ud83e\uded3', '\ud83e\uded4', '\ud83e\uded5',
  '\ud83e\uded6', '\ud83e\uded7', '\ud83e\uded8', '\ud83e\uded9', '\ud83e\udeda', '\ud83e\udedb',
  '\ud83e\udee0', '\ud83e\udee1', '\ud83e\udee2', '\ud83e\udee3', '\ud83e\udee4', '\ud83e\udee5',
  '\ud83e\udee6', '\ud83e\udee7', '\ud83e\udee8', '\ud83e\udef0', '\ud83e\udef1', '\ud83e\udef2',
  '\ud83e\udef3', '\ud83e\udef4', '\ud83e\udef5', '\ud83e\udef6', '\ud83e\udef7', '\ud83e\udef8',
];

var WATCH_SUPPORTED_EMOJI_MAP = {};
for (var watchEmojiIndex = 0; watchEmojiIndex < WATCH_SUPPORTED_EMOJI.length; watchEmojiIndex += 1) {
  WATCH_SUPPORTED_EMOJI_MAP[WATCH_SUPPORTED_EMOJI[watchEmojiIndex]] = true;
}

var WATCH_LINK_TLDS = {
  app: true,
  biz: true,
  ca: true,
  co: true,
  com: true,
  dev: true,
  edu: true,
  gov: true,
  info: true,
  io: true,
  me: true,
  net: true,
  org: true,
  tv: true,
  uk: true,
  us: true
};

function replaceWatchEmojiAliases(value) {
  for (var i = 0; i < WATCH_EMOJI_ALIASES.length; i += 1) {
    value = value.split(WATCH_EMOJI_ALIASES[i][0]).join(WATCH_EMOJI_ALIASES[i][1]);
  }
  return value;
}

function replaceUnsupportedWatchEmoji(value) {
  return value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, function(match) {
    if (WATCH_SUPPORTED_EMOJI_MAP[match]) {
      return match;
    }
    return WATCH_EMOJI_NAMES[match] || '';
  });
}

var WATCH_EMOJI_NAMES = {
  '\ud83e\ude89': '[harp]',
  '\ud83e\ude8a': '[trombone]',
  '\ud83e\ude8e': '[treasure chest]',
  '\ud83e\ude8f': '[shovel]',
  '\ud83e\udebe': '[leafless tree]',
  '\ud83e\udec6': '[fingerprint]',
  '\ud83e\udec8': '[hairy creature]',
  '\ud83e\udecd': '[orca]',
  '\ud83e\udedc': '[root vegetable]',
  '\ud83e\udedf': '[splatter]',
  '\ud83e\udee9': '[face with bags under eyes]',
  '\ud83e\udeea': '[distorted face]',
  '\ud83e\udeef': '[fight cloud]',
};

function normalizeWatchString(value) {
  value = replaceWatchEmojiAliases(String(value || ''));
  // Strip zero-width joiners, variation selectors, and other format chars
  // that the PebbleOS font cannot render. ZWJ sequences then fall back to
  // their individual member glyphs (all in the font); VS16-stripped text
  // matches the base glyph.
  value = value.replace(/[\u200b-\u200f\ufe00-\ufe0f\ufeff\u20e3]/g, '');
  // Any remaining unsupported emoji (newer than the font) becomes a readable
  // [name] tag or is dropped — never passed to the watch as a raw glyph,
  // which can crash PebbleOS text rendering.
  value = replaceUnsupportedWatchEmoji(value);
  return value;
}

function clampText(value, maxLength) {
  return clampUtf8Bytes(normalizeWatchString(value), maxLength);
}

function isLikelyBareLinkHost(host) {
  var parts = String(host || '').toLowerCase().split('.');
  var tld = parts.length > 1 ? parts[parts.length - 1] : '';
  return !!WATCH_LINK_TLDS[tld];
}

function shortenWatchLinks(value) {
  return String(value || '').replace(/\b((?:https?:\/\/|www\.)[^\s<>"']+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s<>"']*)?)/ig, function(url, _link, offset, text) {
    if (offset > 0 && text.charAt(offset - 1) === '@') {
      return url;
    }
    var trailer = '';
    var cleanUrl = url.replace(/[.,!?;:)\]}]+$/g, function(match) {
      trailer = match + trailer;
      return '';
    });
    var match = cleanUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/?#]+)/i);
    if (match && cleanUrl.indexOf('://') === -1 && cleanUrl.slice(0, 4).toLowerCase() !== 'www.' &&
        !isLikelyBareLinkHost(match[1])) {
      return url;
    }
    return (match ? '[Link] ' + match[1] : '[Link]') + trailer;
  });
}

function summarizeWatchStackTrace(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n\s+at\s+[^\n]+/g, ' [trace]')
    .replace(/\n\s*\.\.\.\s+\d+\s+more/g, ' [trace]')
    .replace(/(?:\s+\[trace\]){2,}/g, ' [trace]');
}

function shortenTechnicalToken(token) {
  var suffix = '';
  var core = String(token || '').replace(/[.,!?;:)\]}]+$/g, function(match) {
    suffix = match + suffix;
    return '';
  });
  var parts = core.split('.');
  var shortCore = parts.length > 2 ? parts.slice(-2).join('.') : core;
  if (shortCore.length > 24 && parts.length > 1) {
    shortCore = parts[parts.length - 1];
  }
  if (shortCore.length > 24) {
    shortCore = clampUtf8Bytes(shortCore, 21) + '...';
  }
  return shortCore + suffix;
}

function shortenWatchTechnicalTokens(value) {
  return String(value || '')
    .replace(/\br8-map-id-[A-Za-z0-9-]+(?::\d+)?/g, 'r8-map')
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*){2,}(?::\d+)?/g, shortenTechnicalToken);
}

function shortenToken(token) {
  return clampUtf8Bytes(token, 21) + '...';
}

function watchText(value, maxLength) {
  value = shortenWatchTechnicalTokens(shortenWatchLinks(summarizeWatchStackTrace(normalizeWatchString(value))))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b([A-Za-z0-9_.-]{2,})\/([A-Za-z0-9_.-]{2,})\b/g, '$1 / $2')
    .replace(/[^\s]{29,}/g, shortenToken)
    .trim();
  return clampUtf8Bytes(value, maxLength);
}

function diagnosticText(value, maxLength) {
  return clampUtf8Bytes(normalizeWatchString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(), maxLength);
}

function utf8ByteLengthAt(value, index) {
  var code = value.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
    var next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      return 4;
    }
  }
  if (code < 0x80) {
    return 1;
  }
  if (code < 0x800) {
    return 2;
  }
  return 3;
}

function clampUtf8Bytes(value, maxBytes) {
  value = String(value || '');
  var bytes = 0;
  var output = '';
  for (var i = 0; i < value.length; i += 1) {
    var charBytes = utf8ByteLengthAt(value, i);
    if (bytes + charBytes > maxBytes) {
      break;
    }
    output += value.charAt(i);
    bytes += charBytes;
    if (charBytes === 4 && i + 1 < value.length) {
      output += value.charAt(i + 1);
      i += 1;
    }
  }
  return output;
}

function payloadValue(payload, name) {
  if (!payload) {
    return undefined;
  }
  if (payload[MessageKeys[name]] !== undefined) {
    return payload[MessageKeys[name]];
  }
  return payload[name];
}

function chatPayload(chat, index, total) {
  var payload = {};
  payload[MessageKeys.Type] = 'chat';
  payload[MessageKeys.Index] = index;
  payload[MessageKeys.Count] = Math.min(total, MAX_ROWS);
  payload[MessageKeys.ChatId] = clampText(chat.id, 23);
  payload[MessageKeys.Sender] = clampText(chat.title || 'Untitled', 47);
  payload[MessageKeys.Text] = watchText(chat.preview, 71);
  payload[MessageKeys.IsUnread] = chat.unread ? 1 : 0;
  payload[MessageKeys.UnreadCount] = chat.unread_count || 0;
  return payload;
}

function sendChatRows(chats, silent) {
  var rows = (chats || []).slice(0, MAX_ROWS);
  for (var index = 0; index < rows.length; index += 1) {
    sendToWatch(chatPayload(rows[index], index, rows.length));
  }
  done('chats_done', rows.length);
}

function messageRowCost(message) {
  var contextCost = (message.reply_text || '').length + (message.forward_text || '').length;
  return 64 + String(message.text || '').length + contextCost + (message.image_token ? 180 : 0);
}

function limitMessageWindow(messages, preferNewest) {
  var rows = messages || [];
  var selected = [];
  var used = 0;
  var i;
  if (preferNewest) {
    for (i = rows.length - 1; i >= 0 && selected.length < MAX_MESSAGE_ROWS; i -= 1) {
      used += messageRowCost(rows[i]);
      if (selected.length > 0 && used > MESSAGE_WINDOW_BUDGET) {
        break;
      }
      selected.unshift(rows[i]);
    }
    return selected;
  }
  for (i = 0; i < rows.length && selected.length < MAX_MESSAGE_ROWS; i += 1) {
    used += messageRowCost(rows[i]);
    if (selected.length > 0 && used > MESSAGE_WINDOW_BUDGET) {
      break;
    }
    selected.push(rows[i]);
  }
  return selected;
}

function persistentMessageCacheKey(chatId) {
  return MESSAGE_CACHE_PREFIX + String(chatId || '');
}

function persistentMessageCacheOrder() {
  try {
    return JSON.parse(localStorage.getItem(MESSAGE_CACHE_ORDER_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function removeArrayValue(items, value) {
  var write = 0;
  for (var read = 0; read < items.length; read += 1) {
    if (items[read] !== value) {
      items[write] = items[read];
      write += 1;
    }
  }
  items.length = write;
  return items;
}

function savePersistentMessages(chatId, messages) {
  var id = String(chatId || '');
  if (!id) {
    return;
  }
  try {
    var rows = limitMessageWindow(messages || [], true);
    if (!rows.length) {
      return;
    }
    localStorage.setItem(persistentMessageCacheKey(id), JSON.stringify(rows));
    var order = removeArrayValue(persistentMessageCacheOrder(), id);
    order.push(id);
    while (order.length > MAX_CACHED_CHATS) {
      localStorage.removeItem(persistentMessageCacheKey(order.shift()));
    }
    localStorage.setItem(MESSAGE_CACHE_ORDER_KEY, JSON.stringify(order));
  } catch (e) {
    debugLog('Message cache save skipped: ' + (e && e.message ? e.message : e));
  }
}

function loadPersistentMessages(chatId) {
  var id = String(chatId || '');
  if (!id) {
    return [];
  }
  try {
    var rows = JSON.parse(localStorage.getItem(persistentMessageCacheKey(id)) || '[]');
    return Array.isArray(rows) ? limitMessageWindow(rows, true) : [];
  } catch (e) {
    localStorage.removeItem(persistentMessageCacheKey(id));
    return [];
  }
}

function removePersistentMessages(chatId) {
  var id = String(chatId || '');
  if (!id) {
    return;
  }
  localStorage.removeItem(persistentMessageCacheKey(id));
  try {
    var order = removeArrayValue(persistentMessageCacheOrder(), id);
    localStorage.setItem(MESSAGE_CACHE_ORDER_KEY, JSON.stringify(order));
  } catch (e) {}
}

function messagePayload(message, type, index, count, transferId) {
  var payload = {};
  payload[MessageKeys.Type] = type || 'message';
  payload[MessageKeys.Index] = index || 0;
  payload[MessageKeys.Count] = count;
  if (transferId) {
    payload[MessageKeys.ImageTransferId] = transferId;
  }
  payload[MessageKeys.MessageId] = clampText(message.id, 23);
  payload[MessageKeys.Sender] = clampText(message.sender, 35);
  payload[MessageKeys.Text] = watchText(message.text, MAX_MESSAGE_TEXT);
  if (message.reactions) {
    payload[MessageKeys.Reactions] = clampText(message.reactions, 16);
  }
  if (message.meta) {
    payload[MessageKeys.MessageMeta] = clampUtf8Bytes(message.meta, 15);
  }
  if (message.reply_sender) {
    payload[MessageKeys.ReplySender] = clampText(message.reply_sender, 35);
  }
  if (message.reply_text) {
    payload[MessageKeys.ReplyText] = watchText(message.reply_text, 95);
  }
  if (message.forward_sender) {
    payload[MessageKeys.ForwardSender] = clampText(message.forward_sender, 35);
  }
  if (message.forward_text) {
    payload[MessageKeys.ForwardText] = watchText(message.forward_text, 95);
  }
  payload[MessageKeys.IsOutgoing] = message.outgoing ? 1 : 0;
  if (message.image_token) {
    payload[MessageKeys.ImageToken] = String(message.image_token);
    if (message.image_width && message.image_height) {
      payload[MessageKeys.ImageWidth] = message.image_width;
      payload[MessageKeys.ImageHeight] = message.image_height;
    }
  }
  if (message.voice_token) {
    payload[MessageKeys.VoiceToken] = String(message.voice_token);
    if (message.voice_duration_ms) {
      // The watch uses this to render a duration hint next to the play
      // affordance. Cap it to a sensible display range.
      payload[MessageKeys.VoiceDuration] = message.voice_duration_ms > 0
        ? Math.min(600000, Math.round(message.voice_duration_ms)) : 0;
    }
  }
  if (message.thread_replies) {
    payload[MessageKeys.ThreadCount] = message.thread_replies;
  }
  if (message.thread_list) {
    payload[MessageKeys.ThreadList] = 1;
  }
  if (message.thread_id) {
    payload[MessageKeys.ThreadId] = String(message.thread_id);
  }
  return payload;
}

function streamMessageRows(chatId, messages, mode, finalCount) {
  var isSilent = mode === 'older_silent' || mode === 'newer_silent';
  var isOlder = mode === 'older' || mode === 'older_silent';
  var isNewer = mode === 'newer' || mode === 'newer_silent';
  var rows = limitMessageWindow(messages || [], !isOlder && !isNewer);
  var doneCount = finalCount === undefined ? rows.length : finalCount;
  var transferId = ++messageStreamSeq;
  var cursor = isNewer ? 0 : rows.length - 1;
  var modeCode = isOlder ? 1 : (isNewer ? 2 : 0);
  var start = {};
  start[MessageKeys.Type] = 'messages_start';
  start[MessageKeys.Count] = doneCount;
  start[MessageKeys.Index] = modeCode;
  if (isSilent) {
    start[MessageKeys.Text] = 'silent';
  }
  start[MessageKeys.ImageTransferId] = transferId;
  sendToWatch(start);

  function pump() {
    if (transferId !== messageStreamSeq || currentChatId !== chatId) {
      return;
    }
    if ((!isNewer && cursor < 0) || (isNewer && cursor >= rows.length)) {
      messageStreamTimer = null;
      done('messages_done', doneCount, transferId);
      return;
    }
    sendToWatch(messagePayload(rows[cursor], isNewer ? 'message_append' : 'message_prepend', 0, doneCount, transferId));
    cursor += isNewer ? 1 : -1;
    messageStreamTimer = setTimeout(pump, isOlder || isNewer ? 16 : 20);
  }
  pump();
}

function sendMessageRows(messages, chatId, mode, finalCount) {
  mode = mode || 'initial';
  if (mode === 'initial') {
    sendMessageWindow(chatId || currentChatId, messages, mode, false, finalCount);
    return;
  }
  streamMessageRows(chatId || currentChatId, messages, mode, finalCount);
}

function sendMessageWindow(chatId, messages, mode, silent, finalCount) {
  var rows = limitMessageWindow(messages || [], mode === 'initial');
  var doneCount = finalCount === undefined ? rows.length : finalCount;
  var transferId = ++messageStreamSeq;
  var modeCode = mode === 'older' ? 1 : (mode === 'newer' ? 2 : 0);
  var start = {};
  start[MessageKeys.Type] = 'messages_start';
  start[MessageKeys.Count] = doneCount;
  start[MessageKeys.Index] = modeCode;
  if (silent) {
    start[MessageKeys.Text] = 'silent';
  }
  start[MessageKeys.ImageTransferId] = transferId;
  sendToWatch(start);
  rows.forEach(function(message, index) {
    sendToWatch(messagePayload(message, 'message', index, rows.length, transferId));
  });
  done('messages_done', doneCount, transferId);
}

function sendMessagePatches(chatId, messages) {
  var count = (messageStore[chatId] || []).length;
  (messages || []).forEach(function(message) {
    sendToWatch(messagePayload(message, 'message_update', 0, count, 0));
  });
}

function messageSortValue(id) {
  var parsed = parseInt(id, 10);
  return isNaN(parsed) ? String(id || '') : parsed;
}

function compareMessageIds(a, b) {
  var av = messageSortValue(a && a.id);
  var bv = messageSortValue(b && b.id);
  if (typeof av === 'number' && typeof bv === 'number') {
    return av - bv;
  }
  av = String(av);
  bv = String(bv);
  return av < bv ? -1 : (av > bv ? 1 : 0);
}

function removeChatCache(chatId, clearPersistent) {
  var id = String(chatId || '');
  if (!id) {
    return;
  }
  delete messageStore[id];
  delete messageStoreNewest[id];
  delete messageHistoryStore[id];
  delete oldestComplete[id];
  delete newestComplete[id];
  delete prefetching[id];
  Object.keys(pagePrefetching).forEach(function(key) {
    if (key.indexOf(id + ':') === 0) {
      delete pagePrefetching[key];
    }
  });
  removeArrayValue(chatCacheOrder, id);
  if (clearPersistent !== false) {
    removePersistentMessages(id);
  }
}

function touchChatCache(chatId) {
  var id = String(chatId || '');
  if (!id) {
    return;
  }
  removeArrayValue(chatCacheOrder, id);
  chatCacheOrder.push(id);
}

function trimChatCaches(protectedChatId) {
  var protectedId = String(protectedChatId || '');
  var attempts = 0;
  while (chatCacheOrder.length > MAX_CACHED_CHATS && attempts <= chatCacheOrder.length) {
    var id = chatCacheOrder.shift();
    if (id === protectedId) {
      chatCacheOrder.push(id);
      attempts += 1;
      continue;
    }
    removeChatCache(id, false);
    attempts = 0;
  }
}

function mergeHistoryMessages(chatId, rows) {
  var existing = messageHistoryStore[chatId] || [];
  var byId = {};
  var merged;

  function ingest(source) {
    (source || []).forEach(function(message) {
      if (message && message.id !== undefined && message.id !== null) {
        byId[String(message.id)] = message;
      }
    });
  }

  ingest(existing);
  ingest(rows);
  merged = Object.keys(byId).map(function(id) {
    return byId[id];
  }).sort(compareMessageIds);
  if (merged.length > PHONE_MESSAGE_CACHE_ROWS) {
    merged = merged.slice(merged.length - PHONE_MESSAGE_CACHE_ROWS);
  }
  messageHistoryStore[chatId] = merged;
  touchChatCache(chatId);
  trimChatCaches(currentChatId || chatId);
  return merged;
}

function cachedOlderRows(chatId, beforeId, limit) {
  var rows = messageHistoryStore[chatId] || [];
  var before = String(beforeId);
  var index = rows.length;
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].id) === before) {
      index = i;
      break;
    }
  }
  return rows.slice(Math.max(0, index - limit), index);
}

function cachedNewerRows(chatId, afterId, limit) {
  var rows = messageHistoryStore[chatId] || [];
  var after = String(afterId);
  var index = -1;
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].id) === after) {
      index = i;
      break;
    }
  }
  return index < 0 ? [] : rows.slice(index + 1, index + 1 + limit);
}

function messageIndexById(rows, messageId) {
  var id = String(messageId || '');
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].id) === id) {
      return i;
    }
  }
  return -1;
}

function messageWindowAroundAnchor(rows, anchorId, olderAhead) {
  var anchorIndex = messageIndexById(rows, anchorId);
  var start;
  if (anchorIndex < 0) {
    return rows.slice(Math.max(0, rows.length - MAX_MESSAGE_ROWS));
  }
  start = anchorIndex - olderAhead;
  if (start < 0) {
    start = 0;
  }
  if (start + MAX_MESSAGE_ROWS > rows.length) {
    start = Math.max(0, rows.length - MAX_MESSAGE_ROWS);
  }
  return rows.slice(start, start + MAX_MESSAGE_ROWS);
}

function sendOlderWindow(chatId, anchorId, beforeId, silent) {
  var rows = cachedOlderRows(chatId, beforeId || anchorId, OLDER_MESSAGE_ROWS);
  var merged;
  if (!rows.length) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return 0;
  }
  touchChatCache(chatId);
  trimChatCaches(currentChatId || chatId);
  merged = messageHistoryStore[chatId] || [];
  messageStore[chatId] = messageWindowAroundAnchor(merged, anchorId, MESSAGE_EDGE_BUFFER_ROWS);
  messageStoreNewest[chatId] = false;
  sendMessageWindow(chatId, messageStore[chatId], 'older', silent, messageStore[chatId].length);
  return rows.length;
}

function sendNewerWindow(chatId, anchorId, afterId, silent) {
  var rows = cachedNewerRows(chatId, afterId || anchorId, NEWER_MESSAGE_ROWS);
  var merged;
  if (!rows.length) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return 0;
  }
  touchChatCache(chatId);
  trimChatCaches(currentChatId || chatId);
  merged = messageHistoryStore[chatId] || [];
  messageStore[chatId] = messageWindowAroundAnchor(merged, anchorId,
                                                     MAX_MESSAGE_ROWS - MESSAGE_EDGE_BUFFER_ROWS - 1);
  messageStoreNewest[chatId] = false;
  sendMessageWindow(chatId, messageStore[chatId], 'newer', silent, messageStore[chatId].length);
  return rows.length;
}

function warmChatHistory(chatId) {
  if (!chatId || prefetching[chatId]) {
    return;
  }
  touchChatCache(chatId);
  prefetching[chatId] = true;
  timed('warm history ' + chatId, activePgjs().messages(chatId, MESSAGE_PAGE_FETCH_ROWS)).then(function(messages) {
    delete prefetching[chatId];
    messages = messages || [];
    mergeHistoryMessages(chatId, messages);
    if (!messageStore[chatId]) {
      messageStore[chatId] = limitMessageWindow(messages, true);
      messageStoreNewest[chatId] = true;
      savePersistentMessages(chatId, messageStore[chatId]);
    }
  }).catch(function(err) {
    delete prefetching[chatId];
    debugLog('History warm failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function rememberMessages(chatId, messages) {
  messages = messages || [];
  mergeHistoryMessages(chatId, messages);
  messageStore[chatId] = limitMessageWindow(messages, true);
  messageStoreNewest[chatId] = true;
  savePersistentMessages(chatId, messageStore[chatId]);
}

function mergeMessages(existing, incoming, allowAppend, trimNewest) {
  var byId = {};
  var merged = [];
  var changed = false;

  existing.forEach(function(message) {
    byId[message.id] = message;
    merged.push(message);
  });

  incoming.forEach(function(message) {
    var previous = byId[message.id];
    if (previous) {
      if (singleMessageSignature(previous) !== singleMessageSignature(message)) {
        for (var i = 0; i < merged.length; i += 1) {
          if (merged[i].id === message.id) {
            merged[i] = message;
            changed = true;
            break;
          }
        }
      }
      return;
    }
    if (!allowAppend) {
      return;
    }
    byId[message.id] = message;
    merged.push(message);
    changed = true;
  });

  if (trimNewest && merged.length > MAX_MESSAGE_ROWS) {
    merged = merged.slice(merged.length - MAX_MESSAGE_ROWS);
    changed = true;
  }

  return {
    messages: merged,
    changed: changed
  };
}

function storedWindowTouchesNewestTail(existing, latest) {
  if (!existing || existing.length === 0) {
    return true;
  }
  if (!latest || latest.length === 0) {
    return false;
  }
  var newestKnownId = existing[existing.length - 1].id;
  for (var i = 0; i < latest.length; i += 1) {
    if (latest[i].id === newestKnownId) {
      return true;
    }
  }
  return false;
}

function sendStoredMessages(chatId) {
  var messages = messageStore[chatId];
  if ((!messages || messages.length === 0) && chatId && messageStoreNewest[chatId] === true) {
    messages = loadPersistentMessages(chatId);
    if (messages.length > 0) {
      messageStore[chatId] = messages;
      mergeHistoryMessages(chatId, messages);
    }
  }
  if (messageStoreNewest[chatId] !== true) {
    return false;
  }
  if (!messages || messages.length === 0) {
    return false;
  }
  currentChatSignature = messageSignature(messages);
  touchChatCache(chatId);
  markRead(chatId);
  sendMessageRows(messages, chatId, 'initial');
  return true;
}

function storedMessage(chatId, messageId) {
  var rows = messageStore[chatId] || [];
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].id) === String(messageId)) {
      return rows[i];
    }
  }
  return null;
}

function sendFullMessageText(chatId, messageId) {
  var message = storedMessage(chatId, messageId);
  var payload = {};
  payload[MessageKeys.Type] = 'message_context';
  payload[MessageKeys.MessageId] = clampText(messageId, 23);
  payload[MessageKeys.Sender] = '';
  payload[MessageKeys.Text] = watchText(message ? message.text : 'Message not loaded', MAX_CONTEXT_VIEW_TEXT);
  sendToWatch(payload);
}

function sendMessageContext(chatId, messageId) {
  var message = storedMessage(chatId, messageId);
  var payload = {};
  var title = 'Reply';
  var text = 'Message not loaded';
  if (message) {
    if (message.reply_text || message.reply_sender) {
      title = message.reply_sender || 'Reply';
      text = message.reply_text || 'Message';
    } else if (message.forward_text || message.forward_sender) {
      title = 'Fwd from ' + (message.forward_sender || 'Forwarded');
      text = message.forward_text || 'Message';
    }
  }
  payload[MessageKeys.Type] = 'message_context';
  payload[MessageKeys.MessageId] = clampText(messageId, 23);
  payload[MessageKeys.Sender] = clampText(title, 35);
  payload[MessageKeys.Text] = watchText(text, MAX_CONTEXT_VIEW_TEXT);
  sendToWatch(payload);
}

function prefetchMessages(chatId) {
  warmChatHistory(chatId);
}

function prefetchTopChats(chats) {
  var rows = (chats || []).slice(0, PREFETCH_CHAT_COUNT);
  var seq = ++topPrefetchSeq;

  function prefetchAt(index) {
    if (seq !== topPrefetchSeq || index >= rows.length) {
      return;
    }
    setTimeout(function() {
      if (seq !== topPrefetchSeq) {
        return;
      }
      if (currentChatId || avatarTimer || avatarIndex < avatarChats.length) {
        prefetchAt(index);
        return;
      }
      prefetchMessages(rows[index].id);
      prefetchAt(index + 1);
    }, index === 0 ? 2500 : 900);
  }

  prefetchAt(0);
}

function scheduleUpdateRefresh(delay) {
  if (updateRefreshTimer) {
    return;
  }
  updateRefreshTimer = setTimeout(function() {
    updateRefreshTimer = null;
    if (imageTransferActive || voiceTransferActive) {
      scheduleUpdateRefresh(1500);
      return;
    }
    if (!currentChatId) {
      getChats(true);
    } else {
      refreshOpenChat(true);
    }
  }, delay || 1000);
}

function cancelUpdateRefresh() {
  if (updateRefreshTimer) {
    clearTimeout(updateRefreshTimer);
    updateRefreshTimer = null;
  }
}

function idPart(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function peerId(value) {
  if (!value) {
    return '';
  }
  return idPart(value.userId || value.chatId || value.channelId || value.peerId || value.id);
}

function updateChatId(update) {
  var message = update && (update.message || update.Message);
  return peerId(message && message.peerId) ||
    peerId(message && message.peer) ||
    peerId(update && update.peer) ||
    idPart(update && (update.userId || update.chatId || update.channelId));
}

function handleTelegramUpdate(update) {
  var chatId = updateChatId(update);
  if (currentChatId) {
    if (chatId && chatId === currentChatId) {
      scheduleUpdateRefresh(900);
    } else if (!chatId || chatId !== currentChatId) {
      chatListStale = true;
    }
    return;
  }
  scheduleUpdateRefresh(900);
}


function startConnectionKeepalive() {
  if (connectionKeepaliveTimer) {
    return;
  }
  connectionKeepaliveTimer = setInterval(function() {
    var keepalive;
    if (imageTransferActive || voiceTransferActive) {
      return;
    }
    keepalive = activePgjs().keepalive || activePgjs().ready;
    withTimeout(keepalive(), 'keepalive timed out', 10000).catch(function(err) {
      debugLog('Keepalive reconnect failed: ' + (err && err.message ? err.message : err));
    });
  }, 45000);
}

function startTelegramUpdates() {
  if (updatesStarted) {
    return;
  }
  updatesStarted = true;
  activePgjs().ready().then(function(client) {
    if (!client || typeof client.addEventHandler !== 'function') {
      debugLog('Telegram updates unavailable; chat list refresh is manual only.');
      return;
    }
    client.addEventHandler(handleTelegramUpdate);
    debugLog('Telegram updates enabled.');
  }).catch(function(err) {
    updatesStarted = false;
    debugLog('Telegram updates failed: ' + (err && err.message ? err.message : err));
  });
}

function runPostFirstPaintWork(chats) {
  if (postFirstPaintTimer) {
    clearTimeout(postFirstPaintTimer);
    postFirstPaintTimer = null;
  }
  if (!postFirstPaintStarted) {
    postFirstPaintStarted = true;
    sendSettings();
    startConnectionKeepalive();
    startTelegramUpdates();
  }
  chats = chats || deferredStartupChats || [];
  deferredStartupChats = null;
  if (chats.length > 0) {
    queueChatAvatars(chats);
    prefetchTopChats(chats);
  }
}

function deferPostFirstPaintWork(chats) {
  if (postFirstPaintStarted) {
    runPostFirstPaintWork(chats);
    return;
  }
  deferredStartupChats = chats || [];
  if (!postFirstPaintTimer) {
    postFirstPaintTimer = setTimeout(function() {
      postFirstPaintTimer = null;
      runPostFirstPaintWork();
    }, 2500);
  }
}

function getChats(silent) {
  if (chatLoadPromise) {
    if (!silent) {
      status('Connecting...');
    }
    return chatLoadPromise;
  }
  if (!silent) {
    status('Connecting...');
  }
  chatLoadPromise = timed('telegram connect', activePgjs().ready()).then(function() {
    if (!silent) {
      status('Fetching chats...');
    }
    return timed('chat list load', activePgjs().chats(MAX_ROWS));
  }).then(function(chats) {
    chats = chats || [];
    sendChatRows(chats, silent);
    deferPostFirstPaintWork(chats);
  }).catch(function(err) {
    if (silent) {
      debugLog('Silent chats failed: ' + (err && err.message ? err.message : err));
    } else {
      promiseError('Chats failed', err);
    }
  }).then(function(value) {
    chatLoadPromise = null;
    return value;
  }, function(err) {
    chatLoadPromise = null;
    throw err;
  });
  return chatLoadPromise;
}

function getMessages(chatId) {
  var key = String(chatId || '');
  currentChatId = chatId;
  topPrefetchSeq += 1;
  currentChatSignature = '';
  touchChatCache(chatId);
  cancelUpdateRefresh();
  cancelQueuedMessageTransfers();
  cancelQueuedAvatarTransfers();
  cancelAllQueuedTransfers();
  if (sendStoredMessages(chatId)) {
    return;
  }
  if (messageLoadPromises[key]) {
    status('Loading messages...');
    return;
  }
  currentThreadId = null;
  status('Loading messages...');
  messageLoadPromises[key] = timed('messages load ' + chatId, withTimeout(activePgjs().messages(chatId, INITIAL_MESSAGE_ROWS),
                                      'messages load timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(messages) {
    delete messageLoadPromises[key];
    messages = messages || [];
    if (messages.thread_mode) {
      // Threaded bot chat: the history IS the thread list. Mark every row so
      // the watch switches to thread-list rendering for this chat.
      for (var i = 0; i < messages.length; i++) {
        messages[i].thread_list = true;
      }
    }
    rememberMessages(chatId, messages);
    currentChatSignature = messageSignature(messages);
    markRead(chatId);
    sendMessageRows(messages, chatId, 'initial');
    warmChatHistory(chatId);
  }).catch(function(err) {
    delete messageLoadPromises[key];
    promiseError('Messages failed', err);
  });
}

function getThreadMessages(chatId, threadId) {
  if (!chatId || !threadId) {
    done('messages_done', 0, 0, null);
    return;
  }
  var key = String(chatId || '') + ':thread:' + String(threadId);
  if (threadLoadPromises[key]) {
    return;
  }
  cancelUpdateRefresh();
  cancelAllQueuedTransfers();
  currentThreadId = threadId;
  currentChatSignature = '';
  status('Loading thread...');
  threadLoadPromises[key] = timed('thread load ' + chatId,
      withTimeout(activePgjs().messages(chatId, INITIAL_MESSAGE_ROWS, 0, threadId),
                  'thread load timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(rows) {
    delete threadLoadPromises[key];
    rows = rows || [];
    // Anchor every row to the thread so the watch keeps the root id for
    // scoped pagination and replying inside this thread.
    for (var i = 0; i < rows.length; i++) {
      rows[i].thread_id = threadId;
    }
    currentChatId = chatId;
    currentChatSignature = messageSignature(rows);
    markRead(chatId);
    sendMessageRows(rows, chatId, 'initial');
  }).catch(function(err) {
    delete threadLoadPromises[key];
    currentThreadId = null;
    promiseError('Thread failed', err);
  });
}

function refreshOpenChat() {
  var chatId = currentChatId;
  if (!chatId) {
    return;
  }
  withTimeout(activePgjs().messages(chatId, INITIAL_MESSAGE_ROWS, currentThreadId ? 0 : null, currentThreadId),
              'chat refresh timed out', MESSAGE_FETCH_TIMEOUT_MS).then(function(messages) {
    var signature;
    if (currentChatId !== chatId) {
      return;
    }
    messages = messages || [];
    signature = messageSignature(messages);
    if (signature === currentChatSignature) {
      return;
    }
    currentChatSignature = signature;
    var existing = messageStore[chatId] || [];
    var attachedToNewest = storedWindowTouchesNewestTail(existing, messages);
    var previousById = {};
    var appended = [];
    var patches = [];
    existing.forEach(function(message) {
      previousById[message.id] = message;
    });
    mergeHistoryMessages(chatId, messages);
    if (attachedToNewest) {
      messages.forEach(function(message) {
        if (!previousById[message.id]) {
          appended.push(message);
        }
      });
    }
    var merged = mergeMessages(existing, messages, attachedToNewest, attachedToNewest);
    if (merged.changed) {
      messageStore[chatId] = merged.messages;
      messageStoreNewest[chatId] = attachedToNewest;
      if (attachedToNewest) {
        savePersistentMessages(chatId, messageStore[chatId]);
      }
      merged.messages.forEach(function(message) {
        var previous = previousById[message.id];
        if (previous && singleMessageSignature(previous) !== singleMessageSignature(message)) {
          patches.push(message);
        }
      });
      if (patches.length) {
        sendMessagePatches(chatId, patches);
      }
      if (appended.length) {
        sendMessageRows(appended, chatId, 'newer', messageStore[chatId].length);
      }
      if (attachedToNewest) {
        markRead(chatId);
      }
    }
  }).catch(function(err) {
    debugLog('Open chat refresh failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function verifyReaction(chatId, messageId, token) {
  if (typeof activePgjs().message !== 'function') {
    return Promise.resolve(false);
  }
  return withTimeout(activePgjs().message(chatId, messageId),
                     'reaction verify timed out', MESSAGE_FETCH_TIMEOUT_MS).then(function(message) {
    var existing;
    var merged;
    if (!message) {
      return false;
    }
    mergeHistoryMessages(chatId, [message]);
    existing = messageStore[chatId] || [];
    merged = mergeMessages(existing, [message], false, false);
    if (merged.changed) {
      messageStore[chatId] = merged.messages;
      savePersistentMessages(chatId, messageStore[chatId]);
      sendMessagePatches(chatId, [message]);
    }
    return reactionApplied(message, token);
  }).catch(function(err) {
    debugLog('Reaction verify failed: ' + (err && err.message ? err.message : err));
    return false;
  });
}

function retryReactionAfterError(chatId, messageId, token, originalError) {
  setTimeout(function() {
    activePgjs().sendReaction(chatId, messageId, token).then(function() {
      var payload = {};
      payload[MessageKeys.Type] = 'reacted';
      sendToWatch(payload);
      refreshOpenChat();
    }).catch(function(retryErr) {
      verifyReaction(chatId, messageId, token).then(function(applied) {
        var payload = {};
        if (applied) {
          payload[MessageKeys.Type] = 'reacted';
          sendToWatch(payload);
        } else {
          promiseError('Reaction failed', retryErr || originalError);
        }
      });
    });
  }, 700);
}

function leaveChat(chatId) {
  if (String(currentChatId) === String(chatId || '')) {
    currentChatId = null;
    currentChatSignature = '';
    currentThreadId = null;
    cancelQueuedMessageTransfers();
    cancelAllQueuedTransfers();
    avatarIndex = 0;
    scheduleChatAvatars(300);
    if (chatListStale) {
      chatListStale = false;
      getChats(true);
    }
  }
}

function singleMessageSignature(message) {
  return [
    message.id,
    message.text,
    message.reactions || '',
    message.meta || '',
    message.reply_sender || '',
    message.reply_text || '',
    message.forward_sender || '',
    message.forward_text || '',
    message.image_token || '',
    message.outgoing ? '1' : '0',
    message.thread_replies ? String(message.thread_replies) : '',
    message.thread_id ? String(message.thread_id) : ''
  ].join('|');
}

function messageSignature(messages) {
  return (messages || []).map(singleMessageSignature).join('~');
}

function reactionGlyph(token) {
  switch (token) {
    case 'like':
      return '\ud83d\udc4d';
    case 'heart':
      return '\u2764';
    case 'laugh':
      return '\ud83e\udd23';
    case 'wow':
      return '\ud83d\ude31';
    case 'sad':
      return '\ud83d\ude22';
    case 'angry':
      return '\ud83d\ude21';
    case 'smile_open':
    case 'smile_eyes':
      return '\ud83d\ude01';
    case 'cry_loud':
      return '\ud83d\ude2d';
    case 'fire':
      return '\ud83d\udd25';
    case 'party':
      return '\ud83c\udf89';
    case 'star_struck':
      return '\ud83e\udd29';
    case 'smiling_hearts':
      return '\ud83e\udd70';
    case 'symbols_mouth':
      return '\ud83e\udd2c';
    case 'clap':
      return '\ud83d\udc4f';
    case 'grin':
      return '\ud83d\ude01';
    case 'think':
      return '\ud83e\udd14';
    case 'eyes':
      return '\ud83d\udc40';
    case 'love':
      return '\ud83d\ude0d';
    case 'kiss':
      return '\ud83d\ude18';
    case 'blush':
      return '\ud83d\ude33';
    case 'grimace':
      return '\ud83d\ude2c';
    case 'neutral':
      return '\ud83d\ude10';
    case 'angel':
      return '\ud83d\ude07';
    case 'devil':
      return '\ud83d\ude08';
    case 'pray':
      return '\ud83d\ude4f';
    case 'dislike':
      return '\ud83d\udc4e';
    case 'ok':
      return '\ud83d\udc4c';
    case 'broken_heart':
      return '\ud83d\udc94';
    case 'kiss_mark':
      return '\ud83d\udc8b';
    case 'poop':
      return '\ud83d\udca9';
    case 'sick':
      return '\ud83e\udd2e';
    case 'sleep':
      return '\ud83d\ude34';
    case 'cool':
      return '\ud83d\ude0e';
    case 'bolt':
      return '\u26a1';
    case '\ud83d\ude02':
      return '\ud83e\udd23';
    case '\ud83d\ude00':
    case '\ud83d\ude04':
      return '\ud83d\ude01';
    case '\ud83d\ude2d':
      return '\ud83d\ude2d';
    case '\ud83d\ude33':
      return '\ud83d\ude31';
    case '\ud83d\ude2c':
      return '\ud83d\ude10';
    default:
      return token && /[^\x00-\x7f]/.test(token) ? token : '';
  }
}

function reactionApplied(message, token) {
  var reactions = (message && message.reactions) || '';
  var glyph = reactionGlyph(token);
  if (token === 'remove') {
    return reactions === '';
  }
  return !!(glyph && reactions.indexOf(glyph) !== -1);
}

function markRead(chatId) {
  activePgjs().markRead(chatId).catch(function(err) {
    debugLog('Mark read failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function getOlderMessages(chatId, anchorId, beforeId, silent, threadId) {
  beforeId = beforeId || anchorId;
  if (!beforeId) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return;
  }
  if (!silent) {
    cancelQueuedImageTransfers();
  }
  var threadMode = !!threadId;
  if (!threadMode && (cachedOlderRows(chatId, beforeId, OLDER_MESSAGE_ROWS).length >= OLDER_MESSAGE_ROWS || oldestComplete[chatId])) {
    sendOlderWindow(chatId, anchorId, beforeId, silent);
    return;
  }
  if (!silent) {
    status('Loading older...');
  }
  timed('older messages load ' + chatId, withTimeout(activePgjs().olderMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, beforeId, threadId),
                                            'older messages timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(older) {
    older = older || [];
    if (older.length === 0) {
      if (threadMode) {
        done('messages_done', 0, 0, silent ? 'silent' : null);
        return;
      }
      oldestComplete[chatId] = true;
    }
    if (threadMode) {
      // Thread pages live outside the chat cache; keep the thread anchor on
      // every row so the watch stays anchored while paging inside a thread.
      for (var i = 0; i < older.length; i++) {
        older[i].thread_id = threadId;
      }
      sendOlderWindow(chatId, anchorId, beforeId, silent);
      return;
    }
    mergeHistoryMessages(chatId, older);
    sendOlderWindow(chatId, anchorId, beforeId, silent);
  }).catch(function(err) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    promiseError('Older failed', err);
  });
}

function getNewerMessages(chatId, anchorId, afterId, silent, threadId) {
  afterId = afterId || anchorId;
  var key = String(chatId || '') + ':' + String(afterId || '');
  if (!afterId) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return;
  }
  if (!silent) {
    cancelQueuedImageTransfers();
  }
  var threadMode = !!threadId;
  if (!threadMode && (cachedNewerRows(chatId, afterId, NEWER_MESSAGE_ROWS).length >= NEWER_MESSAGE_ROWS || newestComplete[chatId])) {
    sendNewerWindow(chatId, anchorId, afterId, silent);
    return;
  }
  if (!silent) {
    status('Loading newer...');
  }
  if (newerLoadPromises[key]) {
    return;
  }
  newerLoadPromises[key] = timed('newer messages load ' + chatId, withTimeout(activePgjs().newerMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, afterId, threadId),
                                            'newer messages timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(newer) {
    delete newerLoadPromises[key];
    newer = newer || [];
    if (newer.length === 0) {
      if (threadMode) {
        done('messages_done', 0, 0, silent ? 'silent' : null);
        return;
      }
      newestComplete[chatId] = true;
    }
    if (threadMode) {
      for (var i = 0; i < newer.length; i++) {
        newer[i].thread_id = threadId;
      }
      sendNewerWindow(chatId, anchorId, afterId, silent);
      return;
    }
    mergeHistoryMessages(chatId, newer);
    sendNewerWindow(chatId, anchorId, afterId, silent);
  }).catch(function(err) {
    delete newerLoadPromises[key];
    done('messages_done', 0, 0, silent ? 'silent' : null);
    promiseError('Newer failed', err);
  });
}

function prefetchOlderMessages(chatId, beforeId) {
  beforeId = beforeId || '';
  var key = String(chatId || '') + ':older:' + beforeId;
  if (!chatId || !beforeId || cachedOlderRows(chatId, beforeId, OLDER_MESSAGE_ROWS).length >= OLDER_MESSAGE_ROWS || oldestComplete[chatId]) {
    return;
  }
  if (pagePrefetching[key]) {
    return;
  }
  pagePrefetching[key] = true;
  timed('older prefetch ' + chatId, withTimeout(activePgjs().olderMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, beforeId),
                                      'older prefetch timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(older) {
    delete pagePrefetching[key];
    older = older || [];
    if (older.length === 0) {
      oldestComplete[chatId] = true;
    }
    mergeHistoryMessages(chatId, older);
  }).catch(function(err) {
    delete pagePrefetching[key];
    debugLog('Older prefetch failed: ' + (err && err.message ? err.message : err));
  });
}

function prefetchNewerMessages(chatId, afterId) {
  afterId = afterId || '';
  var key = String(chatId || '') + ':newer:' + afterId;
  if (!chatId || !afterId || cachedNewerRows(chatId, afterId, NEWER_MESSAGE_ROWS).length >= NEWER_MESSAGE_ROWS || newestComplete[chatId]) {
    return;
  }
  if (pagePrefetching[key]) {
    return;
  }
  pagePrefetching[key] = true;
  timed('newer prefetch ' + chatId, withTimeout(activePgjs().newerMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, afterId),
                                      'newer prefetch timed out', MESSAGE_FETCH_TIMEOUT_MS)).then(function(newer) {
    delete pagePrefetching[key];
    newer = newer || [];
    if (newer.length === 0) {
      newestComplete[chatId] = true;
    }
    mergeHistoryMessages(chatId, newer);
  }).catch(function(err) {
    delete pagePrefetching[key];
    debugLog('Newer prefetch failed: ' + (err && err.message ? err.message : err));
  });
}

function sendMessage(chatId, text, replyTo) {
  timed('send message ' + chatId, activePgjs().sendMessage(chatId, text, replyTo)).then(function() {
    var payload = {};
    payload[MessageKeys.Type] = 'sent';
    sendToWatch(payload);
    refreshOpenChat();
  }).catch(function(err) {
    promiseError('Send failed', err);
  });
}

// "New thread" flow for threaded-mode bot chats: create a fresh topic, then
// send the first message into it. This mirrors Telegram's "send in All
// Messages" behavior that Hermes uses to start a new session per topic, and
// keeps the message out of the root lobby where Hermes rejects prompts.
function createThreadAndSend(chatId, text) {
  if (!chatId) {
    return;
  }
  var rootId = null;
  var title = threadTitleFromText(text);
  timed('create thread ' + chatId, activePgjs().createThread(chatId, title)).then(function(createdRootId) {
    rootId = createdRootId;
    return timed('send into new thread ' + chatId, activePgjs().sendMessage(chatId, text, rootId));
  }).then(function() {
    var payload = {};
    payload[MessageKeys.Type] = 'thread_created';
    sendToWatch(payload);
    // Open the fresh thread so the user sees their message + bot reply.
    if (rootId) {
      getThreadMessages(chatId, rootId);
    }
  }).catch(function(err) {
    promiseError('New thread failed', err);
  });
}

function threadTitleFromText(text) {
  var trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return 'New chat';
  }
  return trimmed.length <= 32 ? trimmed : trimmed.slice(0, 32);
}

function deleteMessage(chatId, messageId) {
  timed('delete message ' + chatId, activePgjs().deleteMessage(chatId, messageId)).then(function() {
    var payload = {};
    removeChatCache(chatId);
    payload[MessageKeys.Type] = 'deleted';
    payload[MessageKeys.MessageId] = String(messageId || '');
    sendToWatch(payload);
  }).catch(function(err) {
    promiseError('Delete failed', err);
  });
}

function editMessage(chatId, messageId, text) {
  timed('edit message ' + chatId, activePgjs().editMessage(chatId, messageId, text)).then(function() {
    var payload = {};
    payload[MessageKeys.Type] = 'edited';
    sendToWatch(payload);
    refreshOpenChat();
  }).catch(function(err) {
    promiseError('Edit failed', err);
  });
}

function sendReaction(chatId, messageId, token) {
  timed('send reaction ' + chatId, activePgjs().sendReaction(chatId, messageId, token)).then(function() {
    var payload = {};
    payload[MessageKeys.Type] = 'reacted';
    sendToWatch(payload);
    refreshOpenChat();
  }).catch(function(err) {
    verifyReaction(chatId, messageId, token).then(function(applied) {
      var payload = {};
      if (applied) {
        payload[MessageKeys.Type] = 'reacted';
        sendToWatch(payload);
      } else {
        retryReactionAfterError(chatId, messageId, token, err);
      }
    });
  });
}

function chatAction(kind, chatId) {
  var action = activePgjs()[kind];
  if (typeof action !== 'function') {
    error('Action unavailable');
    return;
  }
  timed(kind + ' ' + chatId, action(chatId)).then(function() {
    var payload = {};
    removeChatCache(chatId);
    payload[MessageKeys.Type] = 'chat_action_done';
    payload[MessageKeys.ChatId] = String(chatId || '');
    payload[MessageKeys.Text] = kind;
    sendToWatch(payload);
  }).catch(function(err) {
    promiseError('Chat action failed', err);
  });
}

function imageRequestOptions(value) {
  var text = String(value || '');
  var parts = text.split(':');
  var level = parseInt(parts[0], 10);
  var maxCost = parseInt(parts[1], 10);
  if (!isFinite(level) || level < 0) {
    level = 0;
  }
  if (!isFinite(maxCost) || maxCost <= 0) {
    maxCost = 0;
  }
  return {
    retryLevel: Math.min(3, level),
    maxCost: Math.min(65000, maxCost)
  };
}

function messageNeedsSafeImagePath(message) {
  return message && message.image_width > 0 && message.image_height > 0 &&
    message.image_height > message.image_width &&
    message.image_height / message.image_width >= 1.2;
}

function sendImage(chatId, messageId, requestText) {
  var startedAt = DEBUG_LOGS ? Date.now() : 0;
  var requestOptions = imageRequestOptions(requestText);
  var message = storedMessage(chatId, messageId);
  var forceTall = messageNeedsSafeImagePath(message);
  debugLog('PGIMG phone request chat=' + chatId + ' msg=' + messageId +
           ' retry=' + requestOptions.retryLevel +
           ' maxCost=' + requestOptions.maxCost +
           ' forceTall=' + (forceTall ? 1 : 0));
  cancelQueuedAvatarTransfers();
  cancelQueuedImageTransfers();
  imageTransferActive = true;
  var requestSeq = imageRequestSeq;
  sendImageStatus(messageId, requestOptions.retryLevel > 0 ? 'Resizing' : 'Preparing');
  withTimeout(activePgjs().imageBytes(chatId, messageId, IMAGE_WIDTH, IMAGE_SIZE, IMAGE_COLORS, IMAGE_MAX_BYTES,
                                      IMAGE_MAX_PIXELS, requestOptions.retryLevel, requestOptions.maxCost, forceTall,
                                      function(text) {
                if (requestSeq === imageRequestSeq && currentChatId === chatId) {
                  sendImageStatus(messageId, text);
                }
              }),
              'image prepare timed out', IMAGE_PREPARE_TIMEOUT_MS).then(function(bytes) {
    if (requestSeq !== imageRequestSeq || currentChatId !== chatId) {
      return;
    }
    if (DEBUG_LOGS) {
      logDuration('image prepare ' + messageId, startedAt);
    }
    sendImageStatus(messageId, 'Sending');
    sendImageBytes(messageId, bytes);
  }).catch(function(err) {
    if (requestSeq !== imageRequestSeq || currentChatId !== chatId) {
      return;
    }
    var detail = err && err.message ? err.message : String(err || 'unknown image error');
    debugLog('Image failed for ' + messageId + ': ' + detail);
    imageTransferActive = false;
    var failed = {};
    failed[MessageKeys.Type] = 'image_error';
    failed[MessageKeys.MessageId] = String(messageId || '');
    failed[MessageKeys.Error] = diagnosticText(detail, 95);
    sendToWatch(failed);
  });
}

function sendImageStatus(messageId, text) {
  var payload = {};
  payload[MessageKeys.Type] = 'image_status';
  payload[MessageKeys.MessageId] = String(messageId || '');
  payload[MessageKeys.Error] = diagnosticText(text || 'Preparing', 40);
  sendToWatch(payload);
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) +
         (bytes[offset + 1] << 16) +
         (bytes[offset + 2] << 8) +
         bytes[offset + 3];
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function pngDimensions(bytes) {
  if (!bytes || bytes.length < 24 ||
      bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20)
  };
}

function pbiDimensions(bytes) {
  if (!bytes || bytes.length < 12 || pngDimensions(bytes)) {
    return null;
  }
  var flags = readUint16LE(bytes, 2);
  var format = (flags >> 1) & 31;
  var width = readUint16LE(bytes, 8);
  var height = readUint16LE(bytes, 10);
  if (format > 4 || width <= 0 || height <= 0 || width > 512 || height > 512) {
    return null;
  }
  return {
    width: width,
    height: height
  };
}

function sendImageBytes(messageId, bytes) {
  var start = {};
  var dimensions = pngDimensions(bytes);
  var isPbi = false;
  if (!dimensions) {
    dimensions = pbiDimensions(bytes);
    isPbi = !!dimensions;
  }
  var transferId = ++imageTransferSeq;
  imageTransferActive = true;
  start[MessageKeys.Type] = 'image_start';
  start[MessageKeys.MessageId] = String(messageId || '');
  start[MessageKeys.ImageSize] = bytes.length;
  start[MessageKeys.ImageTransferId] = transferId;
  if (isPbi) {
    start[MessageKeys.Text] = 'pbi';
  }
  if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
    start[MessageKeys.ImageWidth] = dimensions.width;
    start[MessageKeys.ImageHeight] = dimensions.height;
  }
  debugLog('PGIMG phone image_start msg=' + messageId +
           ' transfer=' + transferId +
           ' bytes=' + bytes.length +
           ' format=' + (isPbi ? 'pbi' : 'png') +
           ' dims=' + (dimensions ? dimensions.width + 'x' + dimensions.height : 'unknown') +
           ' chunks=' + Math.ceil(bytes.length / IMAGE_CHUNK_SIZE));
  sendToWatch(start);

  // PNGs are chunked through AppMessage and reassembled by the C app.
  for (var offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_SIZE) {
    var chunk = {};
    var slice = bytes.subarray(offset, Math.min(offset + IMAGE_CHUNK_SIZE, bytes.length));
    var data = [];
    for (var i = 0; i < slice.length; i++) {
      data.push(slice[i]);
    }
    chunk[MessageKeys.Type] = 'image';
    chunk[MessageKeys.MessageId] = String(messageId || '');
    chunk[MessageKeys.Index] = offset;
    chunk[MessageKeys.ImageData] = data;
    chunk[MessageKeys.ImageTransferId] = transferId;
    sendToWatch(chunk);
  }

  var donePayload = {};
  donePayload[MessageKeys.Type] = 'image_done';
  donePayload[MessageKeys.MessageId] = String(messageId || '');
  donePayload[MessageKeys.ImageTransferId] = transferId;
  debugLog('PGIMG phone image_done queued msg=' + messageId +
           ' transfer=' + transferId);
  sendToWatch(donePayload);
}

function sendVoice(chatId, messageId) {
  var startedAt = DEBUG_LOGS ? Date.now() : 0;
  var message = storedMessage(chatId, messageId);
  if (!message || !message.voice_token) {
    debugLog('PGVOICE chat=' + chatId + ' msg=' + messageId + ' no voice_token; ignoring');
    return;
  }
  // Voice is a single-stream-per-watch resource. Cancel any prior voice
  // transfer before starting a new one; leave image transfers alone.
  cancelQueuedVoiceTransfers();
  voiceTransferActive = true;
  var requestSeq = voiceRequestSeq;
  var transferId = ++voiceTransferSeq;
  withTimeout(
    activePgjs().voiceBytes(chatId, messageId),
    'voice download timed out', VOICE_DOWNLOAD_TIMEOUT_MS
  ).then(function(opusBytes) {
    if (requestSeq !== voiceRequestSeq || currentChatId !== chatId) {
      return null;
    }
    if (DEBUG_LOGS) {
      logDuration('voice download ' + messageId, startedAt);
    }
    if (!opusBytes || !opusBytes.length) {
      throw new Error('empty voice bytes');
    }
    return withTimeout(
      pebblegramVoice.createStreamer()(MessageKeys, message.voice_token, transferId, opusBytes, {
        durationMs: message.voice_duration_ms || 0
      }),
      'voice decode timed out', VOICE_DECODE_TIMEOUT_MS
    );
  }).then(function(frames) {
    if (requestSeq !== voiceRequestSeq || currentChatId !== chatId) {
      return;
    }
    if (!frames || !frames.length) {
      voiceTransferActive = false;
      return;
    }
    if (DEBUG_LOGS) {
      logDuration('voice decode ' + messageId, startedAt);
    }
    for (var i = 0; i < frames.length; i++) {
      sendToWatch(frames[i]);
    }
  }).catch(function(err) {
    if (requestSeq !== voiceRequestSeq || currentChatId !== chatId) {
      return;
    }
    var detail = err && err.message ? err.message : String(err || 'unknown voice error');
    debugLog('Voice failed for ' + messageId + ': ' + detail);
    voiceTransferActive = false;
    var failed = {};
    failed[MessageKeys.Type] = 'voice_error';
    failed[MessageKeys.MessageId] = String(messageId || '');
    failed[MessageKeys.Error] = diagnosticText(detail, 95);
    sendToWatch(failed);
  });
}

function sendAvatar(chatId, bytes) {
  var start = {};
  var transferId = ++avatarTransferSeq;
  start[MessageKeys.Type] = 'avatar_start';
  start[MessageKeys.ChatId] = String(chatId || '');
  start[MessageKeys.ImageSize] = bytes.length;
  start[MessageKeys.ImageTransferId] = transferId;
  sendToWatch(start);

  for (var offset = 0; offset < bytes.length; offset += AVATAR_CHUNK_SIZE) {
    var chunk = {};
    var slice = bytes.subarray(offset, Math.min(offset + AVATAR_CHUNK_SIZE, bytes.length));
    var data = [];
    for (var i = 0; i < slice.length; i++) {
      data.push(slice[i]);
    }
    chunk[MessageKeys.Type] = 'avatar';
    chunk[MessageKeys.ChatId] = String(chatId || '');
    chunk[MessageKeys.Index] = offset;
    chunk[MessageKeys.ImageData] = data;
    chunk[MessageKeys.ImageTransferId] = transferId;
    sendToWatch(chunk);
  }

  var donePayload = {};
  donePayload[MessageKeys.Type] = 'avatar_done';
  donePayload[MessageKeys.ChatId] = String(chatId || '');
  donePayload[MessageKeys.ImageTransferId] = transferId;
  sendToWatch(donePayload);
}

function queueChatAvatars(chats) {
  avatarChats = (chats || []).slice(0, Math.min(MAX_ROWS, AVATAR_ROWS)).filter(function(chat) {
    return chat && chat.id;
  });
  avatarIndex = 0;
  scheduleChatAvatars(350);
}

function scheduleChatAvatars(delay) {
  if (avatarTimer) {
    clearTimeout(avatarTimer);
    avatarTimer = null;
  }
  if (currentChatId) {
    return;
  }
  if (avatarIndex >= avatarChats.length) {
    return;
  }
  avatarTimer = setTimeout(function() {
    avatarTimer = null;
    sendChatAvatars();
  }, delay);
}

function sendChatAvatars() {
  if (currentChatId) {
    return;
  }
  var chat = avatarChats[avatarIndex];
  if (!chat) {
    return;
  }
  activePgjs().avatarBytes(chat.id, AVATAR_SIZE, AVATAR_SIZE, AVATAR_COLORS, AVATAR_MAX_BYTES).then(function(bytes) {
    if (currentChatId) {
      return;
    }
    sendAvatar(chat.id, bytes);
    avatarIndex++;
    scheduleChatAvatars(80);
  }).catch(function(err) {
    debugLog('Avatar failed for ' + chat.id + ': ' + (err && err.message ? err.message : err));
    avatarIndex++;
    scheduleChatAvatars(20);
  });
}

Pebble.addEventListener('ready', function() {
  watchReady = true;
  logLaunch('Pebble ready event');
  configureForPlatform();
  debugLog('Pebblegram JS ready, backend=pgjs, canned=' + cannedReplies());
  prewarmPhoneBackend();
  getChats(false);
});

Pebble.addEventListener('appmessage', function(event) {
  var command = payloadValue(event.payload, 'Command');
  var chatId = payloadValue(event.payload, 'ChatId');
  var text = payloadValue(event.payload, 'Text');
  var replyTo = payloadValue(event.payload, 'ReplyTo');
  var messageId = payloadValue(event.payload, 'MessageId');
  var editMessageId = payloadValue(event.payload, 'EditMessageId');
  var threadId = payloadValue(event.payload, 'ThreadId');

  if (command === 'wake') {
    wakePhoneBackend();
  } else if (command === 'chat_first_paint') {
    runPostFirstPaintWork();
  } else if (command === 'get_chats') {
    getChats(false);
  } else if (command === 'get_messages') {
    getMessages(chatId);
  } else if (command === 'open_thread') {
    getThreadMessages(chatId, messageId);
  } else if (command === 'get_older_messages') {
    getOlderMessages(chatId, messageId, replyTo, text === 'silent', threadId);
  } else if (command === 'get_newer_messages') {
    getNewerMessages(chatId, messageId, replyTo, text === 'silent', threadId);
  } else if (command === 'prefetch_older_messages') {
    prefetchOlderMessages(chatId, messageId);
  } else if (command === 'prefetch_newer_messages') {
    prefetchNewerMessages(chatId, messageId);
  } else if (command === 'get_context') {
    sendMessageContext(chatId, messageId);
  } else if (command === 'get_message_text') {
    sendFullMessageText(chatId, messageId);
  } else if (command === 'leave_chat') {
    leaveChat(chatId);
  } else if (command === 'send_message') {
    sendMessage(chatId, text, replyTo);
  } else if (command === 'create_thread') {
    createThreadAndSend(chatId, text);
  } else if (command === 'delete_message') {
    deleteMessage(chatId, messageId);
  } else if (command === 'edit_message') {
    editMessage(chatId, editMessageId || messageId, text);
  } else if (command === 'send_reaction') {
    sendReaction(chatId, messageId, text);
  } else if (command === 'archive_chat') {
    chatAction('archiveChat', chatId);
  } else if (command === 'delete_chat') {
    chatAction('deleteChat', chatId);
  } else if (command === 'mute_chat') {
    chatAction('muteChat', chatId);
  } else if (command === 'mark_unread') {
    chatAction('markUnread', chatId);
  } else if (command === 'get_image') {
    sendImage(chatId, messageId, text);
  } else if (command === 'cancel_image') {
    cancelQueuedImageTransfers();
  } else if (command === 'get_voice') {
    sendVoice(chatId, messageId);
  } else if (command === 'cancel_voice') {
    cancelQueuedVoiceTransfers();
  } else {
    error('Command failed');
  }
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(settingsPageUrl());
});

Pebble.addEventListener('webviewclosed', function(event) {
  if (!event || !event.response) {
    return;
  }
  var data;
  try {
    data = JSON.parse(decodeURIComponent(event.response));
  } catch (e) {
    debugLog('settings parse failed: ' + e.message);
    return;
  }

  activePgjs().applySettings(data);
  if (data.cannedReplies) {
    localStorage.setItem('cannedReplies', data.cannedReplies);
  }
  sendSettings();
  status('Requesting Telegram login...');
  timed('telegram login', activePgjs().ready()).then(function() {
    status('Telegram connected');
    getChats(false);
  }).catch(function(err) {
    debugLog('Auth failed: ' + (err && err.message ? err.message : String(err || 'unknown error')));
    error(err && err.message ? err.message : 'Auth failed');
  });
});
