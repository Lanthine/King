'use strict';

var http = require('http'),
  express = require('express'),
  WebSocketServer = require('ws').Server,
  server = http.createServer(),
  db = require('./MongoDB').getDb(),
  Lib = require('./Lib'),
  GV = require('./Globalvar'),
  Schema = require('./Schema'),
  wss = new WebSocketServer({server: server}),
  app = express(),
  gameRoom = false,
  process = false,
  uptime = Date.now(),
  numConnected = 0,
  WORKER_PORT = false,
  WORKER_NAME = false,
  WORKER_INDEX = false,
  NODE_ENV = false;

var sniffers = {
  list: [],
  add: function(sniffer){
    let alreadySniffing = false;
    this.list.forEach((e,i)=>{
      if (e.sid == sniffer.sid) alreadySniffing = true;
    });

    if(!alreadySniffing){
      this.list.push(sniffer);
      try {
        process.send({
          m: 'pass',
          to: sniffer.rid,
          data: {
            m: 'godmsg',
            s: sniffer.sid,
            msg: '[' + Lib.humanTimeDate(Date.now()) + '] [' + WORKER_INDEX + '-' + WORKER_NAME + '] [server] ' + ' Sniffing Activated!'
          }
        });
      } catch(err) {
        console.log(err);
      }
    }
  },
  remove: function(sniffer){
    for(let i=0; i<this.list.length; i++){
      if (this.list[i].sid == sniffer.sid){
        this.list.splice(i, 1);
        i--;
        try {
          process.send({
            m: 'pass',
            to: sniffer.rid,
            data: {
              m: 'godmsg',
              s: sniffer.sid,
              msg: '[' + Lib.humanTimeDate(Date.now()) + '] [' + WORKER_INDEX + '-' + WORKER_NAME + '] [server] ' + ' Sniffing De-Activated!'
            }
          });
        } catch(err) {
          console.log(err);
        }
      }
    }
  }
};

class Queue {
  static setup(){
    this.resetTimer();
    this.starting = false;
    this.players = {};
  }

  static resetTimer(wait = GV.game.classic.queue.maxwait){
    if (typeof this.timer !== 'undefined') clearTimeout(this.timer);
    this.timeout = Date.now() + wait;
    this.timer = setTimeout(()=>{this.startGame()}, wait);
  }

  static addPlayer(ws){
    // short circuit if player is already in queue or already playing
    if(typeof this.players[ws.data.id] !== 'undefined'){// player is already in queue
      ws.sendObj({m: 'join', v: false, msg: 'You are already waiting in the queue.'});
      return false;
    }else if(ws.playing){// player is marked as currently in a game
      ws.sendObj({m: 'join', v: false, msg: 'You are already playing.'});
      return false;
    }

    // player is eligible
    this.players[ws.data.id] = ws;
    ws.waiting = true;
    ws.sendObj({m: 'join', v: true, timeout: this.timeout, maxplayers: GV.game.classic.queue.maxplayers, minplayers: GV.game.classic.queue.minplayers});
    this.updatePlayers();
    if(this.numPlayers() >= GV.game.classic.queue.maxplayers && this.starting === false){
      this.startGame();
    }
  }

  static removePlayer(ws){
    if(ws.waiting !== true) return false;

    if(typeof this.players[ws.data.id] !== 'undefined'){// player is already in queue
      delete this.players[ws.data.id];
      ws.waiting = false;
      if (ws.connected) ws.sendObj({m: 'canceljoin', v: true});
      this.updatePlayers();
    }
  }

  static numPlayers(){
    let keys = Object.keys(this.players);
    return keys.length;
  }

  static updatePlayers(note = ''){
    let keys = Object.keys(this.players);
    let sendObj = {m: 'joinupdate', players: keys.length, timeout: this.timeout}
    if (note !== '') sendObj.note = note;
    keys.forEach((e,i)=>{
      this.players[e].sendObj(sendObj);
    });
    log(keys.length + '/' + GV.game.classic.queue.maxplayers + ' in queue. Timeout: ' + Lib.humanTimeDiff(Date.now(), this.timeout) + (note === '' ? '':' Note: ' + note));
  }

