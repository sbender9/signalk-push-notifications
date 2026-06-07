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

/// <reference types="node" />

import { ServerAPI, Plugin, Delta } from '@signalk/server-api'
import { Router, Request, Response } from 'express'
import { Socket, Server, createServer } from 'net'
import path from 'path'
import fs from 'fs'
import * as _ from 'lodash'
import { InvokeCommand, LambdaClient, LogType } from '@aws-sdk/client-lambda'
import split = require('split')
import request = require('request')
import { icon } from './icon'

interface Device {
  deviceToken?: string
  deviceName?: string
  production?: boolean
  targetArn?: string
  accessKey?: string
  secretAccessKey?: string
  registeredPaths?: {
    [path: string]: {
      controls?: Control[]
      widgets?: Widget[]
    }
  }
}

interface Control {
  token?: string
}

interface Widget {
  [key: string]: any
}

interface PushSocket extends Socket {
  id?: number
  device?: Device
  name?: string
}

interface PluginConfig {
  enableRemotePush?: boolean
  localPushSSIDs?: string
  localPushPort?: number
  emergencyCritical?: boolean
  alarmCritical?: boolean
  criticalVolume?: number
  criticalRepeat?: number
  criticalRepeatDurationSeconds?: number
  criticalNotifications?: string[]
}

interface NotificationValue {
  message: string
  state: string
  method?: string[]
  id?: string
}

interface ValuePair {
  path: string
  value: any
}

interface TokenInfo {
  token: string
  production: boolean
}

interface LambdaResponse {
  logs: string
  result: string
}

interface APSAlert {
  body: string
  title?: string
}

interface APSContent {
  aps: {
    alert?: APSAlert
    'content-available'?: number
    category?: string
    sound?: any
  }
  path?: string
  self?: string
  value?: boolean
  controls?: Control[]
  widgets?: Widget[]
  id?: string
  notificationId?: string
  'interruption-level'?: string
}

