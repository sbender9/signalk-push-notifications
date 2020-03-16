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

const Bacon = require('baconjs');
const path = require('path')
const fs = require('fs')
const _ = require('lodash')
const AWS = require('aws-sdk');

module.exports = function(app) {
  var unsubscribes = []
  var plugin = {}
  var deviceid
  var last_states = {}
  
  plugin.start = function(props) {
    deviceid = props.deviceid

    var command = {
      context: "vessels.self",
      subscribe: [{
        path: "notifications.*",
        policy: 'instant'
      }]
    }
    
    app.subscriptionmanager.subscribe(command, unsubscribes, subscription_error, got_delta)
    //devices = readJson(app, "devices" , plugin.id)
    //send_push(app, devices[Object.keys(devices)[0]], "Hellow", "some.path")
  };

  function subscription_error(err)
  {
    app.error("error: " + err)
  }

  function got_delta(notification)
  {
    handleNotificationDelta(app, plugin.id,
                            notification,
                            last_states)
  }

  plugin.registerWithRouter = function(router) {
    router.post("/registerDevice", (req, res) => {

      device = req.body
      if ( typeof device.targetArn == 'undefined'
           || typeof device.deviceName == 'undefined'
           || typeof device.accessKey == 'undefined'
           || typeof device.secretAccessKey == 'undefined' )
      {
        app.debug("invalid request: %O", device)
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
        app.debug("invalid request: %O", device)
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
        app.debug("invalid request:%O ", device)
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
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
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


  function handleNotificationDelta(app, id, notification, last_states)
  {
    //app.debug("notification: %O", notification)

    try {
      devices = readJson(app, "devices", id)
    } catch ( err ) {
      if (e.code && e.code === 'ENOENT') {
        //return
      }
      //app.error(err)
    }

    notification.updates.forEach(function(update) {
      update.values.forEach(function(value) {
        if ( value.value != null
             && typeof value.value.message != 'undefined'
             && value.value.message != null )
        {
          if ( (last_states[value.path] == null
                && value.value.state != 'normal')
               || ( last_states[value.path] != null
                    && last_states[value.path] != value.value.state) )
          {
            last_states[value.path] = value.value.state
            app.debug("message: %s", value.value.message)
            _.forIn(devices, function(device, arn) {
              send_push(app, device, value.value.message, value.path, value.value.state)
            })
          }
        }
        else if ( last_states[value.path] )
        {
          delete last_states[value.path]
        }
      })
    })
  }

  function pathForPluginId(app, id, name) {
    var dir = app.config.configPath || app.config.appPath
    return path.join(dir, "/plugin-config-data", id + "-" + name + '.json')
  }

  function readJson(app, name, id) {
    try
    {
      const path = pathForPluginId(app, id, name)
      const optionsAsString = fs.readFileSync(path, 'utf8');
      try {
        return JSON.parse(optionsAsString)
      } catch (e) {
        app.error("Could not parse JSON options:" + optionsAsString);
        return {}
      }
    } catch (e) {
      if (e.code && e.code === 'ENOENT') {
        return {}
      }
      app.error("Could not find options for plugin " + id + ", returning empty options")
      app.error(e.stack)
      return {}
    }
    return JSON.parse()
  }

  function saveJson(app, name, id, json, res)
  {
    fs.writeFile(pathForPluginId(app, id, name), JSON.stringify(json, null, 2),
                 function(err) {
                   if (err) {
                     app.debug(err.stack)
                     app.error(err)
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

  function send_push(app, device, message, path, state)
  {
    if ( message.startsWith('Unknown Seatalk Alarm') ) {
      return
    }

    var sns = new AWS.SNS({
      region: "us-east-1",
      accessKeyId: device.accessKey,
      secretAccessKey: device.secretAccessKey
    });

    message = `${state.charAt(0).toUpperCase() + state.slice(1)}: ${message}`

    aps =  { 'aps': { 'alert': {'body': message}, 'sound': 'default', 'content-available': 1 }, 'path': path, self: app.selfId }                           


    let category = (state === 'normal' ? "alarm_normal" : "alarm")

    if ( state != 'normal' )
    {
      if ( path === "notifications.autopilot.PilotWayPointAdvance" )
      {
        category = 'advance_waypoint'
      }
      else if ( path === 'notifications.anchorAlarm' || path === 'notifications.navigation.anchor')
      {
        category = 'anchor_alarm'
      }
      else if ( path.startsWith('notifications.security.accessRequest') )
      {
        let parts = path.split('.')
        let permissions = parts[parts.length-2]
        category = `access_req_${permissions}`
      }
    } else if ( path === "notifications.autopilot.PilotWayPointAdvance" ) {
      return
    }
    
    aps["aps"]["category"] = category
    
    var payload = {
      default: message,
      APNS: aps,
      APNS_SANDBOX: aps
    };

    // first have to stringify the inner APNS object...
    payload.APNS = JSON.stringify(payload.APNS);
    payload.APNS_SANDBOX = JSON.stringify(payload.APNS_SANDBOX);

    app.debug('sending push to ' + device.targetArn + "payload: " + JSON.stringify(payload, null, 2));
    
    // then have to stringify the entire message payload
    payload = JSON.stringify(payload);

    
    sns.publish({
      Message: payload,
      MessageStructure: 'json',
      TargetArn: device.targetArn
    }, function(err, data) {
      if (err) {
        console.log(err.stack);
        return;
      }
      
      app.debug('push sent');
    });
  }

  return plugin;
}

