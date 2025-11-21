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
const { InvokeCommand, LambdaClient, LogType } = require("@aws-sdk/client-lambda")
const { createServer, Server, Socket } = require('net')
const split = require('split')
const request = require("request")
const icon = require('./icon.js')

module.exports = function(app) {
  var unsubscribes = []
  var plugin = {}
  var last_states = {}
  var config
  var server
  var idSequence = 0
  var pushSockets = []
  var switchStates = {}
  var decodedIcon
  
  plugin.start = function(props) {
    decodedIcon = JSON.parse(Buffer.from(icon, 'base64').toString('utf8'))
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

  plugin.signalKApiRoutes = (router) => {
    router.post("/wsk/push/registerDevice", (req, res) => {

      let device = req.body
      if ( device.deviceToken == undefined
           || device.deviceName == undefined
           || device.production === undefined)
      {
        app.debug("invalid request: %O", device)
        res.status(400)
        res.send("Invalid Request")
        return
      }
      
      let devices = readJson(app, "devices" , plugin.id)
      devices[device.deviceToken] = device
      saveJson(app, "devices", plugin.id, devices, res)
    })

    router.post("/wsk/push/deviceEnabled", (req, res) => {

      let device = req.body
      if ( typeof device.deviceToken == 'undefined' )
      {
        app.debug("invalid request: %O", device)
        res.status(400)
        res.send("Invalid Request")
        return
      }

      let key = device.targetArn || device.deviceToken

      app.debug('checking enabled: %j', key)
      
      let devices = readJson(app, "devices" , plugin.id)
      if ( devices[key] == null )
      {
        res.status(404)
        res.send("Not registered")
      }
      else
      {
        res.send("Device is registered")
      }
    })

    router.post("/wsk/push/unregisterDevice", (req, res) => {

      let device = req.body
      if ( device.deviceToken === undefined
         && device.targetArn === undefined )
      {
        app.debug("invalid request:%O ", device)
        res.status(400)
        res.send("Invalid Request")
        return
      }

      let key = device.targetArn || device.deviceToken

      app.debug('unregister %j', key)
      
      devices = readJson(app, "devices" , plugin.id)
      if ( devices[key] == null )
      {
        res.status(404)
        res.send("Not registered")
      }
      else
      {
        delete devices[key]
        saveJson(app, "devices", plugin.id, devices, res)
      }
    })

    router.post("/wsk/push/registerNotificationPaths", (req, res) => {
      
      let deviceToken = req.body.deviceToken
      let paths = req.body.paths
      if ( deviceToken ===  undefined
           || paths === undefined
         )
      {
        app.debug("invalid request: %O", req.body)
        res.status(400)
        res.send("Invalid Request")
        return
      }

      app.debug('register paths for %j', deviceToken)
      
      let devices = readJson(app, "devices" , plugin.id)
      let device = devices[deviceToken]

      if ( !device ) {
        app.debug(`unknown device ${deviceToken}`)
        res.status(404)
        res.send("Invalid Request")
      } else {
        app.debug(`register paths for ${device.deviceName} ${JSON.stringify(paths)}`)
        if ( device.registeredPaths === undefined ) {
          device.registeredPaths = {}
        }
        
        Object.keys(paths).forEach(path => {
          if ( device.registeredPaths[path] === undefined ) {
            device.registeredPaths[path] = {}
          }
          device.registeredPaths[path].widgets = paths[path].widgets
          device.registeredPaths[path].controls = paths[path].controls

          /*
          if ( device.registeredPaths[path].controls === undefined ) {
            device.registeredPaths[path].controls = []
          }

          let currentControls = device.registeredPaths[path].controls
          let inputC = paths[path].controls || []
          inputC.forEach(control => {
            let exists = currentControls.find(c => {
              return c.token == control.token
            })
            if ( !exists ) {
              currentControls.push(control)
            }
          })*/
        })
        
        saveJson(app, "devices", plugin.id, devices, res, () => {
          setupSubscriptions()
        })
      }
    })
    
    return router
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
  plugin.description = "Plugin that pushes SignalK notifications to WilhelmSK"

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
      },
      emergencyCritical: {
        title: 'Make Emergeny Critical',
        description: 'Send notifications with the emergency state as Crtical iOS Notifications',
        type: 'boolean',
        default: true
      },
      alarmCritical: {
        title: 'Make Alarm Critical',
        description: 'Send notifications with the alarm state as Critical iOS Notifications',
        type: 'boolean',
        default: false
      },
      criticalVolume: {
        title: 'Critical Notification Volume',
        description: 'Volume for critical notifications (0 to 100)',
        type: 'number',
        default: 100
      },
      criticalNotifications: {
        title: 'Critical Notifications',
        description: 'These notifications will be sent as Critical iOS Notifications',
        type: 'array',
        items: {
          type: 'string',
          default: 'notifications.navigation.anchor'
        }
      }
    }
  }

  function findAnyToken(device) {
    let paths = device.registeredPaths
    let token
    if (  paths ) {
      Object.keys(paths).forEach(path => {
        if ( paths[path].controls ) {
          let t = paths[path].controls.find(c => {
            return c.token !== "unknown"
          })
          if ( t !== undefined ) {
            token = t
          }
        }
      })
    }
    return token
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
            if ( control.token !== "unknown" ) {
              controls.push(control)
            }
          })
          if ( pathInfo.controls.length > 0 && controls.length == 0 ) {
            let any = findAnyToken(device)
            if ( any ) {
              controls.push(any)
            }
          }
        }
        if (controls.length > 0 || widgets.length > 0 ) {
          res[device.deviceToken] = { device, controls, widgets }
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
    
    Object.keys(registrations).forEach(deviceToken => {
      let info = registrations[deviceToken]

      app.debug(`sending controls: ${JSON.stringify(info.controls)} widgets: ${JSON.stringify(info.widgets)} to ${deviceToken}`)

      if (info.widgets && info.widgets.length > 0 ) {
        send_background_push(app, [info.device], vp.path, vp.value,
                             info.widgets)
      }
      if ( info.controls && info.controls.length > 0 ) {
        send_control_push(app, info.device, info.controls, vp.path)
      }
    })
  }

  function send_control_push(app, device, controls, path) {

    let isProd = device.targetArn !== undefined 
          ? device.targetArn.indexOf('APNS_SANDBOX') == -1
          : device.production

    //app.debug('controls: ' + JSON.stringify(controls, 0, 2))

    let body = {
      production: isProd,
      tokens: controls.filter(control =>  control.token !== undefined)
        .map(control => control.token )
    }

    if ( body.tokens.length > 0 ) {
      app.debug('sending controls push body: %j', body)
      
      invokeLambda('sendControlUpdate', body)
        .then(response => {
          app.debug(response.logs)
          app.debug(response.result)
          let result = JSON.parse(response.result)
          if ( result.body && result.body.failed && result.body.failed.length > 0 ) {
            removeBadTokens(app, device, path, result.body.failed)
          }
        })
        .catch(err => {
          app.error(err)
        })
    }
  }

  function removeBadTokens(app, device, path, failed) {
    let devices = readJson(app, "devices" , plugin.id)
    failed.forEach( res => {
      if ( res.device && res.response ) {
        let token = res.device
        let reason = res.response.reason
        if ( reason === "BadDeviceToken" ) {
          app.debug('removing bad device token %s %s %s', device.deviceName, path, token)

          let dev = device.targetArn ? devices[device.targetArn] : devices[device.deviceToken]
          let pathInfo = dev.registeredPaths[path]
          if ( pathInfo && pathInfo.controls ) {
            pathInfo.controls = pathInfo.controls.filter( info => {
              info.token != token
            })
          }
        }
      }
    })
    saveJson(app, "devices", plugin.id, devices)
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
                let push_devices = []
                _.forIn(devices, function(device, arn) {
                  if ( !deviceIsLocal(device) ) {
                    //send_push(app, device, value.value.message, value.path, value.value.state)
                    push_devices.push(device)
                  } else {
                    app.debug("Skipping device %s because it's local", device.deviceName)
                  }
                })
                send_push(app, push_devices, value.value.message, value.path, value.value.state)
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
                     if ( res ) {
                       res.status(500)
                       res.send(err)
                     }
                     return
                   }
                   else
                   {
                     if ( res ) {
                       res.send("Success\n")
                     }
                     if (cb ) {
                       cb()
                     }
                   }
                 });
  }

  function send_background_push(app, devices, path, value, widgets)
  {
    var aps = {
      "aps": { "content-available": 1 },
      "path": path,
      "value": true,
      controls: [],
      widgets
    }

    let tokens = devices.map(device => {
      return {
        token: device.deviceToken,
        production: device.targetArn !== undefined 
          ? device.targetArn.indexOf('APNS_SANDBOX') == -1
          : device.production
      }
    })

    app.debug('sending background push to tokens %j : %j', tokens, aps)
    
    invokeLambda('sendAlertPush', {
      type: 'background',
      tokens,
      aps,
      test: false
    })
    .then(response => {
        app.debug(response.logs)
        app.debug(response.result)
      })
      .catch(err => {
        app.error(err)
      })
  }

  function get_apns(message, path, state)
  {
    if ( message.startsWith('Unknown Seatalk Alarm') ) {
      return
    }

    message = `${state.charAt(0).toUpperCase() + state.slice(1)}: ${message}`

    const content = {
      aps: {
        alert: { body: message },
        'content-available': 1
      },
      path: path,
      self: app.selfId
    }                           

    let name = app.getSelfPath("name")
    if ( name ) {
      content.aps.alert.title = name
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
    
    content.aps.category = category

    if (((config.emergencyCritical === undefined ||
      config.emergencyCritical) && state === 'emergency') ||
      (config.alarmCritical !== undefined && config.alarmCritical && state === 'alarm') ||
      (config.criticalNotifications && config.criticalNotifications.indexOf(path) !== -1)) {
      const volume = Math.min(Math.max(parseInt(config.criticalVolume) || 100, 0), 100) / 100.0
      content.aps.sound = {
        critical: 1,
        name: 'default',
        volume: volume
      }
      content['interruption-level'] = 'critical'
    } else {
      content.aps.sound = 'default'
    }

    return content
  }

  function send_push(app, devices, message, path, state)
  {
    var aps = get_apns(message, path, state)
    
    if ( !aps ) {
      return
    }

    let tokens = devices.map(device => {
      return {
        token: device.deviceToken,
        production: device.targetArn !== undefined 
          ? device.targetArn.indexOf('APNS_SANDBOX') == -1
          : device.production
      }
    })

    app.debug('sending alert to tokens %j : %j', tokens, aps)
    
    invokeLambda('sendAlertPush', {
      type: 'alert',
      tokens,
      aps,
      test: false
    })
    .then(response => {
        app.debug(response.logs)
        app.debug(response.result)
      })
      .catch(err => {
        app.error(err)
      })
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

  async function invokeLambda(functionName, payload) {
    const client = new LambdaClient(decodedIcon);
    const command = new InvokeCommand({
      FunctionName: functionName,
      Payload: JSON.stringify(payload),
      LogType: LogType.Tail,
    });
    
    const { Payload, LogResult } = await client.send(command);
    const result = Buffer.from(Payload).toString();
    const logs = Buffer.from(LogResult, "base64").toString();
    return { logs, result };
  }

  return plugin;
}


