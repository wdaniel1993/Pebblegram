var sha1 = require('js-sha1');
var sha256 = require('js-sha256');
var sha512 = require('../vendor/js-sha512');
var aes = require('@cryptography/aes');

function randomBytes(count) {
  var bytes = new Uint8Array(count);
  var cryptoObject = (typeof self !== 'undefined' && self.crypto) ||
                     (typeof window !== 'undefined' && window.crypto) ||
                     (typeof global !== 'undefined' && global.crypto);
  if (!cryptoObject || !cryptoObject.getRandomValues) {
    throw new Error('Secure random source unavailable');
  }
  cryptoObject.getRandomValues(bytes);
  return bytes;
}

function randomFillSync(buffer, offset, size) {
  offset = offset || 0;
  size = size === undefined ? buffer.length - offset : size;
  var bytes = randomBytes(size);
  for (var i = 0; i < size; i++) {
    buffer[offset + i] = bytes[i];
  }
  return buffer;
}

function Hash(algorithm) {
  this.algorithm = normalizeAlgorithm(algorithm);
  this.parts = [];
}

Hash.prototype.update = function(data) {
  this.parts.push(data);
  return this;
};

Hash.prototype.digest = function(encoding) {
  var Buffer = require('buffer').Buffer;
  var input = Buffer.concat(this.parts.map(function(part) {
    return Buffer.from(part);
  }));
  var bytes;

  if (this.algorithm === 'sha1') {
    bytes = sha1.array(input);
  } else if (this.algorithm === 'sha256') {
    bytes = sha256.array(input);
  } else if (this.algorithm === 'sha512') {
    bytes = sha512.array(input);
  } else {
    throw new Error('Unsupported hash algorithm: ' + this.algorithm);
  }

  if (encoding === 'hex') {
    return bytes.map(function(byte) {
      return ('0' + byte.toString(16)).slice(-2);
    }).join('');
  }
  return Buffer.from(bytes);
};

function createHash(algorithm) {
  return new Hash(algorithm);
}

function createHmac(algorithm, key) {
  var Buffer = require('buffer').Buffer;
  var normalized = normalizeAlgorithm(algorithm);
  var hmacFn;
  if (normalized === 'sha1') {
    hmacFn = sha1.sha1.hmac;
  } else if (normalized === 'sha256') {
    hmacFn = sha256.sha256.hmac;
  } else if (normalized === 'sha512') {
    hmacFn = sha512.sha512.hmac;
  } else {
    throw new Error('Unsupported HMAC algorithm: ' + algorithm);
  }
  var keyBuffer = Buffer.from(key);
  var parts = [];
  return {
    update: function(data) {
      parts.push(data);
      return this;
    },
    digest: function() {
      var input = Buffer.concat(parts.map(function(part) {
        return Buffer.from(part);
      }));
      return Buffer.from(hmacFn.array(keyBuffer, input));
    }
  };
}

function normalizeAlgorithm(algorithm) {
  return String(algorithm || '').toLowerCase().replace(/-/g, '');
}

function toBuffer(value) {
  var Buffer = require('buffer').Buffer;
  if (Buffer.isBuffer(value)) {
    return value;
  }
  return Buffer.from(value);
}

function int32Buffer(value) {
  var Buffer = require('buffer').Buffer;
  var bytes = Buffer.alloc(4);
  bytes[0] = (value >>> 24) & 255;
  bytes[1] = (value >>> 16) & 255;
  bytes[2] = (value >>> 8) & 255;
  bytes[3] = value & 255;
  return bytes;
}

function hmac(algorithm, key, data) {
  if (algorithm === 'sha512') {
    return sha512.sha512.hmac.array(key, data);
  }
  if (algorithm === 'sha256') {
    return sha256.sha256.hmac.array(key, data);
  }
  if (algorithm === 'sha1') {
    return sha1.sha1.hmac.array(key, data);
  }
  throw new Error('Unsupported PBKDF2 digest: ' + algorithm);
}

function pbkdf2Sync(password, salt, iterations, keyLength, digest) {
  var Buffer = require('buffer').Buffer;
  var algorithm = normalizeAlgorithm(digest || 'sha1');
  var blockLength = algorithm === 'sha512' ? 64 : algorithm === 'sha256' ? 32 : 20;
  var blocks = Math.ceil(keyLength / blockLength);
  var output = Buffer.alloc(blocks * blockLength);
  var passwordBytes = toBuffer(password);
  var saltBytes = toBuffer(salt);
  var block;
  var u;
  var blockIndex;
  var round;
  var offset;
  var i;

  if (!iterations || iterations < 1) {
    throw new Error('PBKDF2 iterations must be positive.');
  }

  for (blockIndex = 1; blockIndex <= blocks; blockIndex += 1) {
    u = hmac(algorithm, passwordBytes, Buffer.concat([saltBytes, int32Buffer(blockIndex)]));
    block = Buffer.from(u);
    for (round = 1; round < iterations; round += 1) {
      u = hmac(algorithm, passwordBytes, Buffer.from(u));
      for (i = 0; i < blockLength; i += 1) {
        block[i] ^= u[i];
      }
    }
    offset = (blockIndex - 1) * blockLength;
    block.copy(output, offset);
  }

  return output.slice(0, keyLength);
}

// --- Pure-JS AES (CTR + CBC) for teleproto's node:crypto usage ---

