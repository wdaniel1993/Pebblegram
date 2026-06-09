var telegram = require('./telegram');
var codecs = require('./codecs.bundle');
var imageCache = {};
var imageCacheOrder = [];
var imageInflight = {};
var MAX_IMAGE_CACHE_ITEMS = 64;
var MAX_PERSISTENT_IMAGE_CACHE_ITEMS = 32;
var PERSISTENT_IMAGE_CACHE_ORDER_KEY = 'pgjs.imageCacheOrder';
var IMAGE_CACHE_VERSION = 'v28';
var MEDIA_PIPELINE_TIMEOUT_MS = 22000;
var TALL_IMAGE_ASPECT = 1.85;
var TALL_IMAGE_WATCH_MAX_BYTES = 12000;
var EMERY_TALL_IMAGE_WATCH_MAX_BYTES = 19000;
var GABBRO_TALL_IMAGE_WATCH_MAX_BYTES = 16000;
var DEBUG_LOGS = false;
var foregroundImageGeneration = 0;
var IMAGE_RETRY_PROFILES = [
  {maxBytes: 34000, maxPixels: 52000},
  {maxBytes: 26000, maxPixels: 42000},
  {maxBytes: 18000, maxPixels: 32000}
];
var EMERY_TALL_PBI_MAX_BYTES = 24000;
var EMERY_TALL_PBI_MAX_PIXELS = 48000;
var GABBRO_TALL_PBI_MAX_BYTES = 17000;
var GABBRO_TALL_PBI_MAX_PIXELS = 34000;

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

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) +
         (bytes[offset + 1] << 16) +
         (bytes[offset + 2] << 8) +
         bytes[offset + 3];
}

function pngDimensions(bytes) {
  if (!bytes || bytes.length < 24 || !isPng(bytes)) {
    return null;
  }
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20)
  };
}

function bitmapHeapEstimate(width, height) {
  return (((width + 3) & ~3) * height);
}

function encodedDecodeCost(encoded) {
  var dimensions = pngDimensions(encoded);
  if (!dimensions) {
    return encoded ? encoded.length : 0;
  }
  return encoded.length + bitmapHeapEstimate(dimensions.width, dimensions.height);
}

