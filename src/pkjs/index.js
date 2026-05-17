var MessageKeys = require('message_keys');
var pgjsBackend = require('./pgjs/backend');

var USE_MOCK_BACKEND = false;
var TELEGRAM_SETTINGS_PAGE_URL = 'https://tombolger.github.io/Pebblegram/pgjs/config.html';
var MAX_ROWS = 20;
var INITIAL_MESSAGE_ROWS = 8;
var OLDER_MESSAGE_ROWS = 6;
var NEWER_MESSAGE_ROWS = 6;
var MESSAGE_PAGE_FETCH_ROWS = 80;
var PHONE_MESSAGE_CACHE_ROWS = 600;
var MAX_MESSAGE_ROWS = 8;
var MESSAGE_EDGE_BUFFER_ROWS = 3;
var MAX_MESSAGE_TEXT = 340;
var MAX_CONTEXT_VIEW_TEXT = 700;
var MESSAGE_WINDOW_BUDGET = 3200;
var IMAGE_SIZE = 120;
var IMAGE_WIDTH = 130;
var IMAGE_COLORS = 64;
var IMAGE_MAX_BYTES = 10000;
var IMAGE_CHUNK_SIZE = 500;
var AVATAR_SIZE = 28;
var AVATAR_COLORS = 16;
var AVATAR_MAX_BYTES = 3000;
var AVATAR_CHUNK_SIZE = 500;
var AVATAR_ROWS = MAX_ROWS;
var PREFETCH_CHAT_COUNT = 4;
var sendQueue = [];
var sending = false;
var messageStore = {};
var messageHistoryStore = {};
var oldestComplete = {};
var newestComplete = {};
var prefetching = {};
var mediaWarming = {};
var pgjs = null;
var currentChatId = null;
var currentChatSignature = '';
var updateRefreshTimer = null;
var updatesStarted = false;
var connectionKeepaliveTimer = null;
var chatListStale = false;
var avatarChats = [];
var avatarIndex = 0;
var avatarTimer = null;
var knownAvatarChats = {};
var imageTransferSeq = 0;
var avatarTransferSeq = 0;
var imageRequestSeq = 0;
var imageTransferActive = false;
var messageStreamSeq = 0;
var messageStreamTimer = null;
var sendFailureDelay = 250;

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
      mock: USE_MOCK_BACKEND,
      cannedReplies: cannedReplies,
      status: status
    });
  }
  return pgjs;
}

function configureForPlatform() {
  var info = null;
  try {
    info = Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
  } catch (e) {
    info = null;
  }
  if (info && info.platform === 'emery') {
    INITIAL_MESSAGE_ROWS = 8;
    OLDER_MESSAGE_ROWS = 6;
    NEWER_MESSAGE_ROWS = 6;
    MAX_MESSAGE_ROWS = 8;
    MAX_MESSAGE_TEXT = 300;
    MAX_CONTEXT_VIEW_TEXT = 700;
    MESSAGE_WINDOW_BUDGET = 3200;
    IMAGE_SIZE = 156;
    IMAGE_WIDTH = 170;
    IMAGE_MAX_BYTES = 20000;
    IMAGE_CHUNK_SIZE = 500;
  } else if (info && info.platform === 'gabbro') {
    INITIAL_MESSAGE_ROWS = 8;
    OLDER_MESSAGE_ROWS = 6;
    NEWER_MESSAGE_ROWS = 6;
    MAX_MESSAGE_ROWS = 8;
    MAX_MESSAGE_TEXT = 300;
    MAX_CONTEXT_VIEW_TEXT = 700;
    MESSAGE_WINDOW_BUDGET = 3200;
    IMAGE_SIZE = 118;
    IMAGE_WIDTH = 128;
    IMAGE_MAX_BYTES = 20000;
    IMAGE_CHUNK_SIZE = 500;
  } else if (info && info.platform === 'diorite') {
    IMAGE_SIZE = 96;
    IMAGE_WIDTH = 102;
    IMAGE_COLORS = 4;
    IMAGE_MAX_BYTES = 6000;
    AVATAR_SIZE = 24;
    AVATAR_COLORS = 4;
    AVATAR_MAX_BYTES = 2200;
  } else if (info && info.platform === 'basalt') {
    IMAGE_SIZE = 96;
    IMAGE_WIDTH = 104;
    IMAGE_COLORS = 16;
    IMAGE_MAX_BYTES = 6500;
  }
}

