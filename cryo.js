'use strict';

const path = require('path');
const {isFunction} = require('xcraft-core-utils').js;
const xFs = require('xcraft-core-fs');
const cryoConfig = require('xcraft-core-etc')().load('xcraft-core-cryo');
const cryo = require('./lib/index.js');

const endpoints = {};
const endpointsPath = path.join(__dirname, 'lib/endpoints');
xFs
  .ls(endpointsPath, /\.js$/)
  .map((endpoint) => path.basename(endpoint, '.js'))
  .filter((endpoint) => cryoConfig.endpoints.includes(endpoint))
  .forEach((endpoint) => {
    const Endpoint = require(path.join(endpointsPath, endpoint + '.js'));
    endpoints[endpoint] = new Endpoint(cryoConfig[endpoint]);
  });

const cmd = {};

const proto = Object.getPrototypeOf(cryo);
Object.getOwnPropertyNames(proto)
  .filter((name) => name !== 'constructor' && !name.startsWith('_'))
  .filter((name) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    return !!desc && isFunction(desc.value);
  })
  .forEach((name) => {
    cmd[name] = function* (msg, resp) {
      try {
        const value = cryo[name](resp, msg);
        let results = value && value.then ? yield value : value;

        /* Handle endpoints only when it's done for our own actions store */
        for (const endpoint in endpoints) {
          if (endpoints[endpoint][name]) {
            const value = endpoints[endpoint][name](resp, msg, results);
            if (value && value.then) {
              yield value;
            }
          }
        }

        /* Special case where the whole freeze results must be ignored
         * on finished and we just want the hash in the case of 'persist'
         * type..
         */
        if (name === 'freeze') {
          results =
            results?.type === 'persist' ? {action: results.action} : undefined;
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
module.exports.xcraftCommands = function () {
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
      loadMiddleware: {
        parallel: true,
        desc: 'load and add a new middleware from path',
        options: {
          params: {
            required: ['middlewarePath'],
          },
        },
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
            optional: ['type'],
          },
        },
      },
      getLocation: {
        parallel: true,
        desc: 'return the cryo database location',
      },
      isEmpty: {
        parallel: true,
        desc: 'test if a database is empty',
        options: {
          params: {
            required: ['db'],
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
      immediate: {
        parallel: true,
        desc: 'start an immediate transaction',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      exclusive: {
        parallel: true,
        desc: 'start an exclusive transaction',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      commit: {
        parallel: true,
        desc: 'commit the transaction',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      rollback: {
        parallel: true,
        desc: 'rollback the transaction',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      sync: {
        parallel: true,
        desc: 'sync the store to the disk',
      },
      getEntityTypeCount: {
        parallel: true,
        desc: 'return goblin types and count',
        options: {
          params: {
            required: ['dbSrc'],
          },
        },
      },
      thaw: {
        parallel: true,
        desc: 'thaw (extract) the actions from the store',
        options: {
          params: {
            required: ['db, timestamp'],
            optional: ['type', 'length', 'offset'],
          },
        },
      },
      dump: {
        parallel: true,
        desc: 'extract actions to a new database',
        options: {
          params: {
            required: ['dbName', 'dbDst', 'timestamp'],
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
      isAlreadyCreated: {
        parallel: true,
        desc: 'check if this goblin is already created',
        options: {
          params: {
            required: ['db', 'goblin'],
          },
        },
      },
      registerLastActionTriggers: {
        parallel: true,
        desc: 'register event topic to trigger',
        options: {
          params: {
            required: ['actorType', 'onInsertTopic', 'onUpdateTopic'],
          },
        },
      },
      getDataForSync: {
        parallel: true,
        desc: 'get staged actions and last commit ID',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      prepareDataForSync: {
        parallel: true,
        desc: 'tag actions with the zero commitId',
        options: {
          params: {
            required: ['db', 'rows', 'zero'],
          },
        },
      },
      hasCommitId: {
        parallel: true,
        desc: 'test if a commitId exists',
        options: {
          params: {
            required: ['db', 'commitId'],
          },
        },
      },
      getLastCommitId: {
        parallel: true,
        desc: 'get the last commitId',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      getPersistFromRange: {
        parallel: true,
        desc: 'get persist actions from a range of commits',
        options: {
          params: {
            required: ['db', 'fromCommitId', 'toCommitId'],
          },
        },
      },
      getAllPersist: {
        parallel: true,
        desc: 'get all persist actions',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      bootstrapActions: {
        parallel: true,
        desc: 'freeze a batch of actions',
        options: {
          params: {
            required: ['db', 'streamId', 'routingKey', 'rename'],
          },
        },
      },
      getZeroActions: {
        parallel: true,
        desc: 'get action ids tagged with the zero commitId',
        options: {
          params: {
            required: ['db'],
          },
        },
      },
      getActionsByIds: {
        parallel: true,
        desc: 'get actions by goblin ids',
        options: {
          params: {
            required: ['db', 'goblinIds'],
          },
        },
      },
      updateActionsAfterSync: {
        parallel: true,
        desc: 'commit for staged actions',
        options: {
          params: {
            required: ['db', 'serverCommitId', 'rows'],
          },
        },
      },
      hasGoblin: {
        parallel: true,
        desc: 'check if a goblin exists',
        options: {
          params: {
            required: ['db', 'goblin'],
          },
        },
      },
      sweep: {
        parallel: true,
        desc: 'sweep old actions (default parameters)',
        options: {
          params: {
            optional: ['dbs'],
          },
        },
      },
      sweepByMaxCount: {
        parallel: true,
        desc: 'sweep old actions for a max of persist [1:10]',
        options: {
          params: {
            optional: ['dbs', 'max'],
          },
        },
      },
    },
  };
};

module.exports.dispose = () => {
  cryo.dispose();
};