const start = (app: ServerAPI): Plugin => {
  const unsubscribes: (() => void)[] = []
  const plugin: Plugin = {} as Plugin
  const last_states: { [path: string]: string } = {}
  let config: PluginConfig
  let server: Server | null = null
  let idSequence = 0
  const pushSockets: PushSocket[] = []
  const switchStates: { [path: string]: any } = {}
  let decodedIcon: any
  const repeatingNotifications: { [path: string]: NodeJS.Timeout } = {}

  plugin.start = function (props: PluginConfig) {
    decodedIcon = JSON.parse(Buffer.from(icon, 'base64').toString('utf8'))
    config = props
    setupSubscriptions()
    start_local_server()
  }

  function setupSubscriptions(): void {
    unsubscribes.forEach(function (func) {
      func()
    })
    unsubscribes.length = 0

    const command: any = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'notifications.*',
          period: 1000
        }
      ]
    }

    const devices = readJson(app, 'devices', plugin.id)
    Object.values(devices).forEach((device: Device) => {
      if (device.registeredPaths) {
        Object.keys(device.registeredPaths).forEach((path) => {
          command.subscribe.push({
            path: path,
            period: 1000
          })
        })
      }
    })

    app.debug('subscription: ' + JSON.stringify(command))

    app.subscriptionmanager.subscribe(
      command,
      unsubscribes,
      subscription_error,
      got_delta
    )
  }

  function subscription_error(err: any): void {
    app.error('error: ' + err)
  }

  function got_delta(notification: Delta): void {
    handleNotificationDelta(app, plugin.id, notification, last_states)
  }

  plugin.signalKApiRoutes = (router: Router): Router => {
    router.post('/wsk/push/registerDevice', (req: Request, res: Response) => {
      const device: Device = req.body
      if (
        device.deviceToken === undefined ||
        device.deviceName === undefined ||
        device.production === undefined
      ) {
        app.debug('invalid request: %O', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const devices = readJson(app, 'devices', plugin.id)
      devices[device.deviceToken] = device
      saveJson(app, 'devices', plugin.id, devices, res)
    })

    router.post('/wsk/push/deviceEnabled', (req: Request, res: Response) => {
      const device: Device = req.body
      if (typeof device.deviceToken === 'undefined') {
        app.debug('invalid request: %O', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const key = device.targetArn || device.deviceToken!

      app.debug('checking enabled: %j', key)

      const devices = readJson(app, 'devices', plugin.id)
      if (devices[key] == null) {
        res.status(404)
        res.send('Not registered')
      } else {
        res.send('Device is registered')
      }
    })

    router.post('/wsk/push/unregisterDevice', (req: Request, res: Response) => {
      const device: Device = req.body
      if (device.deviceToken === undefined && device.targetArn === undefined) {
        app.debug('invalid request:%O ', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const key = device.targetArn || device.deviceToken!

      app.debug('unregister %j', key)

      const devices = readJson(app, 'devices', plugin.id)
      if (devices[key] == null) {
        res.status(404)
        res.send('Not registered')
      } else {
        delete devices[key]
        saveJson(app, 'devices', plugin.id, devices, res)
      }
    })

    router.post(
      '/wsk/push/registerNotificationPaths',
      (req: Request, res: Response) => {
        const deviceToken = req.body.deviceToken
        const paths = req.body.paths
        if (deviceToken === undefined || paths === undefined) {
          app.debug('invalid request: %O', req.body)
          res.status(400)
          res.send('Invalid Request')
          return
        }

        app.debug('register paths for %j', deviceToken)

        const devices = readJson(app, 'devices', plugin.id)
        const device = devices[deviceToken]

        if (!device) {
          app.debug(`unknown device ${deviceToken}`)
          res.status(404)
          res.send('Invalid Request')
        } else {
          app.debug(
            `register paths for ${device.deviceName} ${JSON.stringify(paths)}`
          )
          if (device.registeredPaths === undefined) {
            device.registeredPaths = {}
          }

          Object.keys(paths).forEach((path) => {
            if (device.registeredPaths![path] === undefined) {
              device.registeredPaths![path] = {}
            }
            device.registeredPaths![path].widgets = paths[path].widgets
            device.registeredPaths![path].controls = paths[path].controls
          })

          saveJson(app, 'devices', plugin.id, devices, res, () => {
            setupSubscriptions()
          })
        }
      }
    )

    return router
  }

  plugin.registerWithRouter = function (router: Router): void {
    router.post('/registerDevice', (req: Request, res: Response) => {
      const device: Device = req.body
      if (
        typeof device.targetArn === 'undefined' ||
        typeof device.deviceName === 'undefined' ||
        typeof device.accessKey === 'undefined' ||
        typeof device.secretAccessKey === 'undefined'
      ) {
        app.debug('invalid request: %O', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const devices = readJson(app, 'devices', plugin.id)
      devices[req.body.targetArn] = device
      saveJson(app, 'devices', plugin.id, devices, res)
    })

    router.post('/deviceEnabled', (req: Request, res: Response) => {
      const device: Device = req.body
      if (typeof device.targetArn === 'undefined') {
        app.debug('invalid request: %O', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const devices = readJson(app, 'devices', plugin.id)
      if (devices[req.body.targetArn] == null) {
        res.status(404)
        res.send('Not registered')
      } else {
        res.send('Device is registered')
      }
    })

    router.post('/unregisterDevice', (req: Request, res: Response) => {
      const device: Device = req.body
      if (typeof device.targetArn === 'undefined') {
        app.debug('invalid request:%O ', device)
        res.status(400)
        res.send('Invalid Request')
        return
      }

      const arn = req.body.targetArn
      const devices = readJson(app, 'devices', plugin.id)
      if (devices[arn] == null) {
        res.status(404)
        res.send('Not registered')
      } else {
        delete devices[arn]
        saveJson(app, 'devices', plugin.id, devices, res)
      }
    })
  }

  plugin.stop = function (): void {
    unsubscribes.forEach(function (func) {
      func()
    })
    unsubscribes.length = 0

    Object.values(repeatingNotifications).forEach((timer) => {
      clearInterval(timer)
    })

    if (server) {
      server.close()
      server = null
    }
  }

  plugin.id = 'push-notifications'
  plugin.name = 'Push Notifications'
  plugin.description = 'Plugin that pushes SignalK notifications to WilhelmSK'

  plugin.schema = {
    title: 'Push Notifications',
    properties: {
      enableRemotePush: {
        title: 'Enable Remote Push',
        description: 'Send push notifications via the internet when available',
        type: 'boolean',
        default: true
      },
      localPushSSIDs: {
        title: 'Local Push SSIDs',
        description:
          'Comma separated list if Wi-Fi SSIDs where local push should be used',
        type: 'string'
      },
      localPushPort: {
        title: 'Local Push Port',
        description: 'Port on the server used for local push notifications',
        type: 'number',
        default: 3001
      },
      emergencyCritical: {
        title: 'Make Emergency Critical',
        description:
          'Send notifications with the emergency state as Critical iOS Notifications',
        type: 'boolean',
        default: true
      },
      alarmCritical: {
        title: 'Make Alarm Critical',
        description:
          'Send notifications with the alarm state as Critical iOS Notifications',
        type: 'boolean',
        default: false
      },
      criticalVolume: {
        title: 'Critical Notification Volume',
        description: 'Volume for critical notifications (0 to 100)',
        type: 'number',
        default: 100
      },
      criticalRepeat: {
        title: 'Critical Notification Repeat',
        description:
          'Repeat critical notifications every X seconds, 0 to disable repeat',
        type: 'number',
        default: 0
      },
      criticalRepeatDurationSeconds: {
        title: 'Critical Notification Repeat Duration',
        description:
          'Repeat critical notifications duration (seconds), 0 to repeat until cleared, max 3 minutes',
        type: 'number',
        default: 0
      },
      criticalNotifications: {
        title: 'Critical Notifications',
        description:
          'These notifications will be sent as Critical iOS Notifications',
        type: 'array',
        items: {
          type: 'string',
          default: 'notifications.navigation.anchor'
        }
      }
    }
  }

  function findAnyToken(device: Device): Control | undefined {
    const paths = device.registeredPaths
    let token: Control | undefined
    if (paths) {
      Object.keys(paths).forEach((path) => {
        if (paths[path].controls) {
          const t = paths[path].controls!.find((c) => {
            return c.token !== 'unknown'
          })
          if (t !== undefined) {
            token = t
          }
        }
      })
    }
    return token
  }

  function findRegistrations(path: string): {
    [deviceToken: string]: {
      device: Device
      controls: Control[]
      widgets: Widget[]
    }
  } {
    const res: {
      [deviceToken: string]: {
        device: Device
        controls: Control[]
        widgets: Widget[]
      }
    } = {}
    const devices = readJson(app, 'devices', plugin.id)
    Object.values(devices).forEach((device: Device) => {
      const controls: Control[] = []
      const widgets: Widget[] = []

      const paths = device.registeredPaths
      if (paths) {
        const pathInfo = paths[path]
        if (pathInfo && pathInfo.widgets) {
          Object.values(pathInfo.widgets).forEach((widget) => {
            widgets.push(widget)
          })
        }

        if (pathInfo && pathInfo.controls) {
          Object.values(pathInfo.controls).forEach((control) => {
            if (control.token !== 'unknown') {
              controls.push(control)
            }
          })
          if (pathInfo.controls.length > 0 && controls.length === 0) {
            const any = findAnyToken(device)
            if (any) {
              controls.push(any)
            }
          }
        }
        if (controls.length > 0 || widgets.length > 0) {
          res[device.deviceToken!] = { device, controls, widgets }
        }
      }
    })
    return res
  }

  function deviceHasAnyControls(device: Device): boolean {
    let res = false
    if (device.registeredPaths) {
      Object.values(device.registeredPaths).forEach((info) => {
        if (info.controls && info.controls.length > 0) {
          res = true
        }
      })
    }

    return res
  }

  function handleControlChange(vp: ValuePair): void {
    const registrations = findRegistrations(vp.path)

    app.debug(`control changed ${vp.path} = ${vp.value}`)

    Object.keys(registrations).forEach((deviceToken) => {
      const info = registrations[deviceToken]

      app.debug(
        `sending controls: ${JSON.stringify(info.controls)} widgets: ${JSON.stringify(
          info.widgets
        )} to ${deviceToken}`
      )

      if (info.widgets && info.widgets.length > 0) {
        send_background_push(
          app,
          [info.device],
          vp.path,
          vp.value,
          info.widgets
        )
      }
      if (info.controls && info.controls.length > 0) {
        send_control_push(app, info.device, info.controls, vp.path)
      }
    })
  }

  function send_control_push(
    app: ServerAPI,
    device: Device,
    controls: Control[],
    path: string
  ): void {
    const isProd =
      device.targetArn !== undefined
        ? device.targetArn.indexOf('APNS_SANDBOX') === -1
        : device.production

    const body = {
      production: isProd,
      tokens: controls
        .filter((control) => control.token !== undefined)
        .map((control) => control.token)
    }

    if (body.tokens.length > 0) {
      app.debug('sending controls push body: %j', body)

      invokeLambda('sendControlUpdate', body)
        .then((response) => {
          app.debug(response.logs)
          app.debug(response.result)
          const result = JSON.parse(response.result)
          if (
            result.body &&
            result.body.failed &&
            result.body.failed.length > 0
          ) {
            removeBadTokens(app, device, path, result.body.failed)
          }
        })
        .catch((err) => {
          app.error(err)
        })
    }
  }

  function removeBadTokens(
    app: ServerAPI,
    device: Device,
    path: string,
    failed: any[]
  ): void {
    const devices = readJson(app, 'devices', plugin.id)
    failed.forEach((res) => {
      if (res.device && res.response) {
        const token = res.device
        const reason = res.response.reason
        if (reason === 'BadDeviceToken') {
          app.debug(
            'removing bad device token %s %s %s',
            device.deviceName,
            path,
            token
          )

          const dev = device.targetArn
            ? devices[device.targetArn]
            : devices[device.deviceToken!]
          const pathInfo = dev.registeredPaths![path]
          if (pathInfo && pathInfo.controls) {
            pathInfo.controls = pathInfo.controls.filter((info) => {
              return info.token !== token
            })
          }
        }
      }
    })
    saveJson(app, 'devices', plugin.id, devices)
  }

  function handleNotificationDelta(
    app: ServerAPI,
    id: string,
    notification: Delta,
    last_states: { [path: string]: string }
  ): void {
    let devices: { [key: string]: Device }
    try {
      devices = readJson(app, 'devices', id)
    } catch (err: any) {
      if (err.code && err.code === 'ENOENT') {
        devices = {}
      } else {
        throw err
      }
    }

    notification.updates.forEach(function (update: any) {
      if (update.values === undefined) return

      update.values.forEach(function (value: ValuePair) {
        if (value.path != null && value.path.startsWith('notifications.')) {
          const notificationValue = value.value as NotificationValue
          if (
            notificationValue != null &&
            typeof notificationValue.message !== 'undefined' &&
            notificationValue.message != null &&
            notificationValue.method != undefined &&
            notificationValue.method.length > 0
          ) {
            if (
              (last_states[value.path] == null &&
                notificationValue.state !== 'normal' &&
                notificationValue.state !== 'nominal') ||
              (last_states[value.path] != null &&
                last_states[value.path] !== notificationValue.state)
            ) {
              const lastState = last_states[value.path]
              last_states[value.path] = notificationValue.state
              app.debug('message: %s', notificationValue.message)
              const push_devices: Device[] = []
              if (
                typeof config.enableRemotePush === 'undefined' ||
                config.enableRemotePush
              ) {
                _.forIn(devices, function (device: Device) {
                  if (!deviceIsLocal(device)) {
                    push_devices.push(device)
                  } else {
                    app.debug(
                      'Skipping device %s because it is local',
                      device.deviceName
                    )
                  }
                })
                send_push(
                  app,
                  push_devices,
                  notificationValue.message,
                  value.path,
                  notificationValue.state,
                  notificationValue,
                  lastState
                )
              }
              send_local_push(
                notificationValue.message,
                value.path,
                notificationValue.state,
                notificationValue,
                lastState
              )
              if (
                config.criticalRepeat !== undefined &&
                config.criticalRepeat > 0 &&
                isCriticalNotification(value.path, notificationValue.state)
              ) {
                start_critical_repeat_notification(push_devices, value)
              } else if (repeatingNotifications[value.path]) {
                clearInterval(repeatingNotifications[value.path])
                delete repeatingNotifications[value.path]
              }
            } else if (
              last_states[value.path] &&
              repeatingNotifications[value.path] &&
              notificationValue.method &&
              notificationValue.method.indexOf('sound') === -1
            ) {
              clearInterval(repeatingNotifications[value.path])
              delete repeatingNotifications[value.path]
            }
          } else if (last_states[value.path]) {
            delete last_states[value.path]
          }
        } else {
          const last = switchStates[value.path]
          if (last === undefined || last !== value.value) {
            switchStates[value.path] = value.value
            if (last !== undefined) {
              handleControlChange(value)
            }
          }
        }
      })
    })
  }

  function start_critical_repeat_notification(
    devices: Device[],
    value: ValuePair
  ): void {
    const repeatKey = value.path
    if (repeatingNotifications[repeatKey] === undefined) {
      const duration = config.criticalRepeatDurationSeconds || 0
      const startTime = Date.now()

      const limitedDuration = duration > 180 ? 180 : duration

      const interval = setInterval(() => {
        const now = Date.now()
        if (limitedDuration > 0 && now - startTime > limitedDuration * 1000) {
          clearInterval(repeatingNotifications[repeatKey])
          delete repeatingNotifications[repeatKey]
        } else {
          const notificationValue = value.value as NotificationValue
          app.debug('repeating critical notification %s', repeatKey)
          send_push(
            app,
            devices,
            notificationValue.message,
            value.path,
            notificationValue.state,
            notificationValue,
            undefined
          )
          send_local_push(
            notificationValue.message,
            value.path,
            notificationValue.state,
            notificationValue,
            undefined
          )
        }
      }, config.criticalRepeat! * 1000)

      repeatingNotifications[repeatKey] = interval
    }
  }

  function pathForPluginId(app: ServerAPI, id: string, name: string): string {
    const dir = (app as any).config.configPath || (app as any).config.appPath
    return path.join(dir, '/plugin-config-data', id + '-' + name + '.json')
  }

  function readJson(
    app: ServerAPI,
    name: string,
    id: string
  ): { [key: string]: Device } {
    try {
      const filePath = pathForPluginId(app, id, name)
      const optionsAsString = fs.readFileSync(filePath, 'utf8')
      try {
        return JSON.parse(optionsAsString)
      } catch (e: any) {
        app.error('Could not parse JSON options:' + optionsAsString)
        return {}
      }
    } catch (e: any) {
      if (e.code && e.code === 'ENOENT') {
        return {}
      }
      app.error(
        'Could not find options for plugin ' + id + ', returning empty options'
      )
      app.error(e.stack)
      return {}
    }
  }

  function saveJson(
    app: ServerAPI,
    name: string,
    id: string,
    json: any,
    res?: Response,
    cb?: () => void
  ): void {
    fs.writeFile(
      pathForPluginId(app, id, name),
      JSON.stringify(json, null, 2),
      function (err) {
        if (err) {
          app.debug((err as any).stack || err.toString())
          app.error(err.message || err.toString())
          if (res) {
            res.status(500)
            res.send(err.message || err)
          }
          return
        } else {
          if (res) {
            res.send('Success\n')
          }
          if (cb) {
            cb()
          }
        }
      }
    )
  }

  function send_background_push(
    app: ServerAPI,
    devices: Device[],
    path: string,
    value: any,
    widgets: Widget[]
  ): void {
    const aps: APSContent = {
      aps: { 'content-available': 1 },
      path: path,
      value: true,
      controls: [],
      widgets
    }

    const tokens: TokenInfo[] = devices.map((device) => {
      return {
        token: device.deviceToken!,
        production:
          device.targetArn !== undefined
            ? device.targetArn.indexOf('APNS_SANDBOX') === -1
            : device.production!
      }
    })

    app.debug('sending background push to tokens %j : %j', tokens, aps)

    invokeLambda('sendAlertPush', {
      type: 'background',
      tokens,
      aps,
      test: false
    })
      .then((response) => {
        app.debug(response.logs)
        app.debug(response.result)
      })
      .catch((err) => {
        app.error(err)
      })
  }

  function isCriticalNotification(path: string, state: string): boolean {
    const isEmergency =
      (config.emergencyCritical === undefined || config.emergencyCritical) &&
      state === 'emergency'
    const isAlarm =
      config.alarmCritical !== undefined &&
      config.alarmCritical &&
      state === 'alarm'
    const isCritical = config.criticalNotifications
      ? config.criticalNotifications.indexOf(path) !== -1
      : false
    return isEmergency || isAlarm || isCritical
  }

  function get_apns(
    message: string,
    path: string,
    state: string,
    notificationId?: string,
    lastState?: string
  ): APSContent | undefined {
    if (message.startsWith('Unknown Seatalk Alarm')) {
      return
    }

    const formattedMessage = `${state.charAt(0).toUpperCase() + state.slice(1)}: ${message}`

    const content: APSContent = {
      aps: {
        alert: { body: formattedMessage },
        'content-available': 1
      },
      path: path,
      self: (app as any).selfId,
      notificationId: notificationId
    }

    const name = (app as any).getSelfPath('name')
    if (name) {
      content.aps.alert!.title = name
    }

    let category = state === 'normal' ? 'alarm_normal' : 'alarm'

    if (state !== 'normal') {
      if (path === 'notifications.autopilot.PilotWayPointAdvance') {
        category = 'advance_waypoint'
      } else if (
        path === 'notifications.anchorAlarm' ||
        path === 'notifications.navigation.anchor'
      ) {
        category = 'anchor_alarm'
      } else if (path.startsWith('notifications.security.accessRequest')) {
        const parts = path.split('.')
        const permissions = parts[parts.length - 2]
        category = `access_req_${permissions}`
      }
    } else if (path === 'notifications.autopilot.PilotWayPointAdvance') {
      return
    }

    content.aps.category = category

    if (
      isCriticalNotification(path, state) ||
      ((state === 'normal' || state === 'nominal') &&
        lastState &&
        isCriticalNotification(path, lastState))
    ) {
      const volume =
        Math.min(
          Math.max(parseInt(String(config.criticalVolume)) || 100, 0),
          100
        ) / 100.0
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

  function send_push(
    app: ServerAPI,
    devices: Device[],
    message: string,
    path: string,
    state: string,
    value: NotificationValue,
    lastState?: string
  ): void {
    const aps = get_apns(message, path, state, value.id, lastState)

    if (!aps) {
      return
    }

    const tokens: TokenInfo[] = devices.map((device) => {
      return {
        token: device.deviceToken!,
        production:
          device.targetArn !== undefined
            ? device.targetArn.indexOf('APNS_SANDBOX') === -1
            : device.production!
      }
    })

    app.debug('sending alert to tokens %j : %j', tokens, aps)

    invokeLambda('sendAlertPush', {
      type: 'alert',
      tokens,
      aps,
      test: false,
      id: value.id,
      clear:
        (state === 'normal' || state === 'nominal') &&
        lastState &&
        isCriticalNotification(path, lastState)
    })
      .then((response) => {
        app.debug(response.logs)
        app.debug(response.result)
      })
      .catch((err) => {
        app.error(err)
      })
  }

  function send_local_push(
    message: string,
    path: string,
    state: string,
    value: NotificationValue,
    lastState?: string
  ): void {
    const aps = get_apns(message, path, state, value.id, lastState)
    if (aps) {
      aps.id = value.id
      if (aps.aps.alert?.title) {
        aps.aps.alert.title = `${aps.aps.alert.title} (Local)`
      }
      pushSockets.forEach((socket) => {
        try {
          socket.write(JSON.stringify(aps) + '\n')
        } catch (err) {
          app.error('error sending: ' + err)
        }
      })
    }
  }

  function start_local_server(): void {
    const port = config.localPushPort || 3001
    server = createServer((socket: PushSocket) => {
      socket.id = idSequence++
      socket.name = socket.remoteAddress + ':' + socket.remotePort
      app.debug('Connected:' + socket.id + ' ' + socket.name)

      socket.on('error', (err) => {
        app.error(err + ' ' + socket.id + ' ' + socket.name)
      })
      socket.on('close', (hadError) => {
        app.debug('Close:' + hadError + ' ' + socket.id + ' ' + socket.name)
        const idx = pushSockets.indexOf(socket)
        if (idx !== -1) {
          pushSockets.splice(idx, 1)
        }
      })

      socket
        .pipe(
          split((s: string) => {
            if (s.length > 0) {
              try {
                return JSON.parse(s)
              } catch (e) {
                console.log((e as Error).message)
              }
            }
          })
        )
        .on('data', (msg) => {
          if (msg.heartbeat) {
            socket.write('{"heartbeat":true}')
          } else if (!msg.deviceName || !msg.deviceToken) {
            app.debug('invalid msg: %j', msg)
            socket.end()
          } else {
            socket.device = msg
            pushSockets.push(socket)
            app.debug('registered device: %j', msg)
          }
        })
        .on('error', (err) => {
          app.error(err.message || err.toString())
        })
      socket.on('end', () => {
        app.debug('Ended:' + socket.id + ' ' + socket.name)
      })

      socket.write(JSON.stringify((app as any).getHello()) + '\n')
      setTimeout(() => {
        if (!socket.device) {
          app.debug('closing socket, no registration received')
          socket.end()
        }
      }, 5000)
    })

    server.on('listening', () =>
      app.debug('local push server listening on ' + port)
    )
    server.on('error', (e) => {
      app.error(`local push server error: ${e.message}`)
      ;(app as any).setProviderError(
        `can't start local push server ${e.message}`
      )
    })

    if (process.env.TCPSTREAMADDRESS) {
      app.debug('Binding to ' + process.env.TCPSTREAMADDRESS)
      server.listen(port, process.env.TCPSTREAMADDRESS)
    } else {
      server.listen(port)
    }
  }

  function deviceIsLocal(device: Device): PushSocket | undefined {
    return pushSockets.find((socket) => {
      if (device.deviceToken) {
        return socket.device?.deviceToken === device.deviceToken
      } else {
        return socket.device?.deviceName === device.deviceName
      }
    })
  }

  async function invokeLambda(
    functionName: string,
    payload: any
  ): Promise<LambdaResponse> {
    const client = new LambdaClient(decodedIcon)
    const command = new InvokeCommand({
      FunctionName: functionName,
      Payload: JSON.stringify(payload),
      LogType: LogType.Tail
    })

    const { Payload, LogResult } = await client.send(command)
    const result = Buffer.from(Payload!).toString()
    const logs = Buffer.from(LogResult!, 'base64').toString()
    return { logs, result }
  }

  return plugin
}

export = start
