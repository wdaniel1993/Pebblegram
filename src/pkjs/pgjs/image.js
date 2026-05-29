var telegram = require('./telegram');
var codecs = require('./gramjs.bundle');
var imageCache = {};
var imageCacheOrder = [];
var imageInflight = {};
var MAX_IMAGE_CACHE_ITEMS = 64;
var MAX_PERSISTENT_IMAGE_CACHE_ITEMS = 32;
var PERSISTENT_IMAGE_CACHE_ORDER_KEY = 'pgjs.imageCacheOrder';
var IMAGE_CACHE_VERSION = 'v18';
var MEDIA_PIPELINE_TIMEOUT_MS = 22000;
var TALL_IMAGE_ASPECT = 1.85;
var TALL_IMAGE_WATCH_MAX_BYTES = 9000;
var DEBUG_LOGS = false;
var foregroundImageGeneration = 0;

function debugLog(message) {
  if (DEBUG_LOGS) {
    console.log(message);
  }
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

function toUint8Array(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value.buffer) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.length || 0);
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function isPng(bytes) {
  return bytes && bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function byteKind(bytes) {
  if (!bytes || !bytes.length) {
    return 'empty';
  }
  if (isPng(bytes)) {
    return 'png';
  }
  if (isJpeg(bytes)) {
    return 'jpeg';
  }
  return 'unknown';
}

function byteSummary(bytes) {
  var summary = byteKind(bytes) + ' ' + (bytes && bytes.length ? bytes.length : 0) + 'b';
  var limit = bytes && bytes.length ? Math.min(bytes.length, 8) : 0;
  var sig = [];
  for (var i = 0; i < limit; i += 1) {
    sig.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  }
  return sig.length ? summary + ' sig ' + sig.join('') : summary;
}

function rgbaBuffer(bytes) {
  var decoded;
  if (isJpeg(bytes)) {
    try {
      decoded = codecs.JPEG.decode(bytes, {useTArray: true});
      return {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset || 0, decoded.data.byteLength || decoded.data.length || 0)
      };
    } catch (err) {
      throw new Error('phone jpeg decode failed: ' + (err && err.message ? err.message : err) + '; ' + byteSummary(bytes));
    }
  }
  if (isPng(bytes)) {
    try {
      decoded = codecs.UPNG.decode(bytes.buffer.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength));
      return {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8Array(codecs.UPNG.toRGBA8(decoded)[0])
      };
    } catch (err) {
      throw new Error('phone png decode failed: ' + (err && err.message ? err.message : err) + '; ' + byteSummary(bytes));
    }
  }
  throw new Error('phone image format unsupported: ' + byteSummary(bytes));
}

function liftChannel(value) {
  if (value <= 0) {
    return 4;
  }
  return Math.min(255, Math.round((Math.pow(value / 255, 0.82) * 255) + 4));
}

function ditherOffset(x, y) {
  var matrix = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
  ];
  return matrix[((y & 3) * 4) + (x & 3)] - 7.5;
}

function toneChannel(value, x, y) {
  var lifted = liftChannel(value);
  return Math.max(0, Math.min(255, Math.round(lifted + ditherOffset(x, y) * 1.4)));
}

function resizeCover(source, width, height, maskCircle, liftColors) {
  var output = new Uint8Array(width * height * 4);
  var scale = Math.max(width / source.width, height / source.height);
  var cropW = width / scale;
  var cropH = height / scale;
  var startX = (source.width - cropW) / 2;
  var startY = (source.height - cropH) / 2;
  var cx = (width - 1) / 2;
  var cy = (height - 1) / 2;
  var radius = Math.min(width, height) / 2;
  var x;
  var y;
  var srcX;
  var srcY;
  var srcIndex;
  var dstIndex;
  var dx;
  var dy;

  for (y = 0; y < height; y += 1) {
    srcY = Math.min(source.height - 1, Math.max(0, Math.floor(startY + y / scale)));
    for (x = 0; x < width; x += 1) {
      srcX = Math.min(source.width - 1, Math.max(0, Math.floor(startX + x / scale)));
      srcIndex = (srcY * source.width + srcX) * 4;
      dstIndex = (y * width + x) * 4;
      output[dstIndex] = liftColors ? toneChannel(source.data[srcIndex], x, y) : source.data[srcIndex];
      output[dstIndex + 1] = liftColors ? toneChannel(source.data[srcIndex + 1], x, y) : source.data[srcIndex + 1];
      output[dstIndex + 2] = liftColors ? toneChannel(source.data[srcIndex + 2], x, y) : source.data[srcIndex + 2];
      if (maskCircle) {
        dx = x - cx;
        dy = y - cy;
        if (dx * dx + dy * dy <= radius * radius) {
          output[dstIndex + 3] = 255;
        } else {
          output[dstIndex] = 170;
          output[dstIndex + 1] = 170;
          output[dstIndex + 2] = 170;
          output[dstIndex + 3] = 255;
        }
      } else {
        output[dstIndex + 3] = 255;
      }
    }
  }
  return output;
}

