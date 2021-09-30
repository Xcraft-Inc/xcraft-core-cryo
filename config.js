'use strict';

/**
 * Retrieve the inquirer definition for xcraft-core-etc
 */
module.exports = [
  {
    type: 'list',
    name: 'endpoints',
    message: 'List of endpoints to enabled',
    default: [],
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