  static startGame(){
    // hit max players
    // or hit timeout

    // clear timer in case max players is hit before timeout
    clearTimeout(this.timer);

    // too few players?
    if(this.numPlayers() < GV.game.classic.queue.minplayers){
      this.resetTimer();
      if (this.numPlayers() !== 0) this.updatePlayers();
      this.starting = false;
      return false;
    }

    // start game
    // send request

    this.starting = true;

    // maybe wait a second for a game room
    if(gameRoom === false || gameRoom === 'full'){
      setTimeout(()=>{
        this.startGame()
      }, 30000); // Try to start again in 30 seconds
      this.resetTimer(30000);
      this.updatePlayers('full');
      return false;
    }

    // send player to gameroom
    // send gameroom to player
    // set players to playing
    let keys = Object.keys(this.players);
    let numthrough = GV.game.classic.queue.maxplayers
    keys.forEach((e,i)=>{
      if (numthrough <= 0) return false;
      numthrough--;
      let uid = this.players[e].data.id;
      let name = this.players[e].data.name;
      let secret = 's' + Lib.md5(Math.random() + Date.now()) + 'secret';
      process.send({m: 'pass', to: gameRoom.id, data: {m: 'addplayer', uid: uid, secret: secret, name: name}});
      if (NODE_ENV !== 'production')
        this.players[e].sendObj({m: 'joinroom', port: gameRoom.port, secret: secret});
      else
        this.players[e].sendObj({m: 'joinroom', name: gameRoom.name, secret: secret});
      this.players[e].playing = true;
      this.players[e].waiting = false;
      delete this.players[e];
    });

    // reset for next round
    this.starting = false;
    this.resetTimer();
    if (this.numPlayers() !== 0) this.updatePlayers();

    // forget room and request another
    process.send({m: 'pass', to: gameRoom.id, data: {m: 'start'}});
    gameRoom = false;
    process.send({m: 'getroom'});
  }
}

/* Websockets */
function sendPlayerStats(ws) {
  var copy = Lib.deepCopy(ws.data);
  delete copy._id;
  delete copy.cookie;
  delete copy.pastgames;
  ws.sendObj({m: 'stats', data: copy});
}
function sendLeaderboard(ws) {
  db.collection('players').find({lastlogin: {$gt: Date.now() - (1000*60*60*24*7)}}, {_id: 0, name: 1, points: 1}).sort({points: -1}).limit(10).toArray(function(err, docs) {
    if (err) {
      log('Error with mongodb leaderboard request');
      console.log(err);
    } else if (docs.length != 0) {
      //found
      ws.sendObj({m: 'leaderboard', data: docs});
    } else {
      // no leaderboards found
    }
  });
}
function sendTimeoutPing() {
  wss.clients.forEach(function each(client) {
    if (client.timeout === true){
      log('Closing dead client.');
      client.close();
    }else{
      client.timeout = true;
      client.sendObj({m: 'timeout'});
    }
  });
  setTimeout(()=>{
    sendTimeoutPing();
  }, 1000*60*10);// 10 minutes
}
function broadcast(obj) {
  wss.clients.forEach(function each(client) {
    client.sendObj(obj);
  });
}

