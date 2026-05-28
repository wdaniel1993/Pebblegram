var auth = require('./auth');
var telegram = require('./telegram');
var image = require('./image');

function create(options) {
  auth.setStatusHandler(options.status);

  return {
    settingsPageUrl: function(baseUrl) {
      var state = auth.authState();
      return baseUrl +
        '?mode=pgjs' +
        '&apiId=' + encodeURIComponent(state.apiId || '') +
        '&hasApiHash=' + encodeURIComponent(state.hasApiHash ? '1' : '0') +
        '&phone=' + encodeURIComponent(state.phone) +
        '&hasSession=' + encodeURIComponent(state.hasSession ? '1' : '0') +
        '&authStage=' + encodeURIComponent(state.authStage || '') +
        '&cannedReplies=' + encodeURIComponent(options.cannedReplies());
    },
    applySettings: function(data) {
      if (data && data.mode === 'pgjs') {
        auth.saveSettings(data);
        if (data.resetSession) {
          auth.reset();
        }
      }
    },
    ready: function() {
      return auth.getClient();
    },
    chats: telegram.chats,
    messages: telegram.messages,
    olderMessages: function(chatId, limit, beforeId) {
      return telegram.messages(chatId, limit, beforeId);
    },
    newerMessages: telegram.newerMessages,
    keepalive: telegram.keepalive,
    sendMessage: telegram.sendMessage,
    editMessage: telegram.editMessage,
    sendReaction: telegram.sendReaction,
    message: telegram.message,
    deleteMessage: telegram.deleteMessage,
    markRead: telegram.markRead,
    archiveChat: telegram.archiveChat,
    deleteChat: telegram.deleteChat,
    muteChat: telegram.muteChat,
    markUnread: telegram.markUnread,
    imageBytes: image.imageBytes,
    avatarBytes: image.avatarBytes,
    cancelImageRequests: image.cancelImageRequests
  };
}

module.exports = {
  create: create
};
