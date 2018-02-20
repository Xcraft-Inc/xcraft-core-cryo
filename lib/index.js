'use strict';

const path = require('path');
const watt = require('watt');

class Cryo {
  constructor() {
    watt.wrapAll(this);
  }

  *do(resp, next) {}
}

module.exports = new Cryo();
