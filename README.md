DelimiterStream
===============

Get delimiter-separated (e.g. new line) chunks of data from a Readable Stream, Websocket or other
data source.

### Usage
Primary use case is with a server endpoint that accepts new-line-delimited data:
```
var net = require('net'),
    DelimiterStream = require('delimiterstream'),
    server = net.createServer();
function onSocketLine(line) {
    //line will be a buffer
    console.log('Received line from', this.remoteAddress, line.toString());
}
server.on('connection', function(socket) {
    socket.on('data', DelimiterStream.wrap(onSocketLine, socket));
});
server.listen(9999);
```

It also works with files:
```
var fs = require('fs'),
    DelimiterStream = require('delimiterstream');
fs.readFile('example.csv', DelimiterStream.wrap(function(line) {
    //line will be a Buffer
    console.log(line.toString());
});
```

Methods
-------

### DelimiterStream.wrap(options, callback [, context, args...])
### DelimiterStream.wrap(callback [, context, args...])
Returns a function that calls `callback` with a chunk of data as they are received. If `options`
are passed then you can customize the `delimiter` and `dataLimit`. Delimiter defaults to `\n`.

The chunks will **NOT include the delimiter**.

By [James Hartig](https://github.com/fastest963/)