function resizeContain(source, width, height, liftColors) {
  var scale = Math.min(width / source.width, height / source.height);
  var outputWidth = Math.max(1, Math.floor(source.width * scale));
  var outputHeight = Math.max(1, Math.floor(source.height * scale));
  var output = new Uint8Array(outputWidth * outputHeight * 4);
  var x;
  var y;
  var srcX;
  var srcY;
  var srcIndex;
  var dstIndex;

  for (y = 0; y < outputHeight; y += 1) {
    srcY = Math.min(source.height - 1, Math.max(0, Math.floor(y / scale)));
    for (x = 0; x < outputWidth; x += 1) {
      srcX = Math.min(source.width - 1, Math.max(0, Math.floor(x / scale)));
      srcIndex = (srcY * source.width + srcX) * 4;
      dstIndex = (y * outputWidth + x) * 4;
      output[dstIndex] = liftColors ? toneChannel(source.data[srcIndex], x, y) : source.data[srcIndex];
      output[dstIndex + 1] = liftColors ? toneChannel(source.data[srcIndex + 1], x, y) : source.data[srcIndex + 1];
      output[dstIndex + 2] = liftColors ? toneChannel(source.data[srcIndex + 2], x, y) : source.data[srcIndex + 2];
      output[dstIndex + 3] = 255;
    }
  }
  return {
    width: outputWidth,
    height: outputHeight,
    data: output
  };
}

function arrayBufferFromBytes(bytes) {
  return bytes.buffer.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength);
}

function encodePng(source, width, height, colors, maskCircle, liftColors, fitMode) {
  var resized;
  if (fitMode === 'contain') {
    resized = resizeContain(source, width, height, liftColors);
    return new Uint8Array(codecs.UPNG.encode([arrayBufferFromBytes(resized.data)], resized.width, resized.height, colors));
  }
  resized = resizeCover(source, width, height, maskCircle, liftColors);
  return new Uint8Array(codecs.UPNG.encode([arrayBufferFromBytes(resized)], width, height, colors));
}

function imageStats(source) {
  var pixels = source.width * source.height;
  var step = Math.max(1, Math.floor(pixels / 1200));
  var count = 0;
  var white = 0;
  var transparent = 0;
  var dark = 0;
  var i;
  var r;
  var g;
  var b;
  for (i = 0; i < pixels; i += step) {
    r = source.data[i * 4];
    g = source.data[(i * 4) + 1];
    b = source.data[(i * 4) + 2];
    if (source.data[(i * 4) + 3] < 24) {
      transparent += 1;
    }
    if (r > 238 && g > 238 && b > 238) {
      white += 1;
    }
    if (r < 210 || g < 210 || b < 210) {
      dark += 1;
    }
    count += 1;
  }
  return {
    mostlyWhite: count > 0 && white / count > 0.92,
    mostlyTransparent: count > 0 && transparent / count > 0.92,
    hasNonWhiteDetail: count > 0 && dark / count > 0.08
  };
}

function encodedLooksBlank(encoded, sourceStats) {
  try {
    var stats = imageStats(rgbaBuffer(encoded));
    return stats.mostlyTransparent || (!sourceStats.mostlyWhite && stats.mostlyWhite);
  } catch (e) {
    return true;
  }
}

function logDuration(label, startedAt) {
  if (DEBUG_LOGS) {
    console.log(label + ' took ' + (Date.now() - startedAt) + 'ms');
  }
}

function nextTurn() {
  return new Promise(function(resolve) {
    setTimeout(resolve, 0);
  });
}

function throwIfCancelled(options) {
  if (options && options.isCancelled && options.isCancelled()) {
    throw new Error('image request superseded');
  }
}

function imageStatus(options, text) {
  if (options && typeof options.status === 'function') {
    options.status(text);
  }
}

