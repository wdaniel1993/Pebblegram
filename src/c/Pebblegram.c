#include <pebble.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "message_keys.auto.h"

#define MAX_CHATS 20
#define MAX_MESSAGES 9
#define MAX_TEXT 500
#define MAX_FULL_TEXT 1200
#define MESSAGE_PREVIEW_TEXT PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 132, 132, 132, 132, 220, 220, 220)
#define MAX_SENDER 36
#define MAX_REACTIONS 17
#define MAX_META 16
#define MAX_CONTEXT_TEXT PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 60, 60, 60, 56, 72, 72, 64)
#define MAX_ID 24
#define MAX_IMAGE_BYTES PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 10000, 6500, 6500, 6000, 19000, 19000, 19000)
#define MAX_AVATAR_BYTES PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 3000, 3000, 3000, 2200, 3000, 3000, 3000)
#define MAX_LOADED_IMAGES PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 1, 1, 1, 1, 1, 2, 2)
#define IMAGE_THUMB_SIZE PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 120, 96, 96, 96, 156, 156, 118)
#define IMAGE_FRAME_EXTRA_W PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 10, 8, 8, 6, 14, 14, 10)
#define APP_INBOX_SIZE PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 2048, 2048, 2048, 2048, 3072, 3072, 3072)
#define APP_OUTBOX_SIZE PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 512, 512, 512, 512, 1024, 1024, 1024)
#define BW_UI PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 0, 0, 0, 1, 0, 0, 0)
#define ROUND_UI PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 0, 0, 0, 0, 0, 0, 1)
#define STATUS_H PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 24, 24, 24, 24, 24, 24, 22)
#define MAX_CANNED 10
#define CANNED_TEXT_LEN 40
#define PG_MIN(a, b) ((a) < (b) ? (a) : (b))
#define PG_MAX(a, b) ((a) > (b) ? (a) : (b))
#define APP_COLOR GColorCobaltBlue
#define APP_COLOR_LIGHT GColorCobaltBlue
#define UNREAD_COLOR GColorPictonBlue
#define CHAT_BG GColorWhite
#define IN_BUBBLE GColorPastelYellow
#define OUT_BUBBLE GColorCeleste
#define IN_CONTEXT_BUBBLE GColorIcterine
#define OUT_CONTEXT_BUBBLE GColorCadetBlue
#define SELECTED_IN_BUBBLE GColorLightGray
#define SELECTED_OUT_BUBBLE GColorPictonBlue
#define ACTION_BG GColorBlack
#define ACTION_TEXT GColorDarkGray
#define ACTION_TEXT_SELECTED GColorWhite
#define CHAT_SCROLL_STEPS 4
#define CHAT_SCROLL_FRAME_MS 2
#define CHAT_SCROLL_DELTA 30
#define REPEAT_SCROLL_MS 140
#define MESSAGE_PREFETCH_MARGIN 6
#define MESSAGE_MODE_INITIAL 0
#define MESSAGE_MODE_OLDER 1
#define MESSAGE_MODE_NEWER 2
#define LONG_MESSAGE_SCROLL_DELTA PBL_PLATFORM_SWITCH(PBL_PLATFORM_TYPE_CURRENT, 42, 42, 42, 42, 56, 56, 48)
#define COMPOSE_BUBBLE_H 30
#define COMPOSE_BUBBLE_GAP 8
#define MESSAGE_COMMAND_RETRY_MS 3000
#define MESSAGE_COMMAND_MAX_ATTEMPTS 3
#define MESSAGE_TRANSFER_TIMEOUT_MS 20000
#define IMAGE_COMMAND_RETRY_MS 350
#define IMAGE_TRANSFER_STALL_MS 12000
#define IMAGE_KEEP_SCREEN_MARGIN 48
#define IMAGE_LOAD_SCREEN_MARGIN 24
#define IMAGE_TALL_MAX_MULTIPLIER 2

// Platform constants are centralized here. Basalt/Diorite stay conservative on
// heap use; Emery/Gabbro can afford longer text and larger image payloads.
typedef enum {
  ViewStateLoading,
  ViewStateChatList,
  ViewStateChat
} ViewState;

typedef enum {
  ActionMenuMain,
  ActionMenuChat,
  ActionMenuCanned,
  ActionMenuConfirm,
  ActionMenuReply,
  ActionMenuReactionGrid,
  ActionMenuEmojiReplyGrid,
  ActionMenuFullText
} ActionMenuMode;

typedef enum {
  ActionItemCompose,
  ActionItemCanned,
  ActionItemReply,
  ActionItemReplyDictate,
  ActionItemReplyCanned,
  ActionItemReplyEmoji,
  ActionItemReact,
  ActionItemEdit,
  ActionItemDelete,
  ActionItemFullText,
  ActionItemFullContext,
  ActionItemRefresh,
  ActionItemArchiveChat,
  ActionItemDeleteChat,
  ActionItemMuteChat,
  ActionItemMarkUnread,
  ActionItemGoBack
} ActionItem;

typedef struct {
  char id[MAX_ID];
  char title[48];
  char preview[72];
  bool unread;
  int unread_count;
  GBitmap *avatar_bitmap;
} Chat;

typedef struct {
  char id[MAX_ID];
  char sender[MAX_SENDER];
  char text[MAX_TEXT];
  char reactions[MAX_REACTIONS];
  char meta[MAX_META];
  char context[MAX_CONTEXT_TEXT];
  char image_token[MAX_ID];
  bool outgoing;
  bool image_placeholder;
  bool image_requested;
  bool image_failed;
  uint8_t image_decode_retries;
  uint16_t image_width;
  uint16_t image_height;
  GBitmap *image_bitmap;
} Message;

typedef struct {
  const char *token;
  const char *glyph;
} ReactionChoice;

static const ReactionChoice REACTION_GRID_CHOICES[] = {
  // Favorites
  {"\xF0\x9F\x91\x8D", "\xF0\x9F\x91\x8D"}, // 👍
  {"\xE2\x9D\xA4", "\xE2\x9D\xA4"},         // ❤
  {"\xF0\x9F\x98\x82", "\xF0\x9F\x98\x82"}, // 😂
  {"\xF0\x9F\x98\xB1", "\xF0\x9F\x98\xB1"}, // 😱
  {"\xF0\x9F\x98\xA2", "\xF0\x9F\x98\xA2"}, // 😢
  {"\xF0\x9F\x98\xA1", "\xF0\x9F\x98\xA1"}, // 😡
  // Faces
  {"\xF0\x9F\x98\x80", "\xF0\x9F\x98\x80"}, // 😀
  {"\xF0\x9F\x98\x84", "\xF0\x9F\x98\x84"}, // 😄
  {"\xF0\x9F\x98\xAD", "\xF0\x9F\x98\xAD"}, // 😭
  {"\xF0\x9F\x98\x8D", "\xF0\x9F\x98\x8D"}, // 😍
  {"\xF0\x9F\x98\x98", "\xF0\x9F\x98\x98"}, // 😘
  {"\xF0\x9F\x98\x8E", "\xF0\x9F\x98\x8E"}, // 😎
  {"\xF0\x9F\x98\xB3", "\xF0\x9F\x98\xB3"}, // 😳
  {"\xF0\x9F\x98\xAC", "\xF0\x9F\x98\xAC"}, // 😬
  {"\xF0\x9F\x98\x90", "\xF0\x9F\x98\x90"}, // 😐
  {"\xF0\x9F\x98\xB4", "\xF0\x9F\x98\xB4"}, // 😴
  {"\xF0\x9F\x98\x87", "\xF0\x9F\x98\x87"}, // 😇
  {"\xF0\x9F\x98\x88", "\xF0\x9F\x98\x88"}, // 😈
  // Hands
  {"\xF0\x9F\x91\x8E", "\xF0\x9F\x91\x8E"}, // 👎
  {"\xF0\x9F\x91\x8C", "\xF0\x9F\x91\x8C"}, // 👌
  {"\xF0\x9F\x91\x8A", "\xF0\x9F\x91\x8A"}, // 👊
  {"\xE2\x9C\x8A", "\xE2\x9C\x8A"},         // ✊
  {"\xE2\x9C\x8C", "\xE2\x9C\x8C"},         // ✌
  {"\xF0\x9F\x91\x8B", "\xF0\x9F\x91\x8B"}, // 👋
  {"\xE2\x9C\x8B", "\xE2\x9C\x8B"},         // ✋
  {"\xF0\x9F\x91\x8F", "\xF0\x9F\x91\x8F"}, // 👏
  {"\xF0\x9F\x99\x8C", "\xF0\x9F\x99\x8C"}, // 🙌
  {"\xF0\x9F\x99\x8F", "\xF0\x9F\x99\x8F"}, // 🙏
  // Hearts
  {"\xF0\x9F\x92\x94", "\xF0\x9F\x92\x94"}, // 💔
  {"\xF0\x9F\x92\x8B", "\xF0\x9F\x92\x8B"}, // 💋
  // Symbols
  {"\xF0\x9F\x8E\x89", "\xF0\x9F\x8E\x89"}, // 🎉
  {"\xF0\x9F\x8D\xBB", "\xF0\x9F\x8D\xBB"}, // 🍻
  {"\xF0\x9F\x8D\xBA", "\xF0\x9F\x8D\xBA"}, // 🍺
  {"\xF0\x9F\x92\xA9", "\xF0\x9F\x92\xA9"}, // 💩
  {"remove", "Remove"}
};

static Window *s_main_window;
static MenuLayer *s_chat_menu;
static TextLayer *s_status_layer;
static Layer *s_messages_root;

static Window *s_action_window;
static Layer *s_action_layer;
static ActionMenuMode s_action_mode;
static int s_action_selected;
static int s_full_text_scroll_offset;
static int s_full_text_height;
static bool s_full_text_context;
static char s_full_text_title[MAX_SENDER + 10];
static char *s_full_text_body;

static DictationSession *s_dictation_session;

static Chat s_chats[MAX_CHATS];
static Message s_messages[MAX_MESSAGES];
static Message *s_message_stage;
static int s_message_y[MAX_MESSAGES];
static int s_message_h[MAX_MESSAGES];
static int s_compose_bubble_y;
static uint8_t s_image_buffer[MAX_IMAGE_BYTES];
static uint8_t s_avatar_buffer[MAX_AVATAR_BYTES];
static char s_image_message_id[MAX_ID];
static char s_avatar_chat_id[MAX_ID];
static int s_image_size;
static int s_image_received;
static int s_image_expected_offset;
static int s_image_transfer_id;
static int s_avatar_size;
static int s_avatar_received;
static int s_avatar_expected_offset;
static int s_avatar_transfer_id;
static int s_loaded_image_count;
static char s_canned[MAX_CANNED][CANNED_TEXT_LEN] = {
  "Yes",
  "No",
  "On my way",
  "Call you later",
  "Thanks",
  "",
  "",
  "",
  "",
  ""
};
static char s_pending_text[MAX_TEXT];
static char s_pending_edit_message_id[MAX_ID];
static char s_pending_chat_command[24];
static bool s_pending_send_as_reply;
static char s_current_chat_id[MAX_ID];
static char s_current_chat_title[48];
static char s_status_text[64];
static char s_loading_text[160] = "Loading...";
static char s_chat_refresh_selected_id[MAX_ID];
static char s_chat_list_selected_id[MAX_ID];

static int s_chat_count;
static int s_message_count;
static int s_selected_chat;
static int s_selected_message;
static int s_expected_rows;
static int s_message_transfer_id;
static int s_message_stream_mode;
static int s_message_stage_count;
static int s_chat_scroll_offset;
static int s_chat_scroll_start;
static int s_chat_scroll_target;
static int s_chat_scroll_step;
static int s_chat_content_height;
static int s_message_scroll_direction;
static ViewState s_view_state;
static bool s_bridge_ready;
static bool s_chats_loading;
static bool s_loading_error;
static bool s_chat_view_pending;
static bool s_loading_messages;
static bool s_loading_older_messages;
static bool s_loading_newer_messages;
static bool s_user_scrolled_messages;
static bool s_at_newest;
static bool s_at_oldest;
static bool s_message_stream_silent;
static int s_older_anchor_y;
static int s_newer_anchor_y;
static int s_older_anchor_scroll_offset;
static int s_newer_anchor_scroll_offset;
static char s_older_anchor_id[MAX_ID];
static char s_newer_anchor_id[MAX_ID];
static AppTimer *s_chat_scroll_timer;
static AppTimer *s_message_timeout_timer;
static AppTimer *s_message_retry_timer;
static AppTimer *s_image_retry_timer;
static int s_message_request_attempts;

static void request_chats(void);
static void request_messages(const char *chat_id);
static void request_next_image(void);
static void clear_active_image_request(void);
static bool selected_message_needs_image(void);
static void image_retry_timer_callback(void *data);
static void request_older_messages(bool silent);
static void request_newer_messages(bool silent);
static void refresh_loaded_image_count(void);
static void destroy_message_images(void);
static void destroy_offscreen_message_images(void);
static void message_retry_timer_callback(void *data);
static void main_back_click_handler(ClickRecognizerRef recognizer, void *context);
static void send_text_message(const char *text, bool as_reply);
static void edit_selected_message(const char *text);
static void delete_selected_message(void);
static void send_selected_chat_action(const char *command);
static void render_chat_list(void);
static void select_chat_row(int row, bool animated);
static void remove_chat_at(int row);
static void destroy_chat_avatars(void);
static void mask_avatar_corners(GContext *ctx, GPoint center, int radius, GColor bg_color);
static void render_messages(void);
static void show_chat_view_timer(void *data);
static void message_timeout_timer_callback(void *data);
static void show_status(const char *message);
static void show_loading_text(const char *message, bool is_error);
static void click_config_provider(void *context);
static void copy_cstr(char *dest, size_t dest_size, const char *src);
static void action_click_config_provider(void *context);
static void action_window_unload(Window *window);
static bool selected_message_is_truncated(void);
static bool selected_message_has_context(void);
static bool has_selected_message(void);
static bool compose_target_is_selected(void);
static void recalc_message_layout(void);
static void scroll_to_bottom(bool animated);
static void set_chat_scroll_offset(int target, bool animated);
static void set_chat_scroll_offset_quiet(int target);
static void scroll_selected_message_into_view(bool animated);
static void select_message_with_alignment(int index, bool align_bottom, bool animated);
static void chat_scroll_timer_callback(void *data);
static void messages_root_update_proc(Layer *layer, GContext *ctx);

static void update_canned_replies(const char *packed) {
  if (!packed || !packed[0]) {
    return;
  }

  char buffer[MAX_CANNED * CANNED_TEXT_LEN];
  copy_cstr(buffer, sizeof(buffer), packed);
  for (int i = 0; i < MAX_CANNED; i++) {
    s_canned[i][0] = '\0';
  }

  char *cursor = buffer;
  for (int i = 0; i < MAX_CANNED; i++) {
    char *separator = strchr(cursor, '|');
    if (separator) {
      *separator = '\0';
    }
    if (cursor[0]) {
      copy_cstr(s_canned[i], sizeof(s_canned[i]), cursor);
    }
    if (!separator) {
      break;
    }
    cursor = separator + 1;
  }
}

static int canned_reply_count(void) {
  int count = 0;
  for (int i = 0; i < MAX_CANNED; i++) {
    if (s_canned[i][0]) {
      count++;
    }
  }
  return PG_MAX(1, count);
}

// Pebble's string helpers do not consistently protect callers from NULL input.
static void copy_cstr(char *dest, size_t dest_size, const char *src) {
  if (!dest || dest_size == 0) {
    return;
  }
  if (!src) {
    dest[0] = '\0';
    return;
  }
  strncpy(dest, src, dest_size - 1);
  dest[dest_size - 1] = '\0';
}

static char *tuple_cstring(DictionaryIterator *iter, uint32_t key) {
  Tuple *tuple = dict_find(iter, key);
  return tuple ? tuple->value->cstring : NULL;
}

static int tuple_int(DictionaryIterator *iter, uint32_t key, int fallback) {
  Tuple *tuple = dict_find(iter, key);
  return tuple ? (int)tuple->value->int32 : fallback;
}

// Round screens need a narrower central column so rows stay clear of corners.
static GRect round_safe_rect(GRect bounds) {
  if (!ROUND_UI) {
    return bounds;
  }
  int inset = bounds.size.w >= 180 ? 28 : 22;
  return GRect(inset, bounds.origin.y, bounds.size.w - (inset * 2), bounds.size.h);
}

static int message_side_inset(GRect bounds) {
  return ROUND_UI ? PG_MAX(28, bounds.size.w / 7) : 3;
}

static int message_bubble_width(GRect bounds) {
  if (ROUND_UI) {
    return PG_MAX(112, bounds.size.w - (message_side_inset(bounds) * 2));
  }
  return bounds.size.w - 14;
}

static int message_image_frame_width(int bubble_w) {
  return PG_MIN(IMAGE_THUMB_SIZE + IMAGE_FRAME_EXTRA_W, bubble_w - 10);
}

static int chat_status_y(void) {
  return ROUND_UI ? 6 : 0;
}

static int chat_content_y(void) {
  return ROUND_UI ? 48 : STATUS_H;
}

static int chat_bottom_pad(void) {
  return ROUND_UI ? 24 : 0;
}

static void chat_initials(const char *title, char *initials, size_t initials_size) {
  initials[0] = '\0';
  if (!title || !title[0] || initials_size < 2) {
    return;
  }
  initials[0] = toupper((unsigned char)title[0]);
  initials[1] = '\0';
  for (int i = 1; title[i] && initials_size > 2; i++) {
    if (title[i - 1] == ' ' && title[i] != ' ') {
      initials[1] = toupper((unsigned char)title[i]);
      initials[2] = '\0';
      return;
    }
  }
}

