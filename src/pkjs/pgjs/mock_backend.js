var UPDATE_INTERVAL_MS = 14000;
var updateTimer = null;
var updateHandlers = [];
var nextMessageId = 9000;
var tick = 0;

var reactionGlyphs = {
  like: '\ud83d\udc4d',
  heart: '\u2764',
  laugh: '\ud83e\udd23',
  wow: '\ud83d\ude31',
  sad: '\ud83d\ude22',
  angry: '\ud83d\ude21'
};

var MOCK_AVATAR_PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x20,
  0x08, 0x03, 0x00, 0x00, 0x00, 0x44, 0xa4, 0x8a, 0xc6, 0x00, 0x00, 0x00,
  0x0c, 0x50, 0x4c, 0x54, 0x45, 0x28, 0x78, 0xdc, 0xf5, 0xcd, 0x46, 0x23,
  0x23, 0x23, 0xe6, 0xe6, 0xe6, 0x69, 0xfd, 0x4f, 0x38, 0x00, 0x00, 0x00,
  0x2f, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x60, 0x00, 0x02, 0x46,
  0x20, 0x60, 0x02, 0x02, 0x66, 0x20, 0xc0, 0xc6, 0xa7, 0xb5, 0x82, 0x81,
  0xb6, 0x1f, 0x04, 0xf0, 0x49, 0x82, 0xf8, 0xf4, 0x50, 0x80, 0x4f, 0x12,
  0xc4, 0xa7, 0x87, 0x82, 0xd1, 0xf4, 0x30, 0x9a, 0x1e, 0x90, 0xf8, 0x00,
  0x64, 0xd4, 0x06, 0x01, 0x40, 0xc3, 0x54, 0x92, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
];

var MOCK_PHOTO_PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0xec,
  0x08, 0x03, 0x00, 0x00, 0x00, 0x8b, 0xd6, 0x5e, 0xd8, 0x00, 0x00, 0x00,
  0x12, 0x50, 0x4c, 0x54, 0x45, 0x1e, 0x6e, 0xd2, 0xf5, 0xcd, 0x46, 0x23,
  0x23, 0x23, 0xe6, 0xe6, 0xe6, 0x78, 0xc8, 0x5f, 0xdc, 0x50, 0x78, 0x90,
  0xb0, 0x0e, 0x11, 0x00, 0x00, 0x00, 0xc0, 0x49, 0x44, 0x41, 0x54, 0x78,
  0xda, 0xed, 0xda, 0xb1, 0x01, 0x80, 0x30, 0x10, 0x02, 0xc0, 0x8f, 0xc6,
  0xfd, 0x57, 0xb6, 0x25, 0xad, 0x0d, 0x85, 0xc7, 0x00, 0x70, 0x03, 0x30,
  0x13, 0x59, 0x91, 0x2b, 0x72, 0x47, 0x76, 0xe4, 0x89, 0x7c, 0xed, 0x19,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3a, 0xa0, 0x31, 0x9a, 0x3d,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7d, 0x40, 0x63, 0xf4, 0xe8,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xa8, 0x03, 0x2a, 0xa3, 0xd1,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xd0, 0x07, 0x34, 0x46, 0xb3,
  0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xa0, 0x0f, 0x68, 0x8c, 0x66,
  0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x1f, 0xe0, 0x51, 0x09,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x51, 0x09, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xe0, 0x51, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xe0, 0x51, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x51, 0x09,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x51, 0x09, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xe0, 0x51, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xe0, 0x51, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x51, 0x09,
  0x00, 0x00, 0x00, 0xf0, 0x7b, 0xc0, 0x0b, 0x0f, 0xf8, 0x27, 0x60, 0x4d,
  0x6e, 0xd7, 0x82, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
];

var chats = [
  {id: '1001', title: 'Pinned Family', pinned: true, unread: true, unread_count: 2, muted: false, archived: false},
  {id: '1002', title: 'Photo Stress Test', pinned: false, unread: false, unread_count: 0, muted: false, archived: false},
  {id: '1003', title: 'Links and Media', pinned: false, unread: true, unread_count: 5, muted: false, archived: false},
  {id: '1004', title: 'Unread Marker', pinned: false, unread: true, unread_count: 0, muted: false, archived: false},
  {id: '1005', title: 'Muted Project', pinned: false, unread: false, unread_count: 0, muted: true, archived: false},
  {id: '1006', title: 'Archive Candidate', pinned: false, unread: false, unread_count: 0, muted: false, archived: false},
  {id: '1007', title: 'Long Names and Wrapping', pinned: false, unread: false, unread_count: 0, muted: false, archived: false},
  {id: '1008', title: 'Basalt Photos', pinned: false, unread: false, unread_count: 0, muted: false, archived: false}
];

