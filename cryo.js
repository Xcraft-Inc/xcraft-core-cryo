'use strict';

const cmd = {};

cmd['do'] = function* (msg, resp) {
  const cryo = require ('.');

  try {
    yield cryo.do (resp);
    resp.events.send (`cryo.do.${msg.id}.finished`);
  } catch (ex) {
    resp.events.send (`cryo.do.${msg.id}.error`, ex.stack || ex);
  }
};

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  return {
    handlers: cmd,
    rc: {
      do: {
        parallel: true,
        desc: '//do some...',
      },
    },
  };
};