static Message *find_message_by_id(const char *message_id) {
  if (!message_id || !message_id[0]) {
    return NULL;
  }
  for (int i = 0; i < s_message_count; i++) {
    if (strcmp(s_messages[i].id, message_id) == 0) {
      return &s_messages[i];
    }
  }
  return NULL;
}

static Message *find_message_by_image_token(const char *image_token) {
  if (!image_token || !image_token[0]) {
    return NULL;
  }
  for (int i = 0; i < s_message_count; i++) {
    if (strcmp(s_messages[i].image_token, image_token) == 0) {
      return &s_messages[i];
    }
  }
  return find_message_by_id(image_token);
}

static int find_message_index_by_id(const char *message_id) {
  if (!message_id || !message_id[0]) {
    return -1;
  }
  for (int i = 0; i < s_message_count; i++) {
    if (strcmp(s_messages[i].id, message_id) == 0) {
      return i;
    }
  }
  return -1;
}

static bool message_stage_contains_id(const char *message_id) {
  if (!s_message_stage || !message_id || !message_id[0]) {
    return false;
  }
  for (int i = 0; i < s_message_stage_count; i++) {
    if (strcmp(s_message_stage[i].id, message_id) == 0) {
      return true;
    }
  }
  return false;
}

static int find_chat_index_by_id(const char *chat_id) {
  if (!chat_id || !chat_id[0]) {
    return -1;
  }
  for (int i = 0; i < s_chat_count; i++) {
    if (strcmp(s_chats[i].id, chat_id) == 0) {
      return i;
    }
  }
  return -1;
}

static void destroy_chat_avatar(Chat *chat) {
  if (chat && chat->avatar_bitmap) {
    gbitmap_destroy(chat->avatar_bitmap);
    chat->avatar_bitmap = NULL;
  }
}

static void preserve_chat_avatar(Chat *chat, const char *incoming_id) {
  int existing_index = find_chat_index_by_id(incoming_id);
  if (existing_index < 0 || &s_chats[existing_index] == chat) {
    destroy_chat_avatar(chat);
    return;
  }
  Chat moved = s_chats[existing_index];
  s_chats[existing_index] = *chat;
  *chat = moved;
}

static void destroy_chat_avatars(void) {
  for (int i = 0; i < MAX_CHATS; i++) {
    destroy_chat_avatar(&s_chats[i]);
  }
  s_avatar_size = 0;
  s_avatar_received = 0;
  s_avatar_expected_offset = 0;
  s_avatar_transfer_id = 0;
  s_avatar_chat_id[0] = '\0';
}

static void mask_avatar_corners(GContext *ctx, GPoint center, int radius, GColor bg_color) {
  graphics_context_set_fill_color(ctx, bg_color);
  for (int y = -radius; y <= radius; y++) {
    int extent = 0;
    while ((extent + 1) * (extent + 1) + y * y <= radius * radius) {
      extent++;
    }
    int corner_w = radius - extent;
    if (corner_w > 0) {
      graphics_fill_rect(ctx, GRect(center.x - radius, center.y + y, corner_w, 1), 0, GCornerNone);
      graphics_fill_rect(ctx, GRect(center.x + extent + 1, center.y + y, corner_w, 1), 0, GCornerNone);
    }
  }
}

static void destroy_message_bitmap(Message *message) {
  if (message && message->image_bitmap) {
    gbitmap_destroy(message->image_bitmap);
    message->image_bitmap = NULL;
    message->image_requested = false;
    if (s_loaded_image_count > 0) {
      s_loaded_image_count--;
    }
  }
}

static int bitmap_palette_index_at(GBitmapFormat format, uint8_t *row, int x) {
  switch (format) {
    case GBitmapFormat1BitPalette:
      return (row[x >> 3] >> (7 - (x & 7))) & 0x1;
    case GBitmapFormat2BitPalette:
      return (row[x >> 2] >> (6 - ((x & 3) * 2))) & 0x3;
    case GBitmapFormat4BitPalette:
      return (row[x >> 1] >> (4 - ((x & 1) * 4))) & 0xf;
    default:
      return 0;
  }
}

static bool bitmap_has_visible_pixels(GBitmap *bitmap) {
  if (!bitmap) {
    return false;
  }
  GRect bounds = gbitmap_get_bounds(bitmap);
  if (bounds.size.w <= 0 || bounds.size.h <= 0) {
    return false;
  }

  GBitmapFormat format = gbitmap_get_format(bitmap);
  if (format == GBitmapFormat1Bit) {
    return true;
  }

  GColor *palette = gbitmap_get_palette(bitmap);
  for (int y = 0; y < bounds.size.h; y++) {
    GBitmapDataRowInfo row = gbitmap_get_data_row_info(bitmap, bounds.origin.y + y);
    int min_x = PG_MAX(bounds.origin.x, row.min_x);
    int max_x = PG_MIN(bounds.origin.x + bounds.size.w - 1, row.max_x);
    for (int x = min_x; x <= max_x; x++) {
      if (format == GBitmapFormat8Bit || format == GBitmapFormat8BitCircular) {
        if (((row.data[x] >> 6) & 0x3) != 0) {
          return true;
        }
      } else if (palette) {
        int color_index = bitmap_palette_index_at(format, row.data, x);
        if (palette[color_index].a != 0) {
          return true;
        }
      } else {
        return true;
      }
    }
  }
  return false;
}

static void destroy_other_message_images(Message *keep) {
  for (int i = 0; i < MAX_MESSAGES; i++) {
    if (&s_messages[i] != keep) {
      destroy_message_bitmap(&s_messages[i]);
    }
  }
  refresh_loaded_image_count();
}

static void refresh_loaded_image_count(void) {
  s_loaded_image_count = 0;
  for (int i = 0; i < MAX_MESSAGES; i++) {
    if (s_messages[i].image_bitmap) {
      s_loaded_image_count++;
    }
  }
}

static void destroy_message_images(void) {
  if (s_image_retry_timer) {
    app_timer_cancel(s_image_retry_timer);
    s_image_retry_timer = NULL;
  }
  for (int i = 0; i < MAX_MESSAGES; i++) {
    destroy_message_bitmap(&s_messages[i]);
    s_messages[i].image_requested = false;
    s_messages[i].image_failed = false;
  }
  s_loaded_image_count = 0;
  s_image_size = 0;
  s_image_received = 0;
  s_image_expected_offset = 0;
  s_image_transfer_id = 0;
  s_image_message_id[0] = '\0';
}

static void schedule_image_retry(void) {
  if (!s_image_retry_timer && s_view_state == ViewStateChat && s_messages_root) {
    s_image_retry_timer = app_timer_register(IMAGE_COMMAND_RETRY_MS, image_retry_timer_callback, NULL);
  }
}

static void schedule_image_transfer_timeout(void) {
  if (s_image_retry_timer) {
    app_timer_cancel(s_image_retry_timer);
  }
  if (s_view_state == ViewStateChat && s_messages_root) {
    s_image_retry_timer = app_timer_register(IMAGE_TRANSFER_STALL_MS, image_retry_timer_callback, NULL);
  } else {
    s_image_retry_timer = NULL;
  }
}

static bool message_needs_image(Message *message) {
  return message && message->image_placeholder && message->image_token[0] &&
         !message->image_requested && !message->image_failed && !message->image_bitmap;
}

static int message_image_display_width(const Message *message, int max_w) {
  if (!message || message->image_width <= 0 || message->image_height <= 0) {
    return max_w;
  }
  int max_h = message->image_height > message->image_width ?
              IMAGE_THUMB_SIZE * IMAGE_TALL_MAX_MULTIPLIER : IMAGE_THUMB_SIZE;
  int w = max_w;
  int h = (message->image_height * w) / message->image_width;
  if (h > max_h) {
    h = max_h;
    w = (message->image_width * h) / message->image_height;
  }
  return PG_MAX(32, PG_MIN(max_w, w));
}

static int message_image_display_height(const Message *message, int max_w) {
  if (!message || message->image_width <= 0 || message->image_height <= 0) {
    return IMAGE_THUMB_SIZE;
  }
  int max_h = message->image_height > message->image_width ?
              IMAGE_THUMB_SIZE * IMAGE_TALL_MAX_MULTIPLIER : IMAGE_THUMB_SIZE;
  int w = max_w;
  int h = (message->image_height * w) / message->image_width;
  if (h > max_h) {
    h = max_h;
  }
  return PG_MAX(32, PG_MIN(max_h, h));
}

static int message_index_from_ptr(Message *message) {
  if (!message || message < s_messages || message >= s_messages + MAX_MESSAGES) {
    return -1;
  }
  return (int)(message - s_messages);
}

static bool message_image_near_viewport(int index, int margin) {
  if (index < 0 || index >= s_message_count || !s_messages[index].image_placeholder) {
    return false;
  }
  if (!s_messages_root) {
    return false;
  }
  GRect bounds = layer_get_bounds(s_messages_root);
  int bubble_w = message_bubble_width(bounds);
  int image_h = message_image_display_height(&s_messages[index], message_image_frame_width(bubble_w));
  int image_top = s_message_y[index] + s_message_h[index] - image_h - 4;
  int image_bottom = image_top + image_h;
  return image_bottom >= s_chat_scroll_offset - margin &&
         image_top <= s_chat_scroll_offset + bounds.size.h + margin;
}

static bool message_image_visible(int index) {
  return message_image_near_viewport(index, 0);
}

static int message_image_focus_distance(int index) {
  if (s_selected_message >= 0 && s_selected_message < s_message_count) {
    return abs(index - s_selected_message) * 1000;
  }
  if (!s_messages_root) {
    return index * 1000;
  }
  GRect bounds = layer_get_bounds(s_messages_root);
  int focus_y = s_chat_scroll_offset + (bounds.size.h / 2);
  int bubble_w = message_bubble_width(bounds);
  int image_h = message_image_display_height(&s_messages[index], message_image_frame_width(bubble_w));
  int image_y = s_message_y[index] + s_message_h[index] - (image_h / 2) - 4;
  return abs(image_y - focus_y);
}

static bool message_is_gif(const Message *message) {
  return message && strncmp(message->text, "[GIF", 4) == 0;
}

static bool destroy_farthest_loaded_image(void) {
  int farthest_index = -1;
  int farthest_distance = -1;
  for (int i = 0; i < s_message_count; i++) {
    if (!s_messages[i].image_bitmap || message_image_visible(i)) {
      continue;
    }
    int distance = message_image_focus_distance(i);
    if (distance > farthest_distance) {
      farthest_distance = distance;
      farthest_index = i;
    }
  }
  if (farthest_index < 0) {
    return false;
  }
  destroy_message_bitmap(&s_messages[farthest_index]);
  return true;
}

static void prepare_selected_image_request(void) {
  if (!selected_message_needs_image()) {
    return;
  }
  Message *selected = &s_messages[s_selected_message];
  selected->image_failed = false;

  if (s_image_message_id[0] && strcmp(s_image_message_id, selected->image_token) != 0) {
    clear_active_image_request();
  }
}

static void clear_active_image_request(void) {
  Message *message = find_message_by_image_token(s_image_message_id);
  if (message) {
    message->image_requested = false;
  }
  s_image_message_id[0] = '\0';
  s_image_size = 0;
  s_image_received = 0;
  s_image_expected_offset = 0;
  s_image_transfer_id = 0;
}

static bool click_is_repeating(ClickRecognizerRef recognizer) {
  return recognizer && click_number_of_clicks_counted(recognizer) > 1;
}

static void sync_message_images(void) {
  for (int i = 0; i < MAX_MESSAGES; i++) {
    if (!message_image_near_viewport(i, IMAGE_KEEP_SCREEN_MARGIN)) {
      destroy_message_bitmap(&s_messages[i]);
      s_messages[i].image_failed = false;
    }
  }

  if (s_image_message_id[0]) {
    Message *message = find_message_by_image_token(s_image_message_id);
    int image_index = message_index_from_ptr(message);
    if (!message_image_near_viewport(image_index, IMAGE_KEEP_SCREEN_MARGIN)) {
      clear_active_image_request();
    }
  }

  refresh_loaded_image_count();
  while (s_loaded_image_count > MAX_LOADED_IMAGES && destroy_farthest_loaded_image()) {
    refresh_loaded_image_count();
  }
}

static void destroy_offscreen_message_images(void) {
  sync_message_images();
}

static bool message_is_at_or_below_selection(int index) {
  return s_selected_message < 0 || s_selected_message >= s_message_count || index >= s_selected_message;
}

static bool selected_message_needs_image(void) {
  return s_selected_message >= 0 && s_selected_message < s_message_count &&
         s_messages[s_selected_message].image_placeholder &&
         s_messages[s_selected_message].image_token[0] &&
         !s_messages[s_selected_message].image_bitmap;
}

static bool destroy_unselected_loaded_image(void) {
  int farthest_index = -1;
  int farthest_distance = -1;
  for (int i = 0; i < s_message_count; i++) {
    if (i == s_selected_message || !s_messages[i].image_bitmap) {
      continue;
    }
    int distance = message_image_focus_distance(i);
    if (distance > farthest_distance) {
      farthest_distance = distance;
      farthest_index = i;
    }
  }
  if (farthest_index < 0) {
    return false;
  }
  destroy_message_bitmap(&s_messages[farthest_index]);
  return true;
}

static int find_best_image_candidate(bool visible_only, bool prefer_below_selection) {
  int best_index = -1;
  int best_distance = 2147483647;
  for (int i = 0; i < s_message_count; i++) {
    if (!message_needs_image(&s_messages[i])) {
      continue;
    }
    if (visible_only) {
      if (!message_image_visible(i)) {
        continue;
      }
    } else if (!message_image_near_viewport(i, IMAGE_LOAD_SCREEN_MARGIN)) {
      continue;
    }
    if (prefer_below_selection && !message_is_at_or_below_selection(i)) {
      continue;
    }
    int distance = message_image_focus_distance(i);
    if (distance < best_distance) {
      best_distance = distance;
      best_index = i;
    }
  }
  return best_index;
}

static bool send_command_with_status(const char *command, const char *chat_id, const char *text,
                                     const char *reply_to, const char *message_id, bool show_failures) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    if (show_failures) {
      show_status("Bridge busy");
    }
    return false;
  }

  DictionaryResult dict_result = dict_write_cstring(iter, MESSAGE_KEY_Command, command);
  if (dict_result != DICT_OK) {
    if (show_failures) {
      show_status("Command write fail");
    }
    return false;
  }
  if (chat_id) {
    dict_result = dict_write_cstring(iter, MESSAGE_KEY_ChatId, chat_id);
    if (dict_result != DICT_OK) {
      if (show_failures) {
        show_status("Chat ID write fail");
      }
      return false;
    }
  }
  if (text) {
    dict_result = dict_write_cstring(iter, MESSAGE_KEY_Text, text);
    if (dict_result != DICT_OK) {
      if (show_failures) {
        show_status("Text write fail");
      }
      return false;
    }
  }
  if (reply_to) {
    dict_result = dict_write_cstring(iter, MESSAGE_KEY_ReplyTo, reply_to);
    if (dict_result != DICT_OK) {
      if (show_failures) {
        show_status("Reply write fail");
      }
      return false;
    }
  }
  if (text && message_id && strcmp(command, "edit_message") == 0) {
    dict_result = dict_write_cstring(iter, MESSAGE_KEY_EditMessageId, message_id);
    if (dict_result != DICT_OK) {
      if (show_failures) {
        show_status("Edit ID write fail");
      }
      return false;
    }
  }
  if (message_id) {
    dict_result = dict_write_cstring(iter, MESSAGE_KEY_MessageId, message_id);
    if (dict_result != DICT_OK) {
      if (show_failures) {
        show_status("Msg ID write fail");
      }
      return false;
    }
  }
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    if (show_failures) {
      show_status("Command send fail");
    }
    return false;
  }
  return true;
}

static bool send_command(const char *command, const char *chat_id, const char *text,
                         const char *reply_to, const char *message_id) {
  return send_command_with_status(command, chat_id, text, reply_to, message_id, true);
}

static void show_status(const char *message) {
  if (s_status_layer) {
    copy_cstr(s_status_text, sizeof(s_status_text), s_chats_loading ? "Pebblegram" : message);
    text_layer_set_text(s_status_layer, s_status_text);
    text_layer_set_text_color(s_status_layer, GColorWhite);
    text_layer_set_background_color(s_status_layer, APP_COLOR);
  }
}

static void show_loading_text(const char *message, bool is_error) {
  copy_cstr(s_loading_text, sizeof(s_loading_text), message && message[0] ? message : "Loading...");
  s_loading_error = is_error;
  if (s_chat_menu) {
    menu_layer_reload_data(s_chat_menu);
  }
}

static int progress_percent(int current, int total) {
  if (total <= 0) {
    return current > 0 ? 100 : 0;
  }
  return PG_MAX(0, PG_MIN(100, (current * 100) / total));
}

static int chat_loading_percent(void) {
  if (s_expected_rows > 0) {
    return 20 + ((PG_MAX(0, PG_MIN(s_chat_count, s_expected_rows)) * 80) / s_expected_rows);
  }
  if (strcmp(s_loading_text, "Connecting...") == 0) {
    return 10;
  }
  if (strcmp(s_loading_text, "Fetching chats...") == 0) {
    return 20;
  }
  if (strcmp(s_loading_text, "Sending chats...") == 0) {
    return 25;
  }
  return 5;
}