function compactPng(source, width, height, colors, maxBytes, maskCircle, liftColors, scaleSteps, fitMode) {
  var colorSteps = [colors, 32, 16, 8, 4, 2];
  scaleSteps = scaleSteps || [1, 0.9, 0.8, 0.7, 0.6];
  var best = null;
  var bestDetail = '';
  var step;
  var colorIndex;
  var nextWidth;
  var nextHeight;
  var nextColors;
  var encoded;

  for (step = 0; step < scaleSteps.length; step += 1) {
    nextWidth = Math.max(32, Math.floor(width * scaleSteps[step]));
    nextHeight = Math.max(32, Math.floor(height * scaleSteps[step]));
    for (colorIndex = 0; colorIndex < colorSteps.length; colorIndex += 1) {
      nextColors = colorSteps[colorIndex];
      if (nextColors > colors) {
        continue;
      }
      encoded = encodePng(source, nextWidth, nextHeight, nextColors, maskCircle, liftColors, fitMode);
      if (!best || encoded.length < best.length) {
        best = encoded;
        bestDetail = nextWidth + 'x' + nextHeight + '/' + nextColors + 'c';
      }
      if (!maxBytes || encoded.length <= maxBytes) {
        return encoded;
      }
    }
  }
  if (best && (!maxBytes || best.length <= maxBytes)) {
    return best;
  }
  throw new Error('phone png encode over budget: best ' + (best ? best.length : 0) +
                  'b at ' + bestDetail + ' > ' + maxBytes + 'b from ' +
                  source.width + 'x' + source.height);
}

function compactPngAsync(source, width, height, colors, maxBytes, maskCircle, liftColors, scaleSteps, fitMode, options) {
  var colorSteps = [colors, 32, 16, 8, 4, 2];
  var best = null;
  var bestDetail = '';
  scaleSteps = scaleSteps || [1, 0.9, 0.8, 0.7, 0.6];

  function failOverBudget() {
    throw new Error('phone png encode over budget: best ' + (best ? best.length : 0) +
                    'b at ' + bestDetail + ' > ' + maxBytes + 'b from ' +
                    source.width + 'x' + source.height);
  }

  function attempt(step, colorIndex) {
    var nextWidth;
    var nextHeight;
    var nextColors;
    if (step >= scaleSteps.length) {
      if (best && (!maxBytes || best.length <= maxBytes)) {
        return Promise.resolve(best);
      }
      return Promise.resolve().then(failOverBudget);
    }
    if (colorIndex >= colorSteps.length) {
      return attempt(step + 1, 0);
    }
    nextColors = colorSteps[colorIndex];
    if (nextColors > colors) {
      return attempt(step, colorIndex + 1);
    }
    nextWidth = Math.max(32, Math.floor(width * scaleSteps[step]));
    nextHeight = Math.max(32, Math.floor(height * scaleSteps[step]));
    return nextTurn().then(function() {
      var encoded;
      throwIfCancelled(options);
      encoded = encodePng(source, nextWidth, nextHeight, nextColors, maskCircle, liftColors, fitMode);
      throwIfCancelled(options);
      if (!best || encoded.length < best.length) {
        best = encoded;
        bestDetail = nextWidth + 'x' + nextHeight + '/' + nextColors + 'c';
      }
      if (!maxBytes || encoded.length <= maxBytes) {
        return encoded;
      }
      return attempt(step, colorIndex + 1);
    });
  }

  return attempt(0, 0);
}

function safeCompactPng(source, width, height, colors, maxBytes, maskCircle) {
  var sourceStats = imageStats(source);
  var encoded = compactPng(source, width, height, colors, maxBytes, maskCircle, false, [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42]);
  var scaleSteps = [0.85, 0.75, 0.65, 0.55];
  var colorSteps = [Math.max(colors, 128), 128, 64, 32, 16];
  var step;
  var colorIndex;
  var fallback;
  var nextWidth;
  var nextHeight;

  if (!sourceStats.hasNonWhiteDetail || !encodedLooksBlank(encoded, sourceStats)) {
    return encoded;
  }

  for (step = 0; step < scaleSteps.length; step += 1) {
    nextWidth = Math.max(32, Math.floor(width * scaleSteps[step]));
    nextHeight = Math.max(32, Math.floor(height * scaleSteps[step]));
    for (colorIndex = 0; colorIndex < colorSteps.length; colorIndex += 1) {
      fallback = encodePng(source, nextWidth, nextHeight, colorSteps[colorIndex], maskCircle, false);
      if ((!maxBytes || fallback.length <= maxBytes) && !encodedLooksBlank(fallback, sourceStats)) {
        if (DEBUG_LOGS) {
          debugLog('image blank fallback used at ' + nextWidth + 'x' + nextHeight);
        }
        return fallback;
      }
    }
  }

  throw new Error('Photo encoded as blank.');
}

