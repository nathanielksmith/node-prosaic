// azathoth.js
// * listen at some port
// * accept json data terminated by PROSAICFHTAGN
// * run through tokenizer/phraser and into mongodb

var net = require('net');
var EventEmitter = require('events').EventEmitter;

var CMUDict = require('cmudict').CMUDict;
var mongodb = require('mongodb');

var cmudict = new CMUDict();
var mongo_port = 27017;
var mongo_server = '127.0.0.1';
var mongos = new mongodb.Server(mongo_server, mongo_port, {});

// TODO put this in a util
function to_array(thing) { return Array.prototype.slice.call(thing); }
function implement_map(props, from, to) {
    props.forEach(function(p) {
        var func = function() {
            from[p].apply(from, to_array(arguments));
        };
        func.name = p;
        to[p] = func;
    });
}

// TODO BUG handle chunking, knucklehead
// collect data into buffer until PROSAICFHTAGN is spotted.
var server = net.createServer(function(c) {
    console.log('client connected');
    var buffer = '';
    c.on('data', function(data) {
        console.log('client sent data');
        console.log(data.length);
        buffer += data.toString();
        var match = buffer.match(/(.*)PROSAICFHTAGN/);
        if (match) {
            consume(match[1], c);
            buffer = '';
        }
    });
    c.on('disconnect', function() { console.log('client disconnected'); });
});
server.listen(9143, 'localhost');

function consume(json, connection) {
    var text = '';
    try { text = JSON.parse(json); }
    catch (e) {
        var msg = 'ERROR: malformed json';
        console.error(msg);
        connection.write(msg);
        return;
    }
    var do_want = ['label', 'raw'];
    var missing = [];
    do_want.forEach(function(x) {
        if (!text[x]) {
            missing.push(x);
        }
    });
    if (missing.length > 0) {
        var msg = 'ERROR: missing keys: '+missing.join(', ');
        console.error(msg);
        connection.write(msg);
        return;
    }
    var p = Object.create(prosaic_parser).init(connection);
    p.parse(text);
}

var prosaic_parser = {
    init: function(connection) {
        this.connection = connection;
        this.phrases_in = 0;
        this.phrases_out = 0;
        return this;
    },
    error: function(msg) {
        console.error(msg);
        this.connection.write('ERROR: '+msg);
    },
    parse: function(text_obj) {
        this.doc = {
            label: text_obj.label,
            db: (text_obj.db || 'stijfveen')
        };
        var that = this;
        new mongodb.Db(this.doc.db, mongos, {}).open(function(err, client) {
            if (err) {
                this.error(err);
                return;
            }
            that.client = client;
            var t = Object.create(prosaic_tokenizer).init();
            t.on('phrase', function(str) { that.handle_phrase.call(that, str) });
            t.write(text_obj.raw);
        });
    },
    handle_phrase: function(str) {
        this.phrases_in++;
        var phrase_doc = {
            raw: str,
            source: this.doc.label,
            // TODO num_sylls,
            // TODO source
            // TODO phoneme str
            // TODO end rhyme
        };
        var phrases = new mongodb.Collection(this.client, 'phrases');
        var that = this;
        phrases.insert(phrase_doc, {safe:true}, function(err,docs) {
            if (err) {
                that.error(err);
                that.client.close()
                return;
            }
            that.phrases_out++;
            process.stdout.write(that.phrases_in+'/'+that.phrases_out, '\r');
            if (that.phrases_out === that.phrases_in) {
                that.connection.write('OK\r\n');
                that.connection.close();
                that.client.close();
            }
        });
    }
};

var prosaic_tokenizer = {
    init: function() {
        this._buffer = '';
        var eventer = new EventEmitter();
        implement_map(['on', 'emit'], eventer, this);
        this.eventer = eventer;
        return this;
    },
    write: function(data) {
        // TODO abbreviation list
        for (var c in data) {
            if (data[c] === "\n" || data[c] === "\r") {
                this._buffer += ' ';
            }
            else if (data[c].match(/[.,;:]/)) {
                this._buffer += data[c];
                this.emit('phrase', this._buffer);
                this._buffer = '';
            }
            else {
                this._buffer += data[c];
            }
        }
        this.emit('end');
    }
};
