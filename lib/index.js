'use strict';

const Cryo = require('./cryo.js');
const cryoConfig = require('xcraft-core-etc')().load('xcraft-core-cryo');

module.exports = new Cryo(cryoConfig);
