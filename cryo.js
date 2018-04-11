'use strict';

const cryo = require('.');

const cmd = {};

const proto = Object.getPrototypeOf(cryo);
Object.getOwnPropertyNames(proto)
  .filter(name => name !== 'constructor' && !name.startsWith('_'))
  .filter(name => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    return !!desc && typeof desc.value === 'function';
  })
  .forEach(name => {
    cmd[name] = function(msg, resp) {
      try {
        const results = cryo[name](resp, msg);
        resp.events.send(`cryo.${name}.${msg.id}.finished`, results);
      } catch (ex) {
        resp.events.send(`cryo.${name}.${msg.id}.error`, ex);
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
          required: ['db, timestamp'],
        },
      },
      frozen: {
        parallel: true,
        desc: 'statistics on all actions',
        options: {
          required: ['db, timestamp'],
        },
      },
      timestamp: {
        parallel: true,
        desc: 'retrieve a cryo timestamp',
      },
      usable: {
        parallel: true,
        desc: 'check if Cryo is usable',
      },
    },
  };
};
