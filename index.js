/*
 * Copyright 2016 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require('debug')('signalk:push-notifications')
const Bacon = require('baconjs');
const path = require('path')
const util = require('util')
const fs = require('fs')
const _ = require('lodash')
var AWS = require('aws-sdk');

module.exports = function(app) {
  var unsubscribe = undefined
  var plugin = {}
  var deviceid
  
  plugin.start = function(props) {
    debug("starting...")
    deviceid = props.deviceid

    //devices = readJson(app, "devices" , plugin.id)
    //send_push(app, devices[Object.keys(devices)[0]], "Hellow", "some.path")
    
    debug("started")
  };

  plugin.registerWithRouter = function(router) {
    router.post("/registerDevice", (req, res) => {

      device = req.body
      if ( typeof device.targetArn == 'undefined'
           || typeof device.deviceName == 'undefined'
           || typeof device.accessKey == 'undefined'
           || typeof device.secretAccessKey == 'undefined' )
      {
        debug("invalid request: " + util.inspect(device, {showHidden: false, depth: 1}))
        res.status(400)
        res.send("Invalid Request")
        return
      }
      
      devices = readJson(app, "devices" , plugin.id)
      devices[req.body["targetArn"]] = device
      saveJson(app, "devices", plugin.id, devices, res)
    })

    router.post("/deviceEnabled", (req, res) => {

      device = req.body
      if ( typeof device.targetArn == 'undefined' )
      {
        debug("invalid request: " + util.inspect(device, {showHidden: false, depth: 1}))
        res.status(400)
        res.send("Invalid Request")
        return
      }
      
      devices = readJson(app, "devices" , plugin.id)
      if ( devices[req.body["targetArn"]] == null )
      {
        res.status(404)
        res.send("Not registered")
      }
      else
      {
        res.send("Device is registered")
      }
    })

    router.post("/unregisterDevice", (req, res) => {

      device = req.body
      if ( typeof device.targetArn == 'undefined' )
      {
        debug("invalid request: " + util.inspect(device, {showHidden: false, depth: 1}))
        res.status(400)
        res.send("Invalid Request")
        return
      }

      arn = req.body["targetArn"]
      devices = readJson(app, "devices" , plugin.id)
      if ( devices[arn] == null )
      {
        res.status(404)
        res.send("Not registered")
      }
      else
      {
        delete devices[arn]
        saveJson(app, "devices", plugin.id, devices, res)
      }
    })    
  }  
  
  plugin.stop = function() {
    debug("stopping")
    if (unsubscribe) {
      unsubscribe()
    }
    debug("stopped")
  }
  
  plugin.id = "push-notifications"
  plugin.name = "Push Notifications"
  plugin.description = "Plugin that pushes SignalK notifications to Amazon SNS"

  plugin.schema = {
    title: "Push Notifications",
    properties: {
      /*
      devices: {
        type: "array",
        title: " ",
        items: {
          title: "Registered Devices",
          type: "object",
          properties: {
            "deviceName": {
              title: "Device Name",
              type: "string",
            },
            "accessKey": {
              title: "Amazon SNS Access Key",
              type: "string",
            },
            "secretAccessKey": {
              title: "Amazon Secret Access Key",
              type: "string",
            },
            "targetArn": {
              title: "Target Amazon ARN",
              type: "string",
            },
          }
        }
      }
*/
    }
    
  }
  return plugin;
}

function pathForPluginId(app, id, name) {
  return path.join(app.config.appPath, "/plugin-config-data", id + "-" + name + '.json')
}

function readJson(app, name, id) {
  try
  {
    const path = pathForPluginId(app, id, name)
    const optionsAsString = fs.readFileSync(path, 'utf8');
    try {
      return JSON.parse(optionsAsString)
    } catch (e) {
      console.error("Could not parse JSON options:" + optionsAsString);
      return {}
    }
  } catch (e) {
    debug("Could not find options for plugin " + id + ", returning empty options")
    debug(e.stack)
    return {}
  }
  return JSON.parse()
}

function saveJson(app, name, id, json, res)
{
  fs.writeFile(pathForPluginId(app, id, name), JSON.stringify(json, null, 2),
               function(err) {
                 if (err) {
                   debug(err.stack)
                   console.log(err)
                   res.status(500)
                   res.send(err)
                   return
                 }
                 else
                 {
                   res.send("Success\n")
                 }
               });
}

function send_push(app, device, message, path)
{
  var sns = new AWS.SNS({
    region: "us-east-1",
    accessKeyId: device.accessKey,
    secretAccessKey: device.secretAccessKey
  });

  aps =  { 'aps': { 'alert': {'body': message}, 'sound': 'default' }, 'path': path }
  
  var payload = {
    default: message,
    APNS: aps,
    APNS_SANDBOX: aps
  };

  // first have to stringify the inner APNS object...
  payload.APNS = JSON.stringify(payload.APNS);
  payload.APNS_SANDBOX = JSON.stringify(payload.APNS_SANDBOX);  
  // then have to stringify the entire message payload
  payload = JSON.stringify(payload);

  debug('sending push');
  sns.publish({
    Message: payload,
    MessageStructure: 'json',
    TargetArn: device.targetArn
  }, function(err, data) {
    if (err) {
      console.log(err.stack);
      return;
    }
    
    debug('push sent');
  });
}