static void draw_loading_bar(GContext *ctx, GRect rect, int percent) {
  percent = PG_MAX(0, PG_MIN(100, percent));
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_round_rect(ctx, rect, 2);
  if (percent > 0) {
    int pad = 3;
    int fill_w = ((rect.size.w - (pad * 2)) * percent) / 100;
    GRect fill = GRect(rect.origin.x + pad, rect.origin.y + pad,
                      PG_MAX(1, fill_w), rect.size.h - (pad * 2));
    graphics_context_set_fill_color(ctx, APP_COLOR);
    graphics_fill_rect(ctx, fill, 1, GCornersAll);
  }
}

static uint16_t chat_menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t chat_menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  if (s_chats_loading && s_chat_count == 0) {
    return 1;
  }
  return s_chat_count > 0 ? s_chat_count : 1;
}

static int16_t chat_menu_get_header_height_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return 0;
}

static void chat_menu_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer);
  GRect safe = round_safe_rect(bounds);
  bool selected = menu_layer_is_index_selected(s_chat_menu, cell_index);

  graphics_context_set_fill_color(ctx, CHAT_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (s_chats_loading) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, s_loading_error ? "Login needs attention" : "Loading...",
                       fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(safe.origin.x, (bounds.size.h / 2) - 48, safe.size.w, 32),
                       s_loading_error ? GTextOverflowModeWordWrap : GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentCenter, NULL);
    if (s_loading_error) {
      graphics_draw_text(ctx, s_loading_text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                         GRect(safe.origin.x + 4, (bounds.size.h / 2) - 6, safe.size.w - 8, 72),
                         GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    } else {
      int percent = chat_loading_percent();
      int bar_w = PG_MIN(safe.size.w - 24, 112);
      GRect bar = GRect(safe.origin.x + ((safe.size.w - bar_w) / 2), (bounds.size.h / 2) - 8, bar_w, 14);
      draw_loading_bar(ctx, bar, percent);
      graphics_draw_text(ctx, s_loading_text, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                         GRect(safe.origin.x, bar.origin.y + 15, safe.size.w, 22),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    }
    return;
  }
  if (selected) {
    graphics_context_set_fill_color(ctx, APP_COLOR_LIGHT);
    graphics_fill_rect(ctx, GRect(safe.origin.x - 4, 1, safe.size.w + 8, bounds.size.h - 3),
                       ROUND_UI ? 5 : 0, GCornersAll);
  }
  graphics_context_set_stroke_color(ctx, GColorLightGray);
  graphics_draw_line(ctx, GPoint(safe.origin.x, bounds.size.h - 1),
                     GPoint(safe.origin.x + safe.size.w, bounds.size.h - 1));

  graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorBlack);
  if (s_chat_count == 0) {
    graphics_draw_text(ctx, s_bridge_ready ? "No chats yet" : "Loading...",
                       fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(safe.origin.x, (bounds.size.h - 40) / 2, safe.size.w, 40), GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentCenter, NULL);
    return;
  }

  Chat *chat = &s_chats[cell_index->row];
  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  int unread_w = chat->unread ? 24 : 0;
  int avatar_r = ROUND_UI ? 12 : 14;
  int avatar_cx = safe.origin.x + avatar_r + 1;
  int avatar_cy = bounds.size.h / 2;
  int text_x = safe.origin.x + (avatar_r * 2) + 8;
  int text_w = safe.size.w - (text_x - safe.origin.x) - unread_w;
  GColor row_bg = selected ? APP_COLOR_LIGHT : CHAT_BG;
  char initials[3];

  graphics_context_set_fill_color(ctx, GColorLightGray);
  graphics_fill_circle(ctx, GPoint(avatar_cx, avatar_cy), avatar_r);
  if (chat->avatar_bitmap) {
    graphics_draw_bitmap_in_rect(ctx, chat->avatar_bitmap,
                                 GRect(avatar_cx - avatar_r, avatar_cy - avatar_r,
                                       avatar_r * 2, avatar_r * 2));
    mask_avatar_corners(ctx, GPoint(avatar_cx, avatar_cy), avatar_r, row_bg);
  }
  graphics_context_set_stroke_color(ctx, selected ? GColorWhite : APP_COLOR);
  graphics_draw_circle(ctx, GPoint(avatar_cx, avatar_cy), avatar_r);
  if (!chat->avatar_bitmap) {
    chat_initials(chat->title, initials, sizeof(initials));
    graphics_context_set_text_color(ctx, APP_COLOR);
    graphics_draw_text(ctx, initials, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                       GRect(avatar_cx - avatar_r, avatar_cy - 9, avatar_r * 2, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorBlack);
  graphics_draw_text(ctx, chat->title, title_font, GRect(text_x, -4, text_w, 25),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorDarkGray);
  graphics_draw_text(ctx, chat->preview, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(text_x, 20, text_w, 23), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentLeft, NULL);
  if (chat->unread) {
    int cx = safe.origin.x + safe.size.w - 12;
    int cy = bounds.size.h / 2;
    graphics_context_set_fill_color(ctx, UNREAD_COLOR);
    if (chat->unread_count > 0) {
      graphics_fill_circle(ctx, GPoint(cx, cy), 10);
      char unread_text[12];
      if (chat->unread_count > 99) {
        copy_cstr(unread_text, sizeof(unread_text), "99+");
      } else {
        snprintf(unread_text, sizeof(unread_text), "%d", chat->unread_count);
      }
      graphics_context_set_text_color(ctx, GColorBlack);
      graphics_draw_text(ctx, unread_text, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                         GRect(cx - 10, cy - 10, 20, 18),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    } else {
      graphics_fill_circle(ctx, GPoint(cx, cy), 4);
    }
  }
}

static int16_t chat_menu_get_cell_height_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if ((s_chats_loading && s_chat_count == 0) || s_chat_count == 0) {
    Layer *layer = menu_layer_get_layer(menu_layer);
    return layer_get_bounds(layer).size.h;
  }
  return ROUND_UI ? 42 : 46;
}

static void chat_menu_select_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_chats_loading && s_chat_count == 0) {
    return;
  }
  if (s_chat_count == 0) {
    request_chats();
    return;
  }
  s_selected_chat = cell_index->row;
  copy_cstr(s_current_chat_id, sizeof(s_current_chat_id), s_chats[s_selected_chat].id);
  copy_cstr(s_current_chat_title, sizeof(s_current_chat_title), s_chats[s_selected_chat].title);
  APP_LOG(APP_LOG_LEVEL_INFO, "Requesting messages for chat %s", s_current_chat_id);
  request_messages(s_current_chat_id);
}

static int clamp_scroll_offset(int offset) {
  if (!s_messages_root) {
    return 0;
  }
  GRect bounds = layer_get_bounds(s_messages_root);
  int max_offset = PG_MAX(0, s_chat_content_height - bounds.size.h);
  return PG_MAX(0, PG_MIN(offset, max_offset));
}


static bool message_has_context(Message *message) {
  return message && message->context[0];
}

static void copy_context_part(char *dest, size_t dest_size, const char *start, const char *end) {
  size_t len;
  if (!dest || dest_size == 0) {
    return;
  }
  if (!start) {
    dest[0] = '\0';
    return;
  }
  len = end && end > start ? (size_t)(end - start) : strlen(start);
  if (len >= dest_size) {
    len = dest_size - 1;
  }
  memcpy(dest, start, len);
  dest[len] = '\0';
}

static int message_context_height(Message *message) {
  return message_has_context(message) ? 36 : 0;
}

static void message_context_strings(Message *message, char *title, size_t title_size,
                                    char *body, size_t body_size) {
  char *separator = strchr(message->context, '\n');
  copy_context_part(title, title_size, message->context, separator);
  copy_context_part(body, body_size, separator ? separator + 1 : "Message", NULL);
}

static void set_message_context(Message *message, const char *reply_sender, const char *reply_text,
                                const char *forward_sender, const char *forward_text) {
  const char *sender;
  const char *text;
  if ((reply_sender && reply_sender[0]) || (reply_text && reply_text[0])) {
    sender = reply_sender && reply_sender[0] ? reply_sender : "Reply";
    text = reply_text && reply_text[0] ? reply_text : "Message";
    snprintf(message->context, sizeof(message->context), "%s\n%s", sender, text);
    return;
  }
  if ((forward_sender && forward_sender[0]) || (forward_text && forward_text[0])) {
    sender = forward_sender && forward_sender[0] ? forward_sender : "Forwarded";
    text = forward_text && forward_text[0] ? forward_text : "Message";
    snprintf(message->context, sizeof(message->context), "Fwd from %s\n%s", sender, text);
    return;
  }
  message->context[0] = '\0';
}


static void clear_message_slot(Message *message) {
  if (!message) {
    return;
  }
  if (s_image_message_id[0] && strcmp(s_image_message_id, message->image_token) == 0) {
    clear_active_image_request();
  }
  destroy_message_bitmap(message);
  memset(message, 0, sizeof(Message));
}

static void clear_message_rows(void) {
  for (int i = 0; i < MAX_MESSAGES; i++) {
    clear_message_slot(&s_messages[i]);
  }
  s_message_count = 0;
  s_selected_message = -1;
  s_expected_rows = 0;
  s_chat_scroll_offset = 0;
  s_chat_content_height = 0;
}

static void reset_message_stream_state(void) {
  s_message_stream_silent = false;
  s_message_stream_mode = MESSAGE_MODE_INITIAL;
}

static void clear_message_stage(void) {
  if (!s_message_stage) {
    s_message_stage_count = 0;
    return;
  }
  for (int i = 0; i < MAX_MESSAGES; i++) {
    clear_message_slot(&s_message_stage[i]);
  }
  free(s_message_stage);
  s_message_stage = NULL;
  s_message_stage_count = 0;
}

static bool prepare_message_stage(void) {
  clear_message_stage();
  s_message_stage = malloc(sizeof(Message) * MAX_MESSAGES);
  if (!s_message_stage) {
    return false;
  }
  memset(s_message_stage, 0, sizeof(Message) * MAX_MESSAGES);
  s_message_stage_count = 0;
  return true;
}

static bool messages_match_image(const Message *a, const Message *b) {
  return a && b && a->id[0] && b->id[0] && a->image_token[0] &&
         strcmp(a->id, b->id) == 0 && strcmp(a->image_token, b->image_token) == 0;
}

static void preserve_stage_image_state(void) {
  if (!s_message_stage) {
    return;
  }
  int rows = PG_MIN(s_message_stage_count, MAX_MESSAGES);
  for (int i = 0; i < rows; i++) {
    Message *stage = &s_message_stage[i];
    for (int j = 0; j < s_message_count; j++) {
      Message *current = &s_messages[j];
      if (!messages_match_image(stage, current)) {
        continue;
      }
      if (!stage->image_bitmap && current->image_bitmap) {
        stage->image_bitmap = current->image_bitmap;
        current->image_bitmap = NULL;
      }
      stage->image_requested = current->image_requested;
      stage->image_failed = current->image_failed;
      stage->image_decode_retries = current->image_decode_retries;
      current->image_token[0] = '\0';
      break;
    }
  }
}

static void commit_message_stage(int count) {
  if (!s_message_stage) {
    return;
  }
  preserve_stage_image_state();
  clear_message_rows();
  int rows = PG_MIN(PG_MIN(count, s_message_stage_count), MAX_MESSAGES);
  for (int i = 0; i < rows; i++) {
    s_messages[i] = s_message_stage[i];
    memset(&s_message_stage[i], 0, sizeof(Message));
  }
  s_message_count = rows;
  free(s_message_stage);
  s_message_stage = NULL;
  s_message_stage_count = 0;
  refresh_loaded_image_count();
}

static bool message_transfer_matches(DictionaryIterator *iter) {
  int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
  return transfer_id == 0 || s_message_transfer_id == 0 || transfer_id == s_message_transfer_id;
}

static void populate_message_from_tuple(Message *message, DictionaryIterator *iter) {
  char *incoming_message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
  char *incoming_image_token = tuple_cstring(iter, MESSAGE_KEY_ImageToken);
  bool preserve_image_state = incoming_message_id && incoming_image_token &&
                              strcmp(message->id, incoming_message_id) == 0 &&
                              strcmp(message->image_token, incoming_image_token) == 0;
  if (!preserve_image_state) {
    destroy_message_bitmap(message);
  }
  copy_cstr(message->id, sizeof(message->id), incoming_message_id);
  copy_cstr(message->sender, sizeof(message->sender), tuple_cstring(iter, MESSAGE_KEY_Sender));
  copy_cstr(message->text, sizeof(message->text), tuple_cstring(iter, MESSAGE_KEY_Text));
  copy_cstr(message->reactions, sizeof(message->reactions), tuple_cstring(iter, MESSAGE_KEY_Reactions));
  copy_cstr(message->meta, sizeof(message->meta), tuple_cstring(iter, MESSAGE_KEY_MessageMeta));
  set_message_context(message,
                      tuple_cstring(iter, MESSAGE_KEY_ReplySender),
                      tuple_cstring(iter, MESSAGE_KEY_ReplyText),
                      tuple_cstring(iter, MESSAGE_KEY_ForwardSender),
                      tuple_cstring(iter, MESSAGE_KEY_ForwardText));
  message->outgoing = tuple_int(iter, MESSAGE_KEY_IsOutgoing, 0) != 0;
  copy_cstr(message->image_token, sizeof(message->image_token), incoming_image_token);
  message->image_placeholder = message->image_token[0] != '\0';
  message->image_width = tuple_int(iter, MESSAGE_KEY_ImageWidth, message->image_placeholder ? IMAGE_THUMB_SIZE : 0);
  message->image_height = tuple_int(iter, MESSAGE_KEY_ImageHeight, message->image_placeholder ? IMAGE_THUMB_SIZE : 0);
  if (!preserve_image_state) {
    message->image_requested = false;
    message->image_failed = false;
    message->image_decode_retries = 0;
    message->image_bitmap = NULL;
  }
}

static Message *prepend_message_slot(void) {
  if (s_message_count >= MAX_MESSAGES) {
    clear_message_slot(&s_messages[MAX_MESSAGES - 1]);
    s_message_count = MAX_MESSAGES - 1;
  }
  for (int i = s_message_count; i > 0; i--) {
    s_messages[i] = s_messages[i - 1];
  }
  memset(&s_messages[0], 0, sizeof(Message));
  s_message_count++;
  return &s_messages[0];
}

static Message *append_message_slot(void) {
  if (s_message_count >= MAX_MESSAGES) {
    clear_message_slot(&s_messages[0]);
    for (int i = 0; i < MAX_MESSAGES - 1; i++) {
      s_messages[i] = s_messages[i + 1];
    }
    s_message_count = MAX_MESSAGES - 1;
    if (s_selected_message > 0) {
      s_selected_message--;
    }
  }
  memset(&s_messages[s_message_count], 0, sizeof(Message));
  s_message_count++;
  return &s_messages[s_message_count - 1];
}

static void preserve_stream_anchor(const char *anchor_id, int anchor_y, bool dirty) {
  recalc_message_layout();
  if (anchor_id && anchor_id[0]) {
    int anchor_index = find_message_index_by_id(anchor_id);
    if (anchor_index >= 0) {
      s_selected_message = anchor_index;
      int target = s_chat_scroll_offset + (s_message_y[anchor_index] - anchor_y);
      if (dirty) {
        set_chat_scroll_offset(target, false);
      } else {
        set_chat_scroll_offset_quiet(target);
      }
    }
  }
  if (dirty && s_messages_root) {
    layer_mark_dirty(s_messages_root);
  }
  if (dirty) {
    request_next_image();
  }
}

static void render_after_stream_append(const char *anchor_id, int anchor_y) {
  if (s_message_stream_silent) {
    preserve_stream_anchor(anchor_id, anchor_y, false);
    return;
  }
  preserve_stream_anchor(anchor_id, anchor_y, true);
}

static void render_after_stream_prepend(const char *anchor_id, int anchor_y) {
  if (s_message_stream_silent) {
    preserve_stream_anchor(anchor_id, anchor_y, false);
    return;
  }
  if (!s_user_scrolled_messages && (!anchor_id || !anchor_id[0])) {
    recalc_message_layout();
    scroll_to_bottom(false);
    return;
  }
  preserve_stream_anchor(anchor_id, anchor_y, true);
}


static uint8_t message_meta_receipts(const char *meta) {
  char *separator = meta ? strchr(meta, '|') : NULL;
  if (!separator || !separator[1]) {
    return 0;
  }
  return separator[1] == '2' ? 2 : 1;
}

static void message_meta_time(const char *meta, char *dest, size_t dest_size) {
  char *separator = meta ? strchr(meta, '|') : NULL;
  if (!dest || dest_size == 0) {
    return;
  }
  if (!meta) {
    dest[0] = '\0';
    return;
  }
  if (separator) {
    copy_context_part(dest, dest_size, meta, separator);
  } else {
    copy_cstr(dest, dest_size, meta);
  }
}

static void draw_receipt_tick(GContext *ctx, int x, int y) {
  graphics_draw_line(ctx, GPoint(x, y + 4), GPoint(x + 2, y + 6));
  graphics_draw_line(ctx, GPoint(x + 2, y + 6), GPoint(x + 6, y + 1));
}

