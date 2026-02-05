import {Writable, Readable} from 'node:stream';

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
  #port;

  constructor(port, options) {
    super(options);
    this.#port = port;
  }

  #postBuffer(buf, cb) {
    let err = null;

    if (isTransferable(buf)) {
      try {
        this.#port.postMessage(buf, [buf.buffer]);
        return cb();
      } catch (ex) {
        err = ex;
      }
    }

    if (!err || err.name === 'DataCloneError') {
      this.#port.postMessage(buf);
      cb();
    } else {
      cb(err);
    }
  }

  _write(buf, _, cb) {
    this.#postBuffer(buf, cb);
  }

  _final(cb) {
    this.#port.postMessage(null);
    cb();
  }

  _destroy(err, cb) {
    this.#port.close(() => cb(err});
  }

  unref() {
    this.#port.unref();
    return this;
  }
  ref() {
    this.#port.ref();
    return this;
  }
}

export class MessagePortReadable extends Readable {
  #port;

  constructor(port, options) {
    super(options);
    this.#port = port;
    this.#port.onmessage = ({data}) => this.push(data);
  }

  _read() {
    this.#port.start();
  }

  _destroy(err, cb) {
    this.#port.close(() => {
      this.#port.onmessage = undefined;
      cb(err);
    });
  }

  unref() {
    this.#port.unref();
    return this;
  }
  ref() {
    this.#port.ref();
    return this;
  }
}