function cacheKey(chatId, messageId, width, height, colors, maxBytes) {
  return [IMAGE_CACHE_VERSION, chatId, messageId, width, height, colors, maxBytes].join(':');
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

function isTallSource(source) {
  return source && source.width > 0 && source.height / source.width >= TALL_IMAGE_ASPECT;
}

function compactMessagePngAsync(source, width, height, colors, maxBytes, options) {
  var tall = isTallSource(source);
  var watchSafeMaxBytes = tall ? Math.min(maxBytes, TALL_IMAGE_WATCH_MAX_BYTES) : maxBytes;
  var normalScaleSteps = maxBytes >= 24000 ?
                         [1, 0.96, 0.92, 0.88, 0.82, 0.75, 0.67, 0.58, 0.5, 0.42] :
                         [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42];
  if (tall && watchSafeMaxBytes < maxBytes) {
    if (DEBUG_LOGS) {
      debugLog('tall image watch-safe budget ' + watchSafeMaxBytes + 'b');
    }
    return compactPngAsync(source, width, height, Math.min(colors, 32), watchSafeMaxBytes, false, true,
                           [1, 0.85, 0.7, 0.56, 0.45, 0.36, 0.32], 'contain', options).catch(function(tallErr) {
      if (DEBUG_LOGS) {
        debugLog('tall image compact path: ' + (tallErr && tallErr.message ? tallErr.message : tallErr));
      }
      throwIfCancelled(options);
      return compactPngAsync(source, width, height, 16, watchSafeMaxBytes, false, true,
                             [0.5, 0.42, 0.35, 0.3, 0.26], 'contain', options);
    });
  }
  return compactPngAsync(source, width, height, colors, watchSafeMaxBytes, false, true,
                         normalScaleSteps, 'contain', options).catch(function(err) {
    if (!tall) {
      throw err;
    }
    if (DEBUG_LOGS) {
      debugLog('tall image encode fallback: ' + (err && err.message ? err.message : err));
    }
    throwIfCancelled(options);
    return compactPngAsync(source, width, height, Math.min(colors, 32), watchSafeMaxBytes, false, true,
                           [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.32],
                           'contain', options);
  });
}

function noteImageCacheUse(key) {
  removeArrayValue(imageCacheOrder, key);
  imageCacheOrder.push(key);
}

function cacheSet(key, bytes) {
  noteImageCacheUse(key);
  imageCache[key] = bytes;
  while (imageCacheOrder.length > MAX_IMAGE_CACHE_ITEMS) {
    delete imageCache[imageCacheOrder.shift()];
  }
  persistentCacheSet(key, bytes);
}

function persistentCacheGet(key) {
  var raw;
  var bytes;
  try {
    raw = localStorage.getItem('pgjs.imageCache.' + key);
    if (!raw) {
      return null;
    }
    bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i) & 255;
    }
    cacheSetMemoryOnly(key, bytes);
    persistentCacheNoteUse(key);
    return bytes;
  } catch (e) {
    return null;
  }
}

function cacheSetMemoryOnly(key, bytes) {
  noteImageCacheUse(key);
  imageCache[key] = bytes;
  while (imageCacheOrder.length > MAX_IMAGE_CACHE_ITEMS) {
    delete imageCache[imageCacheOrder.shift()];
  }
}

function persistentCacheNoteUse(key) {
  var order;
  try {
    order = JSON.parse(localStorage.getItem(PERSISTENT_IMAGE_CACHE_ORDER_KEY) || '[]');
    removeArrayValue(order, key);
    order.push(key);
    localStorage.setItem(PERSISTENT_IMAGE_CACHE_ORDER_KEY, JSON.stringify(order));
  } catch (e) {}
}

function bytesToStorageString(bytes) {
  var chunks = [];
  var chunkSize = 4096;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length))));
  }
  return chunks.join('');
}

function persistentCacheSet(key, bytes) {
  var order;
  var encoded;
  try {
    order = JSON.parse(localStorage.getItem(PERSISTENT_IMAGE_CACHE_ORDER_KEY) || '[]');
    removeArrayValue(order, key);
    while (order.length >= MAX_PERSISTENT_IMAGE_CACHE_ITEMS) {
      localStorage.removeItem('pgjs.imageCache.' + order.shift());
    }
    encoded = bytesToStorageString(bytes);
    try {
      localStorage.setItem('pgjs.imageCache.' + key, encoded);
    } catch (writeErr) {
      if (order.length > 0) {
        localStorage.removeItem('pgjs.imageCache.' + order.shift());
        localStorage.setItem('pgjs.imageCache.' + key, encoded);
      } else {
        throw writeErr;
      }
    }
    order.push(key);
    localStorage.setItem(PERSISTENT_IMAGE_CACHE_ORDER_KEY, JSON.stringify(order));
  } catch (e) {
    debugLog('Persistent image cache skipped: ' + (e && e.message ? e.message : e));
  }
}