static void draw_message_meta(GContext *ctx, const char *meta, GFont font, GRect rect) {
  char time_text[8];
  uint8_t receipts = message_meta_receipts(meta);
  int ticks_w = receipts ? (receipts == 2 ? 13 : 7) : 0;
  message_meta_time(meta, time_text, sizeof(time_text));
  graphics_context_set_text_color(ctx, BW_UI ? GColorBlack : GColorDarkGray);
  graphics_context_set_stroke_color(ctx, BW_UI ? GColorBlack : GColorDarkGray);
  if (time_text[0] && rect.size.w > ticks_w + 2) {
    graphics_draw_text(ctx, time_text, font,
                       GRect(rect.origin.x, rect.origin.y, rect.size.w - ticks_w - 2, rect.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }
  if (receipts) {
    int tick_x = rect.origin.x + rect.size.w - ticks_w;
    int tick_y = rect.origin.y + 5;
    draw_receipt_tick(ctx, tick_x, tick_y);
    if (receipts > 1) {
      draw_receipt_tick(ctx, tick_x + 6, tick_y);
    }
  }
}

static void draw_message_context(GContext *ctx, Message *message, GRect rect) {
  char title[MAX_SENDER + 10];
  char body[MAX_CONTEXT_TEXT];
  GColor fill = BW_UI ? GColorWhite : (message->outgoing ? OUT_CONTEXT_BUBBLE : IN_CONTEXT_BUBBLE);
  GColor accent = BW_UI ? GColorBlack : APP_COLOR;
  if (!message_has_context(message) || rect.size.h <= 0) {
    return;
  }
  message_context_strings(message, title, sizeof(title), body, sizeof(body));
  graphics_context_set_fill_color(ctx, fill);
  graphics_fill_rect(ctx, rect, 3, GCornersAll);
  graphics_context_set_fill_color(ctx, accent);
  graphics_fill_rect(ctx, GRect(rect.origin.x, rect.origin.y + 2, 3, rect.size.h - 4), 1, GCornersAll);
  graphics_context_set_text_color(ctx, accent);
  graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                     GRect(rect.origin.x + 5, rect.origin.y, rect.size.w - 7, 15),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, body, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(rect.origin.x + 5, rect.origin.y + 14, rect.size.w - 7, rect.size.h - 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static int message_bubble_height(Message *message, int text_w) {
  char display_text[MESSAGE_PREVIEW_TEXT + 8];
  GFont text_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  int name_h = (!message->outgoing && message->sender[0]) ? 16 : 0;
  int reaction_h = (message->reactions[0] || message->meta[0]) ? 17 : 0;
  int context_h = message_context_height(message);
  int image_h = message->image_placeholder ?
                message_image_display_height(message, message_image_frame_width(text_w)) + 8 : 0;
  copy_cstr(display_text, sizeof(display_text), message->text);
  if ((int)strlen(message->text) > MESSAGE_PREVIEW_TEXT) {
    copy_cstr(display_text + MESSAGE_PREVIEW_TEXT - 4, sizeof(display_text) - MESSAGE_PREVIEW_TEXT + 4, " ...");
  }
  GSize size = GSize(0, 0);
  if (display_text[0] && text_w > 4) {
    size = graphics_text_layout_get_content_size(
      display_text,
      text_font,
      GRect(0, 0, text_w, 2000),
      GTextOverflowModeWordWrap,
      GTextAlignmentLeft
    );
  }
  int text_h = display_text[0] ? size.h : 0;
  text_h = PG_MAX(0, PG_MIN(text_h, MAX_TEXT * 2));
  return PG_MAX(28, text_h + name_h + context_h + image_h + reaction_h + 7);
}

static void recalc_message_layout(void) {
  if (!s_messages_root) {
    return;
  }

  GRect bounds = layer_get_bounds(s_messages_root);
  int bubble_w = message_bubble_width(bounds);
  int text_w = bubble_w - 10;
  int y = ROUND_UI ? 8 : 3;

  for (int i = 0; i < s_message_count; i++) {
    s_message_y[i] = y;
    s_message_h[i] = message_bubble_height(&s_messages[i], text_w);
    y += s_message_h[i] + (ROUND_UI ? 6 : 5);
  }
  int bottom_pad = ROUND_UI ? 12 : 5;
  int compose_min_y = bounds.size.h - COMPOSE_BUBBLE_H - (ROUND_UI ? 8 : 6);
  if (s_at_newest && s_message_count > 0 && y + COMPOSE_BUBBLE_GAP < compose_min_y) {
    int shift = compose_min_y - COMPOSE_BUBBLE_GAP - y;
    for (int i = 0; i < s_message_count; i++) {
      s_message_y[i] += shift;
    }
    y += shift;
  }
  if (s_at_newest) {
    s_compose_bubble_y = PG_MAX(y + COMPOSE_BUBBLE_GAP, compose_min_y);
    s_chat_content_height = s_compose_bubble_y + COMPOSE_BUBBLE_H + bottom_pad;
  } else {
    s_compose_bubble_y = y + COMPOSE_BUBBLE_GAP;
    s_chat_content_height = y + bottom_pad;
  }
  s_chat_scroll_offset = clamp_scroll_offset(s_chat_scroll_offset);
}

static void scroll_to_bottom(bool animated) {
  recalc_message_layout();
  s_selected_message = s_at_newest ? s_message_count : (s_message_count > 0 ? s_message_count - 1 : -1);
  set_chat_scroll_offset(s_chat_content_height, animated);
  destroy_offscreen_message_images();
  request_next_image();
}

static void chat_scroll_timer_callback(void *data) {
  s_chat_scroll_timer = NULL;
  s_chat_scroll_step++;

  if (s_chat_scroll_step >= CHAT_SCROLL_STEPS) {
    s_chat_scroll_offset = s_chat_scroll_target;
  } else {
    int delta = s_chat_scroll_target - s_chat_scroll_start;
    int progress = s_chat_scroll_step * CHAT_SCROLL_STEPS;
    int eased = (progress * 2) - (s_chat_scroll_step * s_chat_scroll_step);
    s_chat_scroll_offset = s_chat_scroll_start + ((delta * eased) / (CHAT_SCROLL_STEPS * CHAT_SCROLL_STEPS));
    s_chat_scroll_timer = app_timer_register(CHAT_SCROLL_FRAME_MS, chat_scroll_timer_callback, NULL);
  }

  if (s_messages_root) {
    layer_mark_dirty(s_messages_root);
  }
  request_next_image();
}

static void set_chat_scroll_offset_quiet(int target) {
  if (s_chat_scroll_timer) {
    app_timer_cancel(s_chat_scroll_timer);
    s_chat_scroll_timer = NULL;
  }
  s_chat_scroll_offset = clamp_scroll_offset(target);
}

static void set_chat_scroll_offset(int target, bool animated) {
  target = clamp_scroll_offset(target);
  if (s_chat_scroll_timer) {
    app_timer_cancel(s_chat_scroll_timer);
    s_chat_scroll_timer = NULL;
  }

  if (!animated) {
    s_chat_scroll_offset = target;
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    request_next_image();
    return;
  }

  s_chat_scroll_start = s_chat_scroll_offset;
  s_chat_scroll_target = target;
  if (s_chat_scroll_start == s_chat_scroll_target) {
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    request_next_image();
    return;
  }
  s_chat_scroll_step = 0;
  s_chat_scroll_timer = app_timer_register(CHAT_SCROLL_FRAME_MS, chat_scroll_timer_callback, NULL);
}

// Long messages stay selected while the user scrolls through them line by line.
static void scroll_selected_message_into_view(bool animated) {
  if (!s_messages_root || s_selected_message < 0 || s_selected_message >= s_message_count) {
    return;
  }

  recalc_message_layout();
  GRect bounds = layer_get_bounds(s_messages_root);
  int margin = 8;
  int top = s_message_y[s_selected_message] - margin;
  int bottom = s_message_y[s_selected_message] + s_message_h[s_selected_message] + margin;
  int target = s_chat_scroll_offset;

  if (s_message_h[s_selected_message] > bounds.size.h - (margin * 2)) {
    target = top;
  } else if (top < s_chat_scroll_offset) {
    target = top;
  } else if (bottom > s_chat_scroll_offset + bounds.size.h) {
    target = bottom - bounds.size.h;
  }

  set_chat_scroll_offset(target, animated);
  prepare_selected_image_request();
  request_next_image();
}

static void select_message_with_alignment(int index, bool align_top, bool animated) {
  if (!s_messages_root || index < 0 || index >= s_message_count) {
    return;
  }

  s_selected_message = index;
  recalc_message_layout();
  prepare_selected_image_request();
  GRect bounds = layer_get_bounds(s_messages_root);
  int margin = 6;
  int top = s_message_y[s_selected_message] - margin;
  int bottom = s_message_y[s_selected_message] + s_message_h[s_selected_message] + margin;

  if (s_message_h[s_selected_message] > bounds.size.h - (margin * 2)) {
    set_chat_scroll_offset(align_top ? top : bottom - bounds.size.h, animated);
    request_next_image();
    return;
  }

  if (align_top && top < s_chat_scroll_offset) {
    set_chat_scroll_offset(top, animated);
    request_next_image();
    return;
  }

  if (!align_top && bottom > s_chat_scroll_offset + bounds.size.h) {
    set_chat_scroll_offset(bottom - bounds.size.h, animated);
    request_next_image();
    return;
  }

  if (s_messages_root) {
    layer_mark_dirty(s_messages_root);
  }
  request_next_image();
}

static void render_messages(void) {
  if (!s_messages_root) {
    return;
  }
  recalc_message_layout();
  if (s_selected_message >= 0 && s_selected_message < s_message_count) {
    scroll_selected_message_into_view(false);
  } else {
    scroll_to_bottom(false);
  }
}

static void messages_root_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, CHAT_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  if (s_message_count == 0) {
    graphics_context_set_text_color(ctx, GColorDarkGray);
    graphics_draw_text(ctx, s_loading_messages ? "Loading messages..." : "No messages loaded",
                       fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(8, 40, bounds.size.w - 16, 80), GTextOverflowModeWordWrap,
                       GTextAlignmentCenter, NULL);
  }

  recalc_message_layout();
  GFont text_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  GFont sender_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GFont reaction_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  int first = 0;
  while (first < s_message_count - 1 &&
         s_message_y[first] + s_message_h[first] < s_chat_scroll_offset - 12) {
    first++;
  }

  for (int i = first; i < s_message_count; i++) {
    Message *message = &s_messages[i];
    char display_text[MESSAGE_PREVIEW_TEXT + 8];
    bool selected = i == s_selected_message;
    bool truncated = (int)strlen(message->text) > MESSAGE_PREVIEW_TEXT;
    int bubble_w = message_bubble_width(bounds);
    int text_w = bubble_w - 10;
    int inset = message_side_inset(bounds);
    int offset = ROUND_UI ? 6 : 0;
    int x = message->outgoing ? bounds.size.w - bubble_w - inset + offset : inset - offset;
    x = PG_MAX(2, PG_MIN(x, bounds.size.w - bubble_w - 2));
    int name_h = (!message->outgoing && message->sender[0]) ? 16 : 0;
    int reaction_h = (message->reactions[0] || message->meta[0]) ? 17 : 0;
    int context_h = message_context_height(message);
    int y = s_message_y[i] - s_chat_scroll_offset;
    int bubble_h = s_message_h[i];

    if (y > bounds.size.h) {
      break;
    }

    copy_cstr(display_text, sizeof(display_text), message->text);
    if (truncated) {
      copy_cstr(display_text + MESSAGE_PREVIEW_TEXT - 4, sizeof(display_text) - MESSAGE_PREVIEW_TEXT + 4, " ...");
    }

    GColor fill = BW_UI ? GColorWhite : (message->outgoing ? OUT_BUBBLE : IN_BUBBLE);
    GRect bubble = GRect(x, y, bubble_w, bubble_h);

    graphics_context_set_fill_color(ctx, fill);
    graphics_fill_rect(ctx, bubble, 6, GCornersAll);

    graphics_context_set_stroke_color(ctx, BW_UI ? GColorBlack : (selected ? APP_COLOR : GColorLightGray));
    graphics_draw_round_rect(ctx, bubble, 6);
    if (selected) {
      graphics_draw_round_rect(ctx, GRect(bubble.origin.x + 1, bubble.origin.y + 1,
                                          bubble.size.w - 2, bubble.size.h - 2), 5);
      if (BW_UI) {
        graphics_draw_round_rect(ctx, GRect(bubble.origin.x + 2, bubble.origin.y + 2,
                                            bubble.size.w - 4, bubble.size.h - 4), 4);
      }
    }

    int text_y = y + 2;
    if (name_h) {
      graphics_context_set_text_color(ctx, BW_UI ? GColorBlack : APP_COLOR);
      graphics_draw_text(ctx, message->sender, sender_font, GRect(x + 5, text_y, text_w, name_h),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      text_y += name_h;
    }
    if (context_h) {
      draw_message_context(ctx, message, GRect(x + 5, text_y + 1, text_w, context_h - 3));
      text_y += context_h;
    }
    graphics_context_set_text_color(ctx, GColorBlack);
    int image_h = message->image_placeholder ?
                  message_image_display_height(message, message_image_frame_width(bubble_w)) + 8 : 0;
    int text_rect_h = bubble_h - name_h - context_h - image_h - reaction_h - 6;
    if (display_text[0] && text_rect_h > 0 && text_w > 4) {
      graphics_draw_text(ctx, display_text, text_font,
                         GRect(x + 5, text_y, text_w, text_rect_h),
                         GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    }

    if (message->image_placeholder) {
      int max_image_w = message_image_frame_width(text_w);
      int image_w = message_image_display_width(message, max_image_w);
      int image_h = message_image_display_height(message, max_image_w);
      GRect image_rect = GRect(x + 5 + ((text_w - image_w) / 2),
                              y + bubble_h - reaction_h - image_h - 4,
                              image_w, image_h);
      if (message->image_bitmap) {
        graphics_draw_bitmap_in_rect(ctx, message->image_bitmap, image_rect);
      } else {
        int image_percent = 0;
        bool is_active_image = strcmp(message->image_token, s_image_message_id) == 0;
        if (message->image_requested && is_active_image) {
          image_percent = progress_percent(s_image_received, s_image_size);
        }
        bool gif = message_is_gif(message);
        const char *media_name = gif ? "GIF" : "Photo";
        const char *label = message->image_failed ? (gif ? "GIF failed" : "Photo failed") :
                            (message->image_requested ?
                             (message->image_decode_retries > 0 ? "Retrying image..." : "Loading Image...") :
                             media_name);
        graphics_context_set_stroke_color(ctx, BW_UI ? GColorBlack : GColorLightGray);
        graphics_draw_round_rect(ctx, image_rect, 4);
        graphics_context_set_text_color(ctx, GColorBlack);
        int label_y = image_rect.origin.y + PG_MAX(2, (image_rect.size.h - (message->image_requested ? 42 : 24)) / 2);
        graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                           GRect(image_rect.origin.x + 4, label_y, image_rect.size.w - 8, 24),
                           GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
        if (message->image_requested && image_rect.size.h >= 48) {
          int bar_w = PG_MIN(image_rect.size.w - 20, 112);
          GRect bar = GRect(image_rect.origin.x + ((image_rect.size.w - bar_w) / 2),
                            label_y + 28, bar_w, 10);
          draw_loading_bar(ctx, bar, image_percent);
        }
      }
    }

    if (reaction_h > 0) {
      int meta_w = message->meta[0] ? PG_MIN(50, text_w) : 0;
      graphics_context_set_text_color(ctx, BW_UI ? GColorBlack : GColorDarkGray);
      if (message->reactions[0]) {
        graphics_draw_text(ctx, message->reactions, reaction_font,
                           GRect(x + 7, y + bubble_h - reaction_h - 1,
                                 text_w - meta_w - 6, reaction_h),
                           GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      }
      if (message->meta[0]) {
        draw_message_meta(ctx, message->meta, reaction_font,
                          GRect(x + bubble_w - meta_w - 7, y + bubble_h - reaction_h - 1,
                                meta_w, reaction_h));
      }
    }
  }

  int compose_w = PG_MIN(bounds.size.w - 24, ROUND_UI ? 120 : 132);
  int compose_x = (bounds.size.w - compose_w) / 2;
  int compose_y = s_compose_bubble_y - s_chat_scroll_offset;
  bool compose_selected = compose_target_is_selected();
  GRect compose_rect = GRect(compose_x, compose_y, compose_w, COMPOSE_BUBBLE_H);
  if (s_at_newest && compose_y < bounds.size.h && compose_y + COMPOSE_BUBBLE_H > 0) {
    graphics_context_set_fill_color(ctx, BW_UI ? GColorWhite : GColorLightGray);
    graphics_fill_rect(ctx, compose_rect, COMPOSE_BUBBLE_H / 2, GCornersAll);
    graphics_context_set_stroke_color(ctx, BW_UI ? GColorBlack : (compose_selected ? APP_COLOR : GColorDarkGray));
    graphics_draw_round_rect(ctx, compose_rect, COMPOSE_BUBBLE_H / 2);
    if (compose_selected) {
      graphics_draw_round_rect(ctx, GRect(compose_rect.origin.x + 1, compose_rect.origin.y + 1,
                                          compose_rect.size.w - 2, compose_rect.size.h - 2),
                               (COMPOSE_BUBBLE_H / 2) - 1);
    }
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "New message", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(compose_rect.origin.x + 8, compose_rect.origin.y + 3,
                             compose_rect.size.w - 16, compose_rect.size.h - 5),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void destroy_chat_view(void) {
  if (s_chat_scroll_timer) {
    app_timer_cancel(s_chat_scroll_timer);
    s_chat_scroll_timer = NULL;
  }
  if (s_messages_root) {
    layer_destroy(s_messages_root);
    s_messages_root = NULL;
  }
}

static void show_chat_view(void) {
  s_chat_view_pending = false;
  s_view_state = ViewStateChat;
  window_set_click_config_provider(s_main_window, click_config_provider);
  destroy_chat_view();
  if (s_chat_menu) {
    layer_set_hidden(menu_layer_get_layer(s_chat_menu), true);
  }
  show_status(s_current_chat_title);

  Layer *window_layer = window_get_root_layer(s_main_window);
  GRect bounds = layer_get_bounds(window_layer);
  int content_y = chat_content_y();
  int bottom_pad = chat_bottom_pad();
  s_messages_root = layer_create(GRect(0, content_y, bounds.size.w, bounds.size.h - content_y - bottom_pad));
  layer_set_update_proc(s_messages_root, messages_root_update_proc);
  layer_add_child(window_layer, s_messages_root);
  s_chat_scroll_offset = 0;
  s_chat_content_height = 0;
  recalc_message_layout();
  if (s_message_count > 0) {
    s_chat_scroll_offset = clamp_scroll_offset(s_chat_content_height);
  }
  render_messages();
}

static void show_chat_view_timer(void *data) {
  show_chat_view();
}

static void render_chat_list(void) {
  int row = s_selected_chat;
  s_view_state = ViewStateChatList;
  s_chats_loading = false;
  s_loading_error = false;
  window_set_click_config_provider(s_main_window, click_config_provider);
  destroy_chat_view();
  if (s_chat_menu) {
    int saved_row = find_chat_index_by_id(s_chat_list_selected_id);
    if (saved_row >= 0) {
      row = saved_row;
    }
    layer_set_hidden(menu_layer_get_layer(s_chat_menu), false);
    menu_layer_reload_data(s_chat_menu);
    select_chat_row(row, false);
  }
  show_status("Pebblegram");
}

static void select_chat_row(int row, bool animated) {
  if (!s_chat_menu || s_chats_loading || s_chat_count <= 0) {
    return;
  }
  s_selected_chat = PG_MAX(0, PG_MIN(row, s_chat_count - 1));
  copy_cstr(s_chat_list_selected_id, sizeof(s_chat_list_selected_id), s_chats[s_selected_chat].id);
  menu_layer_set_selected_index(s_chat_menu, MenuIndex(0, s_selected_chat), MenuRowAlignCenter, animated);
}

static void remove_chat_at(int row) {
  if (row < 0 || row >= s_chat_count) {
    return;
  }
  destroy_chat_avatar(&s_chats[row]);
  for (int i = row; i < s_chat_count - 1; i++) {
    s_chats[i] = s_chats[i + 1];
  }
  memset(&s_chats[s_chat_count - 1], 0, sizeof(Chat));
  s_chat_count--;
  if (s_selected_chat > row) {
    s_selected_chat--;
  }
  if (s_chat_count <= 0) {
    s_selected_chat = 0;
  } else if (s_selected_chat >= s_chat_count) {
    s_selected_chat = s_chat_count - 1;
  }
  if (s_chat_menu) {
    menu_layer_reload_data(s_chat_menu);
    select_chat_row(s_selected_chat, false);
  }
}

static void request_chats(void) {
  s_view_state = ViewStateChatList;
  destroy_message_images();
  destroy_chat_avatars();
  s_chat_count = 0;
  s_expected_rows = 0;
  s_bridge_ready = false;
  s_chats_loading = true;
  show_loading_text("Loading...", false);
  show_status("Pebblegram");
  if (s_chat_menu) {
    menu_layer_reload_data(s_chat_menu);
  }
  send_command("get_chats", NULL, NULL, NULL, NULL);
}

static void cancel_message_timeout(void) {
  if (s_message_timeout_timer) {
    app_timer_cancel(s_message_timeout_timer);
    s_message_timeout_timer = NULL;
  }
}

static void schedule_message_timeout(void) {
  cancel_message_timeout();
  s_message_timeout_timer = app_timer_register(MESSAGE_TRANSFER_TIMEOUT_MS, message_timeout_timer_callback, NULL);
}

static void cancel_message_retry(void) {
  if (s_message_retry_timer) {
    app_timer_cancel(s_message_retry_timer);
    s_message_retry_timer = NULL;
  }
}

static void message_timeout_timer_callback(void *data) {
  s_message_timeout_timer = NULL;
  if (!s_loading_messages && !s_loading_older_messages && !s_loading_newer_messages) {
    return;
  }
  bool had_rows = s_message_count > 0;
  s_loading_messages = false;
  s_loading_older_messages = false;
  s_loading_newer_messages = false;
  s_message_transfer_id = 0;
  s_older_anchor_id[0] = '\0';
  s_newer_anchor_id[0] = '\0';
  clear_message_stage();
  reset_message_stream_state();
  show_status(had_rows ? s_current_chat_title : "Messages failed");
  if (s_messages_root) {
    layer_mark_dirty(s_messages_root);
  }
}

static void message_retry_timer_callback(void *data) {
  s_message_retry_timer = NULL;
  if (!s_loading_messages || s_message_count > 0) {
    return;
  }
  if (s_message_request_attempts >= MESSAGE_COMMAND_MAX_ATTEMPTS) {
    return;
  }

  s_message_request_attempts++;
  if (send_command("get_messages", s_current_chat_id, NULL, NULL, NULL) &&
      s_message_request_attempts < MESSAGE_COMMAND_MAX_ATTEMPTS) {
    s_message_retry_timer = app_timer_register(MESSAGE_COMMAND_RETRY_MS, message_retry_timer_callback, NULL);
  }
}

// Load the first photo that is visible or just about to enter view. This keeps
// heap use predictable while still prefetching as the user scrolls.
static bool send_active_image_request(void) {
  if (!s_image_message_id[0]) {
    return false;
  }
  Message *message = find_message_by_image_token(s_image_message_id);
  if (!message || message->image_bitmap) {
    clear_active_image_request();
    return false;
  }
  int image_index = message_index_from_ptr(message);
  if (!message_image_near_viewport(image_index, IMAGE_KEEP_SCREEN_MARGIN)) {
    clear_active_image_request();
    return false;
  }
  if (send_command_with_status("get_image", s_current_chat_id, NULL, NULL, message->image_token, false)) {
    return true;
  }
  schedule_image_retry();
  return false;
}

static void request_next_image(void) {
  if (!s_messages_root || s_message_count == 0) {
    return;
  }
  refresh_loaded_image_count();

  if (s_image_message_id[0]) {
    Message *active_message = find_message_by_image_token(s_image_message_id);
    int active_index = message_index_from_ptr(active_message);
    if (!message_image_visible(active_index) ||
        (selected_message_needs_image() && active_index != s_selected_message)) {
      clear_active_image_request();
    } else {
      return;
    }
  }

  if (s_image_message_id[0]) {
    return;
  }

  int image_index = selected_message_needs_image() ? s_selected_message : -1;
  if (image_index < 0) {
    image_index = find_best_image_candidate(true, true);
  }
  if (image_index < 0) {
    image_index = find_best_image_candidate(true, false);
  }

  if (image_index < 0) {
    return;
  }

  if (s_loaded_image_count >= MAX_LOADED_IMAGES) {
    if (destroy_farthest_loaded_image()) {
      refresh_loaded_image_count();
    }
    if (s_loaded_image_count >= MAX_LOADED_IMAGES && image_index == s_selected_message &&
        destroy_unselected_loaded_image()) {
      refresh_loaded_image_count();
    }
    if (s_loaded_image_count >= MAX_LOADED_IMAGES) {
      return;
    }
  }

  Message *message = &s_messages[image_index];
  message->image_failed = false;
  message->image_requested = true;
  copy_cstr(s_image_message_id, sizeof(s_image_message_id), message->image_token);
  s_image_size = 0;
  s_image_received = 0;
  s_image_expected_offset = 0;
  s_image_transfer_id = 0;
  send_active_image_request();
  if (s_messages_root) {
    layer_mark_dirty(s_messages_root);
  }
}

static void image_retry_timer_callback(void *data) {
  s_image_retry_timer = NULL;
  if (!send_active_image_request()) {
    request_next_image();
  }
}

static void request_older_messages(bool silent) {
  if (s_at_oldest) {
    if (!silent) {
      show_status("No older messages");
    }
    return;
  }
  if (s_message_count <= 0 || !s_messages[0].id[0]) {
    if (!silent) {
      show_status("No older messages");
    }
    return;
  }
  if (s_loading_older_messages) {
    return;
  }
  recalc_message_layout();
  if (s_selected_message >= 0 && s_selected_message < s_message_count) {
    copy_cstr(s_older_anchor_id, sizeof(s_older_anchor_id), s_messages[s_selected_message].id);
    s_older_anchor_y = s_message_y[s_selected_message];
    s_older_anchor_scroll_offset = s_chat_scroll_offset;
  } else {
    s_older_anchor_id[0] = '\0';
    s_older_anchor_y = 0;
    s_older_anchor_scroll_offset = s_chat_scroll_offset;
  }
  s_loading_older_messages = true;
  if (!silent) {
    show_status("Loading older...");
  }
  const char *anchor_id = (s_selected_message >= 0 && s_selected_message < s_message_count) ?
                          s_messages[s_selected_message].id : s_messages[0].id;
  if (!send_command_with_status("get_older_messages", s_current_chat_id, silent ? "silent" : NULL,
                                s_messages[0].id, anchor_id, !silent)) {
    s_loading_older_messages = false;
    s_older_anchor_id[0] = '\0';
    s_older_anchor_y = 0;
  } else {
    schedule_message_timeout();
  }
}

static void request_newer_messages(bool silent) {
  if (s_message_count <= 0 || !s_messages[s_message_count - 1].id[0]) {
    if (!silent) {
      scroll_to_bottom(true);
    }
    return;
  }
  if (s_at_newest) {
    if (!silent) {
      scroll_to_bottom(true);
    }
    return;
  }
  if (s_loading_newer_messages) {
    return;
  }
  recalc_message_layout();
  if (s_selected_message >= 0 && s_selected_message < s_message_count) {
    copy_cstr(s_newer_anchor_id, sizeof(s_newer_anchor_id), s_messages[s_selected_message].id);
    s_newer_anchor_y = s_message_y[s_selected_message];
    s_newer_anchor_scroll_offset = s_chat_scroll_offset;
  } else {
    s_newer_anchor_id[0] = '\0';
    s_newer_anchor_y = 0;
    s_newer_anchor_scroll_offset = s_chat_scroll_offset;
  }
  s_loading_newer_messages = true;
  if (!silent) {
    show_status("Loading newer...");
  }
  const char *anchor_id = (s_selected_message >= 0 && s_selected_message < s_message_count) ?
                          s_messages[s_selected_message].id : s_messages[s_message_count - 1].id;
  if (!send_command_with_status("get_newer_messages", s_current_chat_id, silent ? "silent" : NULL,
                                s_messages[s_message_count - 1].id, anchor_id, !silent)) {
    s_loading_newer_messages = false;
    s_newer_anchor_id[0] = '\0';
    s_newer_anchor_y = 0;
  } else {
    schedule_message_timeout();
  }
}

static void request_messages(const char *chat_id) {
  cancel_message_timeout();
  cancel_message_retry();
  destroy_message_images();
  clear_message_stage();
  s_loading_older_messages = false;
  s_loading_newer_messages = false;
  s_older_anchor_id[0] = '\0';
  s_newer_anchor_id[0] = '\0';
  s_older_anchor_y = 0;
  s_newer_anchor_y = 0;
  s_older_anchor_scroll_offset = 0;
  s_newer_anchor_scroll_offset = 0;
  s_at_newest = true;
  s_at_oldest = false;
  s_message_scroll_direction = 0;
  s_message_count = 0;
  s_expected_rows = 0;
  s_message_transfer_id = 0;
  reset_message_stream_state();
  s_selected_message = -1;
  s_user_scrolled_messages = false;
  s_chat_view_pending = false;
  s_loading_messages = true;
  s_message_request_attempts = 1;
  show_status("Loading messages...");
  if (s_view_state != ViewStateChat || !s_messages_root) {
    show_chat_view();
  } else {
    render_messages();
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
  }
  if (send_command("get_messages", chat_id, NULL, NULL, NULL)) {
    s_message_retry_timer = app_timer_register(MESSAGE_COMMAND_RETRY_MS, message_retry_timer_callback, NULL);
  }
  schedule_message_timeout();
}

static void maybe_prefetch_older_messages(void) {
  if (!s_loading_older_messages && !s_at_oldest && s_message_count > 0 &&
      s_selected_message >= 0) {
    request_older_messages(true);
  }
}

static void maybe_prefetch_newer_messages(void) {
  if (!s_loading_newer_messages && !s_at_newest && s_message_count > 0 &&
      s_selected_message >= 0) {
    request_newer_messages(true);
  }
}

static void send_text_message(const char *text, bool as_reply) {
  const char *reply_to = NULL;
  if (as_reply && s_selected_message >= 0 && s_selected_message < s_message_count) {
    reply_to = s_messages[s_selected_message].id;
  }
  show_status("Sending...");
  send_command("send_message", s_current_chat_id, text, reply_to, NULL);
}

static void edit_selected_message(const char *text) {
  if (!s_pending_edit_message_id[0]) {
    show_status("No edit target");
    return;
  }
  show_status("Editing...");
  send_command("edit_message", s_current_chat_id, text, NULL, s_pending_edit_message_id);
  s_pending_edit_message_id[0] = '\0';
}

static bool has_selected_message(void) {
  return s_selected_message >= 0 && s_selected_message < s_message_count;
}

static bool compose_target_is_selected(void) {
  return s_at_newest && s_selected_message == s_message_count;
}

static bool selected_message_is_truncated(void) {
  return has_selected_message() &&
         (int)strlen(s_messages[s_selected_message].text) > MESSAGE_PREVIEW_TEXT;
}

static bool selected_message_has_context(void) {
  return has_selected_message() && message_has_context(&s_messages[s_selected_message]);
}

static bool selected_message_context_is_forward(void) {
  return selected_message_has_context() &&
         strncmp(s_messages[s_selected_message].context, "Fwd from ", 9) == 0;
}

static void delete_selected_message(void) {
  if (s_selected_message < 0 || s_selected_message >= s_message_count) {
    return;
  }
  show_status("Deleting...");
  send_command("delete_message", s_current_chat_id, NULL, NULL, s_messages[s_selected_message].id);
}

static const ReactionChoice *reaction_grid_choices(void) {
  return REACTION_GRID_CHOICES;
}

static int reaction_grid_count(void) {
  return (int)(sizeof(REACTION_GRID_CHOICES) / sizeof(REACTION_GRID_CHOICES[0]));
}

static const char *reaction_grid_token_at(int index) {
  if (index < 0 || index >= reaction_grid_count()) {
    return "";
  }
  return reaction_grid_choices()[index].token;
}

static void send_selected_reaction(const char *token) {
  if (!has_selected_message()) {
    return;
  }
  show_status((token && strcmp(token, "remove") == 0) ? "Removing..." : "Reacting...");
  send_command("send_reaction", s_current_chat_id, token, NULL, s_messages[s_selected_message].id);
}

static void send_selected_chat_action(const char *command) {
  if (s_selected_chat < 0 || s_selected_chat >= s_chat_count) {
    return;
  }
  show_status("Updating...");
  send_command(command, s_chats[s_selected_chat].id, NULL, NULL, NULL);
}

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  char *type = tuple_cstring(iter, MESSAGE_KEY_Type);
  if (!type) {
    return;
  }

  if (strcmp(type, "status") == 0) {
    char *status = tuple_cstring(iter, MESSAGE_KEY_Status);
    if (status) {
      if (s_chats_loading && s_view_state != ViewStateChat) {
        s_chats_loading = true;
        show_loading_text(status, false);
      }
      if (strcmp(status, "Loading messages...") == 0) {
        cancel_message_retry();
      }
      show_status(status);
    }
    return;
  }

  if (strcmp(type, "settings") == 0) {
    update_canned_replies(tuple_cstring(iter, MESSAGE_KEY_CannedReplies));
    return;
  }

  if (strcmp(type, "error") == 0) {
    char *error = tuple_cstring(iter, MESSAGE_KEY_Error);
    cancel_message_timeout();
    cancel_message_retry();
    if (s_view_state != ViewStateChat) {
      s_bridge_ready = false;
      s_chats_loading = true;
      show_loading_text(error ? error : "Login failed", true);
      show_status("Pebblegram");
    } else {
      s_loading_messages = false;
      s_loading_older_messages = false;
      s_loading_newer_messages = false;
      s_message_transfer_id = 0;
      show_status(error ? error : "Error");
      if (s_messages_root) {
        layer_mark_dirty(s_messages_root);
      }
    }
    return;
  }

  int index = tuple_int(iter, MESSAGE_KEY_Index, 0);
  int count = tuple_int(iter, MESSAGE_KEY_Count, 0);
  s_expected_rows = count;

  if (strcmp(type, "chats_done") == 0) {
    char selected_id[MAX_ID];
    copy_cstr(selected_id, sizeof(selected_id), s_chat_list_selected_id);
    if (!selected_id[0]) {
      copy_cstr(selected_id, sizeof(selected_id), s_chat_refresh_selected_id);
    }
    s_chat_refresh_selected_id[0] = '\0';
    if (!selected_id[0] && s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
      copy_cstr(selected_id, sizeof(selected_id), s_chats[s_selected_chat].id);
    }
    if (s_view_state == ViewStateLoading) {
      s_view_state = ViewStateChatList;
    }
    s_bridge_ready = true;
    s_chats_loading = false;
    s_loading_error = false;
    if (s_chat_count > count) {
      s_chat_count = count;
    }
    int preserved_index = find_chat_index_by_id(selected_id);
    if (preserved_index >= 0) {
      s_selected_chat = preserved_index;
      copy_cstr(s_chat_list_selected_id, sizeof(s_chat_list_selected_id), s_chats[s_selected_chat].id);
    } else if (s_selected_chat >= s_chat_count) {
      s_selected_chat = s_chat_count > 0 ? s_chat_count - 1 : 0;
    }
    if (s_chat_menu) {
      menu_layer_reload_data(s_chat_menu);
      select_chat_row(s_selected_chat, false);
    }
    show_status("Pebblegram");
    return;
  }

  if (strcmp(type, "messages_start") == 0) {
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    int mode = tuple_int(iter, MESSAGE_KEY_Index, MESSAGE_MODE_INITIAL);
    bool initial = mode == MESSAGE_MODE_INITIAL;
    if (initial && s_view_state != ViewStateChat && !s_loading_messages) {
      return;
    }
    s_message_transfer_id = transfer_id;
    s_expected_rows = count;
    s_message_stream_mode = mode;
    char *stream_flag = tuple_cstring(iter, MESSAGE_KEY_Text);
    s_message_stream_silent = stream_flag && strcmp(stream_flag, "silent") == 0;
    if (initial) {
      clear_message_stage();
      clear_message_rows();
      s_loading_older_messages = false;
      s_loading_newer_messages = false;
      s_older_anchor_id[0] = '\0';
      s_newer_anchor_id[0] = '\0';
      s_at_newest = true;
      s_at_oldest = false;
    } else if (!prepare_message_stage()) {
      reset_message_stream_state();
      s_loading_older_messages = false;
      s_loading_newer_messages = false;
      show_status("Memory low");
      return;
    }
    if (initial && !s_message_stream_silent && s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    return;
  }

  if (strcmp(type, "message_prepend") == 0) {
    char anchor_id[MAX_ID];
    int anchor_y = 0;
    Message *slot;
    if (!message_transfer_matches(iter)) {
      return;
    }
    if (s_view_state != ViewStateChat || !s_messages_root) {
      return;
    }
    anchor_id[0] = '\0';
    recalc_message_layout();
    if (!s_message_stream_silent && s_loading_older_messages && s_older_anchor_id[0]) {
      copy_cstr(anchor_id, sizeof(anchor_id), s_older_anchor_id);
      int anchor_index = find_message_index_by_id(s_older_anchor_id);
      if (anchor_index >= 0) {
        anchor_y = s_message_y[anchor_index];
      }
    } else if (has_selected_message()) {
      copy_cstr(anchor_id, sizeof(anchor_id), s_messages[s_selected_message].id);
      anchor_y = s_message_y[s_selected_message];
    }
    slot = prepend_message_slot();
    populate_message_from_tuple(slot, iter);
    s_expected_rows = count;
    render_after_stream_prepend(anchor_id, anchor_y);
    return;
  }

  if (strcmp(type, "message_append") == 0) {
    char anchor_id[MAX_ID];
    int anchor_y = 0;
    Message *slot;
    if (!message_transfer_matches(iter)) {
      return;
    }
    if (s_view_state != ViewStateChat || !s_messages_root) {
      return;
    }
    anchor_id[0] = '\0';
    recalc_message_layout();
    if (!s_message_stream_silent && s_loading_newer_messages && s_newer_anchor_id[0]) {
      copy_cstr(anchor_id, sizeof(anchor_id), s_newer_anchor_id);
      int anchor_index = find_message_index_by_id(s_newer_anchor_id);
      if (anchor_index >= 0) {
        anchor_y = s_message_y[anchor_index];
      }
    } else if (has_selected_message()) {
      copy_cstr(anchor_id, sizeof(anchor_id), s_messages[s_selected_message].id);
      anchor_y = s_message_y[s_selected_message];
    }
    slot = append_message_slot();
    populate_message_from_tuple(slot, iter);
    s_expected_rows = count;
    render_after_stream_append(anchor_id, anchor_y);
    return;
  }

  if (strcmp(type, "messages_done") == 0) {
    if (!message_transfer_matches(iter)) {
      return;
    }
    cancel_message_timeout();
    cancel_message_retry();
    char selected_id[MAX_ID];
    bool loading_initial = s_loading_messages;
    bool loading_older = s_loading_older_messages;
    bool loading_newer = s_loading_newer_messages;
    char *done_flag = tuple_cstring(iter, MESSAGE_KEY_Text);
    bool loading_silent = s_message_stream_silent || (done_flag && strcmp(done_flag, "silent") == 0);
    bool show_pending = s_chat_view_pending;
    bool chat_visible = s_view_state == ViewStateChat && s_messages_root;
    s_loading_messages = false;
    s_message_transfer_id = 0;
    selected_id[0] = '\0';

    if (loading_older && count == 0) {
      s_loading_older_messages = false;
      s_older_anchor_id[0] = '\0';
      s_older_anchor_y = 0;
      s_at_oldest = true;
      clear_message_stage();
      reset_message_stream_state();
      if (!loading_silent) {
        show_status("No older messages");
        if (s_messages_root) {
          layer_mark_dirty(s_messages_root);
        }
      }
      return;
    }

    if (loading_newer && count == 0) {
      s_loading_newer_messages = false;
      s_newer_anchor_id[0] = '\0';
      s_newer_anchor_y = 0;
      s_at_newest = true;
      clear_message_stage();
      reset_message_stream_state();
      if (!loading_silent) {
        show_status(s_current_chat_title);
        if (s_messages_root) {
          layer_mark_dirty(s_messages_root);
        }
      }
      return;
    }

    char fallback_id[MAX_ID];
    bool staged_load = loading_older || loading_newer;
    bool live_anchor = false;
    fallback_id[0] = '\0';

    if (chat_visible && staged_load && has_selected_message()) {
      recalc_message_layout();
      copy_cstr(selected_id, sizeof(selected_id), s_messages[s_selected_message].id);
      live_anchor = true;
    }

    if (loading_older) {
      s_at_newest = false;
      s_at_oldest = false;
      copy_cstr(fallback_id, sizeof(fallback_id), s_older_anchor_id);
    } else if (loading_newer) {
      s_at_oldest = false;
      copy_cstr(fallback_id, sizeof(fallback_id), s_newer_anchor_id);
    } else if (s_user_scrolled_messages && s_selected_message >= 0 && s_selected_message < s_message_count) {
      copy_cstr(selected_id, sizeof(selected_id), s_messages[s_selected_message].id);
    }

    bool reversed_load = staged_load &&
                         ((loading_older && s_message_scroll_direction > 0) ||
                          (loading_newer && s_message_scroll_direction < 0));
    if (reversed_load) {
      s_loading_older_messages = false;
      s_loading_newer_messages = false;
      s_older_anchor_id[0] = '\0';
      s_newer_anchor_id[0] = '\0';
      clear_message_stage();
      reset_message_stream_state();
      if (chat_visible) {
        show_status(s_current_chat_title);
        layer_mark_dirty(s_messages_root);
      }
      return;
    }

    if (staged_load && live_anchor && !message_stage_contains_id(selected_id)) {
      s_loading_older_messages = false;
      s_loading_newer_messages = false;
      s_older_anchor_id[0] = '\0';
      s_newer_anchor_id[0] = '\0';
      clear_message_stage();
      reset_message_stream_state();
      if (chat_visible) {
        show_status(s_current_chat_title);
        layer_mark_dirty(s_messages_root);
      }
      if (loading_older && !s_at_oldest) {
        request_older_messages(true);
      } else if (loading_newer && !s_at_newest) {
        request_newer_messages(true);
      }
      return;
    }

    if (staged_load && !live_anchor && fallback_id[0]) {
      copy_cstr(selected_id, sizeof(selected_id), fallback_id);
    }

    if (staged_load && s_message_stage) {
      commit_message_stage(count);
    } else if (s_message_count > count) {
      s_message_count = count;
    }
    int preserved_index = find_message_index_by_id(selected_id);
    if (preserved_index < 0 && staged_load && fallback_id[0]) {
      copy_cstr(selected_id, sizeof(selected_id), fallback_id);
      preserved_index = find_message_index_by_id(selected_id);
    }
    if (preserved_index >= 0) {
      s_selected_message = preserved_index;
    } else if (!s_user_scrolled_messages && !staged_load) {
      s_selected_message = s_at_newest ? s_message_count : (s_message_count > 0 ? s_message_count - 1 : -1);
    } else if (s_message_count > 0 && s_selected_message >= s_message_count) {
      s_selected_message = s_message_count - 1;
    } else if (s_message_count <= 0) {
      s_selected_message = -1;
    }
    s_loading_older_messages = false;
    s_loading_newer_messages = false;
    s_older_anchor_id[0] = '\0';
    s_newer_anchor_id[0] = '\0';
    reset_message_stream_state();
    s_expected_rows = count;
    if (!loading_older && !loading_newer && s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
      s_chats[s_selected_chat].unread = false;
      s_chats[s_selected_chat].unread_count = 0;
    }

    if (chat_visible) {
      recalc_message_layout();
      if (staged_load && preserved_index >= 0) {
        GRect bounds = layer_get_bounds(s_messages_root);
        int margin = 6;
        bool anchor_top = s_message_scroll_direction < 0 ||
                          (s_message_scroll_direction == 0 && loading_older);
        int target = anchor_top ?
                     s_message_y[preserved_index] - margin :
                     s_message_y[preserved_index] + s_message_h[preserved_index] + margin - bounds.size.h;
        set_chat_scroll_offset(target, false);
      }
      if (has_selected_message()) {
        if (!loading_silent && !staged_load) {
          scroll_selected_message_into_view(false);
        }
      } else if (!loading_silent) {
        scroll_to_bottom(false);
      }
      show_status(s_current_chat_title);
      layer_mark_dirty(s_messages_root);
      s_older_anchor_y = 0;
      s_newer_anchor_y = 0;
      request_next_image();
      return;
    }

    s_older_anchor_y = 0;
    s_newer_anchor_y = 0;
    if (!show_pending && loading_initial) {
      s_chat_view_pending = true;
      app_timer_register(1, show_chat_view_timer, NULL);
    }
    return;
  }

  if (strcmp(type, "chat") == 0 && index >= 0 && index < MAX_CHATS) {
    if (s_view_state == ViewStateLoading) {
      s_view_state = ViewStateChatList;
    }
    if (index == 0) {
      s_chat_refresh_selected_id[0] = '\0';
      if (s_chat_menu && s_view_state == ViewStateChatList) {
        MenuIndex selected = menu_layer_get_selected_index(s_chat_menu);
        s_selected_chat = selected.row;
        if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
          copy_cstr(s_chat_list_selected_id, sizeof(s_chat_list_selected_id),
                    s_chats[s_selected_chat].id);
        }
      }
      if (s_chat_list_selected_id[0]) {
        copy_cstr(s_chat_refresh_selected_id, sizeof(s_chat_refresh_selected_id),
                  s_chat_list_selected_id);
      } else if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
        copy_cstr(s_chat_refresh_selected_id, sizeof(s_chat_refresh_selected_id),
                  s_chats[s_selected_chat].id);
      }
    }
    Chat *chat = &s_chats[index];
    char *incoming_id = tuple_cstring(iter, MESSAGE_KEY_ChatId);
    if (incoming_id && strcmp(chat->id, incoming_id) != 0) {
      preserve_chat_avatar(chat, incoming_id);
    }
    copy_cstr(chat->id, sizeof(chat->id), incoming_id);
    copy_cstr(chat->title, sizeof(chat->title), tuple_cstring(iter, MESSAGE_KEY_Sender));
    copy_cstr(chat->preview, sizeof(chat->preview), tuple_cstring(iter, MESSAGE_KEY_Text));
    chat->unread = tuple_int(iter, MESSAGE_KEY_IsUnread, 0) != 0;
    chat->unread_count = tuple_int(iter, MESSAGE_KEY_UnreadCount, chat->unread ? 1 : 0);
    if (index + 1 > s_chat_count) {
      s_chat_count = index + 1;
    }
    s_bridge_ready = true;
    s_loading_error = false;
    if (s_chats_loading && s_chat_count > 0) {
      s_chats_loading = false;
      if (s_view_state == ViewStateLoading) {
        s_view_state = ViewStateChatList;
      }
    }
    if (s_chat_menu) {
      menu_layer_reload_data(s_chat_menu);
    }
    if (s_chat_count >= s_expected_rows) {
      show_status("Pebblegram");
    }
    return;
  }

  if (strcmp(type, "message") == 0 && index >= 0 && index < MAX_MESSAGES) {
    cancel_message_timeout();
    cancel_message_retry();
    bool stream_initial = s_message_stream_mode == MESSAGE_MODE_INITIAL;
    Message *message = stream_initial || !s_message_stage ? &s_messages[index] : &s_message_stage[index];
    populate_message_from_tuple(message, iter);
    if (index + 1 > s_message_stage_count && !stream_initial && s_message_stage) {
      s_message_stage_count = index + 1;
    }
    if (index + 1 > s_message_count && stream_initial) {
      s_message_count = index + 1;
    }
    if (stream_initial && !s_message_stream_silent && s_view_state == ViewStateChat && s_messages_root) {
      render_messages();
      layer_mark_dirty(s_messages_root);
    }
    int loaded_count = stream_initial ? s_message_count : s_message_stage_count;
    if (loaded_count < s_expected_rows &&
        (s_loading_messages || s_loading_older_messages || s_loading_newer_messages)) {
      schedule_message_timeout();
    }
    if (loaded_count >= s_expected_rows) {
      if (stream_initial) {
        if (!s_user_scrolled_messages) {
          s_selected_message = s_at_newest ? s_message_count : (s_message_count > 0 ? s_message_count - 1 : -1);
        } else if (s_selected_message < 0 || s_selected_message >= s_message_count) {
          s_selected_message = s_message_count > 0 ? s_message_count - 1 : s_message_count;
        }
        request_next_image();
      }
      APP_LOG(APP_LOG_LEVEL_INFO, "Loaded %d messages", loaded_count);
      if (stream_initial && s_loading_messages && s_view_state != ViewStateChat && !s_chat_view_pending) {
        s_chat_view_pending = true;
        app_timer_register(1, show_chat_view_timer, NULL);
      }
    }
    return;
  }

  if (strcmp(type, "avatar_start") == 0) {
    char *chat_id = tuple_cstring(iter, MESSAGE_KEY_ChatId);
    int image_size = tuple_int(iter, MESSAGE_KEY_ImageSize, 0);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    if (!chat_id || find_chat_index_by_id(chat_id) < 0 || image_size <= 0 || image_size > MAX_AVATAR_BYTES) {
      s_avatar_chat_id[0] = '\0';
      s_avatar_size = 0;
      s_avatar_received = 0;
      s_avatar_expected_offset = 0;
      s_avatar_transfer_id = 0;
      return;
    }
    copy_cstr(s_avatar_chat_id, sizeof(s_avatar_chat_id), chat_id);
    s_avatar_size = image_size;
    s_avatar_received = 0;
    s_avatar_expected_offset = 0;
    s_avatar_transfer_id = transfer_id;
    return;
  }

  if (strcmp(type, "avatar") == 0) {
    char *chat_id = tuple_cstring(iter, MESSAGE_KEY_ChatId);
    int offset = tuple_int(iter, MESSAGE_KEY_Index, -1);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    Tuple *data = dict_find(iter, MESSAGE_KEY_ImageData);
    if (!chat_id || strcmp(chat_id, s_avatar_chat_id) != 0 || transfer_id != s_avatar_transfer_id || !data ||
        offset != s_avatar_expected_offset ||
        offset < 0 || offset + data->length > MAX_AVATAR_BYTES || offset + data->length > s_avatar_size) {
      s_avatar_chat_id[0] = '\0';
      s_avatar_size = 0;
      s_avatar_received = 0;
      s_avatar_expected_offset = 0;
      s_avatar_transfer_id = 0;
      return;
    }
    memcpy(s_avatar_buffer + offset, data->value->data, data->length);
    s_avatar_received = offset + data->length;
    s_avatar_expected_offset = s_avatar_received;
    return;
  }

  if (strcmp(type, "avatar_done") == 0) {
    char *chat_id = tuple_cstring(iter, MESSAGE_KEY_ChatId);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    int chat_index = find_chat_index_by_id(chat_id);
    if (chat_index >= 0 && chat_id && strcmp(chat_id, s_avatar_chat_id) == 0 &&
        transfer_id == s_avatar_transfer_id && s_avatar_received == s_avatar_size) {
      Chat *chat = &s_chats[chat_index];
      destroy_chat_avatar(chat);
      chat->avatar_bitmap = gbitmap_create_from_png_data(s_avatar_buffer, s_avatar_size);
      if (s_chat_menu) {
        layer_mark_dirty(menu_layer_get_layer(s_chat_menu));
      }
    }
    if (chat_id && strcmp(chat_id, s_avatar_chat_id) == 0) {
      s_avatar_chat_id[0] = '\0';
      s_avatar_size = 0;
      s_avatar_received = 0;
      s_avatar_expected_offset = 0;
      s_avatar_transfer_id = 0;
    }
    return;
  }

  if (strcmp(type, "image_start") == 0) {
    char *message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    int image_size = tuple_int(iter, MESSAGE_KEY_ImageSize, 0);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    Message *message = find_message_by_image_token(message_id);
    bool is_active_image = message_id && strcmp(message_id, s_image_message_id) == 0;
    if (!message || !is_active_image) {
      request_next_image();
      return;
    }
    if (!message_id || transfer_id <= 0 || image_size <= 0 || image_size > MAX_IMAGE_BYTES) {
      message->image_requested = false;
      message->image_failed = true;
      if (s_messages_root) {
        layer_mark_dirty(s_messages_root);
      }
      if (message_id && strcmp(message_id, s_image_message_id) == 0) {
        s_image_message_id[0] = '\0';
        s_image_transfer_id = 0;
      }
      request_next_image();
      return;
    }
    copy_cstr(s_image_message_id, sizeof(s_image_message_id), message_id);
    s_image_size = image_size;
    s_image_received = 0;
    s_image_expected_offset = 0;
    s_image_transfer_id = transfer_id;
    schedule_image_transfer_timeout();
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    return;
  }

  if (strcmp(type, "image") == 0) {
    char *message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    int offset = tuple_int(iter, MESSAGE_KEY_Index, -1);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    Tuple *data = dict_find(iter, MESSAGE_KEY_ImageData);
    if (!message_id || strcmp(message_id, s_image_message_id) != 0 ||
        transfer_id != s_image_transfer_id || !data) {
      return;
    }
    if (offset != s_image_expected_offset ||
        offset < 0 || offset + data->length > MAX_IMAGE_BYTES || offset + data->length > s_image_size) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "Image transfer gap for %s at %d expected %d",
              message_id, offset, s_image_expected_offset);
      clear_active_image_request();
      schedule_image_retry();
      if (s_messages_root) {
        layer_mark_dirty(s_messages_root);
      }
      return;
    }
    memcpy(s_image_buffer + offset, data->value->data, data->length);
    s_image_received = offset + data->length;
    s_image_expected_offset = s_image_received;
    schedule_image_transfer_timeout();
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    return;
  }

  if (strcmp(type, "image_done") == 0) {
    char *message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, 0);
    Message *message = find_message_by_image_token(message_id);
    int image_index = message_index_from_ptr(message);
    bool should_keep_image = message_image_near_viewport(image_index, IMAGE_KEEP_SCREEN_MARGIN);
    bool is_active_image = message_id && strcmp(message_id, s_image_message_id) == 0 &&
                           transfer_id == s_image_transfer_id;
    if (message && is_active_image) {
      if (should_keep_image && s_image_received == s_image_size) {
        if (message->image_decode_retries > 0) {
          destroy_other_message_images(message);
        }
        destroy_message_bitmap(message);
        message->image_bitmap = gbitmap_create_from_png_data(s_image_buffer, s_image_size);
        if (message->image_bitmap) {
          if (bitmap_has_visible_pixels(message->image_bitmap)) {
            message->image_decode_retries = 0;
            s_loaded_image_count++;
            sync_message_images();
          } else {
            APP_LOG(APP_LOG_LEVEL_WARNING, "Decoded blank image for %s", message_id);
            gbitmap_destroy(message->image_bitmap);
            message->image_bitmap = NULL;
            message->image_decode_retries++;
            if (message->image_decode_retries < 3) {
              message->image_failed = false;
              schedule_image_retry();
            } else {
              message->image_failed = true;
            }
          }
        } else {
          APP_LOG(APP_LOG_LEVEL_WARNING, "Image decode failed for %s", message_id);
          message->image_decode_retries++;
          if (message->image_decode_retries < 3) {
            destroy_other_message_images(message);
            message->image_failed = false;
            schedule_image_retry();
          } else {
            message->image_failed = true;
          }
        }
      } else if (should_keep_image) {
        message->image_failed = false;
        schedule_image_retry();
      } else {
        message->image_failed = false;
      }
      message->image_requested = false;
      if (s_messages_root) {
        layer_mark_dirty(s_messages_root);
      }
    }
    if (is_active_image) {
      if (s_image_retry_timer) {
        app_timer_cancel(s_image_retry_timer);
        s_image_retry_timer = NULL;
      }
      s_image_size = 0;
      s_image_received = 0;
      s_image_expected_offset = 0;
      s_image_transfer_id = 0;
      s_image_message_id[0] = '\0';
    }
    request_next_image();
    return;
  }

  if (strcmp(type, "image_error") == 0) {
    char *message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    int transfer_id = tuple_int(iter, MESSAGE_KEY_ImageTransferId, s_image_transfer_id);
    Message *message = find_message_by_image_token(message_id);
    int image_index = message_index_from_ptr(message);
    bool is_active_image = message_id && strcmp(message_id, s_image_message_id) == 0 &&
                           transfer_id == s_image_transfer_id;
    if (message && is_active_image) {
      message->image_requested = false;
      message->image_failed = message_image_near_viewport(image_index, IMAGE_KEEP_SCREEN_MARGIN);
    }
    if (is_active_image) {
      if (s_image_retry_timer) {
        app_timer_cancel(s_image_retry_timer);
        s_image_retry_timer = NULL;
      }
      s_image_message_id[0] = '\0';
      s_image_size = 0;
      s_image_received = 0;
      s_image_expected_offset = 0;
      s_image_transfer_id = 0;
    }
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    request_next_image();
    return;
  }

  if (strcmp(type, "reacted") == 0) {
    show_status("Reacted");
  }

  if (strcmp(type, "sent") == 0 || strcmp(type, "deleted") == 0 ||
      strcmp(type, "edited") == 0) {
    request_messages(s_current_chat_id);
  }

  if (strcmp(type, "message_context") == 0) {
    char *incoming_message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    if (!has_selected_message() || !incoming_message_id ||
        strcmp(s_messages[s_selected_message].id, incoming_message_id) != 0) {
      return;
    }
    copy_cstr(s_full_text_title, sizeof(s_full_text_title), tuple_cstring(iter, MESSAGE_KEY_Sender));
    if (s_full_text_body) {
      copy_cstr(s_full_text_body, MAX_FULL_TEXT, tuple_cstring(iter, MESSAGE_KEY_Text));
    }
    if (s_action_mode == ActionMenuFullText && s_full_text_context && s_action_layer) {
      s_full_text_scroll_offset = 0;
      layer_mark_dirty(s_action_layer);
    }
    return;
  }

  if (strcmp(type, "chat_action_done") == 0) {
    char *action = tuple_cstring(iter, MESSAGE_KEY_Text);
    char *chat_id = tuple_cstring(iter, MESSAGE_KEY_ChatId);
    int chat_index = find_chat_index_by_id(chat_id);
    if (action && (strcmp(action, "archiveChat") == 0 || strcmp(action, "deleteChat") == 0)) {
      remove_chat_at(chat_index >= 0 ? chat_index : s_selected_chat);
      show_status(strcmp(action, "archiveChat") == 0 ? "Archived" : "Deleted");
    } else if (action && strcmp(action, "muteChat") == 0) {
      show_status("Muted");
    } else if (action && strcmp(action, "markUnread") == 0) {
      if (chat_index >= 0) {
        s_chats[chat_index].unread = true;
        s_chats[chat_index].unread_count = 0;
        if (s_chat_menu) {
          menu_layer_reload_data(s_chat_menu);
          select_chat_row(s_selected_chat, false);
        }
      }
      show_status("Marked unread");
    } else {
      show_status("Done");
    }
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  show_status("Message dropped");
}

static void outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  char *command = tuple_cstring(iter, MESSAGE_KEY_Command);
  if (command && strcmp(command, "get_image") == 0) {
    char *message_id = tuple_cstring(iter, MESSAGE_KEY_MessageId);
    Message *message = find_message_by_image_token(tuple_cstring(iter, MESSAGE_KEY_MessageId));
    if (message) {
      message->image_requested = true;
    }
    if (message_id && strcmp(message_id, s_image_message_id) == 0) {
      s_image_size = 0;
      s_image_received = 0;
    }
    schedule_image_retry();
    if (s_messages_root) {
      layer_mark_dirty(s_messages_root);
    }
    return;
  }
  show_status("Send failed");
}

static void close_action_window(void) {
  if (s_action_window) {
    window_stack_remove(s_action_window, true);
    s_action_window = NULL;
  }
}

static int action_item_count(void) {
  switch (s_action_mode) {
    case ActionMenuMain:
      if (!has_selected_message()) {
        return 3;
      }
      return 4 +
             (s_messages[s_selected_message].outgoing ? 1 : 0) +
             (selected_message_has_context() ? 1 : 0) +
             (selected_message_is_truncated() ? 1 : 0);
    case ActionMenuChat:
      return 5;
    case ActionMenuCanned:
      return canned_reply_count();
    case ActionMenuConfirm:
      return 2;
    case ActionMenuReply:
      return 3;
    case ActionMenuReactionGrid:
      return reaction_grid_count();
    case ActionMenuEmojiReplyGrid:
      return PG_MAX(0, reaction_grid_count() - 1);
    case ActionMenuFullText:
      return 0;
  }
  return 0;
}

static ActionItem action_item_at(int index) {
  if (!has_selected_message()) {
    static const ActionItem compose_items[] = {
      ActionItemCompose,
      ActionItemCanned,
      ActionItemRefresh
    };
    return compose_items[index];
  }

  int target = 0;
  if (index == target++) {
    return ActionItemReply;
  }
  if (index == target++) {
    return ActionItemReact;
  }
  if (selected_message_has_context() && index == target++) {
    return ActionItemFullContext;
  }
  if (s_messages[s_selected_message].outgoing) {
    if (index == target) {
      return ActionItemEdit;
    }
    target++;
  }
  if (selected_message_is_truncated() && index == target++) {
    return ActionItemFullText;
  }
  if (index == target++) {
    return ActionItemDelete;
  }
  return ActionItemRefresh;
}

static bool action_item_has_chevron(int index) {
  if (s_action_mode == ActionMenuMain) {
    return action_item_at(index) == ActionItemReact;
  }
  if (s_action_mode == ActionMenuReply) {
    return index == 2;
  }
  return false;
}

static bool action_item_has_separator_before(int index) {
  if (s_action_mode == ActionMenuMain) {
    ActionItem item = action_item_at(index);
    return item == ActionItemDelete || (!has_selected_message() && item == ActionItemRefresh);
  }
  return false;
}

static const char *action_item_title(int index) {
  static const char *confirm_items[] = {
    "Send",
    "Cancel"
  };
  static const char *delete_confirm_items[] = {
    "Delete",
    "Cancel"
  };

  if (s_action_mode == ActionMenuChat) {
    static const char *chat_items[] = {
      "Archive Chat",
      "Delete Chat",
      "Mute Chat",
      "Mark as Unread",
      "Go Back"
    };
    return chat_items[index];
  }
  if (s_action_mode == ActionMenuReply) {
    static const char *reply_items[] = {
      "Dictate Reply",
      "Canned Message",
      "Emoji Reply"
    };
    return reply_items[index];
  }
  if (s_action_mode == ActionMenuMain) {
    ActionItem item = action_item_at(index);
    switch (item) {
      case ActionItemCompose:
        return "New Message";
      case ActionItemCanned:
        return "Canned Message";
      case ActionItemReply:
        return "Reply";
      case ActionItemReact:
        return "React";
      case ActionItemEdit:
        return "Edit Message";
      case ActionItemDelete:
        return "Delete Message";
      case ActionItemFullText:
        return "View Full Message";
      case ActionItemFullContext:
        return selected_message_context_is_forward() ? "View Forward" : "View Quote";
      case ActionItemRefresh:
        return "Refresh";
      case ActionItemReplyDictate:
      case ActionItemReplyCanned:
      case ActionItemReplyEmoji:
      case ActionItemArchiveChat:
      case ActionItemDeleteChat:
      case ActionItemMuteChat:
      case ActionItemMarkUnread:
      case ActionItemGoBack:
        return "";
    }
  }
  if (s_action_mode == ActionMenuCanned) {
    return s_canned[index][0] ? s_canned[index] : "Canned message";
  }
  if (s_action_mode == ActionMenuConfirm && s_pending_chat_command[0]) {
    return delete_confirm_items[index];
  }
  return confirm_items[index];
}

// Custom action sheet instead of ActionMenu: it keeps behavior identical across
// the SDK targets this app supports.
static void action_layer_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, ACTION_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  int rail_w = ROUND_UI ? 0 : 18;
  int content_x = ROUND_UI ? 28 : 24;
  int content_w = bounds.size.w - content_x - (ROUND_UI ? 24 : 0);
  graphics_context_set_fill_color(ctx, APP_COLOR);
  if (ROUND_UI) {
    graphics_fill_rect(ctx, GRect(0, 0, 12, bounds.size.h), 0, GCornerNone);
  } else {
    graphics_fill_rect(ctx, GRect(0, 0, rail_w, bounds.size.h), 0, GCornerNone);
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, GPoint(rail_w / 2, 10), 2);
  }

  int count = action_item_count();
  int row_h = ROUND_UI ? 32 : 48;
  int top = ROUND_UI ? PG_MAX(0, (bounds.size.h - (count * row_h)) / 2) : 0;

  if (s_action_mode == ActionMenuConfirm) {
    graphics_context_set_text_color(ctx, ACTION_TEXT);
    graphics_draw_text(ctx, s_pending_text, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(content_x + 6, 10, content_w - 12, 70),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    top = bounds.size.h - (count * row_h) - 8;
  }

  if (s_action_mode == ActionMenuFullText) {
    char title[MAX_SENDER + 10];
    const char *text = "";
    const char *heading = NULL;
    GFont full_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
    GFont heading_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
    int text_w = content_w - 12;
    int heading_h = 0;
    GSize text_size;

    title[0] = '\0';
    if (s_selected_message >= 0 && s_selected_message < s_message_count) {
      if (s_full_text_context) {
        copy_cstr(title, sizeof(title), s_full_text_title);
        heading = title;
        text = s_full_text_body ? s_full_text_body : "";
      } else {
        text = s_messages[s_selected_message].text;
      }
    }

    if (heading && heading[0]) {
      GSize heading_size = graphics_text_layout_get_content_size(
        heading, heading_font, GRect(0, 0, text_w, 2000),
        GTextOverflowModeWordWrap, GTextAlignmentLeft
      );
      heading_h = heading_size.h + 4;
    }
    text_size = graphics_text_layout_get_content_size(
      text, full_font, GRect(0, 0, text_w, 2000),
      GTextOverflowModeWordWrap, GTextAlignmentLeft
    );
    s_full_text_height = heading_h + text_size.h + 20;
    int max_scroll = PG_MAX(0, s_full_text_height - bounds.size.h + 8);
    s_full_text_scroll_offset = PG_MIN(s_full_text_scroll_offset, max_scroll);

    graphics_context_set_text_color(ctx, ACTION_TEXT_SELECTED);
    if (heading && heading[0]) {
      graphics_draw_text(ctx, heading, heading_font,
                         GRect(content_x + 6, 8 - s_full_text_scroll_offset, text_w, heading_h),
                         GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    }
    graphics_draw_text(ctx, text, full_font,
                       GRect(content_x + 6, 8 + heading_h - s_full_text_scroll_offset,
                             text_w, text_size.h + 16),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    return;
  }

  if (s_action_mode == ActionMenuReactionGrid || s_action_mode == ActionMenuEmojiReplyGrid) {
    int cols = 3;
    int cell_h = ROUND_UI ? 40 : 44;
    int cell_w = content_w / cols;
    int rows = (count + cols - 1) / cols;
    int selected_row = s_action_selected / cols;
    int visible_rows = PG_MAX(1, bounds.size.h / cell_h);
    int first_row = selected_row - (visible_rows / 2);
    int max_first_row = PG_MAX(0, rows - visible_rows);
    int visible_h;
    int top;

    first_row = PG_MAX(0, PG_MIN(first_row, max_first_row));
    visible_h = PG_MIN(rows, visible_rows) * cell_h;
    top = PG_MAX(0, (bounds.size.h - visible_h) / 2);

    for (int i = 0; i < count; i++) {
      int row_index = i / cols;
      int col_index = i % cols;
      int y = top + ((row_index - first_row) * cell_h);
      GRect cell = GRect(content_x + (col_index * cell_w), y, cell_w, cell_h);
      bool selected = i == s_action_selected;

      if (y + cell_h < 0 || y > bounds.size.h) {
        continue;
      }
      if (selected) {
        graphics_context_set_fill_color(ctx, APP_COLOR);
        graphics_fill_rect(ctx, cell, 4, GCornersAll);
      }
      graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorLightGray);
      if (strcmp(reaction_grid_choices()[i].token, "remove") == 0) {
        graphics_draw_text(ctx, reaction_grid_choices()[i].glyph,
                           fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                           GRect(cell.origin.x, cell.origin.y + 10, cell.size.w, cell.size.h - 10),
                           GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
      } else {
        graphics_draw_text(ctx, reaction_grid_choices()[i].glyph,
                           fonts_get_system_font(FONT_KEY_GOTHIC_28),
                           GRect(cell.origin.x, cell.origin.y + 4, cell.size.w, cell.size.h - 4),
                           GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
      }
    }
    return;
  }

  if (s_action_mode != ActionMenuConfirm) {
    int list_h = count * row_h;
    if (list_h > bounds.size.h) {
      int visible_rows = PG_MAX(1, bounds.size.h / row_h);
      int first_row = s_action_selected - (visible_rows / 2);
      int max_first_row = PG_MAX(0, count - visible_rows);
      first_row = PG_MAX(0, PG_MIN(first_row, max_first_row));
      top = -(first_row * row_h);
    }
  }

  for (int i = 0; i < count; i++) {
    GRect row = GRect(content_x, top + (i * row_h), content_w, row_h);
    bool selected = i == s_action_selected;

    if (action_item_has_separator_before(i)) {
      int line_y = row.origin.y - 3;
      graphics_context_set_stroke_color(ctx, GColorLightGray);
      graphics_draw_line(ctx, GPoint(row.origin.x + 8, line_y),
                         GPoint(row.origin.x + row.size.w - 1, line_y));
    }

    graphics_context_set_text_color(ctx, selected ? ACTION_TEXT_SELECTED : ACTION_TEXT);
    graphics_draw_text(ctx, action_item_title(i), fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(row.origin.x + 1, row.origin.y + 1,
                             row.size.w - (action_item_has_chevron(i) ? 34 : 4), row.size.h - 3),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    if (action_item_has_chevron(i)) {
      graphics_draw_text(ctx, ">>", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                         GRect(row.origin.x + row.size.w - 32, row.origin.y + 1, 30, row.size.h - 3),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
    }
  }
}

static void show_action_window(ActionMenuMode mode) {
  s_action_mode = mode;
  s_action_selected = 0;
  s_action_window = window_create();
  window_set_background_color(s_action_window, ACTION_BG);
  window_set_click_config_provider(s_action_window, action_click_config_provider);
  window_set_window_handlers(s_action_window, (WindowHandlers) {
    .unload = action_window_unload
  });

  Layer *window_layer = window_get_root_layer(s_action_window);
  GRect bounds = layer_get_bounds(window_layer);
  s_action_layer = layer_create(bounds);
  layer_set_update_proc(s_action_layer, action_layer_update_proc);
  layer_add_child(window_layer, s_action_layer);

  window_stack_push(s_action_window, true);
}

static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                               char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess && transcription) {
    copy_cstr(s_pending_text, sizeof(s_pending_text), transcription);
    s_pending_chat_command[0] = '\0';
    show_action_window(ActionMenuConfirm);
  } else {
    show_status("Dictation failed");
  }
}

static void start_dictation(void) {
  if (!s_dictation_session) {
    s_dictation_session = dictation_session_create(MAX_TEXT - 1, dictation_callback, NULL);
  }
  dictation_session_start(s_dictation_session);
}

static void action_window_unload(Window *window) {
  if (s_action_layer) {
    layer_destroy(s_action_layer);
    s_action_layer = NULL;
  }
  window_destroy(window);
  if (s_action_window == window) {
    s_action_window = NULL;
  }
}

static void action_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  int selected = s_action_selected;

  if (s_action_mode == ActionMenuChat) {
    switch (selected) {
      case 0:
        close_action_window();
        send_selected_chat_action("archive_chat");
        break;
      case 1:
        copy_cstr(s_pending_chat_command, sizeof(s_pending_chat_command), "delete_chat");
        if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
          snprintf(s_pending_text, sizeof(s_pending_text), "Delete %s?", s_chats[s_selected_chat].title);
        } else {
          copy_cstr(s_pending_text, sizeof(s_pending_text), "Delete chat?");
        }
        s_action_mode = ActionMenuConfirm;
        s_action_selected = 1;
        layer_mark_dirty(s_action_layer);
        break;
      case 2:
        close_action_window();
        send_selected_chat_action("mute_chat");
        break;
      case 3:
        if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
          s_chats[s_selected_chat].unread = true;
          s_chats[s_selected_chat].unread_count = 0;
          if (s_chat_menu) {
            menu_layer_reload_data(s_chat_menu);
            select_chat_row(s_selected_chat, false);
          }
        }
        close_action_window();
        send_selected_chat_action("mark_unread");
        break;
      case 4:
      default:
        close_action_window();
        break;
    }
    return;
  }

  if (s_action_mode == ActionMenuMain) {
    ActionItem item = action_item_at(selected);
    switch (item) {
      case ActionItemCompose:
        close_action_window();
        s_pending_edit_message_id[0] = '\0';
        s_pending_chat_command[0] = '\0';
        s_pending_send_as_reply = false;
        start_dictation();
        break;
      case ActionItemCanned:
        s_pending_edit_message_id[0] = '\0';
        s_pending_chat_command[0] = '\0';
        s_pending_send_as_reply = false;
        s_action_mode = ActionMenuCanned;
        s_action_selected = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case ActionItemReply:
        s_action_mode = ActionMenuReply;
        s_action_selected = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case ActionItemReact:
        s_action_mode = ActionMenuReactionGrid;
        s_action_selected = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case ActionItemEdit:
        if (has_selected_message() && s_messages[s_selected_message].outgoing) {
          copy_cstr(s_pending_edit_message_id, sizeof(s_pending_edit_message_id), s_messages[s_selected_message].id);
          s_pending_send_as_reply = false;
          close_action_window();
          start_dictation();
        }
        break;
      case ActionItemDelete:
        close_action_window();
        delete_selected_message();
        break;
      case ActionItemFullText:
        s_full_text_context = true;
        if (has_selected_message()) {
          s_full_text_title[0] = '\0';
          copy_cstr(s_full_text_body, MAX_FULL_TEXT, s_messages[s_selected_message].text);
          send_command_with_status("get_message_text", s_current_chat_id, NULL, NULL,
                                   s_messages[s_selected_message].id, false);
        }
        s_action_mode = ActionMenuFullText;
        s_full_text_scroll_offset = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case ActionItemFullContext:
        s_full_text_context = true;
        if (has_selected_message()) {
          char body[MAX_CONTEXT_TEXT];
          message_context_strings(&s_messages[s_selected_message], s_full_text_title,
                                  sizeof(s_full_text_title), body, sizeof(body));
          if (s_full_text_body) {
            copy_cstr(s_full_text_body, MAX_FULL_TEXT, body);
          }
          send_command_with_status("get_context", s_current_chat_id, NULL, NULL,
                                   s_messages[s_selected_message].id, false);
        }
        s_action_mode = ActionMenuFullText;
        s_full_text_scroll_offset = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case ActionItemRefresh:
        close_action_window();
        request_messages(s_current_chat_id);
        break;
      case ActionItemReplyDictate:
      case ActionItemReplyCanned:
      case ActionItemReplyEmoji:
      case ActionItemArchiveChat:
      case ActionItemDeleteChat:
      case ActionItemMuteChat:
      case ActionItemMarkUnread:
      case ActionItemGoBack:
        break;
    }
    return;
  }

  if (s_action_mode == ActionMenuReply) {
    s_pending_edit_message_id[0] = '\0';
    s_pending_chat_command[0] = '\0';
    s_pending_send_as_reply = true;
    switch (selected) {
      case 0:
        close_action_window();
        start_dictation();
        break;
      case 1:
        s_action_mode = ActionMenuCanned;
        s_action_selected = 0;
        layer_mark_dirty(s_action_layer);
        break;
      case 2:
      default:
        s_action_mode = ActionMenuEmojiReplyGrid;
        s_action_selected = 0;
        layer_mark_dirty(s_action_layer);
        break;
    }
    return;
  }

  if (s_action_mode == ActionMenuReactionGrid) {
    const char *token = reaction_grid_token_at(selected);
    close_action_window();
    send_selected_reaction(token);
    return;
  }

  if (s_action_mode == ActionMenuEmojiReplyGrid) {
    const char *token = reaction_grid_token_at(selected);
    close_action_window();
    send_text_message(token, true);
    s_pending_send_as_reply = false;
    return;
  }

  if (s_action_mode == ActionMenuCanned) {
    copy_cstr(s_pending_text, sizeof(s_pending_text), s_canned[selected]);
    s_pending_chat_command[0] = '\0';
    s_action_mode = ActionMenuConfirm;
    s_action_selected = 0;
    layer_mark_dirty(s_action_layer);
    return;
  }

  if (s_action_mode == ActionMenuConfirm) {
    close_action_window();
    if (selected == 0) {
      if (s_pending_chat_command[0]) {
        send_selected_chat_action(s_pending_chat_command);
        s_pending_chat_command[0] = '\0';
      } else if (s_pending_edit_message_id[0]) {
        edit_selected_message(s_pending_text);
      } else {
        send_text_message(s_pending_text, s_pending_send_as_reply);
      }
      s_pending_send_as_reply = false;
    } else {
      s_pending_edit_message_id[0] = '\0';
      s_pending_chat_command[0] = '\0';
      s_pending_send_as_reply = false;
    }
  }
}

static void action_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_action_mode == ActionMenuFullText) {
    s_full_text_scroll_offset = PG_MAX(0, s_full_text_scroll_offset - CHAT_SCROLL_DELTA);
    layer_mark_dirty(s_action_layer);
    return;
  }
  if (s_action_selected > 0) {
    s_action_selected--;
    layer_mark_dirty(s_action_layer);
  }
}

