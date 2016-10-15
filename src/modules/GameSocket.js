import Data from './Data'
import SS from './ServerSocket'
import Vue from 'vue'
var Schema = require('../../server/Schema')

var ws = {}
var sendQueue = []
Data.state.gameSocket = 'dead'

function start (obj) {
  if (Data.state.gameSocket !== 'dead') return false

  Data.state.gameSocket = 'connecting'
  if (Data.dev.on) {
    ws = new window.WebSocket('ws://' + Data.dev.server + ':' + obj.port)
  } else {
    ws = new window.WebSocket('ws://' + Data.server + '/' + obj.name)
  }

  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    if (ws.connected) return false // already connected

    ws.connected = true
    Data.state.gameSocket = 'ready'

    sendObj({m: 'hi'})
    sendObj({m: 'joinroom', uid: Data.user.id, secret: obj.secret})

    sendQueue.forEach((e, i) => {
      sendObj(e)
    })
  }
  ws.onclose = () => {
    ws.connected = false
    Data.state.gameSocket = 'dead'
    // console.log('GameSocket closed.')
    Data.page = 'home'
    Vue.set(Data.game, 'map', [])
    Vue.set(Data.game, 'leaderboard', [])
    SS.sendObj({m: 'gameover'})
  }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      handleMessage(JSON.parse(e.data))
    } else {
      var buf = new Buffer(e.data, 'binary')
      handleMessage(Schema.unpack(buf))
    }
  }
}

function setLeaderboard (players) {
  Vue.set(Data.game, 'leaderboard', [])
  for (let i = 0; i < players.length; i++) {
    Data.game.leaderboard.push({
      name: players[i].name,
      color: 'hsl(' + players[i].color + ',100%,80%)',
      pid: players[i].pid,
      units: 0,
      blocks: 0
    })
  }
}
function updateLeaderboard () {
  for (let i = 0; i < Data.game.leaderboard.length; i++) {
    Data.game.leaderboard[i].units = 0
    Data.game.leaderboard[i].blocks = 0
  }
  for (let y = 0; y < Data.game.map.length; y++) {
    for (let x = 0; x < Data.game.map[y].length; x++) {
      let cell = Data.game.map[y][x]
      for (let i = 0; i < Data.game.leaderboard.length; i++) {
        if (Data.game.leaderboard[i].pid === cell.owner) {
          Data.game.leaderboard[i].units += cell.units
          Data.game.leaderboard[i].blocks += 1
          break
        }
      }
    }
  }

  Data.game.leaderboard.sort(function (a, b) {
    if (a.units > b.units) return -1
    if (a.units < b.units) return 1
    if (a.blocks > b.blocks) return -1
    if (a.blocks < b.blocks) return 1
    return 0
  })
}

