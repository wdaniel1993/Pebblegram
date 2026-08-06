// Minimal fs shim for teleproto in the PebbleKit WebView.
//
// teleproto's download path touches exactly three fs surfaces:
//   1. closeWriter():  `writer instanceof fs.WriteStream`   ← MUST be a real
//      class or `instanceof undefined` throws "Right-hand side of 'instanceof'
//      is not an object" on EVERY download (this was the v1.0.6/1.0.7 image
//      failure: empty.js made fs.WriteStream undefined).
//   2. getWriter():    `fs.createWriteStream(path)` for string outputFile —
//      Pebblegram always downloads in-memory (BinaryWriter), never reaches it.
//   3. getProperFilename(): fs.existsSync/lstatSync for string file paths —
//      only when outputFile is a string; Pebblegram never passes one.
//
// Everything else (readFileSync/writeFileSync/...) must NOT exist as silent
// no-ops — a missing method fails loudly, which is what we want for any
// code path that assumes a real filesystem.
'use strict';

// A real, instantiable class so `x instanceof fs.WriteStream` is legal and
// false for BinaryWriter. If anything ever constructs it, that's a bug — the
// WebView has no filesystem.
function WriteStream() {
  throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
}

WriteStream.prototype = {
  constructor: WriteStream,
  write: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  end: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  on: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  once: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  removeListener: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  addListener: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  },
  emit: function() {
    throw new Error('fs.WriteStream is not supported in the PebbleKit WebView');
  }
};

function createWriteStream() {
  throw new Error('fs.createWriteStream is not supported in the PebbleKit WebView');
}

function existsSync() {
  return false;
}

function lstatSync() {
  return {
    isDirectory: function() {
      return false;
    }
  };
}

module.exports = {
  WriteStream: WriteStream,
  createWriteStream: createWriteStream,
  existsSync: existsSync,
  lstatSync: lstatSync
};
