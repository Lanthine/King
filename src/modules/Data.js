export default {
  version: 'LKYHFOEIHLSKDJGEG',
  server: 'localhost',
  page: 'home',
  user: {name: ''},
  waiting: {players: 9000, timeout: Date.now()},
  game: {
    playing: false,
    dead: false,
    chat: {asdf: 'qwerty', msg: []},
    deadscreen: {
      spectate: false,
      name: 'name',
      killer: 'killer',
      playtime: 0,
      place: 0,
      kills: 0
    },
    scroll: {
      x: 0,
      y: 0
    }
  },
  state: {serverSocket: '', gameSocket: ''}
}
