'use strict';

const {expect} = require('chai');
const {SQLite} = require('xcraft-core-book');
const sqliteVector = require('../lib/sqlite-vector/loader.js');

describe('xcraft.cryo.vector', function () {
  const dbName = ':memory:';
  let sqlite;
  let db;

  function vector(values) {
    const array = new Float32Array(values);
    return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  }

  beforeEach(function () {
    sqlite = new SQLite(__dirname);
    sqlite.open(
      dbName,
      `
        CREATE TABLE embeddings (
          rowid INTEGER PRIMARY KEY,
          locale TEXT NOT NULL,
          scope TEXT,
          documentId TEXT,
          chunkId TEXT,
          chunk TEXT,
          embedding BLOB NOT NULL
        );

        CREATE INDEX embeddings_documentId ON embeddings (documentId);
        CREATE INDEX embeddings_filters ON embeddings (locale, scope);
      `,
      {},
      () => sqliteVector.load(sqlite._db[dbName]),
      () =>
        sqliteVector.initialize(sqlite._db[dbName], {
          dimensions: 3,
          vecFunc: 'vec_f32',
        })
    );
    db = sqlite.getHandle(dbName)();

    const insert = db.prepare(`
      INSERT INTO embeddings
        (locale, scope, documentId, chunkId, chunk, embedding)
      VALUES
        ($locale, $scope, $documentId, $chunkId, $chunk, $embedding)
    `);
    insert.run({
      locale: 'fr',
      scope: 'web',
      documentId: 'same',
      chunkId: 'title',
      chunk: 'Same direction',
      embedding: vector([1, 0, 0]),
    });
    insert.run({
      locale: 'de',
      scope: 'web',
      documentId: 'orthogonal',
      chunkId: 'title',
      chunk: 'Orthogonal direction',
      embedding: vector([0, 1, 0]),
    });
    insert.run({
      locale: 'fr',
      scope: 'internal',
      documentId: 'opposite',
      chunkId: 'title',
      chunk: 'Opposite direction',
      embedding: vector([-1, 0, 0]),
    });
  });

  afterEach(function () {
    sqlite.close(dbName);
  });

  it('creates embeddings as an ordinary table', function () {
    const {sql} = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'embeddings'`)
      .get();

    expect(sql).to.include('CREATE TABLE embeddings');
    expect(sql).not.to.include('CREATE VIRTUAL TABLE');
  });

  it('returns nearest embeddings ordered by cosine distance', function () {
    const rows = db
      .prepare(
        `
        SELECT e.documentId, v.distance
        FROM vector_full_scan(
          'embeddings',
          'embedding',
          ?,
          CAST(? AS INTEGER)
        ) AS v
        JOIN embeddings AS e ON e.rowid = v.rowid
        ORDER BY v.distance, e.rowid
      `
      )
      .all(vector([1, 0, 0]), 3);

    expect(rows.map(({documentId}) => documentId)).to.deep.equal([
      'same',
      'orthogonal',
      'opposite',
    ]);
    expect(rows[0].distance).to.be.closeTo(0, 0.000001);
  });

  it('filters results by locale and scope', function () {
    const rows = db
      .prepare(
        `
        SELECT e.documentId, v.distance
        FROM vector_full_scan('embeddings', 'embedding', ?) AS v
        JOIN embeddings AS e ON e.rowid = v.rowid
        WHERE e.locale = ? AND e.scope = ?
        ORDER BY v.distance, e.rowid
        LIMIT CAST(? AS INTEGER)
      `
      )
      .all(vector([1, 0, 0]), 'fr', 'web', 10);

    expect(rows.map(({documentId}) => documentId)).to.deep.equal(['same']);
  });

  it('removes every embedding of a document', function () {
    db.prepare(`DELETE FROM embeddings WHERE documentId = ?`).run('same');

    const {count} = db
      .prepare(`SELECT COUNT(*) AS count FROM embeddings WHERE documentId = ?`)
      .get('same');
    expect(count).to.equal(0);
  });
});