static void action_down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_action_mode == ActionMenuFullText) {
    if (s_action_layer) {
      GRect bounds = layer_get_bounds(s_action_layer);
      int max_scroll = PG_MAX(0, s_full_text_height - bounds.size.h + 8);
      s_full_text_scroll_offset = PG_MIN(max_scroll, s_full_text_scroll_offset + CHAT_SCROLL_DELTA);
      layer_mark_dirty(s_action_layer);
    }
    return;
  }
  if (s_action_selected < action_item_count() - 1) {
    s_action_selected++;
    layer_mark_dirty(s_action_layer);
  }
}

static void action_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_action_mode == ActionMenuCanned || s_action_mode == ActionMenuConfirm ||
      s_action_mode == ActionMenuReply || s_action_mode == ActionMenuReactionGrid ||
      s_action_mode == ActionMenuEmojiReplyGrid || s_action_mode == ActionMenuFullText) {
    s_action_mode = ActionMenuMain;
    s_action_selected = 0;
    layer_mark_dirty(s_action_layer);
  } else {
    close_action_window();
  }
}

static void action_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, action_select_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_SCROLL_MS, action_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_SCROLL_MS, action_down_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, action_back_click_handler);
}

static void main_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_view_state == ViewStateChat) {
    show_action_window(ActionMenuMain);
  } else if (s_view_state == ViewStateChatList && s_chat_menu) {
    MenuIndex index = menu_layer_get_selected_index(s_chat_menu);
    chat_menu_select_callback(s_chat_menu, &index, NULL);
  }
}

