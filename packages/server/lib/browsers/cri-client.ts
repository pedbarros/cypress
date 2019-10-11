import debugModule from 'debug'
import _ from 'lodash'

const chromeRemoteInterface = require('chrome-remote-interface')
const errors = require('../errors')

const debugVerbose = debugModule('cypress-verbose:server:browsers:cri-client')
const debugVerboseSend = debugModule('cypress-verbose:server:browsers:cri-client:[-->]')
const debugVerboseReceive = debugModule('cypress-verbose:server:browsers:cri-client:[<--]')

/**
 * Url returned by the Chrome Remote Interface
*/
type websocketUrl = string

/**
 * Enumerations to make programming CDP slightly simpler - provides
 * IntelliSense whenever you use named types.
 */
namespace CRI {
  export type Command =
    'Browser.getVersion' |
    'Page.bringToFront' |
    'Page.captureScreenshot' |
    'Page.navigate' |
    'Page.startScreencast'

  export enum EventNames {
    'Page.screencastFrame'
  }
}

/**
 * Wrapper for Chrome Remote Interface client. Only allows "send" method.
 * @see https://github.com/cyrus-and/chrome-remote-interface#clientsendmethod-params-callback
*/
interface CRIWrapper {
  /**
   * Get the `protocolVersion` supported by the browser.
   */
  getProtocolVersion (): Promise<string>
  /**
   * Rejects if `protocolVersion` is less than the current version.
   * @param protocolVersion CDP version string (ex: 1.3)
   */
  ensureMinimumProtocolVersion(protocolVersion: string): Promise<void>
  /**
   * Sends a command to the Chrome remote interface.
   * @example client.send('Page.navigate', { url })
  */
  send (command: CRI.Command, params?: object):Promise<any>
  /**
   * Resolves with a base64 data URI screenshot.
   */
  takeScreenshot(): Promise<string>
  /**
   * Exposes Chrome remote interface Page domain,
   * buton only for certain actions that are hard to do using "send"
   *
   * @example client.Page.screencastFrame(cb)
  */

  /**
   * Registers callback for particular event.
   * @see https://github.com/cyrus-and/chrome-remote-interface#class-cdp
   */
  on (eventName: CRI.EventNames, cb: Function): void

  /**
   * Calls underlying remote interface client close
  */
  close ():Promise<void>
}

const getMajorMinorVersion = (version: string) => {
  const [major, minor] = version.split('.', 2).map(Number)

  return { major, minor }
}

const maybeDebugCdpMessages = (cri) => {
  if (debugVerboseReceive.enabled) {
    cri._ws.on('message', (data) => {
      data = _
      .chain(JSON.parse(data))
      .tap((data) => {
        const str = _.get(data, 'params.data')

        if (!_.isString(str)) {
          return
        }

        data.params.data = _.truncate(str, {
          length: 100,
          omission: `... [truncated string of total bytes: ${str.length}]`,
        })

        return data
      })
      .value()

      debugVerboseReceive('received CDP message %o', data)
    })

  }

  if (debugVerboseSend.enabled) {
    const send = cri._ws.send

    cri._ws.send = (data, callback) => {
      debugVerboseSend('sending CDP command %o', JSON.parse(data))

      return send.call(cri._ws, data, callback)
    }
  }
}

/**
 * Creates a wrapper for Chrome remote interface client
 * that only allows to use low-level "send" method
 * and not via domain objects and commands.
 *
 * @example create('ws://localhost:...').send('Page.bringToFront')
 */
export { chromeRemoteInterface }

export const create = async (debuggerUrl: websocketUrl): Promise<CRIWrapper> => {
  const cri = await chromeRemoteInterface({
    target: debuggerUrl,
    local: true,
  })

  maybeDebugCdpMessages(cri)

  let cachedProtocolVersionP

  const ensureMinimumProtocolVersion = (protocolVersion: string) : Promise<void> => {
    return getProtocolVersion()
    .then((actual) => {
      const minimum = getMajorMinorVersion(protocolVersion)

      const hasVersion = actual.major > minimum.major
         || (actual.major === minimum.major && actual.minor >= minimum.minor)

      if (!hasVersion) {
        errors.throw('CDP_VERSION_TOO_OLD', protocolVersion, actual)
      }
    })
  }

  const getProtocolVersion = () => {
    if (!cachedProtocolVersionP) {
      cachedProtocolVersionP = cri.send('Browser.getVersion')
      .catch(() => {
        // could be any version <= 1.2
        return { protocolVersion: '0.0' }
      })
      .then(({ protocolVersion }) => {
        return getMajorMinorVersion(protocolVersion)
      })
    }

    return cachedProtocolVersionP
  }

  /**
   * Wrapper around Chrome remote interface client
   * that logs every command sent.
   */
  const client: CRIWrapper = {
    ensureMinimumProtocolVersion,
    getProtocolVersion,
    send: (command: CRI.Command, params?: object):Promise<any> => {
      return cri.send(command, params)
    },
    takeScreenshot: () => {
      return ensureMinimumProtocolVersion('1.3')
      .catch((err) => {
        throw new Error(`Taking a screenshot requires at least Chrome 64.\n\nDetails:\n${err.message}`)
      })
      .then(() => {
        return client.send('Page.captureScreenshot')
        .catch((err) => {
          throw new Error(`The browser responded with an error when Cypress attempted to take a screenshot.\n\nDetails:\n${err.message}`)
        })
      })
      .then(({ data }) => {
        return `data:image/png;base64,${data}`
      })
    },
    on (eventName: CRI.EventNames, cb: Function) {
      debugVerbose('registering CDP on event %o', { eventName })

      return cri.on(eventName, cb)
    },

    close ():Promise<void> {
      return cri.close()
    },
  }

  return client
}