function logDuration(label, startedAt) {
  console.log(label + ' took ' + (Date.now() - startedAt) + 'ms');
}

function timed(label, promise) {
  var startedAt = Date.now();
  return promise.then(function(value) {
    logDuration(label, startedAt);
    return value;
  }, function(err) {
    logDuration(label + ' failed', startedAt);
    throw err;
  });
}

// AppMessage delivery is serialized. Older phones can drop messages if image
// chunks and rows are pushed in parallel.
function sendToWatch(payload) {
  sendQueue.push({payload: payload, queuedAt: Date.now()});
  flushQueue();
}

function isAvatarTransferPayload(payload) {
  var type = payload && payload[MessageKeys.Type];
  return type === 'avatar_start' || type === 'avatar' || type === 'avatar_done';
}

function isImageTransferPayload(payload) {
  var type = payload && payload[MessageKeys.Type];
  return type === 'image_start' || type === 'image' || type === 'image_done' || type === 'image_error';
}

function isMessageTransferPayload(payload) {
  var type = payload && payload[MessageKeys.Type];
  return type === 'messages_start' || type === 'message' || type === 'message_prepend' || type === 'message_append' || type === 'messages_done';
}

function cancelQueuedMessageTransfers() {
  messageStreamSeq += 1;
  if (messageStreamTimer) {
    clearTimeout(messageStreamTimer);
    messageStreamTimer = null;
  }
  sendQueue = sendQueue.filter(function(entry, index) {
    return index === 0 && sending ? true : !isMessageTransferPayload(entry.payload);
  });
}

function cancelQueuedImageTransfers() {
  imageRequestSeq += 1;
  imageTransferActive = false;
  sendQueue = sendQueue.filter(function(entry, index) {
    return index === 0 && sending ? true : !isImageTransferPayload(entry.payload);
  });
}

function cancelQueuedAvatarTransfers() {
  if (avatarTimer) {
    clearTimeout(avatarTimer);
    avatarTimer = null;
  }
  sendQueue = sendQueue.filter(function(entry, index) {
    return index === 0 && sending ? true : !isAvatarTransferPayload(entry.payload);
  });
}

function flushQueue() {
  if (sending || sendQueue.length === 0) {
    return;
  }
  sending = true;
  var entry = sendQueue[0];
  Pebble.sendAppMessage(entry.payload, function() {
    sendFailureDelay = 250;
    if (entry.payload[MessageKeys.Type] === 'image_done' ||
        entry.payload[MessageKeys.Type] === 'chats_done' ||
        entry.payload[MessageKeys.Type] === 'messages_done') {
      logDuration('AppMessage ' + entry.payload[MessageKeys.Type] + ' queue', entry.queuedAt);
    }
    if (entry.payload[MessageKeys.Type] === 'image_done' ||
        entry.payload[MessageKeys.Type] === 'image_error') {
      imageTransferActive = false;
    }
    sendQueue.shift();
    sending = false;
    flushQueue();
  }, function(error) {
    sending = false;
    console.log('sendAppMessage failed: ' + JSON.stringify(error));
    setTimeout(flushQueue, sendFailureDelay);
    sendFailureDelay = Math.min(5000, Math.floor(sendFailureDelay * 1.6));
  });
}

function status(text) {
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
  console.log(prefix + ': ' + message);
  error(prefix + ': ' + message);
}

function clampText(value, maxLength) {
  value = String(value || '');
  if (value.length <= maxLength) {
    return value;
  }
  return value.substring(0, maxLength - 1);
}

