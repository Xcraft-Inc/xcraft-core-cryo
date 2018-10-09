'use strict';

const cryo = require('.');

const cmd = {};

function isFunction(fn) {
  return typeof fn === 'function';
}

function isGenerator(fn) {
  return (
    fn &&
    isFunction(fn) &&
    fn.constructor &&
    fn.constructor.name === 'GeneratorFunction'
  );
}

const proto = Object.getPrototypeOf(cryo);
Object.getOwnPropertyNames(proto)
  .filter(name => name !== 'constructor' && !name.startsWith('_'))
  .filter(name => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    return !!desc && isFunction(desc.value);
  })
  .forEach(name => {
    cmd[name] = function*(msg, resp) {
      try {
        let results;
        if (isGenerator(cryo[name])) {
          results = yield cryo[name](resp, msg);
        } else {
          results = cryo[name](resp, msg);
        }
        resp.events.send(`cryo.${name}.${msg.id}.finished`, results);
      } catch (ex) {
        resp.events.send(`cryo.${name}.${msg.id}.error`, {
          code: ex.code,
          message: ex.message,
          stack: ex.stack,
        });
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
      actions: {
        parallel: true,
        desc: 'list the actions between two timestamps',
        options: {
          params: {
            required: ['db', 'from', 'to'],
          },
        },
      },
      branch: {
        parallel: true,
        desc: 'create a new branch',
        options: {
          params: {
            required: 'db',
          },
        },
      },
      branches: {
        parallel: true,
        desc: 'list all available branches for all databases',
      },
      close: {
        parallel: true,
        desc: 'close the table',
      },
      freeze: {
        parallel: true,
        desc: 'freeze (persist) an action in the store',
        options: {
          params: {
            required: ['db', 'action', 'rules'],
          },
        },
      },
      frozen: {
        parallel: true,
        desc: 'statistics on all actions',
        options: {
          params: {
            required: ['db, timestamp'],
          },
        },
      },
      restore: {
        parallel: true,
        desc: 'restore an actions store to a particular timestamp',
        options: {
          params: {
            required: ['dbSrc', 'dbDst', 'timestamp'],
          },
        },
      },
      sync: {
        parallel: true,
        desc: 'sync the store to the disk',
      },
      thaw: {
        parallel: true,
        desc: 'thaw (extract) the actions from the store',
        options: {
          params: {
            required: ['db, timestamp'],
          },
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
