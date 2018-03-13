'use strict';

const watt = require('watt');

class Cryo {
  constructor() {
    watt.wrapAll(this);
  }

  *create(resp, msg) {}

  *sync(resp, msg) {}

  *freeze(resp, msg) {}

  *thaw(resp, msg) {}
}

module.exports = new Cryo();