function watchText(value, maxLength) {
  value = String(value || '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(https?:\/\/|www\.)[^\s]+/ig, function(url) {
      var match = url.match(/^(?:https?:\/\/)?(?:www\.)?([^\/?#]+)/i);
      return match ? '[Link] ' + match[1] : '[Link]';
    })
    .replace(/[^\s]{36,}/g, function(token) {
      return token.substring(0, 28) + '...';
    })
    .trim();
  return clampText(value, maxLength);
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
  payload[MessageKeys.Text] = clampText(chat.preview, 71);
  payload[MessageKeys.IsUnread] = chat.unread ? 1 : 0;
  payload[MessageKeys.UnreadCount] = chat.unread_count || 0;
  return payload;
}

function sendChatRows(chats, silent) {
  var rows = (chats || []).slice(0, MAX_ROWS);
  var index = 0;
  if (!silent) {
    status('Loading first chat...');
  }
  function pump() {
    if (index >= rows.length) {
      done('chats_done', rows.length);
      return;
    }
    sendToWatch(chatPayload(rows[index], index, rows.length));
    index += 1;
    setTimeout(pump, index === 1 ? 10 : 24);
  }
  pump();
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
    payload[MessageKeys.Reactions] = clampUtf8Bytes(message.reactions, 16);
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
  streamMessageRows(chatId || currentChatId, messages, mode || 'initial', finalCount);
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

function mergeHistoryMessages(chatId, rows) {
  var existing = messageHistoryStore[chatId] || [];
  var byId = {};
  existing.concat(rows || []).forEach(function(message) {
    if (message && message.id !== undefined && message.id !== null) {
      byId[String(message.id)] = message;
    }
  });
  var merged = Object.keys(byId).map(function(id) {
    return byId[id];
  }).sort(compareMessageIds);
  if (merged.length > PHONE_MESSAGE_CACHE_ROWS) {
    merged = merged.slice(merged.length - PHONE_MESSAGE_CACHE_ROWS);
  }
  messageHistoryStore[chatId] = merged;
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
  var current = messageStore[chatId] || [];
  var rows = cachedOlderRows(chatId, beforeId || anchorId, OLDER_MESSAGE_ROWS);
  var merged;
  if (!rows.length) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return 0;
  }
  merged = mergeHistoryMessages(chatId, rows.concat(current));
  messageStore[chatId] = messageWindowAroundAnchor(merged, anchorId, MESSAGE_EDGE_BUFFER_ROWS);
  sendMessageWindow(chatId, messageStore[chatId], 'older', silent, messageStore[chatId].length);
  return rows.length;
}

function sendNewerWindow(chatId, anchorId, afterId, silent) {
  var current = messageStore[chatId] || [];
  var rows = cachedNewerRows(chatId, afterId || anchorId, NEWER_MESSAGE_ROWS);
  var merged;
  if (!rows.length) {
    done('messages_done', 0, 0, silent ? 'silent' : null);
    return 0;
  }
  merged = mergeHistoryMessages(chatId, current.concat(rows));
  messageStore[chatId] = messageWindowAroundAnchor(merged, anchorId,
                                                     MAX_MESSAGE_ROWS - MESSAGE_EDGE_BUFFER_ROWS - 1);
  sendMessageWindow(chatId, messageStore[chatId], 'newer', silent, messageStore[chatId].length);
  return rows.length;
}

function warmMessageMedia(chatId, messages) {
  var rows = messages || [];
  var delay = 0;
  rows.forEach(function(message) {
    var key;
    if (!message || !message.image_token) {
      return;
    }
    key = String(chatId) + ':' + String(message.image_token);
    if (mediaWarming[key]) {
      return;
    }
    mediaWarming[key] = true;
    setTimeout(function() {
      activePgjs().imageBytes(chatId, message.image_token, IMAGE_WIDTH, IMAGE_SIZE, IMAGE_COLORS, IMAGE_MAX_BYTES).catch(function(err) {
        console.log('Media warm failed ' + key + ': ' + (err && err.message ? err.message : err));
      });
    }, delay);
    delay += 250;
  });
}

function warmChatHistory(chatId) {
  if (!chatId || prefetching[chatId]) {
    return;
  }
  prefetching[chatId] = true;
  timed('warm history ' + chatId, activePgjs().messages(chatId, MESSAGE_PAGE_FETCH_ROWS)).then(function(messages) {
    delete prefetching[chatId];
    messages = messages || [];
    mergeHistoryMessages(chatId, messages);
    if (!messageStore[chatId]) {
      messageStore[chatId] = limitMessageWindow(messages, true);
    }
    warmMessageMedia(chatId, messages);
  }).catch(function(err) {
    delete prefetching[chatId];
    console.log('History warm failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function rememberMessages(chatId, messages) {
  messages = messages || [];
  mergeHistoryMessages(chatId, messages);
  messageStore[chatId] = limitMessageWindow(messages, true);
  warmMessageMedia(chatId, messages);
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
      if (messageSignature([previous]) !== messageSignature([message])) {
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
  if (!messages || messages.length === 0) {
    return false;
  }
  currentChatSignature = messageSignature(messages);
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
  chats.slice(0, PREFETCH_CHAT_COUNT).forEach(function(chat) {
    prefetchMessages(chat.id);
  });
}

function scheduleUpdateRefresh(delay) {
  if (updateRefreshTimer) {
    return;
  }
  updateRefreshTimer = setTimeout(function() {
    updateRefreshTimer = null;
    if (imageTransferActive) {
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
  if (connectionKeepaliveTimer || USE_MOCK_BACKEND) {
    return;
  }
  connectionKeepaliveTimer = setInterval(function() {
    activePgjs().ready().catch(function(err) {
      console.log('Keepalive reconnect failed: ' + (err && err.message ? err.message : err));
    });
  }, 60000);
}

function startTelegramUpdates() {
  if (updatesStarted) {
    return;
  }
  updatesStarted = true;
  activePgjs().ready().then(function(client) {
    if (!client || typeof client.addEventHandler !== 'function') {
      console.log('Telegram updates unavailable; chat list refresh is manual only.');
      return;
    }
    client.addEventHandler(handleTelegramUpdate);
    console.log('Telegram updates enabled.');
  }).catch(function(err) {
    updatesStarted = false;
    console.log('Telegram updates failed: ' + (err && err.message ? err.message : err));
  });
}

function getChats(silent) {
  if (!silent) {
    status('Connecting...');
  }
  timed('telegram connect', activePgjs().ready()).then(function() {
    if (!silent) {
      status('Fetching chats...');
    }
    return timed('chat list load', activePgjs().chats(MAX_ROWS));
  }).then(function(chats) {
    chats = chats || [];
    sendChatRows(chats, silent);
    queueChatAvatars(chats, silent);
    prefetchTopChats(chats);
  }).catch(function(err) {
    if (silent) {
      console.log('Silent chats failed: ' + (err && err.message ? err.message : err));
    } else {
      promiseError('Chats failed', err);
    }
  });
}

function getMessages(chatId) {
  currentChatId = chatId;
  currentChatSignature = '';
  cancelUpdateRefresh();
  cancelQueuedMessageTransfers();
  cancelQueuedAvatarTransfers();
  cancelQueuedImageTransfers();
  if (sendStoredMessages(chatId)) {
    return;
  }
  status('Loading messages...');
  timed('messages load ' + chatId, activePgjs().messages(chatId, INITIAL_MESSAGE_ROWS)).then(function(messages) {
    rememberMessages(chatId, messages || []);
    currentChatSignature = messageSignature(messages || []);
    markRead(chatId);
    sendMessageRows(messages || [], chatId, 'initial');
    warmChatHistory(chatId);
  }).catch(function(err) {
    promiseError('Messages failed', err);
  });
}

function refreshOpenChat() {
  var chatId = currentChatId;
  if (!chatId) {
    return;
  }
  activePgjs().messages(chatId, INITIAL_MESSAGE_ROWS).then(function(messages) {
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
    mergeHistoryMessages(chatId, messages);
    warmMessageMedia(chatId, messages);
    var merged = mergeMessages(existing, messages, attachedToNewest, attachedToNewest);
    if (attachedToNewest) {
      messageStore[chatId] = merged.messages;
      markRead(chatId);
      sendMessageWindow(chatId, messageStore[chatId], 'initial', false);
    } else if (merged.changed) {
      messageStore[chatId] = merged.messages;
    }
  }).catch(function(err) {
    console.log('Open chat refresh failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function leaveChat(chatId) {
  if (!chatId || currentChatId === chatId) {
    currentChatId = null;
    currentChatSignature = '';
    cancelQueuedMessageTransfers();
    cancelQueuedImageTransfers();
    scheduleChatAvatars(300);
    if (chatListStale) {
      chatListStale = false;
      getChats(true);
    }
  }
}

function messageSignature(messages) {
  return messages.map(function(message) {
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
      message.outgoing ? '1' : '0'
    ].join('|');
  }).join('~');
}

function markRead(chatId) {
  activePgjs().markRead(chatId).catch(function(err) {
    console.log('Mark read failed for ' + chatId + ': ' + (err && err.message ? err.message : err));
  });
}

function getOlderMessages(chatId, anchorId, beforeId, silent) {
  beforeId = beforeId || anchorId;
  if (!beforeId) {
    return;
  }
  if (cachedOlderRows(chatId, beforeId, OLDER_MESSAGE_ROWS).length >= OLDER_MESSAGE_ROWS || oldestComplete[chatId]) {
    sendOlderWindow(chatId, anchorId, beforeId, silent);
    return;
  }
  if (!silent) {
    status('Loading older...');
  }
  timed('older messages load ' + chatId, activePgjs().olderMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, beforeId)).then(function(older) {
    older = older || [];
    if (older.length === 0) {
      oldestComplete[chatId] = true;
    }
    mergeHistoryMessages(chatId, older);
    warmMessageMedia(chatId, older);
    sendOlderWindow(chatId, anchorId, beforeId, silent);
  }).catch(function(err) {
    promiseError('Older failed', err);
  });
}

function getNewerMessages(chatId, anchorId, afterId, silent) {
  afterId = afterId || anchorId;
  if (!afterId) {
    return;
  }
  if (cachedNewerRows(chatId, afterId, NEWER_MESSAGE_ROWS).length >= NEWER_MESSAGE_ROWS || newestComplete[chatId]) {
    sendNewerWindow(chatId, anchorId, afterId, silent);
    return;
  }
  if (!silent) {
    status('Loading newer...');
  }
  timed('newer messages load ' + chatId, activePgjs().newerMessages(chatId, MESSAGE_PAGE_FETCH_ROWS, afterId)).then(function(newer) {
    newer = newer || [];
    if (newer.length === 0) {
      newestComplete[chatId] = true;
    }
    mergeHistoryMessages(chatId, newer);
    warmMessageMedia(chatId, newer);
    sendNewerWindow(chatId, anchorId, afterId, silent);
  }).catch(function(err) {
    promiseError('Newer failed', err);
  });
}

function sendMessage(chatId, text, replyTo) {
  timed('send message ' + chatId, activePgjs().sendMessage(chatId, text, replyTo)).then(function() {
    var payload = {};
    delete messageStore[chatId];
    delete messageHistoryStore[chatId];
    delete oldestComplete[chatId];
    delete newestComplete[chatId];
    payload[MessageKeys.Type] = 'sent';
    sendToWatch(payload);
  }).catch(function(err) {
    promiseError('Send failed', err);
  });
}

function deleteMessage(chatId, messageId) {
  timed('delete message ' + chatId, activePgjs().deleteMessage(chatId, messageId)).then(function() {
    var payload = {};
    delete messageStore[chatId];
    delete messageHistoryStore[chatId];
    delete oldestComplete[chatId];
    delete newestComplete[chatId];
    payload[MessageKeys.Type] = 'deleted';
    sendToWatch(payload);
  }).catch(function(err) {
    promiseError('Delete failed', err);
  });
}

function editMessage(chatId, messageId, text) {
  timed('edit message ' + chatId, activePgjs().editMessage(chatId, messageId, text)).then(function() {
    var payload = {};
    delete messageStore[chatId];
    delete messageHistoryStore[chatId];
    delete oldestComplete[chatId];
    delete newestComplete[chatId];
    payload[MessageKeys.Type] = 'edited';
    sendToWatch(payload);
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
    promiseError('Reaction failed', err);
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
    delete messageStore[chatId];
    delete messageHistoryStore[chatId];
    delete oldestComplete[chatId];
    delete newestComplete[chatId];
    payload[MessageKeys.Type] = 'chat_action_done';
    payload[MessageKeys.ChatId] = String(chatId || '');
    payload[MessageKeys.Text] = kind;
    sendToWatch(payload);
  }).catch(function(err) {
    promiseError('Chat action failed', err);
  });
}

function sendImage(chatId, messageId) {
  var startedAt = Date.now();
  cancelQueuedAvatarTransfers();
  cancelQueuedImageTransfers();
  imageTransferActive = true;
  var requestSeq = imageRequestSeq;
  activePgjs().imageBytes(chatId, messageId, IMAGE_WIDTH, IMAGE_SIZE, IMAGE_COLORS, IMAGE_MAX_BYTES).then(function(bytes) {
    if (requestSeq !== imageRequestSeq || currentChatId !== chatId) {
      return;
    }
    logDuration('image prepare ' + messageId, startedAt);
    sendImageBytes(messageId, bytes);
  }).catch(function(err) {
    if (requestSeq !== imageRequestSeq || currentChatId !== chatId) {
      return;
    }
    console.log('Image failed: ' + (err && err.message ? err.message : err));
    imageTransferActive = false;
    var failed = {};
    failed[MessageKeys.Type] = 'image_error';
    failed[MessageKeys.MessageId] = String(messageId || '');
    sendToWatch(failed);
  });
}

function sendImageBytes(messageId, bytes) {
  var start = {};
  var transferId = ++imageTransferSeq;
  imageTransferActive = true;
  start[MessageKeys.Type] = 'image_start';
  start[MessageKeys.MessageId] = String(messageId || '');
  start[MessageKeys.ImageSize] = bytes.length;
  start[MessageKeys.ImageTransferId] = transferId;
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
  sendToWatch(donePayload);
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

function queueChatAvatars(chats, onlyMissing) {
  avatarChats = (chats || []).slice(0, Math.min(MAX_ROWS, AVATAR_ROWS)).filter(function(chat) {
    return chat && chat.id && (!onlyMissing || !knownAvatarChats[chat.id]);
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
    knownAvatarChats[chat.id] = true;
    sendAvatar(chat.id, bytes);
    avatarIndex++;
    scheduleChatAvatars(80);
  }).catch(function(err) {
    console.log('Avatar failed for ' + chat.id + ': ' + (err && err.message ? err.message : err));
    avatarIndex++;
    scheduleChatAvatars(20);
  });
}

Pebble.addEventListener('ready', function() {
  configureForPlatform();
  console.log('Pebblegram JS ready, backend=' + (USE_MOCK_BACKEND ? 'mock' : 'pgjs') + ', canned=' + cannedReplies());
  sendSettings();
  activePgjs().ready().catch(function(err) {
    console.log('Warm connect failed: ' + (err && err.message ? err.message : err));
  });
  startConnectionKeepalive();
  startTelegramUpdates();
  getChats(false);
});

Pebble.addEventListener('appmessage', function(event) {
  var command = payloadValue(event.payload, 'Command');
  var chatId = payloadValue(event.payload, 'ChatId');
  var text = payloadValue(event.payload, 'Text');
  var replyTo = payloadValue(event.payload, 'ReplyTo');
  var messageId = payloadValue(event.payload, 'MessageId');
  var editMessageId = payloadValue(event.payload, 'EditMessageId');

  if (command === 'get_chats') {
    getChats(false);
  } else if (command === 'get_messages') {
    getMessages(chatId);
  } else if (command === 'get_older_messages') {
    getOlderMessages(chatId, messageId, replyTo, text === 'silent');
  } else if (command === 'get_newer_messages') {
    getNewerMessages(chatId, messageId, replyTo, text === 'silent');
  } else if (command === 'get_context') {
    sendMessageContext(chatId, messageId);
  } else if (command === 'get_message_text') {
    sendFullMessageText(chatId, messageId);
  } else if (command === 'leave_chat') {
    leaveChat(chatId);
  } else if (command === 'send_message') {
    sendMessage(chatId, text, replyTo);
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
    sendImage(chatId, messageId);
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
    console.log('settings parse failed: ' + e.message);
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
    console.log('Auth failed: ' + (err && err.message ? err.message : String(err || 'unknown error')));
    error(err && err.message ? err.message : 'Auth failed');
  });
});
