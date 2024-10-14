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
const { SNS } = require('@aws-sdk/client-sns');
const { createServer, Server, Socket } = require('net')
const split = require('split')

module.exports = function(app) {
  var unsubscribes = []
  var plugin = {}
  var last_states = {}
  var config
  var server
  var idSequence = 0
  var pushSockets = []
  var switchStates = {}
  
  plugin.start = function(props) {
    config = props
    setupSubscriptions()
    start_local_server()
  }

  function setupSubscriptions() {
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
    
    var command = {
      context: "vessels.self",
      subscribe: [{
        path: "notifications.*",
        period: 1000
      }]
    }

    let devices = readJson(app, "devices" , plugin.id)
    Object.values(devices).forEach(device => {
      if ( device.registeredPaths ) {
        Object.keys(device.registeredPaths).forEach(path => {
          command.subscribe.push({
            path: path,
            period: 1000
          })
        })
      }
    })

    app.debug('subscription: ' + JSON.stringify(command))

    app.subscriptionmanager.subscribe(command, unsubscribes, subscription_error, got_delta)
  }

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

      let device = req.body
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
      
      let devices = readJson(app, "devices" , plugin.id)
      devices[req.body["targetArn"]] = device
      saveJson(app, "devices", plugin.id, devices, res)
    })

    router.post("/deviceEnabled", (req, res) => {

      let device = req.body
      if ( typeof device.targetArn == 'undefined' )
      {
        app.debug("invalid request: %O", device)
        res.status(400)
        res.send("Invalid Request")
        return
      }
      
      let devices = readJson(app, "devices" , plugin.id)
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

      let device = req.body
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

    router.post("/registerNotificationPaths", (req, res) => {
      
      let targetArn = req.body.targetArn
      let paths = req.body.paths
      if ( targetArn ===  undefined
           || paths === undefined
         )
      {
        app.debug("invalid request: %O", req.body)
        res.status(400)
        res.send("Invalid Request")
        return
      }
      
      let devices = readJson(app, "devices" , plugin.id)
      let stored = devices[targetArn]

      app.debug(`register paths for ${targetArn} ${JSON.stringify(paths)}`)

      if ( !stored ) {
        app.debug(`unknown device ${targetArn}`)
        res.status(404)
        res.send("Invalid Request")
      } else {
        stored.registeredPaths = paths
        saveJson(app, "devices", plugin.id, devices, res, () => {
          setupSubscriptions()
        })
      }
    })

    router.get("/fake", (req, res) => {
      _.forIn(devices, function(device, arn) {
        send_control_push(app, device)
      })
      res.send("FAKE!")
      })
  }
  
  plugin.stop = function() {
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
    
    if (server) {
      server.close()
      server = null
    }
  }
  
  plugin.id = "push-notifications"
  plugin.name = "Push Notifications"
  plugin.description = "Plugin that pushes SignalK notifications to Amazon SNS"

  plugin.schema = {
    title: "Push Notifications",
    properties: {
      enableRemotePush: {
        title: 'Enable Remote Push',
        description: 'Send push notifications via the internet when available',
        type: 'boolean',
        default: true
      },
      localPushSSIDs: {
        title: 'Local Push SSIDs',
        description: 'Comma separated list if Wi-Fi SSIDs where local push should be used',
        type: 'string'
      },
      localPushPort: {
        title: 'Local Push Port',
        description: 'Port on the server used for local push notifications',
        type: 'number',
        default: 3001
      }
    }
  }

  function findRegistrations(path) {
    let res = {}
    let devices = readJson(app, "devices" , plugin.id)
    Object.values(devices).forEach(device => {
      let controls = []
      let widgets = [] 
      
      let paths = device.registeredPaths
      if (  paths ) {
        let pathInfo = paths[path]
        if ( pathInfo && pathInfo.widgets ) {
          Object.values(pathInfo.widgets).forEach(widget => {
            widgets.push(widget)
          })
        }

        if ( pathInfo && pathInfo.controls ) {
          Object.values(pathInfo.controls).forEach(control => {
            controls.push({
              token: control.token,
              kind: control.kind
            })
          })
        }
        if (controls.length > 0 || widgets.length > 0 ) {
          res[device.targetArn] = { device, controls, widgets }
        }
      }
    })
    return res
  }

  function deviceHasAnyControls(device) {
    let res = false
    Object.values(device.registeredPaths).forEach(info => {
      if (info.controls && info.controls.length > 0 ) {
        res = true
      }
    })

    return res
  }

  function handleControlChange(vp) {
    let registrations = findRegistrations(vp.path)

    app.debug(`control changed ${vp.path} = ${vp.value}`)
    
    Object.keys(registrations).forEach(targetArn => {
      let info = registrations[targetArn]
      let controls = info.controls

      if ( controls.length == 0 && deviceHasAnyControls(info.device) ) {
        controls = [ { kind:"com.scottbender.Wilhelm.controls.SetSwitch"} ]
      }
      controls = controls.map(c => c.kind)
      
      app.debug(`sending controls: ${JSON.stringify(controls)} widgets: ${JSON.stringify(info.widgets)} to ${targetArn}`)

      send_backgroup_push(app, info.device, vp.value, vp.value,
                          controls, info.widgets)
    })

    /*

    controls.forEach(info => {
      let isSandbox = info.targetArn.indexOf('APNS_SANDBOX')
      let path = `/3/device/${info.deviceToken}`
      let headers = {
        //':method': 'POST',
        //':path': path,
        authorization: `bearer ${info.token}`,
        "apns-push-type": 'controls',
        "apns-expiration": 0,
        "apns-priority": 10,
        "apns-topic": 'com.scottbender.Wilhelm.push-type.controls',
      }
      let post = { aps : { "content-changed" : true } }
      app.debug(JSON.stringify(headers, 0, 2))

      let host = isSandbox ? 'api.development.push.apple.com' : 'api.push.apple.com'
      let url = `https://${host}${path}`
      app.debug(`url: ${url}`)
      
    })*/
  }

  function handleNotificationDelta(app, id, notification, last_states)
  {
    //app.debug("notification: %O", notification)

    let devices 
    try {
      devices = readJson(app, "devices", id)
    } catch ( err ) {
      if (e.code && e.code === 'ENOENT') {
        //return
      }
      //app.error(err)
    }

    notification.updates.forEach(function(update) {
      if ( update.values === undefined )
        return
      
      update.values.forEach(function(value) {
        if ( value.path != null
             && value.path.startsWith('notifications.') ) {
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
              if ( typeof config.enableRemotePush === 'undefined'
                   || config.enableRemotePush )
              {
                _.forIn(devices, function(device, arn) {
                  if ( !deviceIsLocal(device) ) {
                    send_push(app, device, value.value.message, value.path, value.value.state)
                  } else {
                    app.debug("Skipping device %s because it's local", device.deviceName)
                  }
                })
              }
              send_local_push(value.value.message, value.path, value.value.state)
            }
          }
          else if ( last_states[value.path] )
          {
            delete last_states[value.path]
          }
        } else {
          let last = switchStates[value.path]
          if ( last === undefined || last !== value.value) {
            switchStates[value.path] = value.value
            if (last !== undefined ) {
              handleControlChange(value)
            }
          }
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

  function saveJson(app, name, id, json, res, cb)
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
                     if (cb ) {
                       cb()
                     }
                   }
                 });
  }

  function send_backgroup_push(app, device, path, value, controls, widgets)
  {
    //var aps =   { "aps" : { "content-changed" : 1 } }
    var aps = {
      "aps": { "content-available": 1 },
      "pathUpdate": "path",
      "value": true,
      controls,
      widgets
    }

    var sns = new SNS({
      region: "us-east-1",

      credentials: {
        accessKeyId: device.accessKey,
        secretAccessKey: device.secretAccessKey
      }
    });

    var payload = {
      default: "path changed",
      APNS: aps,
      APNS_SANDBOX: aps
    };

    // first have to stringify the inner APNS object...
    payload.APNS = JSON.stringify(payload.APNS);
    payload.APNS_SANDBOX = JSON.stringify(payload.APNS_SANDBOX);

    app.debug('sending background push to ' + device.targetArn + "payload: " + JSON.stringify(payload, null, 2));
    
    // then have to stringify the entire message payload
    payload = JSON.stringify(payload);
    
    sns.publish({
      Message: payload,
      MessageStructure: 'json',
      MessageAttributes: {
        "AWS.SNS.MOBILE.APNS.PUSH_TYPE": {"DataType":"String","StringValue":"background"},
        "AWS.SNS.MOBILE.APNS.PRIORITY":{"DataType":"String","StringValue":"10"},
        "AWS.SNS.MOBILE.APNS.TOPIC":{"DataType":"String","StringValue":"com.scottbender.Wilhelm"}
      },
      TargetArn: device.targetArn
    }, function(err, data) {
      if (err) {
        console.log(err.stack);
        return;
      }
      
      app.debug('push sent');
    });
  }


  function send_control_push(app, device)
  {
    var aps =   { "aps" : { "content-changed" : 1 } }

    var sns = new SNS({
      region: "us-east-1",

      credentials: {
        accessKeyId: device.accessKey,
        secretAccessKey: device.secretAccessKey
      }
    });

    var payload = {
      default: "control changed",
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
      MessageAttributes: {
        "AWS.SNS.MOBILE.APNS.PUSH_TYPE": {"DataType":"String","StringValue":"controls"},
        "AWS.SNS.MOBILE.APNS.PRIORITY":{"DataType":"String","StringValue":"10"},
        "AWS.SNS.MOBILE.APNS.TOPIC":{"DataType":"String","StringValue":"com.scottbender.Wilhelm.push-type.controls"}
      },
      TargetArn: device.targetArn
    }, function(err, data) {
      if (err) {
        console.log(err.stack);
        return;
      }
      
      app.debug('push sent');
    });
  }

  function get_apns(message, path, state)
  {
    if ( message.startsWith('Unknown Seatalk Alarm') ) {
      return
    }

    message = `${state.charAt(0).toUpperCase() + state.slice(1)}: ${message}`

    aps =  { 'aps': { 'alert': {'body': message}, 'sound': 'default', 'content-available': 1 }, 'path': path, self: app.selfId }                           

    let name = app.getSelfPath("name")
    if ( name ) {
      aps.aps.alert.title = name
    }

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

    return aps
  }

  function send_push(app, device, message, path, state)
  {
    return //FIXME, remove
    var aps = get_apns(message, path, state)
    
    if ( !aps ) {
      return
    }

    var sns = new SNS({
      region: "us-east-1",

      credentials: {
        accessKeyId: device.accessKey,
        secretAccessKey: device.secretAccessKey
      }
    });

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

  function send_local_push(message, path, state)
  {
    var aps = get_apns(message, path, state)
    if ( aps ) {
      if ( aps.aps.alert.title ) {
        aps.aps.alert.title = `${aps.aps.alert.title} (Local)`
      }
      pushSockets.forEach(socket => {
        try {
          socket.write(JSON.stringify(aps) + '\n')
        } catch (err) {
          app.error('error sending: ' + err)
        }
      })
    }
  }

  function start_local_server()
  {
    const port = config.localPushPort || 3001
    server = createServer((socket) => {
      socket.id = idSequence++
      socket.name = socket.remoteAddress + ':' + socket.remotePort
      app.debug('Connected:' + socket.id + ' ' + socket.name)

      socket.on('error', (err) => {
        app.error(err + ' ' + socket.id + ' ' + socket.name)
      })
      socket.on('close', hadError => {
        app.debug('Close:' + hadError + ' ' + socket.id + ' ' + socket.name)
        let idx = pushSockets.indexOf(socket)
        if ( idx != -1 ) {
          pushSockets.splice(idx, 1)
        }
      })

      socket
        .pipe(
          split((s) => {
            if (s.length > 0) {
              try {
                return JSON.parse(s)
              } catch (e) {
                console.log(e.message)
              }
            }
          })
        )
        .on('data', msg => {
          if ( msg.heartbeat ) {
            socket.write('{"heartbeat":true}')
          } else if ( !msg.deviceName || !msg.deviceToken ) {
            app.debug('invalid msg: %j', msg)
            socket.end()
          } else {
            socket.device = msg
            pushSockets.push(socket)
            app.debug('registered device: %j', msg)
          }
        })
        .on('error', (err) => {
          app.error(err)
        })
      socket.on('end', () => {
        app.debug('Ended:' + socket.id + ' ' + socket.name)
      })

      socket.write(JSON.stringify(app.getHello()) + '\n')
      setTimeout(() => {
        if ( !socket.device ) {
          app.debug('closing socket, no registration received')
          socket.end()
        }
      }, 5000)
    })
    
    server.on('listening', () =>
              app.debug('local push server listening on ' + port)
             )
    server.on('error', e => {
      app.error(`local push server error: ${e.message}`)
      app.setProviderError(`can't start local push server ${e.message}`)
    })

    if (process.env.TCPSTREAMADDRESS) {
      app.debug('Binding to ' + process.env.TCPSTREAMADDRESS)
      server.listen(port, process.env.TCPSTREAMADDRESS)
    } else {
      server.listen(port)
    }
  }

  function deviceIsLocal(device) {
    return pushSockets.find(socket => {
      if ( device.deviceToken ) {
        return socket.device.deviceToken == device.deviceToken
      } else {
        return socket.device.deviceName == device.deviceName
      }
    })
  }

  return plugin;
}