function handleMessage(ws, d) {// websocket client messages
  try{
    if (d.m === 'hi') {
      //ws.sendObj({m: 'hi'});
    }else if (d.m === 'timeout') {
      ws.timeout = false;
    }else if (d.m === 'version') {
      if(d.version === GV.version){
        ws.compatible = true;
        ws.sendObj({m: 'version', compatible: true});
      } else {
        ws.sendObj({m: 'version', compatible: false});
      }
    }else if (d.m === 'cookie' && ws.compatible) {
      sendLeaderboard(ws);
      db.collection('players').find({cookie: d.cookie}).limit(1).toArray(function(err, docs) {
        if (err) {
          ws.sendObj({m: 'badcookie'});
          log('Error with mongodb cookie request');
          console.log(err);
        } else if (docs.length != 0) {
          //User WAS found
          ws.data = docs[0];

          // update rank on the fly
          db.collection('players').find({points: {$gt: ws.data.points}}).count({}, function (err, count) {
            ws.data.rank = count + 1; // +1 to account for yourself

            // Set login stuff
            sendPlayerStats(ws);
            ws.sendObj({m: 'ready'});
            ws.loggedin = true;

            // Update last login
            db.collection('players').updateOne({id: ws.data.id}, {$set: {lastlogin: Date.now()}}, function(err, result){
              if(err)
                console.log(err);
            });
          });

        } else {
          ws.sendObj({m: 'badcookie'});
        }
      });
    }else if (d.m === 'makecookie' && ws.compatible){
      var freshCookie = 'c' + Lib.md5(Math.random() + Date.now()) + 'cookie';
      var uniqueId = 'u' + Lib.md5(Math.random() + Date.now()) + 'user';
      var player = {
        cookie: freshCookie, // should be kept private, used for login
        id: uniqueId, // can be public
        name: 'Nameless',
        rank: 0,
        points: 100000,
        numplays: 0,
        lastlogin: Date.now(),
        pastgames: []
      };
      db.collection('players').insertOne(player, function(err){
        if(!err)
          ws.sendObj({m: 'makecookie', cookie: freshCookie});
      });
    }else if (d.m === 'setname' && ws.loggedin){
      if(typeof d.name !== 'string'){
        // bad name
        ws.sendObj({m: 'setname', v: false});
      }else{
        if(ws.data.name !== d.name){
          var newname = d.name.slice(0, GV.maxnamelength);

          db.collection('players').updateOne({id: ws.data.id}, {$set: {name: newname}}, function(err, result){
            if (err) {
              console.log(err);
            } else {
              ws.data.name = newname;
              sendPlayerStats(ws);
              sendLeaderboard(ws);
              ws.sendObj({m: 'setname', v: true});
            }
          });
        } else {
          // name is the same
          ws.sendObj({m: 'setname', v: false});
        }
      }
    }else if (d.m === 'join' && ws.loggedin) {
      Queue.addPlayer(ws);
    }else if (d.m === 'canceljoin' && ws.loggedin) {
      Queue.removePlayer(ws);
    }else if (d.m === 'gameover' && ws.loggedin){
      sendLeaderboard(ws);
      // update player status on ws, then send the status to user
      db.collection('players').find({cookie: ws.data.cookie}).limit(1).toArray(function(err, docs) {
        if (err) {
          log('Error with mongodb refresh request');
          console.log(err);
        } else if (docs.length != 0) {
          ws.data = docs[0];
          // update rank on the fly
          db.collection('players').find({points: {$gt: ws.data.points}}).count({}, function (err, count) {
            ws.data.rank = count + 1; // +1 to account for yourself
            sendPlayerStats(ws);
            ws.playing = false;
          });
        }
      });
    }
    // Example broadcast to all nodes
    // process.send({m: 'pass', to: 'server', data: {m: 'broadcast', message: d.message, level: d.level}});
  }catch(err){
    console.log(d);
    console.log(err);
  }
}

/* General */
function log(msg){
  if(typeof msg === 'object') {
    msg = JSON.stringify(msg);
  }
  console.log('[' + Lib.humanTimeDate(Date.now()) + ']S----Worker ' + WORKER_INDEX + ': ' + msg);
  sniffers.list.forEach((e,i)=>{
    try {
      process.send({
        m: 'pass',
        to: e.rid,
        data: {
          m: 'godmsg',
          s: e.sid,
          msg: '[' + Lib.humanTimeDate(Date.now()) + '] [' + WORKER_INDEX + '-' + WORKER_NAME + '] [server] ' + msg
        }
      });
    } catch(err) {
      console.log(err);
    }
  });
}