var messages = {
  '1001': [
    message(100, 'Maya', 'Pinned chat stays above regular chats.', false),
    message(101, 'You', 'Good. This one has a reaction target too.', true, null, '\ud83d\udc4d2'),
    message(102, 'Maya', 'Live updates should not yank the selection around.', false)
  ],
  '1002': [
    message(200, 'Riley', 'Several photos in a row exercise image eviction.', false),
    imageMessage(201, 'Riley', 'Tall screenshot preview', false, 720, 1600),
    imageMessage(202, 'Riley', 'Wide landscape preview', false, 1600, 720),
    imageMessage(203, 'Riley', 'Square crop preview', false, 1200, 1200),
    imageMessage(204, 'Riley', 'Second nearby image should still load reliably.', false, 900, 1400),
    message(205, 'You', 'Fast scrolling should pass image bubbles cleanly.', true)
  ],
  '1003': [
    message(300, 'Sam', '[Link] youtube.com Test link preview title', false, 'link:300'),
    message(301, 'Sam', '[GIF preview] wave.gif', false, 'gif:301'),
    message(302, 'Sam', '[Video preview] short_clip.mp4', false, 'video:302'),
    message(303, 'Sam', '[Audio] voice-note.ogg', false),
    message(304, 'Sam', '[File] schedule.pdf', false),
    message(305, 'You', 'Reactions should show as emoji when supported.', true, null, '\u2764')
  ],
  '1004': [
    message(400, 'Jordan', 'This chat is marked unread with a dot only.', false),
    message(401, 'Jordan', 'No unread count, just the generic marker.', false)
  ],
  '1005': [
    message(500, 'Casey', 'Mute and unmute actions can be tested here.', false),
    message(501, 'You', 'The mock keeps the list stable after actions.', true)
  ],
  '1006': [
    message(600, 'Taylor', 'Archive and delete are safe in mock mode.', false),
    message(601, 'Taylor', 'Deleted chats disappear from this test list.', false)
  ],
  '1007': [
    message(700, 'Long Name', 'A very long message body gives us wrapping and scroll behavior to inspect without needing a real Telegram account during emulator loops.', false),
    message(701, 'You', 'Holding up and down should still feel quick.', true)
  ],
  '1008': [
    imageMessage(800, 'Alex', 'Basalt-sized image target', false, 640, 900),
    imageMessage(801, 'Alex', 'Another image follows closely', false, 900, 640),
    message(802, 'Alex', 'If this fails in emulator, the bug is in UI/image transfer, not Telegram.', false)
  ]
};

function message(id, sender, text, outgoing, imageToken, reactions) {
  return {
    id: String(id),
    sender: outgoing ? 'You' : sender,
    text: text || '',
    reactions: reactions || '',
    outgoing: !!outgoing,
    image_token: imageToken || null,
    image_width: 0,
    image_height: 0
  };
}

function imageMessage(id, sender, text, outgoing, width, height) {
  var row = message(id, sender, text, outgoing, 'image:' + id, '');
  row.image_width = width;
  row.image_height = height;
  return row;
}

function sortedChats() {
  return chats.filter(function(chat) {
    return !chat.archived && !chat.deleted;
  }).map(function(chat, index) {
    var rows = messages[chat.id] || [];
    var last = rows[rows.length - 1] || {};
    return {
      id: chat.id,
      title: chat.title,
      preview: last.text || '',
      unread: !!chat.unread || !!chat.unread_count,
      unread_count: chat.unread_count || 0,
      pinned: !!chat.pinned,
      order: chat.order === undefined ? index : chat.order,
      updated: chat.updated || 0
    };
  }).sort(function(a, b) {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.updated !== b.updated) {
      return b.updated - a.updated;
    }
    return a.order - b.order;
  });
}

function cloneRows(rows) {
  return (rows || []).map(function(row) {
    var copy = {};
    var key;
    for (key in row) {
      if (row.hasOwnProperty(key)) {
        copy[key] = row[key];
      }
    }
    return copy;
  });
}

function chatById(chatId) {
  for (var i = 0; i < chats.length; i += 1) {
    if (chats[i].id === String(chatId)) {
      return chats[i];
    }
  }
  return null;
}

function delayed(value, delay) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve(value);
    }, delay || 120);
  });
}

function emitUpdate(chatId) {
  var update = {
    message: {
      peerId: {
        userId: String(chatId)
      }
    }
  };
  updateHandlers.forEach(function(handler) {
    try {
      handler(update);
    } catch (e) {
      console.log('mock update handler failed: ' + e.message);
    }
  });
}

