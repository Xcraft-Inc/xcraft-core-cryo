'use strict';

const {Readable, Writable} = require('node:stream');

class ReadableSQL extends Readable {
  #it;
  #step = 128;
  #eos = false;

  #stmt;
  #params;
  #wait;

  constructor(stmt, params, wait = null) {
    super();
    this.#stmt = stmt;
    this.#params = params;
    this.#wait = wait;
  }

  async _read() {
    if (!this.#it) {
      if (this.#wait) {
        this.#it = await this.#wait(() =>
          this.#params //
            ? this.#stmt.iterate(this.#params)
            : this.#stmt.iterate()
        );
      } else {
        this.#it = this.#params //
          ? this.#stmt.iterate(this.#params)
          : this.#stmt.iterate();
      }
    }

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
      this.push(buffer);
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
  #wait;

  #progressPos = 0;
  #progressCb;

  constructor(
    insertStmt,
    beginStmt,
    Stmt,
    wait = null,
    step = null,
    progressCb = null
  ) {
    super();
    this.#insertStmt = insertStmt;
    this.#beginStmt = beginStmt;
    this.#commitStmt = Stmt;
    this.#wait = wait;
    this.#progressCb = progressCb;
    if (step !== null && step !== undefined) {
      this.#step = step;
    }
  }

  async #begin() {
    if (this.#wait) {
      await this.#wait(() => this.#beginStmt.run());
    } else {
      this.#beginStmt.run();
    }
  }

  async #commit() {
    if (this.#wait) {
      await this.#wait(() => this.#commitStmt.run());
    } else {
      this.#commitStmt.run();
    }
  }

  async #insert(row) {
    if (this.#wait) {
      await this.#wait(() => this.#insertStmt.run(row));
    } else {
      this.#insertStmt.run();
    }
  }

  async _construct(callback) {
    try {
      await this.#begin();
      callback();
    } catch (ex) {
      callback(ex);
    }
  }

  async _write(chunk, encoding, callback) {
    try {
      const newTransaction = this.#counter % this.#step === 0;
      const rows = JSON.parse(chunk);

      if (newTransaction) {
        await this.#commit();
      }
      for (const row of rows) {
        await this.#insert(row);
      }
      if (newTransaction) {
        await this.#begin();
      }

      if (this.#progressCb) {
        this.#progressPos += rows.length;
        this.#progressCb(this.#progressPos);
      }

      ++this.#counter;
      callback();
    } catch (ex) {
      callback(ex);
    }
  }

  async _destroy(err, callback) {
    try {
      await this.#commit();
      callback(err);
    } catch (ex) {
      callback(ex || err);
    }
  }
}

module.exports = {
  ReadableSQL,
  WritableSQL,
};
