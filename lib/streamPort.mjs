import {Writable, Readable} from 'node:stream';

const kPort = Symbol('kPort');

function isTransferable(buf) {
  const ibuf = buf.buffer;

  if (ibuf instanceof SharedArrayBuffer) {
    return false;
  }
  /* If it's a view */
  if (buf.byteOffset !== 0 || buf.byteLength !== ibuf.byteLength) {
    return false;
  }
  /* if already detached */
  if (ibuf.byteLength === 0 && ibuf.maxByteLength === undefined) {
    return false;
  }
  return true;
}

export class MessagePortWritable extends Writable {
  constructor(port, options) {
    super(options);
    this[kPort] = port;
  }

  #postBuffer(buf, cb) {
    let err = null;

    if (isTransferable(buf)) {
      try {
        this[kPort].postMessage(buf, [buf.buffer]);
        return cb();
      } catch (ex) {
        err = ex;
      }
    }

    if (!err || err.name === 'DataCloneError') {
      this[kPort].postMessage(buf);
      cb();
    } else {
      cb(err);
    }
  }

  _write(buf, _, cb) {
    this.#postBuffer(buf, cb);
  }

  _final(cb) {
    this[kPort].postMessage(null);
    cb();
  }

  _destroy(err, cb) {
    this[kPort].close(() => cb(err));
  }

  unref() {
    this[kPort].unref();
    return this;
  }
  ref() {
    this[kPort].ref();
    return this;
  }
}

export class MessagePortReadable extends Readable {
  constructor(port, options) {
    super(options);
    this[kPort] = port;
    port.onmessage = ({data}) => this.push(data);
  }

  _read() {
    this[kPort].start();
  }

  _destroy(err, cb) {
    this[kPort].close(() => {
      this[kPort].onmessage = undefined;
      cb(err);
    });
  }

  unref() {
    this[kPort].unref();
    return this;
  }
  ref() {
    this[kPort].ref();
    return this;
  }
}
