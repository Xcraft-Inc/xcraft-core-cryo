'use strict';

/**
 * Retrieve the inquirer definition for xcraft-core-etc
 */
module.exports = [
  {
    type: 'input',
    name: 'journal',
    message: 'journal mode for SQLite (journal or WAL)',
    default: 'WAL',
  },
  {
    type: 'list',
    name: 'endpoints',
    message: 'List of endpoints to enabled',
    default: [],
  },
  {
    type: 'confirm',
    name: 'enableFTS',
    message: 'enable full text search',
    default: false,
  },
  {
    type: 'confirm',
    name: 'enableVEC',
    message: 'enable vector search (require enableFTS)',
    default: false,
  },
  {
    type: 'list',
    name: 'fts.list',
    message:
      'List of databases where using FTS (if enableFTS is true); all if empty array',
    default: [],
  },
  {
    type: 'list',
    name: 'vec.list',
    message:
      'List of databases where using VEC (if enableVEC is true); all if empty array',
    default: [],
  },
  {
    type: 'list',
    name: 'vec.dimensions',
    message: 'Number of dimensions for embeddings',
    default: 4096,
  },
  {
    type: 'confirm',
    name: 'vec.defaultLocale',
    message: 'used for vectors partionning',
    default: 'fr',
  },
  {
    type: 'input',
    name: 'migrations.cleanings',
    message: 'cleaning rules (array of types to clean) by database name',
    default: null,
  },
  {
    type: 'confirm',
    name: 'enableTimetable',
    message: 'enable timetable',
    default: false,
  },
  {
    type: 'input',
    name: 'googleQueue.topic',
    message: 'Topic to use to publish messages',
    default: '',
  },
  {
    type: 'input',
    name: 'googleQueue.authFile',
    message: 'Authentification file for Google Queue pub/sub connection',
    default: '',
  },
  {
    type: 'input',
    name: 'googleQueue.orderingPrefix',
    message: 'fixed part of the ordering key',
    default: '',
  },
];
