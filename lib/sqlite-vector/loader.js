'use strict';

const {getExtensionPath} = require('@sqliteai/sqlite-vector');

function getLoadablePath() {
  return getExtensionPath().replace('app.asar', 'app.asar.unpacked');
}

function load(db) {
  const previous = process.report.excludeNetwork;
  try {
    /* See https://github.com/zhangyuang/node-ffi-rs/issues/143 */
    process.report.excludeNetwork = true;
    db.loadExtension(getLoadablePath());
  } finally {
    process.report.excludeNetwork = previous;
  }
}

function initialize(db, {dimensions, vecFunc}) {
  const type = vecFunc === 'vec_int8' ? 'INT8' : 'FLOAT32';
  const options = `dimension=${dimensions},type=${type},distance=COSINE`;
  db.prepare(`SELECT vector_init('embeddings', 'embedding', ?)`).get(options);
}

module.exports = {getLoadablePath, initialize, load};