function encodedFits(encoded, maxBytes, maxCost) {
  if (maxBytes && encoded.length > maxBytes) {
    return false;
  }
  if (maxCost && encodedDecodeCost(encoded) > maxCost) {
    return false;
  }
  return true;
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

function darkScreenshotChannel(value) {
  if (value < 96) {
    return Math.max(0, Math.round(value * 0.55));
  }
  if (value < 160) {
    return Math.max(0, Math.round(96 + ((value - 96) * 0.86)));
  }
  return value;
}

function lightScreenshotChannel(value) {
  if (value >= 248) {
    return 255;
  }
  if (value >= 210) {
    return Math.max(0, Math.round(186 + ((value - 210) * 0.74)));
  }
  if (value >= 128) {
    return Math.max(0, Math.round(value * 0.9));
  }
  return Math.max(0, Math.round(value * 0.82));
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

function toneChannel(value, x, y, mode) {
  if (mode === 'dark') {
    return darkScreenshotChannel(value);
  }
  if (mode === 'light') {
    return lightScreenshotChannel(value);
  }
  var lifted = liftChannel(value);
  return Math.max(0, Math.min(255, Math.round(lifted + ditherOffset(x, y) * 1.4)));
}

function channelToneMode(value) {
  if (value === 'dark' || value === 'light') {
    return value;
  }
  return value ? 'lift' : '';
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
  var toneMode = channelToneMode(liftColors);

  for (y = 0; y < height; y += 1) {
    srcY = Math.min(source.height - 1, Math.max(0, Math.floor(startY + y / scale)));
    for (x = 0; x < width; x += 1) {
      srcX = Math.min(source.width - 1, Math.max(0, Math.floor(startX + x / scale)));
      srcIndex = (srcY * source.width + srcX) * 4;
      dstIndex = (y * width + x) * 4;
      output[dstIndex] = toneMode ? toneChannel(source.data[srcIndex], x, y, toneMode) : source.data[srcIndex];
      output[dstIndex + 1] = toneMode ? toneChannel(source.data[srcIndex + 1], x, y, toneMode) : source.data[srcIndex + 1];
      output[dstIndex + 2] = toneMode ? toneChannel(source.data[srcIndex + 2], x, y, toneMode) : source.data[srcIndex + 2];
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
  var toneMode = channelToneMode(liftColors);

  for (y = 0; y < outputHeight; y += 1) {
    srcY = Math.min(source.height - 1, Math.max(0, Math.floor(y / scale)));
    for (x = 0; x < outputWidth; x += 1) {
      srcX = Math.min(source.width - 1, Math.max(0, Math.floor(x / scale)));
      srcIndex = (srcY * source.width + srcX) * 4;
      dstIndex = (y * outputWidth + x) * 4;
      output[dstIndex] = toneMode ? toneChannel(source.data[srcIndex], x, y, toneMode) : source.data[srcIndex];
      output[dstIndex + 1] = toneMode ? toneChannel(source.data[srcIndex + 1], x, y, toneMode) : source.data[srcIndex + 1];
      output[dstIndex + 2] = toneMode ? toneChannel(source.data[srcIndex + 2], x, y, toneMode) : source.data[srcIndex + 2];
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

function writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >> 8) & 255;
}

function pebbleChannel(value) {
  return Math.max(0, Math.min(3, Math.round(value / 85)));
}

function argb8FromRgba(r, g, b, a) {
  if (a < 64) {
    return 0;
  }
  return (3 << 6) | (pebbleChannel(r) << 4) | (pebbleChannel(g) << 2) | pebbleChannel(b);
}

function argb8Distance(a, b) {
  var ar = ((a >> 4) & 3) * 85;
  var ag = ((a >> 2) & 3) * 85;
  var ab = (a & 3) * 85;
  var br = ((b >> 4) & 3) * 85;
  var bg = ((b >> 2) & 3) * 85;
  var bb = (b & 3) * 85;
  var dr = ar - br;
  var dg = ag - bg;
  var db = ab - bb;
  return dr * dr + dg * dg + db * db;
}

function pbiPalette(colors) {
  var forced = [0xff, 0xc0, 0xea, 0xd5];
  var counts = {};
  var ranked = [];
  var palette = [];
  var i;
  for (i = 0; i < colors.length; i += 1) {
    counts[colors[i]] = (counts[colors[i]] || 0) + 1;
  }
  for (i = 0; i < forced.length; i += 1) {
    palette.push(forced[i]);
  }
  Object.keys(counts).forEach(function(key) {
    ranked.push({color: parseInt(key, 10), count: counts[key]});
  });
  ranked.sort(function(a, b) {
    return b.count - a.count;
  });
  for (i = 0; i < ranked.length && palette.length < 16; i += 1) {
    if (palette.indexOf(ranked[i].color) < 0) {
      palette.push(ranked[i].color);
    }
  }
  while (palette.length < 16) {
    palette.push(0);
  }
  return palette;
}

function nearestPaletteIndex(color, palette) {
  var best = 0;
  var bestDistance = 2147483647;
  for (var i = 0; i < palette.length; i += 1) {
    var distance = argb8Distance(color, palette[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
      if (distance === 0) {
        break;
      }
    }
  }
  return best;
}

function encodePbi4(resized) {
  var width = resized.width;
  var height = resized.height;
  var rowSize = Math.ceil(width / 2);
  var dataSize = rowSize * height;
  var output = new Uint8Array(12 + dataSize + 16);
  var colors = new Uint8Array(width * height);
  var palette;
  var x;
  var y;
  var srcIndex;
  var color;
  var high;
  var low;

  for (var i = 0; i < width * height; i += 1) {
    srcIndex = i * 4;
    colors[i] = argb8FromRgba(resized.data[srcIndex], resized.data[srcIndex + 1],
                              resized.data[srcIndex + 2], resized.data[srcIndex + 3]);
  }
  palette = pbiPalette(colors);

  writeUint16LE(output, 0, rowSize);
  writeUint16LE(output, 2, (1 << 12) | (4 << 1));
  writeUint16LE(output, 4, 0);
  writeUint16LE(output, 6, 0);
  writeUint16LE(output, 8, width);
  writeUint16LE(output, 10, height);

  for (y = 0; y < height; y += 1) {
    for (x = 0; x < width; x += 2) {
      color = colors[(y * width) + x];
      high = nearestPaletteIndex(color, palette);
      low = 0;
      if (x + 1 < width) {
        low = nearestPaletteIndex(colors[(y * width) + x + 1], palette);
      }
      output[12 + (y * rowSize) + Math.floor(x / 2)] = (high << 4) | low;
    }
  }
  for (i = 0; i < 16; i += 1) {
    output[12 + dataSize + i] = palette[i];
  }
  return output;
}

function compactPbi4(source, width, height, maxBytes, maxPixels, options) {
  var encodeBox = fitEncodeBoxForPixelBudget(source, width, height, maxPixels);
  var scaleSteps = [1, 0.94, 0.88, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4];
  var toneMode = messageImageToneMode(source);
  var best = null;
  for (var step = 0; step < scaleSteps.length; step += 1) {
    throwIfCancelled(options);
    var resized = resizeContain(source,
                                Math.max(32, Math.floor(encodeBox.width * scaleSteps[step])),
                                Math.max(32, Math.floor(encodeBox.height * scaleSteps[step])),
                                toneMode);
    var encoded = encodePbi4(resized);
    if (!best || encoded.length < best.length) {
      best = encoded;
    }
    if (!maxBytes || encoded.length <= maxBytes) {
      return encoded;
    }
  }
  if (best && (!maxBytes || best.length <= maxBytes)) {
    return best;
  }
  throw new Error('phone pbi encode over budget: best ' + (best ? best.length : 0) + 'b > ' + maxBytes + 'b');
}

function tallPbiBudget(maxBytes, maxPixels, options) {
  var platformMaxBytes = options && options.platformMaxBytes || maxBytes;
  var platformMaxPixels = options && options.platformMaxPixels || maxPixels;
  if (options && options.retryLevel > 0) {
    return {
      maxBytes: maxBytes,
      maxPixels: maxPixels
    };
  }
  if (platformMaxBytes >= 24000 || platformMaxPixels >= 40000) {
    return {
      maxBytes: Math.min(maxBytes, EMERY_TALL_PBI_MAX_BYTES),
      maxPixels: maxPixels ? Math.min(maxPixels, EMERY_TALL_PBI_MAX_PIXELS) : EMERY_TALL_PBI_MAX_PIXELS
    };
  }
  if (platformMaxBytes >= 14000 || platformMaxPixels >= 28000) {
    return {
      maxBytes: Math.min(maxBytes, GABBRO_TALL_PBI_MAX_BYTES),
      maxPixels: maxPixels ? Math.min(maxPixels, GABBRO_TALL_PBI_MAX_PIXELS) : GABBRO_TALL_PBI_MAX_PIXELS
    };
  }
  return {
    maxBytes: Math.min(maxBytes, TALL_IMAGE_WATCH_MAX_BYTES),
    maxPixels: maxPixels ? Math.min(maxPixels, 20000) : 20000
  };
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

function messageImageToneMode(source) {
  var pixels = source.width * source.height;
  var step = Math.max(1, Math.floor(pixels / 1600));
  var count = 0;
  var lumaTotal = 0;
  var dark = 0;
  var midDark = 0;
  var light = 0;
  var nearWhite = 0;
  var saturated = 0;
  for (var i = 0; i < pixels; i += step) {
    var index = i * 4;
    var r = source.data[index];
    var g = source.data[index + 1];
    var b = source.data[index + 2];
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var luma = (r * 0.299) + (g * 0.587) + (b * 0.114);
    lumaTotal += luma;
    if (luma < 96) {
      dark += 1;
    }
    if (luma >= 42 && luma < 140) {
      midDark += 1;
    }
    if (luma > 178) {
      light += 1;
    }
    if (luma > 222) {
      nearWhite += 1;
    }
    if (max - min > 58) {
      saturated += 1;
    }
    count += 1;
  }
  if (count <= 0) {
    return false;
  }
  var average = lumaTotal / count;
  var darkRatio = dark / count;
  var midDarkRatio = midDark / count;
  var lightRatio = light / count;
  var nearWhiteRatio = nearWhite / count;
  var saturatedRatio = saturated / count;
  if (average < 112 && darkRatio > 0.42 && midDarkRatio > 0.18 &&
      lightRatio < 0.45 && saturatedRatio < 0.48) {
    return 'dark';
  }
  if (average > 174 && lightRatio > 0.58 && nearWhiteRatio > 0.22 &&
      darkRatio < 0.28 && saturatedRatio < 0.38) {
    return 'light';
  }
  return false;
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

function compactPng(source, width, height, colors, maxBytes, maskCircle, liftColors, scaleSteps, fitMode, maxCost) {
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
      if (encodedFits(encoded, maxBytes, maxCost)) {
        return encoded;
      }
    }
  }
  if (best && encodedFits(best, maxBytes, maxCost)) {
    return best;
  }
  throw new Error('phone png encode over budget: best ' + (best ? best.length : 0) +
                  'b cost ' + (best ? encodedDecodeCost(best) : 0) + ' at ' + bestDetail +
                  ' > ' + maxBytes + 'b/' + (maxCost || 0) + 'c from ' +
                  source.width + 'x' + source.height);
}

function compactPngAsync(source, width, height, colors, maxBytes, maskCircle, liftColors, scaleSteps, fitMode, options, maxCost) {
  var colorSteps = [colors, 32, 16, 8, 4, 2];
  var best = null;
  var bestDetail = '';
  scaleSteps = scaleSteps || [1, 0.9, 0.8, 0.7, 0.6];

  function failOverBudget() {
    throw new Error('phone png encode over budget: best ' + (best ? best.length : 0) +
                    'b cost ' + (best ? encodedDecodeCost(best) : 0) + ' at ' + bestDetail +
                    ' > ' + maxBytes + 'b/' + (maxCost || 0) + 'c from ' +
                    source.width + 'x' + source.height);
  }

  function attempt(step, colorIndex) {
    var nextWidth;
    var nextHeight;
    var nextColors;
    if (step >= scaleSteps.length) {
      if (best && encodedFits(best, maxBytes, maxCost)) {
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
      if (encodedFits(encoded, maxBytes, maxCost)) {
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

function cacheKey(chatId, messageId, width, height, colors, maxBytes, maxPixels, maxCost, forceTall) {
  return [IMAGE_CACHE_VERSION, chatId, messageId, width, height, colors, maxBytes, maxPixels || 0,
          maxCost || 0, forceTall ? 1 : 0].join(':');
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

function applyImageRetryProfile(maxBytes, maxPixels, retryLevel) {
  retryLevel = Math.max(0, Math.min(IMAGE_RETRY_PROFILES.length, retryLevel || 0));
  if (retryLevel <= 0) {
    return {
      maxBytes: maxBytes,
      maxPixels: maxPixels
    };
  }
  var profile = IMAGE_RETRY_PROFILES[retryLevel - 1];
  return {
    maxBytes: Math.min(maxBytes, profile.maxBytes),
    maxPixels: maxPixels ? Math.min(maxPixels, profile.maxPixels) : profile.maxPixels
  };
}

function containPixelCount(source, width, height) {
  if (!source || source.width <= 0 || source.height <= 0 || width <= 0 || height <= 0) {
    return width * height;
  }
  var scale = Math.min(width / source.width, height / source.height);
  var outputWidth = Math.max(1, Math.floor(source.width * scale));
  var outputHeight = Math.max(1, Math.floor(source.height * scale));
  return outputWidth * outputHeight;
}

function fitEncodeBoxForPixelBudget(source, width, height, maxPixels) {
  var pixels = containPixelCount(source, width, height);
  var scale;
  if (!maxPixels || pixels <= maxPixels) {
    return {
      width: width,
      height: height
    };
  }
  scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(32, Math.floor(width * scale)),
    height: Math.max(32, Math.floor(height * scale))
  };
}

function tallWatchMaxBytes(maxBytes, maxPixels) {
  if (maxBytes >= 24000 && maxPixels >= 40000) {
    return EMERY_TALL_IMAGE_WATCH_MAX_BYTES;
  }
  if (maxBytes >= 14000 && maxPixels >= 28000) {
    return GABBRO_TALL_IMAGE_WATCH_MAX_BYTES;
  }
  return TALL_IMAGE_WATCH_MAX_BYTES;
}

function compactMessagePngAsync(source, width, height, colors, maxBytes, options, maxPixels, maxCost) {
  var encodeBox = fitEncodeBoxForPixelBudget(source, width, height, maxPixels);
  var tall = isTallSource(source);
  var costLimit = tall || (options && options.retryLevel > 0) ? maxCost : 0;
  var watchSafeMaxBytes = tall ? Math.min(maxBytes, tallWatchMaxBytes(maxBytes, maxPixels || 0)) : maxBytes;
  var toneMode = messageImageToneMode(source);
  var normalScaleSteps = maxBytes >= 38000 ?
                         [1, 0.98, 0.95, 0.92, 0.86, 0.78, 0.68, 0.58, 0.5, 0.42] :
                         (maxBytes >= 22000 ?
                          [1, 0.96, 0.92, 0.86, 0.78, 0.68, 0.58, 0.5, 0.42] :
                          [1, 0.93, 0.86, 0.76, 0.66, 0.56, 0.46, 0.38]);
  width = encodeBox.width;
  height = encodeBox.height;
  if (tall && watchSafeMaxBytes < maxBytes) {
    if (DEBUG_LOGS) {
      debugLog('tall image watch-safe budget ' + watchSafeMaxBytes + 'b/' + (costLimit || 0) + 'c at ' + width + 'x' + height);
    }
    return compactPngAsync(source, width, height, Math.min(colors, 32), watchSafeMaxBytes, false, toneMode,
                           [1, 0.85, 0.7, 0.56, 0.45, 0.36, 0.32], 'contain', options, costLimit).catch(function(tallErr) {
      if (DEBUG_LOGS) {
        debugLog('tall image compact path: ' + (tallErr && tallErr.message ? tallErr.message : tallErr));
      }
      throwIfCancelled(options);
      return compactPngAsync(source, width, height, 16, watchSafeMaxBytes, false, toneMode,
                             [0.5, 0.42, 0.35, 0.3, 0.26], 'contain', options, costLimit);
    });
  }
  return compactPngAsync(source, width, height, colors, watchSafeMaxBytes, false, toneMode,
                         normalScaleSteps, 'contain', options, costLimit).catch(function(err) {
    if (!tall) {
      throw err;
    }
    if (DEBUG_LOGS) {
      debugLog('tall image encode fallback: ' + (err && err.message ? err.message : err));
    }
    throwIfCancelled(options);
    return compactPngAsync(source, width, height, Math.min(colors, 32), watchSafeMaxBytes, false, toneMode,
                           [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.32],
                           'contain', options, costLimit);
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

function cachedBytes(key, label, downloader, width, height, colors, maxBytes, maskCircle, options, maxPixels, maxCost) {
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
    var tall = options && options.forceTall || isTallSource(source);
    imageStatus(options, tall && !maskCircle ? 'Packing' : 'Encoding');
    if (maskCircle) {
      return Promise.resolve(safeCompactPng(source, width, height, colors, maxBytes, true)).then(function(encoded) {
        throwIfCancelled(options);
        if (DEBUG_LOGS) {
          logDuration('image encode ' + label, encodeStartedAt);
        }
        imageStatus(options, 'Caching');
        cacheSet(key, encoded);
        return encoded;
      });
    }
    if (tall) {
      var pbiBudget = tallPbiBudget(maxBytes, maxPixels, options);
      maxBytes = pbiBudget.maxBytes;
      maxPixels = pbiBudget.maxPixels;
      if (DEBUG_LOGS) {
        debugLog('tall pbi budget ' + maxBytes + 'b/' + (maxPixels || 0) + 'px');
      }
      return Promise.resolve(compactPbi4(source, width, height, maxBytes, maxPixels, options)).then(function(encoded) {
        throwIfCancelled(options);
        if (DEBUG_LOGS) {
          logDuration('image encode ' + label, encodeStartedAt);
        }
        imageStatus(options, 'Caching');
        cacheSet(key, encoded);
        return encoded;
      });
    }
    return compactMessagePngAsync(source, width, height, colors, maxBytes, options, maxPixels, maxCost).then(function(encoded) {
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

function imageBytes(chatId, messageId, width, height, colors, maxBytes, maxPixels, retryLevel, maxCost, forceTall, status) {
  var key;
  var generation = ++foregroundImageGeneration;
  function isCancelled() {
    return generation !== foregroundImageGeneration;
  }
  if (typeof maxPixels === 'function') {
    status = maxPixels;
    maxPixels = 0;
    retryLevel = 0;
    maxCost = 0;
  } else if (typeof retryLevel === 'function') {
    status = retryLevel;
    retryLevel = 0;
    maxCost = 0;
  } else if (typeof maxCost === 'function') {
    status = maxCost;
    maxCost = 0;
    forceTall = false;
  } else if (typeof forceTall === 'function') {
    status = forceTall;
    forceTall = false;
  }
  width = width || 120;
  height = height || 120;
  colors = colors || 64;
  maxBytes = maxBytes || 10000;
  var platformMaxBytes = maxBytes;
  var platformMaxPixels = maxPixels;
  maxCost = maxCost || 0;
  if (maxCost > 0) {
    maxCost = Math.max(12000, Math.floor(maxCost / 2048) * 2048);
  }
  var retryProfile = applyImageRetryProfile(maxBytes, maxPixels, retryLevel);
  maxBytes = retryProfile.maxBytes;
  maxPixels = retryProfile.maxPixels;
  height = height * 2;
  key = cacheKey(chatId, messageId, width, height, colors, maxBytes, maxPixels, maxCost, forceTall);
  return cachedBytes(key, messageId, function() {
    if (status) {
      status('Downloading');
    }
    return telegram.downloadMedia(chatId, messageId, {
      targetWidth: width,
      targetHeight: height,
      cancelled: isCancelled
    });
  }, width, height, colors, maxBytes, false,
  {
    noInflightReuse: true,
    isCancelled: isCancelled,
    status: status,
    retryLevel: retryLevel,
    forceTall: !!forceTall,
    platformMaxBytes: platformMaxBytes,
    platformMaxPixels: platformMaxPixels
  },
  maxPixels, maxCost);
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