static void main_select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_view_state == ViewStateChatList && !s_chats_loading && s_chat_count > 0 && s_chat_menu) {
    MenuIndex index = menu_layer_get_selected_index(s_chat_menu);
    s_selected_chat = index.row;
    show_action_window(ActionMenuChat);
  }
}

static void main_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  bool repeating = click_is_repeating(recognizer);
  if (s_view_state == ViewStateChatList && s_chat_menu) {
    menu_layer_set_selected_next(s_chat_menu, true, MenuRowAlignCenter, !repeating);
    s_selected_chat = menu_layer_get_selected_index(s_chat_menu).row;
    if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
      copy_cstr(s_chat_list_selected_id, sizeof(s_chat_list_selected_id), s_chats[s_selected_chat].id);
    }
    return;
  }
  if (s_view_state != ViewStateChat || !s_messages_root || s_message_count == 0) {
    return;
  }
  s_user_scrolled_messages = true;
  bool direction_changed = s_message_scroll_direction != -1;
  s_message_scroll_direction = -1;
  recalc_message_layout();
  if (repeating) {
    clear_active_image_request();
  }

  if (compose_target_is_selected() || s_selected_message < 0) {
    select_message_with_alignment(s_message_count - 1, true, !repeating);
    if (!direction_changed) {
      maybe_prefetch_older_messages();
    }
    return;
  }

  GRect bounds = layer_get_bounds(s_messages_root);
  int margin = 6;
  int top = s_message_y[s_selected_message] - margin;
  if (!repeating && s_message_h[s_selected_message] > bounds.size.h - (margin * 2) &&
      s_chat_scroll_offset > top) {
    set_chat_scroll_offset(PG_MAX(top, s_chat_scroll_offset - LONG_MESSAGE_SCROLL_DELTA), true);
    if (!direction_changed) {
      maybe_prefetch_older_messages();
    }
    return;
  }
  if (s_selected_message > 0) {
    select_message_with_alignment(s_selected_message - 1, true, !repeating);
    if (!direction_changed) {
      maybe_prefetch_older_messages();
    }
  } else {
    if (s_loading_older_messages) {
      show_status("Loading older...");
    } else {
      request_older_messages(false);
    }
  }
}

