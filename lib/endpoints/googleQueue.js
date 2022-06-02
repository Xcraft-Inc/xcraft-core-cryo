'use strict';

const watt = require('gigawatts');
const {PubSub} = require('@google-cloud/pubsub');

class GoogleQueue {
  constructor(config) {
    const path = require('path');
    const {resourcesPath} = require('xcraft-core-host');

    this._authFile = path.join(resourcesPath, config.authFile);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = this._authFile;

    this._orderingPrefix = config.orderingPrefix;
    this._topic = config.topic;
    this._pubsubClient = new PubSub();

    watt.wrapAll(this);
  }

  *freeze(resp, msg, results) {
    const message = {
      json: results,
      orderingKey: this._orderingPrefix,
      attributes: {
        origin: 'polypheme',
        publish_timestamp: `${Date.now()}`,
      },
    };

    if (results.timestamp) {
      message.attributes.timestamp = results.timestamp;
    }
    if (results.goblin) {
      message.attributes.goblin = results.goblin;
    }
    if (results.version) {
      message.attributes.version = results.version;
    }

    try {
      yield this._pubsubClient
        .topic(this._topic, {enableMessageOrdering: true})
        .publishMessage(message);
    } catch (ex) {
      resp.log.err(
        `GoogleQueue freeze has failed: ${ex.stack || ex.message || ex}`
      );
    }
  }
}

module.exports = GoogleQueue;