function handleMessage (d) {
  if (d.m === 'welcome') {
    Vue.set(Data.game, 'map', [])
    Vue.set(Data.game, 'players', [])
    Vue.set(Data.game, 'myid', d.pid)

    Data.page = 'game'
    Data.game.playing = true
    Data.game.dead = false
    Data.game.deadscreen.spectate = false
  } else if (d.m === 'map') {
    for (let y = 0; y < d.data.length; y++) {
      if (typeof Data.game.map[y] === 'undefined') Vue.set(Data.game.map, y, [])
      for (let x = 0; x < d.data[y].length; x++) {
        if (typeof Data.game.map[y][x] === 'undefined') {
          Vue.set(Data.game.map[y], x, {units: 0, owner: -1, token: 0, color: 0, movehelp: 0, loc: {x: x, y: y}})
        }

        Vue.set(Data.game.map[y][x], d.type, d.data[y][x])

        // computed values (color)
        if (d.type === 'owner') {
          let id = Data.game.map[y][x].owner

          if (typeof Data.game.players[id] !== 'undefined') {
            // cell has owner

            // compute color
            Data.game.map[y][x].color = 'hsl(' + Data.game.players[id].color + ',100%,50%)'
          } else {
            // un-owned block

            // comput color
            if (Data.game.map[y][x].owner === -2) {
              Data.game.map[y][x].color = 'hsl(0,100%,0%)'
            } else if (Data.game.map[y][x].owner === -1) {
              Data.game.map[y][x].color = 'hsl(0,100%,100%)'
            } else {
              Data.game.map[y][x].color = 'hsl(0,0%,50%)'
            }
          }
        }
      }
    }
    // Update leaderboard
    if (d.type === 'owner') {
      updateLeaderboard()
    }
  } else if (d.m === 'players') {
    d.data.dead = false // inject data into data
    Data.game.players = Object.assign({}, Data.game.players, d.data)
    setLeaderboard(d.data)
  } else if (d.m === 'chat') {
    if (typeof Data.game.players[d.from] !== 'undefined') {
      // Data.game.chat.msg.push('[' + Data.game.players[d.from].name + '] ' + d.message)
      Data.game.chat.msg.push({
        msg: d.message,
        name: Data.game.players[d.from].name,
        color: 'hsl(' + Data.game.players[d.from].color + ',100%,80%)'
      })
    } else {
      // Data.game.chat.msg.push('*' + d.from + '* ' + d.message)
      let color = 'hsl(0,0%,70%)'
      if (d.from === 'Game') color = 'hsl(0,0%,100%)'
      if (d.from === 'God') color = 'hsl(0,100%,50%)'
      Data.game.chat.msg.push({
        msg: d.message,
        name: d.from,
        color: color
      })
    }

    // archive message after 30 seconds
    setTimeout(() => {
      Data.game.chat.history.push(Data.game.chat.msg.shift())
    }, 30000)
  } else if (d.m === 'playerdead') {
    // make sure player exists
    if (typeof Data.game.players[d.pid] !== 'undefined') {
      Data.game.players[d.pid].dead = true
      if (d.pid === Data.game.myid) {
        // you are dead
        Data.game.dead = true
        Data.game.deadscreen.name = Data.game.players[d.pid].name
        Data.game.deadscreen.killer = d.killer
        let time = d.timealive
        time /= 1000 // convert from miliseconds to seconds
        let minutes = Math.floor(time / 60)
        let sec = Math.floor(time % 60)
        if (sec < 10) {
          sec = '0' + sec
        }
        let humantime = minutes + ':' + sec
        Data.game.deadscreen.playtime = humantime
        Data.game.deadscreen.place = d.place
        Data.game.deadscreen.kills = d.kills
      } else {
        // someone else is dead
      }

      // handleMessage({m: 'chat', from: 'Game', message: Data.game.players[d.pid].name + ' was taken over by ' + d.killer})
    }
  } else if (d.m === 'scrollhome') {
    // Call this only when the map is loaded
    let w = window.innerWidth
    let h = window.innerHeight
    let kingloc = {x: Math.floor(Data.game.map.length / 2), y: Math.floor(Data.game.map[0].length / 2)}

    for (let y = 0; y < Data.game.map.length; y++) {
      for (let x = 0; x < Data.game.map[y].length; x++) {
        if (Data.game.map[y][x].owner === Data.game.myid && Data.game.map[y][x].token === 1) {
          kingloc.x = x
          kingloc.y = y
        }
      }
    }

    Data.game.scroll.x = (kingloc.x * 50) - (w / 2) + 25
    Data.game.scroll.x = -Data.game.scroll.x
    Data.game.scroll.y = (kingloc.y * 50) - (h / 2) + 25
    Data.game.scroll.y = -Data.game.scroll.y
  }

  if (typeof d.page !== 'undefined') {
    Data.page = d.page
  }
}

function close () {
  if (Data.state.gameSocket !== 'ready') return false
  ws.close()
}

function sendObj (object, queue = false) {
  if (Data.state.gameSocket !== 'ready') {
    if (queue) {
      sendQueue.push(object)
      // console.log('object added to web socket queue')
    } else {
      console.warn('Game server is not connected.')
      Data.popup.show('Connection', 'You are not connected to the game server!')
    }
    return false
  }
  ws.send(JSON.stringify(object))
}

function sendBinary (binary) {
  if (Data.state.serverSocket !== 'ready') {
    console.warn('WebSocket is not connected.')
    Data.popup.show('Connection', 'You are not connected to the server!')
    return false
  }
  ws.send(binary, { binary: true, mask: true })
}

// short circuit, skip the WebSocket.
function shortObj (object) {
  handleMessage(object)
}

export default {sendObj, shortObj, sendBinary, start, close}