static void main_down_click_handler(ClickRecognizerRef recognizer, void *context) {
  bool repeating = click_is_repeating(recognizer);
  if (s_view_state == ViewStateChatList && s_chat_menu) {
    menu_layer_set_selected_next(s_chat_menu, false, MenuRowAlignCenter, !repeating);
    s_selected_chat = menu_layer_get_selected_index(s_chat_menu).row;
    if (s_selected_chat >= 0 && s_selected_chat < s_chat_count) {
      copy_cstr(s_chat_list_selected_id, sizeof(s_chat_list_selected_id), s_chats[s_selected_chat].id);
    }
    return;
  }
  if (s_view_state != ViewStateChat || !s_messages_root || s_message_count == 0) {
    return;
  }
  s_user_scrolled_messages = true;
  bool direction_changed = s_message_scroll_direction != 1;
  s_message_scroll_direction = 1;
  recalc_message_layout();
  if (repeating) {
    clear_active_image_request();
  }

  if (compose_target_is_selected() || s_selected_message < 0) {
    if (s_at_newest) {
      scroll_to_bottom(!repeating);
    } else if (s_message_count > 0) {
      select_message_with_alignment(s_message_count - 1, false, !repeating);
      if (!direction_changed) {
        maybe_prefetch_newer_messages();
      }
    }
    return;
  }

  GRect bounds = layer_get_bounds(s_messages_root);
  int margin = 6;
  int bottom = s_message_y[s_selected_message] + s_message_h[s_selected_message] + margin;
  if (!repeating && s_message_h[s_selected_message] > bounds.size.h - (margin * 2) &&
      s_chat_scroll_offset + bounds.size.h < bottom) {
    set_chat_scroll_offset(PG_MIN(bottom - bounds.size.h, s_chat_scroll_offset + LONG_MESSAGE_SCROLL_DELTA), true);
    if (!direction_changed) {
      maybe_prefetch_newer_messages();
    }
    return;
  }
  if (s_selected_message < s_message_count - 1) {
    int next_index = s_selected_message + 1;
    bool next_is_tall = s_message_h[next_index] > bounds.size.h - (margin * 2);
    select_message_with_alignment(next_index, next_is_tall, !repeating);
    if (!direction_changed) {
      maybe_prefetch_newer_messages();
    }
  } else if (s_loading_newer_messages) {
    show_status("Loading newer...");
  } else if (s_at_newest) {
    scroll_to_bottom(!repeating);
  } else {
    request_newer_messages(false);
  }
}

