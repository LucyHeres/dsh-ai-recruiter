'use strict'

// 极简 WebSocket (RFC 6455) 服务端。
// 只实现网关用得到的部分：文本帧、ping/pong、close、分片重组。
// 之所以不引 ws 依赖，是为了让插件内置网关保持零依赖，直接 `node gateway.js` 就能跑。

const crypto = require('crypto')
const { EventEmitter } = require('events')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// 协议约定单条 Socket 消息不超过 256KB，这里给一点余量做硬上限。
const MAX_MESSAGE_BYTES = 512 * 1024

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
}

const computeAcceptKey = (key) =>
  crypto.createHash('sha1').update(key + WS_GUID).digest('base64')

const encodeFrame = (opcode, payload) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = null
    this.lastActivityAt = Date.now()

    socket.setNoDelay(true)
    socket.on('data', (chunk) => this._onData(chunk))
    // 关键：对端断开时，HTTP upgrade 之后的 socket 往往只触发 'end'，
    // 'close' 可能一直不来（socket 未处于 flowing 状态）。只监听 'close' 会导致
    // 网关永远发现不了扩展掉线，重连时被误判成"已有连接"。
    socket.on('end', () => {
      this._finish()
      socket.destroy()
    })
    socket.on('close', () => this._finish())
    socket.on('error', (error) => {
      this.emit('error', error)
      this._finish()
    })
  }

  sendText(text) {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, text))
      return true
    } catch (error) {
      this.emit('error', error)
      return false
    }
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value))
  }

  ping() {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)))
    } catch (error) {
      this.emit('error', error)
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, body))
    } catch (error) {
      /* socket 已经不可写，直接销毁 */
    }
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 200).unref?.()
    this._finish()
  }

  _finish() {
    if (this.finished) return
    this.finished = true
    this.closed = true
    this.emit('close')
  }

  _onData(chunk) {
    this.lastActivityAt = Date.now()
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk

    for (;;) {
      const frame = this._readFrame()
      if (!frame) return
      this._handleFrame(frame)
      if (this.closed) return
    }
  }

  // 返回 null 表示缓冲区里还没有完整的一帧
  _readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null

    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f

    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009, 'message too big')
        return null
      }
      length = Number(big)
      offset += 8
    }

    if (length > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too big')
      return null
    }

    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }

    if (buffer.length < offset + length) return null

    let payload = buffer.subarray(offset, offset + length)
    if (maskKey) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
    }

    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        try {
          this.socket.write(encodeFrame(OPCODE.PONG, payload))
        } catch (error) {
          this.emit('error', error)
        }
        return
      case OPCODE.PONG:
        return
      case OPCODE.CLOSE:
        this.close(1000, '')
        return
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        break
      case OPCODE.CONTINUATION:
        if (!this.fragmentOpcode) return
        this.fragments.push(payload)
        break
      default:
        return
    }

    if (!fin) return

    const opcodeUsed = this.fragmentOpcode
    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentOpcode = null

    if (opcodeUsed === OPCODE.BINARY) {
      this.emit('binary', data)
      return
    }
    this.emit('message', data.toString('utf8'))
  }
}

// 把 HTTP upgrade 请求升级成 WebSocket 连接。
const handleUpgrade = (request, socket, head, onConnection, onReject) => {
  const key = request.headers['sec-websocket-key']
  const upgrade = String(request.headers.upgrade || '').toLowerCase()
  if (upgrade !== 'websocket' || !key) {
    onReject?.(socket)
    return
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
      '',
      ''
    ].join('\r\n')
  )

  const connection = new WebSocketConnection(socket)
  if (head && head.length) connection._onData(head)
  onConnection(connection)
}

module.exports = { WebSocketConnection, handleUpgrade, computeAcceptKey }
