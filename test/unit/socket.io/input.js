'use strict';
/*
 * Sets/gets whether client code is being served.
 *
 * @param {Boolean} v whether to serve client code
 * @return {Server|Boolean} self when setting or value when getting
 * @api public
 */

Server.prototype.serveClient = function(v){
  if (!arguments.length) return this._serveClient;
  this._serveClient = v;
  var resolvePath = function(file){
    var filepath = path.resolve(__dirname, './../../', file);
    if (exists(filepath)) {
      return filepath;
    }
    return require.resolve(file);
  };
  if (v && !clientSource) {
    clientSource = read(resolvePath( 'socket.io-client/dist/socket.io.js'), 'utf-8');
    try {
      clientSourceMap = read(resolvePath( 'socket.io-client/dist/socket.io.js.map'), 'utf-8');
    } catch(err) {
      debug('could not load sourcemap file');
    }
  }
  return this;
};
