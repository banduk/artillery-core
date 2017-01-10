/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const WebSocket = require('ws');
const debug = require('debug')('ws');
const engineUtil = require('./engine_util');
const template = engineUtil.template;
const deepEqual = require('deep-equal');

module.exports = WSEngine;

function WSEngine(script) {
  this.config = script.config;
}


function isResponseRequired(spec) {
  return (spec.response);
}

function processResponse(ee, data, response, context, callback) {
  // Do we have supplied data to validate?
  if (response.data && !deepEqual(data, response.data)) {
    debug(data);
    let err = 'data is not valid';
    ee.emit('error', err);
    return callback(err, context);
  }

  // If no capture or match specified, then we consider it a success at this point...
  if (!response.capture && !response.match) {
    return callback(null, context);
  }

  // Construct the (HTTP) response...
  let fauxResponse = {body: JSON.stringify(data)};

  // Handle the capture or match clauses...
  engineUtil.captureOrMatch(response, fauxResponse, context, function(err, result) {
    // Were we unable to invoke captureOrMatch?
    if (err) {
      debug(data);
      ee.emit('error', err);
      return callback(err, context);
    }

    // Do we have any failed matches?
    let haveFailedMatches = _.some(result.matches, function(v, k) {
      return !v.success;
    });

    // How to handle failed matches?
    if (haveFailedMatches) {
      // TODO: Should log the details of the match somewhere
      ee.emit('error', 'Failed match');
      return callback(new Error('Failed match'), context);
    } else {
      // Emit match events...
      _.each(result.matches, function(v, k) {
        ee.emit('match', v.success, {
          expected: v.expected,
          got: v.got,
          expression: v.expression
        });
      });

      // Populate the context with captured values
      _.each(result.captures, function(v, k) {
        context.vars[k] = v;
      });

      // Replace the base object context
      // Question: Should this be JSON object or String?
      context.vars.$ = fauxResponse.body;

      // Increment the success count...
      context._successCount++;

      return callback(null, context);
    }
  });
}

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.emit('response', delta, 0, context._uid);
}

WSEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

WSEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(requestSpec.count || -1, steps);
  }

  if (requestSpec.think) {
    return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
  }

  let f = function(context, callback) {
    ee.emit('request');
    let startedAt = process.hrtime();

    const bufferPayload = requestSpec.send instanceof Buffer;
    let payload = bufferPayload ? requestSpec.send : template(requestSpec.send, context);

    if (!bufferPayload) {
      if (typeof payload === 'object') {
        payload = JSON.stringify(payload);
      } else {
        payload = payload.toString();
      }
    }

    debug('WS send: %s', payload);

    if (isResponseRequired(requestSpec)) {
      let response = {
        data: template(requestSpec.response.data, context),
        capture: template(requestSpec.response.capture, context),
        match: template(requestSpec.response.match, context)
      };
      let done = false;

      context.ws.on('message', function(data) {
        if (!done) {
          done = true;
          processResponse(ee, data, response, context, function(err) {
            if (!err) {
              markEndTime(ee, context, startedAt);
            }
            return callback(err, context);
          });
        }
      });

      context.ws.send(payload, function(err) {
        if (err) {
          debug(err);
          ee.emit('error', err);
        }
      });

      const timeout = requestSpec.timeout || self.config.timeout || 1000;
      setTimeout(() => {
        if (!done) {
          done = true;
          let err = 'response timeout';
          ee.emit('error', err);
          return callback(err, context);
        }
      }, timeout);
    } else {
      context.ws.send(payload, function(err) {
        if (err) {
          debug(err);
          ee.emit('error', err);
        } else {
          markEndTime(ee, context, startedAt);
        }
        return callback(err, context);
      });
    }
  };

  return f;
};

WSEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;

  return function scenario(initialContext, callback) {
    function zero(callback) {
      let tls = config.tls || {}; // TODO: config.tls is deprecated
      let options = _.extend(tls, config.ws);

      ee.emit('started');

      let ws = new WebSocket(config.target, options);
      ws.on('open', function() {
        initialContext.ws = ws;
        return callback(null, initialContext);
      });
      ws.once('error', function(err) {
        debug(err);
        ee.emit('error', err.code);
        return callback(err, {});
      });
    }

    initialContext._successCount = 0;
    initialContext._pendingRequests = _.size(
      _.reject(scenarioSpec, function(rs) {
        return (typeof rs.think === 'number');
      }));

    let steps = _.flatten([
      zero,
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }
        if (context.ws) {
          context.ws.close();
        }
        return callback(err, context);
      });
  };
};
