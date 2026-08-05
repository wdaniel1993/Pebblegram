var pako = require('pako');

function unzipSync(input) {
  var Buffer = require('buffer').Buffer;
  var data = input;
  if (data && typeof data.length === 'number' && !(data instanceof Uint8Array) && !Buffer.isBuffer(data)) {
    data = new Uint8Array(data);
  }
  return Buffer.from(pako.inflate(data));
}

module.exports = {
  unzipSync: unzipSync
};
