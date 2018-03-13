'use strict';

const cmd = {
  create: null,
  sync: null,
  freeze: null,
  thaw: null,
};

Object.keys(cmd).forEach(c => {
  cmd[c] = function*(msg, resp) {
    const cryo = require('.');

    try {
      yield cryo[c](resp, msg);
      resp.events.send(`cryo.${c}.${msg.id}.finished`);
    } catch (ex) {
      resp.events.send(`cryo.${c}.${msg.id}.error`, ex);
    }
  };
});

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function() {
  return {
    handlers: cmd,
    rc: {
      create: {
        parallel: true,
        desc: 'create a new action table',
        options: {
          params: {
            required: 'table',
            optional: 'options',
          },
        },
      },
    },
    sync: {
      parallel: true,
      desc: 'sync the store to the disk',
    },
    freeze: {
      parallel: true,
      desc: 'freeze (persist) an action in the store',
      options: {
        required: ['action', 'rules'],
      },
    },
    thaw: {
      parallel: true,
      desc: 'thaw (extract) the actions from the store',
      options: {
        required: ['table'],
      },
    },
  };
};
