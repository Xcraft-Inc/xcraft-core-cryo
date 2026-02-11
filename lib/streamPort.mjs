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
  #closed = false;

  constructor(port, options) {
    super(options);
    this.#port = port;

    this.#port.onmessage = () => {
      if (this.#closed) {
        return;
      }
      if (this.#buf) {
        this.#postBuffer();
      } else {
        this.#demand = true;
      }
    };

    this.#port.onclose = () => {
      this.#closed = true;
      this.destroy(new Error('MessagePort closed'));
    };

    this.#port.onmessageerror = (err) => {
      this.#closed = true;
      this.destroy(
        err instanceof Error ? err : new Error('MessagePort messageerror')
      );
    };
  }

  #postBuffer() {
    let err = null;
    const buf = this.#buf;
    const cb = this.#cb;
    this.#buf = null;
    this.#cb = null;
    this.#demand = false;

    try {
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
    } catch (ex) {
      this.destroy(ex);
      cb(ex);
    }
  }

  _write(buf, _, cb) {
    if (this.#closed) {
      return cb(new Error('MessagePort closed'));
    }

    this.#cb = cb;
    this.#buf = buf;

    if (this.#demand) {
      this.#postBuffer();
    }
  }

  _final(cb) {
    if (this.#closed) {
      return cb();
    }

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
    if (this.#closed) {
      return cb(err);
    }

    this.#closed = true;
    if (err) {
      this.#port.postMessage(err);
    }
    this.#port.close(() => {
      this.#port.onmessage = null;
      this.#port.onclose = null;
      this.#port.onmessageerror = null;
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
  #closed = false;

  constructor(port, options) {
    super(options);
    this.#port = port;

    this.#port.onmessage = ({data}) => {
      if (data instanceof Error) {
        this.destroy(data);
        return;
      }
      if (this.#closed) {
        return;
      }
      this.push(data);
    };

    this.#port.onclose = () => {
      this.#closed = true;
      this.destroy();
    };

    this.#port.onmessageerror = (err) => {
      this.#closed = true;
      this.destroy(
        err instanceof Error ? err : new Error('MessagePort messageerror')
      );
    };

    this.#postMessage();
  }

  #postMessage() {
    if (this.#closed) {
      return;
    }
    try {
      this.#port.postMessage({});
    } catch (ex) {
      this.destroy(ex);
    }
  }

  _read() {
    this.#postMessage();
  }

  _destroy(err, cb) {
    if (this.#closed) {
      return cb(err);
    }

    this.#closed = true;
    this.#port.close(() => {
      this.#port.onmessage = null;
      this.#port.onclose = null;
      this.#port.onmessageerror = null;
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
