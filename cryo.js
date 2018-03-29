'use strict';

const cmd = {
  close: null,
  sync: null,
  freeze: null,
  thaw: null,
  usable: null,
};

Object.keys(cmd).forEach(c => {
  cmd[c] = function(msg, resp) {
    const cryo = require('.');

    try {
      const results = cryo[c](resp, msg);
      resp.events.send(`cryo.${c}.${msg.id}.finished`, results);
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
      close: {
        parallel: true,
        desc: 'close the table',
      },
      sync: {
        parallel: true,
        desc: 'sync the store to the disk',
      },
      freeze: {
        parallel: true,
        desc: 'freeze (persist) an action in the store',
        options: {
          required: ['db', 'action', 'rules'],
        },
      },
      thaw: {
        parallel: true,
        desc: 'thaw (extract) the actions from the store',
        options: {
          required: ['table'],
        },
      },
      usable: {
        parallel: true,
        desc: 'check if Cryo is usable',
      },
    },
  };
};
