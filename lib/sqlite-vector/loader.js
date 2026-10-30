'use strict';

const {getExtensionPath} = require('@sqliteai/sqlite-vector');

function getLoadablePath() {
  return getExtensionPath().replace('app.asar', 'app.asar.unpacked');
}

function load(db) {
  db.loadExtension(getLoadablePath());
}

module.exports = {getLoadablePath, load};
