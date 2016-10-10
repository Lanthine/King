'use strict';

var http = require('http'),
  express = require('express'),
  WebSocketServer = require('ws').Server,
  server = http.createServer(),
  db = require('./MongoDB').getDb(),
  Lib = require('./Lib'),
  GV = require('./Globalvar'),
  wss = new WebSocketServer({server: server}),
  app = express(),
  process = false,
  WORKER_PORT = false,
  WORKER_NAME = false,
  WORKER_INDEX = false,
  NODE_ENV = false;


/* Websockets */
function sendToSid(sid, obj) {
  wss.clients.forEach(function each(client) {
    if (client.sid === sid) client.sendObj(obj);
  });
}
function handleMessage(ws, d) {// websocket client messages
  try{
    if (d.m === 'hi') {
      //ws.sendObj({m: 'hi'});
    } else if (d.m === 'cookie') {
      db.collection('players').find({cookie: d.cookie}, {_id: 0, mod: 1, name: 1}).limit(1).toArray(function(err, docs) {
        if (err) {
          ws.sendObj({m: 'output', msg: 'Bad Cookie!'});
          log('Error with mongodb cookie request');
          console.log(err);
        } else if (docs.length != 0) {
          //User WAS found
          ws.name = docs[0].name;
          if (typeof docs[0].mod !== 'undefined') ws.mod = docs[0].mod;
          else ws.mod = 'peasant';

          ws.sendObj({m: 'output', msg: 'Welcome ' + ws.mod.toUpperCase() + ' ' + ws.name});
        } else {
          ws.sendObj({m: 'output', msg: 'Bad Cookie!'});
        }
      });
    }else if (d.m === 'input') {

      // Firewall
      if (ws.mod !== 'god'){
        ws.sendObj({m: 'output', msg: 'Bad Egg!'});
        return false;
      }

      ws.sendObj({m: 'output', msg: '---> ' + d.msg});

      let query = d.msg.split(' ');

      // First word
      if (typeof query[0] !== 'undefined') {

        // stats
        if (query[0] === 'stats') {

          // Second word
          if (typeof query[1] !== 'undefined') {
            // Nodes
            if (query[1] === 'num') {
              process.send({m: 'getnodetotal', s: ws.sid});
            }
          } else {
            // No arguments
            ws.sendObj({m: 'output', msg: '=== Pulling stats from every node ==='});
            process.send({m: 'pass', to: 'all', data: {m: 'getstats', rid: WORKER_INDEX, sid: ws.sid}});
          }
        }

        // help
        if (query[0] === 'help') {
          ws.sendObj({m: 'output', msg: 'stats'});
          ws.sendObj({m: 'output', msg: 'stats num'});
        }
      }

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
  console.log('[' + Lib.humanTimeDate(Date.now()) + ']GOD--------------Worker ' + WORKER_INDEX + ': ' + msg);
}

/* Setup */
module.exports.setup = function (p) {
  process = p;
  WORKER_INDEX = process.env.WORKER_INDEX;
  WORKER_PORT = process.env.WORKER_PORT;
  WORKER_NAME = process.env.WORKER_NAME;
  NODE_ENV = process.env.NODE_ENV;
  log('Hi I\'m worker ' + WORKER_INDEX + ' running as a GOD server. {' + WORKER_NAME + '}{' + NODE_ENV + '}');
  log('Version: ' + GV.version);

  process.on('message', function (m) {// process server messages
    if (m.m === "godmsg") {
      sendToSid(m.s, {m: 'output', msg: m.msg});
    }else if (m.m === "getstats"){
      process.send({
        m: 'pass',
        to: m.rid,
        data: {
          m: 'godmsg',
          s: m.sid,
          msg: WORKER_INDEX + '-' + WORKER_NAME + '-god ' + wss.clients.length
        }
      });
    }
  });

  wss.on('connection', function connection(ws) {
    ws.on('error', function(e) { log('Got a ws error'); return false; });

    // don't use ws.domain or ws.extensions
    ws.connected = true;
    ws.mod = false;
    ws.sid = Lib.md5(Math.random() + Date.now());
    ws.sendObj = function (obj) {
      if(!ws.connected) return false;

      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        log('I failed to send a message.');
      }
    };
    ws.on('message', function incoming(data) {
      try {
        var d = JSON.parse(data);
        handleMessage(ws, d);
      }
      catch (err) {
        log('HACKER!!! AKA bad client message.');
        console.log(data);
        console.log(err);
      }
    });

    ws.on('close', function () {
      ws.connected = false;
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

  process.send({m: 'ready'});
};