function startUpdates() {
  if (updateTimer) {
    return;
  }
  updateTimer = setInterval(function() {
    var chat = chatById('1003');
    var row;
    if (!chat || chat.archived || chat.deleted) {
      return;
    }
    tick += 1;
    row = message(nextMessageId++, 'Sam', 'Mock live update #' + tick, false);
    messages[chat.id].push(row);
    chat.unread_count = (chat.unread_count || 0) + 1;
    chat.unread = true;
    chat.updated = Date.now();
    emitUpdate(chat.id);
  }, UPDATE_INTERVAL_MS);
}

function ready() {
  startUpdates();
  return delayed({
    addEventHandler: function(handler) {
      if (typeof handler === 'function') {
        updateHandlers.push(handler);
      }
    }
  }, 120);
}

function getChats(limit) {
  return delayed(sortedChats().slice(0, limit || 20), 180);
}

function getMessages(chatId, limit, beforeId) {
  var rows = messages[String(chatId)] || [];
  var end = rows.length;
  var i;
  if (beforeId) {
    for (i = 0; i < rows.length; i += 1) {
      if (rows[i].id === String(beforeId)) {
        end = i;
        break;
      }
    }
  }
  return delayed(cloneRows(rows.slice(Math.max(0, end - (limit || 8)), end)), 160);
}

function sendMessage(chatId, text) {
  var id = nextMessageId++;
  var chat = chatById(chatId);
  if (!messages[String(chatId)]) {
    messages[String(chatId)] = [];
  }
  messages[String(chatId)].push(message(id, 'You', text, true));
  if (chat) {
    chat.updated = Date.now();
  }
  emitUpdate(chatId);
  return delayed(true, 120);
}

function editMessage(chatId, messageId, text) {
  var rows = messages[String(chatId)] || [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].id === String(messageId)) {
      rows[i].text = text;
      break;
    }
  }
  emitUpdate(chatId);
  return delayed(true, 100);
}

function deleteMessage(chatId, messageId) {
  var id = String(messageId);
  messages[String(chatId)] = (messages[String(chatId)] || []).filter(function(row) {
    return row.id !== id;
  });
  emitUpdate(chatId);
  return delayed(true, 100);
}

function sendReaction(chatId, messageId, token) {
  var rows = messages[String(chatId)] || [];
  var glyph = reactionGlyphs[token] || '';
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].id === String(messageId)) {
      rows[i].reactions = token === 'remove' ? '' : glyph;
      break;
    }
  }
  emitUpdate(chatId);
  return delayed(true, 100);
}

function markRead(chatId) {
  var chat = chatById(chatId);
  if (chat) {
    chat.unread = false;
    chat.unread_count = 0;
  }
  return delayed(true, 60);
}

function archiveChat(chatId) {
  var chat = chatById(chatId);
  if (chat) {
    chat.archived = true;
  }
  return delayed(true, 100);
}

function deleteChat(chatId) {
  var chat = chatById(chatId);
  if (chat) {
    chat.deleted = true;
  }
  return delayed(true, 100);
}

function muteChat(chatId) {
  var chat = chatById(chatId);
  if (chat) {
    chat.muted = !chat.muted;
  }
  return delayed(true, 100);
}

function markUnread(chatId) {
  var chat = chatById(chatId);
  if (chat) {
    chat.unread = true;
    chat.unread_count = 0;
  }
  return delayed(true, 100);
}

function mockPngBytes() {
  return new Uint8Array(MOCK_PHOTO_PNG);
}

function mockAvatarBytes() {
  return new Uint8Array(MOCK_AVATAR_PNG);
}

function imageBytes(chatId, messageId, width, height, colors, maxBytes) {
  return delayed(mockPngBytes(), 240);
}

function avatarBytes(chatId, width, height, colors, maxBytes) {
  return delayed(mockAvatarBytes(), 120);
}

function settingsPageUrl(baseUrl) {
  return baseUrl + '?mode=mock';
}

function applySettings() {}

module.exports = {
  create: function() {
    return {
      settingsPageUrl: settingsPageUrl,
      applySettings: applySettings,
      ready: ready,
      chats: getChats,
      messages: getMessages,
      olderMessages: getMessages,
      sendMessage: sendMessage,
      editMessage: editMessage,
      sendReaction: sendReaction,
      deleteMessage: deleteMessage,
      markRead: markRead,
      archiveChat: archiveChat,
      deleteChat: deleteChat,
      muteChat: muteChat,
      markUnread: markUnread,
      imageBytes: imageBytes,
      avatarBytes: avatarBytes
    };
  }
};