function cachedBytes(key, label, downloader, width, height, colors, maxBytes, maskCircle, options) {
  var pipeline;
  var wrapped;
  options = options || {};
  if (imageCache[key]) {
    noteImageCacheUse(key);
    if (DEBUG_LOGS) {
      debugLog('image cache hit ' + label);
    }
    imageStatus(options, 'Cache hit');
    return Promise.resolve(imageCache[key]);
  }
  var cached = persistentCacheGet(key);
  if (cached) {
    if (DEBUG_LOGS) {
      debugLog('persistent image cache hit ' + label);
    }
    imageStatus(options, 'Storage cache hit');
    return Promise.resolve(cached);
  }
  if (imageInflight[key] && !options.noInflightReuse) {
    if (DEBUG_LOGS) {
      debugLog('image inflight hit ' + label);
    }
    return imageInflight[key];
  }
  if (imageInflight[key]) {
    if (DEBUG_LOGS) {
      debugLog('image inflight bypass ' + label);
    }
  }
  var downloadStartedAt = DEBUG_LOGS ? Date.now() : 0;
  pipeline = withTimeout(Promise.resolve().then(downloader), 'image pipeline timed out', MEDIA_PIPELINE_TIMEOUT_MS).then(function(raw) {
    if (DEBUG_LOGS) {
      logDuration('image download ' + label, downloadStartedAt);
    }
    var encodeStartedAt = DEBUG_LOGS ? Date.now() : 0;
    var bytes = toUint8Array(raw);
    var source;
    if (!bytes || !bytes.length) {
      throw new Error('empty image');
    }
    throwIfCancelled(options);
    imageStatus(options, 'Decoding');
    source = rgbaBuffer(bytes);
    throwIfCancelled(options);
    imageStatus(options, 'Encoding');
    return (maskCircle ?
      Promise.resolve(safeCompactPng(source, width, height, colors, maxBytes, true)) :
      compactMessagePngAsync(source, width, height, colors, maxBytes, options)).then(function(encoded) {
      throwIfCancelled(options);
      if (DEBUG_LOGS) {
        logDuration('image encode ' + label, encodeStartedAt);
      }
      imageStatus(options, 'Caching');
      cacheSet(key, encoded);
      return encoded;
    });
  });
  wrapped = pipeline.then(function(bytes) {
    if (imageInflight[key] === wrapped) {
      delete imageInflight[key];
    }
    return bytes;
  }, function(err) {
    if (imageInflight[key] === wrapped) {
      delete imageInflight[key];
    }
    throw err;
  });
  imageInflight[key] = wrapped;
  return wrapped;
}

function imageBytes(chatId, messageId, width, height, colors, maxBytes, status) {
  var key;
  var generation = ++foregroundImageGeneration;
  function isCancelled() {
    return generation !== foregroundImageGeneration;
  }
  width = width || 120;
  height = height || 120;
  colors = colors || 64;
  maxBytes = maxBytes || 10000;
  height = height * 2;
  key = cacheKey(chatId, messageId, width, height, colors, maxBytes);
  return cachedBytes(key, messageId, function() {
    if (status) {
      status('Downloading');
    }
    return telegram.downloadMedia(chatId, messageId, {
      targetWidth: width,
      targetHeight: height,
      cancelled: isCancelled
    });
  }, width, height, colors, maxBytes, false, {noInflightReuse: true, isCancelled: isCancelled, status: status});
}

function avatarBytes(chatId, width, height, colors, maxBytes) {
  width = width || 28;
  height = height || 28;
  colors = colors || 16;
  maxBytes = maxBytes || 3000;
  var key = cacheKey(chatId, 'avatar', width, height, colors, maxBytes);
  return cachedBytes(key, 'avatar ' + chatId, function() {
    return telegram.downloadProfilePhoto(chatId);
  }, width, height, colors, maxBytes, true);
}

function cancelImageRequests() {
  foregroundImageGeneration += 1;
}

module.exports = {
  imageBytes: imageBytes,
  avatarBytes: avatarBytes,
  cancelImageRequests: cancelImageRequests
};