/* Setup */
module.exports.setup = function (p) {
  process = p;
  WORKER_INDEX = process.env.WORKER_INDEX;
  WORKER_PORT = process.env.WORKER_PORT;
  WORKER_NAME = process.env.WORKER_NAME;
  NODE_ENV = process.env.NODE_ENV;
  log('Hi I\'m worker ' + WORKER_INDEX + ' running as a server. {' + WORKER_NAME + '}{' + NODE_ENV + '}');
  log('Version: ' + GV.version);

  // update for dev server
  if (NODE_ENV === 'development') {
    GV.game.classic.queue.maxwait = 15000; // set wait time to 15 seconds
  }

  process.on('message', function (m) {// process server messages
    if(m.m == 'getroom'){
      if (typeof m.fail === 'undefined') {
        gameRoom = {port: m.port, id: m.id, name: m.name};
      }else{
        gameRoom = 'full';
        setTimeout(()=>{
          process.send({m: 'getroom'});
        }, 30000); // Request another room in 30 seconds
      }
    }else if(m.m === 'broadcast'){
      broadcast(m);
    }else if (m.m === "getstats"){
      try {
        process.send({
          m: 'pass',
          to: m.rid,
          data: {
            m: 'godmsg',
            s: m.sid,
            msg: '[' + WORKER_INDEX + '-' + WORKER_NAME + '] [server]' + ' Uptime:' + Lib.humanTimeDiff(uptime, Date.now()) + ' Clients:' + wss.clients.length + ' numConnected:'  + numConnected +
            ' Waiting:' + Queue.numPlayers() + '/' + GV.game.classic.queue.maxplayers + ' Timeout:' + Lib.humanTimeDiff(Date.now(), Queue.timeout)
          }
        });
      } catch(err) {
        log('I failed to send stats to god.');
        console.log(err);
      }
    }else if (m.m === "sniff"){
      try {
        sniffers.add({rid: m.rid, sid: m.sid});
      } catch(err) {
        log('I failed to add sniffer.');
        console.log(err);
      }
    }else if (m.m === "unsniff"){
      try {
        sniffers.remove({rid: m.rid, sid: m.sid});
      } catch(err) {
        log('I failed to remove sniffer.');
        console.log(err);
      }
    }
  });

  wss.on('connection', function connection(ws) {
    ws.on('error', function(e) { log('Got a ws error'); console.log(e); return false; });

    numConnected++;
    log('Player connected. Total: ' + numConnected);

    // don't use ws.domain or ws.extensions
    ws.connectedtime = Date.now(); // connect time
    ws.timeout = false;
    ws.connected = true;
    ws.compatible = false;
    ws.loggedin = false;
    ws.playing = false;
    ws.waiting = false;
    ws.sendObj = function (obj) {
      if(!ws.connected) return false;

      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        log('I failed to send a message.');
      }
    };
    ws.sendBinary = function(data){
      if(!ws.connected) return false;

      try{
        ws.send(data, {binary: true});
      }catch(err){
        log('I failed to send binary a message.');
        log(err);
      }
    };
    ws.on('message', function incoming(data) {
      try {
        if (typeof data === 'string') {
          handleMessage(ws, JSON.parse(data))
        } else {
          var buf = new Buffer(data, 'binary')
          handleMessage(ws, Schema.unpack(buf))
        }
      }
      catch (err) {
        log('HACKER!!! AKA bad client message.');
        console.log(data);
        console.log(err);
      }
    });

    ws.on('close', function () {
      ws.connected = false;
      numConnected--;
      log('Player disconnected. Total: ' + numConnected + ' Stayed: ' + Lib.humanTimeDiff(ws.connectedtime, Date.now()));
      Queue.removePlayer(ws);
    });

    ws.sendObj({m: 'hi'});
  });

  app.use(function (req, res) {// This is sent when the WebSocket is requested as a web page
    try {
      res.send('WebSocket -_- ' + WORKER_INDEX);
    } catch (err) {
      log('I failed to send a http request.');
      console.log(err);
    }
  });

  server.on('request', app);
  server.listen(WORKER_PORT, function () {
    log( 'I\'m listening on port ' + server.address().port)
  });

  Queue.setup();
  process.send({m: 'ready'});
  process.send({m: 'getroom'});
  sendTimeoutPing();
};

