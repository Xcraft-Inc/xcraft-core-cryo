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
  #buf;
  #cb;
  #port;
  #demand = false;

  constructor(port, options) {
    super(options);
    this.#port = port;
    this.#port.onmessage = () => {
      if (this.#buf) {
        this.#postBuffer();
      } else {
        this.#demand = true;
      }
    };
  }

  #postBuffer() {
    let err = null;
    const buf = this.#buf;
    const cb = this.#cb;
    this.#buf = null;
    this.#cb = null;
    this.#demand = false;

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
    this.#cb = cb;
    this.#buf = buf;

    if (this.#demand) {
      this.#postBuffer();
    }
  }

  _final(cb) {
    if (this.#buf) {
      const _cb = this.#cb;
      this.#cb = () => {
        _cb();
        this.#port.postMessage(null);
        cb();
      };
      this.#postBuffer();
    } else {
      this.#port.postMessage(null);
      cb();
    }
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

export class MessagePortReadable extends Readable {
  #port;

  constructor(port, options) {
    super(options);
    this.#port = port;
    this.#port.onmessage = ({data}) => this.push(data);
    this.#port.postMessage({});
  }

  _read() {
    this.#port.postMessage({});
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
