const {Readable, Writable} = require('node:stream');

class ReadableSQL extends Readable {
  #it;
  #step = 16;
  #eos = false;

  constructor(stmt) {
    super();
    this.#it = stmt.iterate();
  }

  _read() {
    /* Terminate with End Of Stream */
    if (this.#eos) {
      this.push(null);
      return;
    }

    try {
      const rows = [];

      for (let i = 0; i < this.#step; ++i) {
        const row = this.#it.next();
        if (row.done) {
          this.#eos = true;
          break;
        }
        rows.push(row.value);
      }

      if (!rows.length) {
        this.push(null);
        return;
      }

      const buffer = Buffer.from(JSON.stringify(rows));
      setImmediate(() => this.push(buffer));
    } catch (ex) {
      this.destroy(ex);
    }
  }
}

class WritableSQL extends Writable {
  #counter = 1;
  #step = 1024;

  #insertStmt;
  #beginStmt;
  #commitStmt;

  constructor(insertStmt, beginStmt, Stmt) {
    super();
    this.#insertStmt = insertStmt;
    this.#beginStmt = beginStmt;
    this.#commitStmt = Stmt;
  }

  #begin() {
    this.#beginStmt.run();
  }

  #commit() {
    this.#commitStmt.run();
  }

  _construct(callback) {
    try {
      this.#begin();
      callback();
    } catch (ex) {
      callback(ex);
    }
  }

  _write(chunk, encoding, callback) {
    try {
      const newTransaction = this.#counter % this.#step === 0;
      const rows = JSON.parse(chunk);

      if (newTransaction) {
        this.#commit();
      }
      for (const row of rows) {
        this.#insertStmt.run(row);
      }
      if (newTransaction) {
        this.#begin();
      }

      ++this.#counter;
      callback();
    } catch (ex) {
      callback(ex);
    }
  }

  _destroy(err, callback) {
    try {
      this.#commit();
      callback();
    } catch (ex) {
      callback(ex || err);
    }
  }
}

module.exports = {
  ReadableSQL,
  WritableSQL,
};
