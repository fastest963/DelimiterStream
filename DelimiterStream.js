(function(undefined) {
    var root = this,
        isNode = false,
        DelimiterStream, BUFFER_CONSTRUCTOR,
        concatBuffer;
    if (typeof module !== 'undefined' && typeof Buffer !== 'undefined') {
        isNode = true;
        BUFFER_CONSTRUCTOR = Buffer;
        concatBuffer = require('buffer-concat-limit');
    } else {
        BUFFER_CONSTRUCTOR = Array;
        concatBuffer = function(stringArr, newString, limitFromEnd) {
            if (limitFromEnd > 0) {
                var i = stringArr.length,
                    newLen = newString.length;
                if (newLen > limitFromEnd) {
                    return [stringArr.substr(newLen - limitFromEnd, limitFromEnd)];
                }
                while (i-- && newLen < limitFromEnd) {
                    newLen += stringArr[i].length;
                    if (newLen > limitFromEnd) {
                        stringArr[i] = stringArr[i].substr(limitFromEnd - newLen);
                    }
                }
                if (i > 0) {
                    stringArr.splice(0, i);
                }
            }
            stringArr.push(newString);
            return stringArr;
        };
    }

    /**
     * Emit "data" events for each match
     */
    function emitEvents(stream) {
        //if emitEvents gets called while in emitEvents we don't want to screw up the order
        if (stream._emittingMatches) {
            return;
        }

        var matches = stream.matches,
            i = matches.length;
        stream.matches = [];
        stream._emittingMatches = true;
        while (i--) {
            stream.emit('data', matches[i]);
        }
        stream._emittingMatches = false;
        //test to see if someone tried to emit events within emitting events
        if (stream.emitEvents && stream.matches[0] !== undefined) {
            emitEvents(stream);
        }
    }

    /**
     * Handle data from a string stream
     */
    function handleData(stream, asString, data, dataLimit) {
        var dataLen = data.length,
            i = dataLen,
            trailingDataIndex = -1, //index of data after the last delimiter match in data
            lastMatchIndex = 0,
            matchLimit  = dataLimit || Infinity,
            len = 0;

        //first start going back through data to find the last match
        //we do this loop separately so we can just store the index of the last match and then add that to the buffer at the end for the next packet
        while (i--) {
            if (data[i] === stream.delimiter) {
                //now that we found the match, store the index (+1 so we don't store the delimiter)
                trailingDataIndex = i + 1;
                break;
            }
        }

        //if we didn't find a match at all, just push the data onto the buffer
        if (trailingDataIndex === -1) {
            //don't use dataLimit here since we shouldn't pass in infinity to concatBuffer
            stream.buffer = concatBuffer(stream.buffer, data, dataLimit);
            return;
        }
        lastMatchIndex = i;
        while (i--) {
            if (data[i] === stream.delimiter) {
                //make sure we ignore back-to-back delimiters
                len = lastMatchIndex - (i + 1); //i + 1 so we don't include the delimiter we just matched
                if (len > matchLimit) {
                    stream.matches.push(data.slice(lastMatchIndex - matchLimit, lastMatchIndex));
                } else if (len > 0) {
                    stream.matches.push(data.slice(i + 1, lastMatchIndex));
                }
                lastMatchIndex = i;
            }
        }
        //since the loop stops at the beginning of data we need to store the bytes before the first match in the string
        if (lastMatchIndex > 0) {
            stream.buffer = concatBuffer(stream.buffer, data.slice(0, lastMatchIndex), dataLimit);
        }
        //add the leftover buffer to the matches at the end (beginning when we emit events)
        if (asString) {
            if (isNode) {
                stream.matches.push(stream.buffer.toString());
                stream.buffer = new BUFFER_CONSTRUCTOR(0);
            } else {
                stream.matches.push(stream.buffer.splice(0, stream.buffer.length).join(''));
            }
        } else {
            stream.matches.push(stream.buffer);
            stream.buffer = new BUFFER_CONSTRUCTOR(0);
        }

        //todo: optimize this to not make an empty buffer just to fill it with a new thing immediately after
        //make sure the lastMatchIndex isn't the end
        if (lastMatchIndex < dataLen) {
            //don't use dataLimit here since we shouldn't pass in infinity to concatBuffer
            stream.buffer = concatBuffer(stream.buffer, data.slice(trailingDataIndex), dataLimit);
        }

        if (stream.emitEvents) {
            emitEvents(stream);
        }
    }


    if (isNode) {
        var util = require('util'),
            events = require('events'),
            readStringData, readBinaryData;

        /**
         * Read data from a string stream
         */
        readStringData = function() {
            var data = this.readableStream.read();
            if (!data) {
                return;
            }
            handleData(this, true, data, 0);
        };

        /**
         * Read data from a binary stream
         */
        readBinaryData = function() {
            var data = this.readableStream.read();
            if (!data) {
                return;
            }
            handleData(this, false, data, 0);
        };

        /**
         * Encoding should be what you set on the readableStream.
         */
        DelimiterStream = function(readableStream, delimiter, encoding) {
            //todo: when we remove oldStream, check read()
            if (!readableStream || typeof readableStream.on !== 'function') {
                throw new Error('DelimiterStream requires a valid ReadableStream!');
            }
            events.EventEmitter.call(this);

            if (!encoding) {
                encoding = 'binary';
            }
            if (!delimiter) {
                delimiter = "\n";
            }
            //if you pass in "\n" but encoding is binary
            if (encoding === 'binary' && typeof delimiter !== 'number') {
                delimiter = delimiter.charCodeAt(0);
            }

            if (readableStream._readableState) {
                if (typeof readableStream._readableState.encoding === 'string' && readableStream._readableState.encoding != encoding) {
                    throw new Error('DelimiterStream was setup with encoding ' + encoding + ' but stream is encoding ' + readableStream._readableState.encoding);
                } else if (readableStream._readableState.encoding === null && encoding !== 'binary') {
                    if (typeof readableStream.setEncoding === 'function') {
                        readableStream.setEncoding(encoding);
                    } else {
                        throw new Error('DelimiterStream was setup with encoding ' + encoding + ' but stream has default encoding. Set encoding on the stream first explicitly.');
                    }
                }
                //there's no way to unset the encoding from utf8 -> binary without hacking up _readableState
            }

            this._reFireListeners = {};
            this.delimiter = delimiter;
            this.readableStream = readableStream;
            this.emitEvents = false;
            this.matches = [];
            this.buffer = new BUFFER_CONSTRUCTOR(0);
            this.destroyed = false;

            this._closeCallback = this.onStreamClose.bind(this);
            readableStream.on('close', this._closeCallback);

            if (encoding === 'binary') {
                this._readableCallback = readBinaryData.bind(this);
            } else {
                this._readableCallback = readStringData.bind(this);
            }
            readableStream.on('readable', this._readableCallback);
        };
        util.inherits(DelimiterStream, events.EventEmitter);

        /**
         * A DelimiterStream is in the paused state by default.
         * By calling resume() you're allowing data events to start firing.
         */
        DelimiterStream.prototype.resume = function() {
            this.emitEvents = true;
            //emit any events we might have missed
            emitEvents(this);
            return this;
        };

        DelimiterStream.prototype.pause = function() {
            this.emitEvents = false;
            return this;
        };

        DelimiterStream.prototype.addListener = function(type, listener) {
            if (type === 'readable') {
                console.warn("Potentially invalid use of DelimiterStream. 'readable' events are not fired, only 'data' events.");
                return this;
            }
            events.EventEmitter.prototype.addListener.call(this, type, listener);
            if (this.readableStream == null) {
                return this;
            }
            if (this._reFireListeners[type] == null && type && type !== 'data' && type !== 'close') {
                this._reFireListeners[type] = this.emit.bind(this, type);
                this.readableStream.on(type, this._reFireListeners[type]);
            }
            return this;
        };
        DelimiterStream.prototype.on = DelimiterStream.prototype.addListener;

        DelimiterStream.prototype.removeListener = function(type, listener) {
            events.EventEmitter.prototype.removeListener.call(this, type, listener);
            if (this.readableStream == null) {
                return this;
            }
            if (type && this._events[type] == null && this._reFireListeners[type] != null) {
                this.readableStream.removeListener(type, this._reFireListeners[type]);
                delete this._reFireListeners[type];
            }
            return this;
        };

        DelimiterStream.prototype.removeAllListeners = function(type) {
            var args = [];
            if (type !== undefined) {
                args.push(type);
            }
            events.EventEmitter.prototype.removeAllListeners.apply(this, args);
            if (this.readableStream != null) {
                this.removeAllStreamListeners();
            }
            return this;
        };

        DelimiterStream.prototype.removeAllStreamListeners = function(type) {
            if (type && this._reFireListeners[type] != null) {
                if (this.readableStream != null) {
                    this.readableStream.removeListener(type, this._reFireListeners[type]);
                }
                delete this._reFireListeners[type];
            } else if (type == null) {
                if (this.readableStream != null) {
                    for (var t in this._reFireListeners) {
                        this.readableStream.removeListener(t, this._reFireListeners[t]);
                    }
                }
                this._reFireListeners = {};
            }
            return this;
        };

        //on underlying stream close we should destroy and emit close
        DelimiterStream.prototype.onStreamClose = function() {
            if (arguments.length > 0) {
                this.emit.apply(this, Array.prototype.concat.apply(['close'], arguments));
            } else {
                this.emit('close');
            }
            this.destroy();
        };

        /**
         * When you're finished with a stream, call destroy to remove all listeners and cleanup.
         */
        DelimiterStream.prototype.destroy = function() {
            this.buffer = [];
            this.emitEvents = false;
            this.destroyed = true;
            if (this.readableStream == null) {
                return this;
            }
            this.readableStream.removeListener('close', this._closeCallback);
            if (this._dataCallback) {
                this.readableStream.removeListener('data', this._dataCallback);
            }
            if (this._readableCallback) {
                this.readableStream.removeListener('readable', this._readableCallback);
            }
            if (typeof this.readableStream.destroy === 'function') {
                this.readableStream.destroy.apply(this.readableStream, arguments);
            }
            this.removeAllStreamListeners();
            this.readableStream = null;
            return this;
        };

        //some helper passthru events
        var passthruEvents = ['write', 'connect', 'end', 'ref', 'unref', 'setTimeout', 'abort'];
        do {
            (function(e) {
                DelimiterStream.prototype[e] = function() {
                    if (this.readableStream == null) {
                        this.emit('error', new Error(e + ' called after stream closed'));
                        return;
                    }
                    this.readableStream[e].apply(this.readableStream, arguments);
                };
            }(passthruEvents.pop()));
        } while (passthruEvents[0] != null);

        /**
         * Helper getter functions
         */
        DelimiterStream.prototype.getStream = function() {
            return this.readableStream;
        };
        DelimiterStream.prototype.getBuffer = function() {
            return this.buffer.slice(0);
        };
    } else {
        DelimiterStream = function() {};
    }

    function WrapStream(opts, cb, ctx, args) {
        this.callback = cb;
        this.callbackCtx = ctx;
        this.args = args;
        this.emitEvents = true;
        this.delimiter = opts.delimiter || "\n";
        if (typeof this.delimiter !== 'number' && typeof this.delimiter !== 'string') {
            throw new TypeError('delimiter must be a number/string');
        }
        this.dataLimit = opts.dataLimit || 0;
        if (typeof this.dataLimit !== 'number') {
            throw new TypeError('dataLimit must be a number');
        }
        this.matches = [];
        this.buffer = new BUFFER_CONSTRUCTOR(0);
        this._isKnownType = false;
        this._isString = true;
    }
    WrapStream.prototype.emit = function(eventName, data) {
        if (eventName !== 'data' || this.callback === undefined) {
            return;
        }
        //don't call apply unless we need to
        if (this.args !== null) {
            //we reserved space for data in wrap()
            this.args[this.args.length - 1] = data;
            this.callback.apply(this.callbackCtx, this.args);
        } else {
            this.callback.call(this.callbackCtx, data);
        }
    };
    WrapStream.prototype.handleData = function(data) {
        if (this._isKnownType === false) {
            if (isNode && Buffer.isBuffer(data)) {
                this._isString = false;
                if (typeof this.delimiter === 'string') {
                    this.delimiter = this.delimiter.charCodeAt(0);
                }
            }
            this._isKnownType = true;
        }
        //null means we should flush the data we have left
        if (!data) {
            if (data === null) {
                this.flushData();
            }
            return;
        }
        handleData(this, this._isString, data, this.dataLimit);
    };
    WrapStream.prototype.flushData = function() {
        if (this._isKnownType === false || this.buffer.length === 0) {
            return;
        }
        var lastMatch;
        //add the leftover buffer to the matches at the end (beginning when we emit events)
        if (this._isString) {
            if (isNode) {
                lastMatch = this.buffer.toString();
            } else {
                lastMatch = this.buffer.join("");
            }
        } else {
            lastMatch = this.buffer;
        }
        if (lastMatch.length > 0) {
            this.buffer = new BUFFER_CONSTRUCTOR(0);
            this.matches.push(lastMatch);
            emitEvents(this);
        }
    };

    DelimiterStream.wrap = function(opts, fn, ctx /*, [...args] */) {
        var argsSkip = 3, //wrap(opts, function, ctx)
            options = opts,
            callback = fn,
            callbackContext = ctx,
            args, stream;
        if (typeof opts === 'function') { //wrap(function, ctx)
            options = {};
            callback = opts;
            callbackContext = fn;
            argsSkip = 2;
        } else if (!opts) {
            throw new TypeError('Invalid function/options sent to DelimiterStream.wrap');
        }
        //put an undefined at the end so we leave space for data
        args = arguments.length > argsSkip ? Array.prototype.slice.call(arguments, argsSkip).concat([undefined]) : null;
        stream = new WrapStream(options, callback, callbackContext, args);
        return function(err, data) {
            if (arguments.length > 1) {
                stream.handleData(data);
            } else {
                if (err instanceof Error) {
                    stream.handleData(null);
                } else {
                    stream.handleData(err);
                }
            }
        };
    };

    if (isNode) {
        module.exports = DelimiterStream;
    } else {
        root.DelimiterStream = DelimiterStream;
    }
}());