static void main_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_view_state == ViewStateChat) {
    cancel_message_timeout();
    cancel_message_retry();
    s_loading_messages = false;
    s_loading_older_messages = false;
    s_loading_newer_messages = false;
    s_message_transfer_id = 0;
    s_chat_view_pending = false;
    clear_message_stage();
    send_command_with_status("leave_chat", s_current_chat_id, NULL, NULL, NULL, false);
    render_chat_list();
  } else {
    window_stack_pop(true);
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, main_select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, main_select_long_click_handler, NULL);
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_SCROLL_MS, main_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_SCROLL_MS, main_down_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, main_back_click_handler);
}

static void main_window_load(Window *window) {
  window_set_background_color(window, CHAT_BG);
  window_set_click_config_provider(window, click_config_provider);
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  GRect status_rect = ROUND_UI ? GRect(24, chat_status_y(), bounds.size.w - 48, STATUS_H) :
                                 GRect(0, 0, bounds.size.w, STATUS_H);
  s_status_layer = text_layer_create(status_rect);
  text_layer_set_text(s_status_layer, "Pebblegram");
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_status_layer, GColorWhite);
  text_layer_set_background_color(s_status_layer, APP_COLOR);
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  int content_y = chat_content_y();
  int bottom_pad = chat_bottom_pad();
  s_chat_menu = menu_layer_create(GRect(0, content_y, bounds.size.w, bounds.size.h - content_y - bottom_pad));
  if (ROUND_UI) {
    menu_layer_set_center_focused(s_chat_menu, false);
  }
  menu_layer_set_callbacks(s_chat_menu, NULL, (MenuLayerCallbacks) {
    .get_num_sections = chat_menu_get_num_sections_callback,
    .get_num_rows = chat_menu_get_num_rows_callback,
    .get_header_height = chat_menu_get_header_height_callback,
    .draw_row = chat_menu_draw_row_callback,
    .get_cell_height = chat_menu_get_cell_height_callback,
    .select_click = chat_menu_select_callback
  });
  layer_add_child(window_layer, menu_layer_get_layer(s_chat_menu));
}

static void main_window_unload(Window *window) {
  light_enable(false);
  destroy_chat_view();
  destroy_chat_avatars();
  destroy_message_images();
  if (s_chat_menu) {
    menu_layer_destroy(s_chat_menu);
    s_chat_menu = NULL;
  }
  if (s_status_layer) {
    text_layer_destroy(s_status_layer);
    s_status_layer = NULL;
  }
}

static void main_window_appear(Window *window) {
  light_enable(false);
}

static void init(void) {
  s_view_state = ViewStateLoading;
  s_selected_message = -1;
  s_chats_loading = true;
  s_full_text_body = malloc(MAX_FULL_TEXT);
  if (s_full_text_body) {
    s_full_text_body[0] = '\0';
  }
  light_enable(false);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_open(APP_INBOX_SIZE, APP_OUTBOX_SIZE);

  s_main_window = window_create();
  window_set_click_config_provider(s_main_window, click_config_provider);
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load,
    .appear = main_window_appear,
    .unload = main_window_unload
  });
  window_stack_push(s_main_window, true);
}

static void deinit(void) {
  light_enable(false);
  destroy_chat_avatars();
  destroy_message_images();
  if (s_dictation_session) {
    dictation_session_destroy(s_dictation_session);
  }
  if (s_full_text_body) {
    free(s_full_text_body);
    s_full_text_body = NULL;
  }
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