function bytesToWords(bytes) {
  var words = new Uint32Array(Math.ceil(bytes.length / 4));
  for (var i = 0; i < words.length; i++) {
    var o = i * 4;
    words[i] = ((bytes[o] || 0) << 24) ^
               ((bytes[o + 1] || 0) << 16) ^
               ((bytes[o + 2] || 0) << 8) ^
               (bytes[o + 3] || 0);
  }
  return words;
}

function wordsToBytes(words, length) {
  var bytes = new Uint8Array(length);
  for (var i = 0; i < length; i++) {
    var w = words[i >> 2];
    bytes[i] = (w >>> (24 - (i % 4) * 8)) & 255;
  }
  return bytes;
}

function incrementCounter(counter) {
  for (var i = 15; i >= 0; i--) {
    counter[i] = (counter[i] + 1) & 255;
    if (counter[i] !== 0) {
      break;
    }
  }
}

function AesCtrCipher(key, iv) {
  var Buffer = require('buffer').Buffer;
  this.aes = new aes.default(bytesToWords(toBuffer(key)));
  this.counter = new Uint8Array(toBuffer(iv));
  // Leftover keystream from a partially-consumed block, buffered across
  // update() calls (Node cipher semantics).
  this.keystream = null;
  this.keystreamPos = 16;
}

AesCtrCipher.prototype.update = function(data) {
  var Buffer = require('buffer').Buffer;
  var input = toBuffer(data);
  var out = Buffer.alloc(input.length);
  var offset = 0;
  while (offset < input.length) {
    if (this.keystreamPos >= 16) {
      this.keystream = wordsToBytes(this.aes.encrypt(bytesToWords(this.counter)), 16);
      this.keystreamPos = 0;
      incrementCounter(this.counter);
    }
    for (; this.keystreamPos < 16 && offset < input.length; this.keystreamPos++, offset++) {
      out[offset] = input[offset] ^ this.keystream[this.keystreamPos];
    }
  }
  return out;
};

AesCtrCipher.prototype.final = function() {
  var Buffer = require('buffer').Buffer;
  return Buffer.alloc(0);
};

function AesCbcCipher(key, iv, decrypt) {
  var Buffer = require('buffer').Buffer;
  this.aes = new aes.default(bytesToWords(toBuffer(key)));
  this.iv = new Uint8Array(toBuffer(iv));
  this.prev = new Uint8Array(toBuffer(iv));
  this.decrypt = !!decrypt;
  this.buffer = Buffer.alloc(0);
}

AesCbcCipher.prototype.setAutoPadding = function() {};

AesCbcCipher.prototype.update = function(data) {
  var Buffer = require('buffer').Buffer;
  var input = Buffer.concat([this.buffer, toBuffer(data)]);
  var fullBlocks = Math.floor(input.length / 16);
  if (fullBlocks === 0) {
    this.buffer = input;
    return Buffer.alloc(0);
  }
  var out = Buffer.alloc(fullBlocks * 16);
  var block = new Uint8Array(16);
  var result;
  for (var b = 0; b < fullBlocks; b++) {
    for (var i = 0; i < 16; i++) {
      block[i] = input[b * 16 + i];
    }
    if (this.decrypt) {
      result = wordsToBytes(this.aes.decrypt(bytesToWords(block)), 16);
      for (i = 0; i < 16; i++) {
        out[b * 16 + i] = result[i] ^ this.prev[i];
      }
      // CBC decrypt chains from the PREVIOUS CIPHERTEXT block.
      this.prev = new Uint8Array(block);
    } else {
      for (i = 0; i < 16; i++) {
        block[i] ^= this.prev[i];
      }
      result = wordsToBytes(this.aes.encrypt(bytesToWords(block)), 16);
      for (i = 0; i < 16; i++) {
        out[b * 16 + i] = result[i];
      }
      this.prev = result;
    }
  }
  this.buffer = input.slice(fullBlocks * 16);
  return out;
};

AesCbcCipher.prototype.final = function() {
  var Buffer = require('buffer').Buffer;
  return this.buffer;
};

function createCipheriv(algorithm, key, iv) {
  var normalized = normalizeAlgorithm(algorithm);
  if (normalized.indexOf('ecb') !== -1) {
    throw new Error('ECB mode is not supported');
  }
  if (normalized.indexOf('cbc') !== -1) {
    return new AesCbcCipher(key, iv, false);
  }
  return new AesCtrCipher(key, iv);
}

function createDecipheriv(algorithm, key, iv) {
  var normalized = normalizeAlgorithm(algorithm);
  if (normalized.indexOf('ecb') !== -1) {
    throw new Error('ECB mode is not supported');
  }
  if (normalized.indexOf('cbc') !== -1) {
    return new AesCbcCipher(key, iv, true);
  }
  return new AesCtrCipher(key, iv);
}

// sha256Hex(input) -> uppercase hex string.
// BUFFER-FREE: the shim's Hash.digest() uses require('buffer'), and the
// SDK webpack config maps `buffer` to an EXTERNAL — in the phone WebView
// there is no `require` global, so ANY runtime path through Hash.digest()
// throws "require is not defined" (seen live: TTS "Speak failed: require
// is not defined"). js-sha256's .array() is pure JS — use it directly.
function sha256Hex(input) {
  var bytes = sha256.array(String(input));
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i].toString(16);
    hex += b.length === 1 ? '0' + b : b;
  }
  return hex.toUpperCase();
}

module.exports = {
  createHash: createHash,
  createHmac: createHmac,
  createCipheriv: createCipheriv,
  createDecipheriv: createDecipheriv,
  pbkdf2Sync: pbkdf2Sync,
  randomBytes: randomBytes,
  randomFillSync: randomFillSync,
  sha256Hex: sha256Hex
};
