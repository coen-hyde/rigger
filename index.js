var async = require('async'),
    debug = require('debug')('rigger'),
    getit = require('getit'),
    Stream = require('stream').Stream,
    fs = require('fs'),
    path = require('path'),
    util = require('util'),
    _ = require('underscore'),

    // define some reusable regexes,
    reLineBreak = /\n/,
    reTrailingReturn = /\r$/,
    reLeadingDot = /^\./,
    reTrailingDot = /\.$/,
    reLeadingSlash = /^\//,
    reTrailingSlash = /\/$/,
    reMultiTarget = /^(.*?)\[(.*)\]$/,
    reAlias = /^([\w\-]+)\!(.*)$/,

    reIncludeDoubleSlash = /^(\s*)\/\/\=(\w*)\s*(.*)$/,
    reIncludeSlashStar = /^(\s*)\/\*\=(\w*)\s*(.*?)\s*\*\/$/,
    reIncludeHash = /^(\s*)\#\=(\w*)\s*(.*)$/,
    reQuotesLeadAndTrail = /(^[\"\']|[\"\']$)/g,
    reFallbackDelim = /\s+\:\s+/,

    // initialise the default converters
    converters = {},

    // intialise line endings based on platform
    lineEnding = process.platform == 'win32' ? '\r\n' : '\n',

    // initialise the concatenators
    concatenators = {
        js: ';' + lineEnding,
        default: lineEnding
    },

    // include patterns as used in interleave
    includeRegexes = {
        // core supported file types
        js:     [ reIncludeDoubleSlash, reIncludeSlashStar ],
        css:    [ reIncludeSlashStar ],

        // other cool languages that I use every now and again
        coffee: [ reIncludeHash ],
        roy:    [ reIncludeDoubleSlash ],
        styl:   [ reIncludeDoubleSlash ]
    },

    // get a reference to the platform correct exists function
    _exists = fs.exists || path.exists,
    _existsSync = fs.existsSync || path.existsSync;

function _cleanLine(line) {
    return line.replace(reTrailingReturn, '');
}

/**
# Class: Rigger > Stream

Create a new class of Rigger that will be used to parse a input source file and 
produce a parsed output file.

## Valid Options

- filetype {String} - (default: js) the type of file that we are processing (js, coffee, css, roy, etc)
- encoding {String} - (default: utf8) file encoding
- cwd {String} - The current working directory 
*/
function Rigger(opts) {
    // call the inherited Stream constructor
    Stream.call(this);

    // save a reference to the options
    // these options will be passed through to getit calls
    opts = this.opts = _.extend({}, opts);

    // initialise the base settings that will be passed through to include calls
    this.baseSettings = _.extend({}, opts.settings);

    // initialise the tolerant setting to false
    this.tolerant = opts.tolerant === true;

    // initialise the basename from the opts
    this.basename = opts.basename;

    // initialise the default file format
    this.filetype = this._normalizeExt(opts.filetype || 'js');
    debug('filetype initialized to: ' + this.filetype);

    // initialise the concatenator based on the filetype
    this.concatenator = concatenators[this.filetype] || concatenators['default'];

    // initialise the encoding (default to utf8)
    this.encoding = this.opts.encoding || 'utf8';

    // initialise the cwd (this is also used by getit)
    this.cwd = this.opts.cwd || process.cwd();
    this.csd = this.opts.csd || this.cwd;

    // initiliase the include pattern
    this.regexes = this.opts.regexes || includeRegexes[this.filetype] || includeRegexes.js;

    // initialise the stream as writable
    this.writable = true;

    // create a resolving queue to track resolving includes progress
    this.activeIncludes = 0;

    // initialise the context, if not explicitly defined, match the filetype
    this.targetType = this._normalizeExt(this.opts.targetType || this.filetype);

    // initialise the buffer to empty
    this.buffer = '';

    // initialise the converters
    this.converters = _.defaults(opts.converters || {}, converters);

    // create the output array
    this.output = [];
}

util.inherits(Rigger, Stream);

Rigger.prototype.convert = function(conversion, input, opts, callback) {
    var steps, ii;

    // ensure we have options
    if (typeof opts == 'function') {
        callback = opts;
        opts = {};
    }

    // if we have no conversion required, simply return the input back
    if (typeof conversion == 'undefined') return callback(null, input);

    // get the converter
    steps = [].concat(this.converters[conversion] || []);

    // if we don't have a converter, then return an error
    if (steps.length === 0) return callback(new Error('Unable to run conversion from ' + conversion));

    // add the first step in the waterfall
    debug('attempting tp apply conversion of: ' + conversion);
    steps.unshift(function(itemCb) {
        itemCb(null, input, opts);
    });

    // bind the steps
    for (ii = 0; ii < steps.length; ii++) {
        steps[ii] = steps[ii].bind(this);
    }

    // start the conversion process
    async.waterfall(steps, function(err, output) {
        if (err) {
            debug('recieved error trying to run conversion "' + conversion + '"', err);
            return callback(err, '');
        }

        if (! output) {
            debug('running conversion "' + conversion + '" produced no output for input: ', input);
        }

        // trigger the callback
        callback(err, output);
    });
};

Rigger.prototype.get = function(getTarget, callback) {
    var rigger = this,
        multiMatch = reMultiTarget.exec(getTarget),
        targets = [getTarget];

    // check whether we have more than one target
    if (multiMatch) {
        targets = multiMatch[2].split(/\,\s*/).map(function(item) {
            return multiMatch[1] + item;
        });
    }

    async.map(
        targets,
        this._getSingle.bind(this),
        function(err, results) {
            callback(err, (results || []).join(lineEnding));
        }
    );
};

Rigger.prototype.end = function() {
    var rigger = this;

    // if we have active includes, then wait
    if (this.activeIncludes) {
        this.once('resume', this.end.bind(this));
    }
    else if (this.buffer) {
        this.once('resume', this.end.bind(this));
        this.write('', true);
    }
    else {
        var conversion = this._getConversion(this.filetype);

        debug('finished writing to rigger stream, determining if conversion is required');
        this.convert(conversion, this.output.join(lineEnding), function(err, content) {
            if (err) {
                rigger.emit('error', err);
            }
            else {
                // emit a buffer for the parsed lines
                rigger.emit('data', new Buffer(content));
                rigger.emit('end');
            }
        });
    }
};

Rigger.prototype.write = function(data, all) {
    var rigger = this, lines,
        settings = this.baseSettings,
        previousCSD = this.csd;

    // if we have active includes, then wait until we resume before pushing out more data
    // otherwise we risk pushing data back not in order (which would be less than ideal)
    if (this.activeIncludes) {
        this.once('resume', this.write.bind(this, data));
    }

    // split on line breaks and include the remainder
    lines = (this.buffer + data).toString(this.encoding).split(reLineBreak).map(_cleanLine);

    // reset the remainder
    this.buffer = '';

    // grab everything but the last line
    // unless we are building all
    if (! all) {
        this.buffer = lines.splice(lines.length - 1)[0];
    }

    // process each of the lines
    async.map(
        lines,

        // expand the known includes
        this._expandIncludes.bind(this, settings),

        function(err, result) {
            // restore the previous current source directory
            rigger.csd = previousCSD;

            // if we processed everything successfully, emit the data
            if (! err) {
                rigger.output = (rigger.output || []).concat(result);

                // iterate through the settings and emit those settings
                for (var key in settings) {
                    rigger.emit('setting', key, settings[key]);
                }

                // resume processing the stream
                rigger.emit('resume');
            }
            else {
                rigger.emit('error', err);
            }
        }
    );

    // pause the stream
    this.emit('pause');
};

/* core action handlers */

Rigger.prototype.include = function(match, settings, callback) {
    var rigger = this,
        templateText = match[3].replace(reTrailingDot, '').replace(reQuotesLeadAndTrail, ''),
        target, targetExt, conversion;

    // initialise the target
    try {
        target = _.template(
            templateText,
            settings, {
                interpolate : /\{\{(.+?)\}\}/g
            }
        );
    }
    catch (e) {
        return callback(new Error('Unable to expand variables in include "' + templateText + '"'));
    }

    // get the target extension
    targetExt = path.extname(target);

    // update the current context (js, coffee, roy, css, etc)
    debug('include: ' + target + ' requested, file ext = ' + targetExt + ', context: ' + this.targetType);

    // get the file
    debug('including: ' + target);
    this.get(target, function(err, data) {
        callback(err, data);
    });
};

Rigger.prototype.plugin = function(match, settings, callback) {
    var pluginName = match[3],
        plugin,
        scope = {
            done: callback
        },
        packagePath = this.cwd,
        lastPackagePath = '';

    // first try to include a node_module from the cwd
    try {
        // FIXME: hacky
        while (packagePath && packagePath != lastPackagePath && (! _existsSync(path.join(packagePath, 'package.json')))) {
            lastPackagePath = packagePath;
            packagePath = path.dirname(packagePath);
        }

        plugin = require(path.join(packagePath, 'node_modules', 'rigger-' + pluginName));
    }
    catch (projectErr) {
        // first try an npm require for the plugin
        try {
            plugin = require('rigger-' + pluginName);
        }
        catch (npmError) {
            try {
                plugin = require('./plugins/' + pluginName);
            }
            catch (localError) {
                // not found
            }
        }
    }

    // if we have a plugin then call it with the temporary scope
    if (typeof plugin == 'function') {
        plugin.apply(scope, [this].concat(match.slice(4)));
    }
    else {
        callback(new Error('Unable to find plugin "' + pluginName + '"'));
    }

    return plugin;
};

Rigger.prototype.set = function(match, settings, callback) {
    var parts = (match[3] || '').split(/\s/),
        err;

    try {
        debug('found setting: ', parts);
        settings[parts[0]] = JSON.parse(parts.slice(1).join(' '));
    }
    catch (e) {
        err = new Error('Could not parse setting: ' + parts[0] + ', value must be valid JSON');
    }

    callback(err);
};

Rigger.prototype.resolve = function(targetPath) {
    var scopeRelative = path.resolve(this.csd, targetPath),
        workingRelative = path.resolve(this.cwd, targetPath);

    return _existsSync(scopeRelative) ? scopeRelative : workingRelative;
};

/* internal functions */

Rigger.prototype._expandAliases = function(target) {
    var match = reAlias.exec(target),
        aliases = this.opts.aliases || {},
        base;

    // if the target is an aliases, then construct into an actual target
    if (match) {
        // if the alias is not valid, then fire the invalid alias event
        if (! aliases[match[1]]) {
            this.emit('alias:invalid', match[1]);
        }

        // update the base reference
        base = (aliases[match[1]] || '').replace(reTrailingSlash, '');

        // update the target, recursively expand
        target = this._expandAliases(base + '/' + match[2].replace(reLeadingSlash, ''));
        debug('found alias, ' + match[1] + ' expanding target to: ' + target);
    }

    return target;
};

Rigger.prototype._expandIncludes = function(settings, line, callback) {
    var rigger = this, 
        ii, regexes = this.regexes,
        cacheResults,
        match, action;

    // iterate through the regexes and see if this line is a match
    for (ii = regexes.length; (!match) && ii--; ) {
        // test for a regex match
        match = regexes[ii].exec(line);

        // if we have a match, then process the result
        if (match) {
            match[2] = match[2] || 'include';
            break;
        }
    }

    // if we have a target, then get that content and pass that back
    if (! match) return callback(null, line);

    // increment the number of active includes
    this.activeIncludes += 1;

    // initialise the action name to the backreference
    action = match[2];

    // if the action is not defined, default to the plugin action
    if (typeof this[action] != 'function') {
        action = 'plugin';
        match.splice(2, 0, 'plugin');
    }

    // run the specified action
    this[action].call(this, match, settings, function(err, content) {
        // reduce the number of active includes
        rigger.activeIncludes -=1;

        // if we have an error, trigger the callback
        if (err) return callback(err);

        // parse the lines
        async.map(
            (content || '').split(reLineBreak).map(_cleanLine),
            function(line, itemCallback) {
                rigger._expandIncludes(settings, match[1] + line, itemCallback);
            },

            function(err, results) {
                if (err) return callback(err);

                callback(null, results.join(lineEnding));
            }
        );
    });
};

Rigger.prototype._fork = function(files, callback) {
    var rigger = this,
        // initialise subrigger opts for settings that we want to 
        // pass through
        subriggerOpts = {
            encoding: this.encoding,
            csd: this.csd,
            targetType: this.filetype
        };

    // ensure we have an array for files
    files = [].concat(files || []);

    // iterate through the files and create a subrigger
    async.map(
        files,

        function(file, itemCallback) {
            var isRemote = getit.isRemote(file),
                subrigger;

            // emit the correct event
            rigger.emit('include:' + (isRemote ? 'remote' : 'file'), file);

            // create the subrigger
            debug('subrigging: ' + file);
            subrigger = rig(file, subriggerOpts, itemCallback);

            // attach the subrigger events
            subrigger.on('include:file', rigger.emit.bind(rigger, 'include:file'));
            subrigger.on('include:remote', rigger.emit.bind(rigger, 'include:remote'));
        },

        function(err, results) {
            debug('finished subrigging', results);
            callback(null, (results || []).join(lineEnding));
        }
    );
};

Rigger.prototype._getConversion = function(ext) {
    // normalize the extension to the format .ext
    ext = this._normalizeExt(ext);

    // otherwise, check whether a conversion is required
    return ext && ext !== this.targetType ? (ext + '2' + this.targetType).replace(/\./g, '') : undefined;
};

Rigger.prototype._getSingle = function(target, callback) {
    var rigger = this,
        previousCSD,
        targetOptions = target.split(reFallbackDelim),
        fallbacks = targetOptions.slice(1),
        // only use tolerant mode if we have no fallbacks
        tolerant = this.tolerant && fallbacks.length === 0,
        files;

    // remap the target to the first target option
    target = this._expandAliases(targetOptions[0]);
    debug('getting: ' + target);

    // create an attempt fallback function that will help with rerunning the getSingle method for alternative options
    function attemptFallback(err) {
        // if the current operation had an error, and we have fallbacks available
        // then attempt the operation with the fallback
        if (err && fallbacks.length > 0) {
            rigger._getSingle(fallbacks.join(' : '), callback);
        }
        else {
            callback.apply(null, arguments);
        }
    }

    // check if we have a csd (current source directory) that is remote
    // and a target that is non remote
    if (getit.isRemote(this.csd) && (! getit.isRemote(target))) {
        target = this.csd.replace(reTrailingSlash) + '/' + target;
    }

    // if the target is remote, then let getit do it's job
    if (getit.isRemote(target)) {
        // update the csd to the remote basepath
        rigger.csd = path.dirname(target);

        // ensure the extension is provided
        if (path.extname(target) === '') {
            target += '.' + this.filetype;
        }

        rigger._fork(target, attemptFallback);
    }
    // otherwise, we'll do a little more work
    else {
        var testTargets = [
            path.resolve(this.csd, target), // the target relative to the last processed include
            path.resolve(this.cwd, target)  // the target relative to the originally specified working directory
        ];

        // if the test target does not have an extension then add it
        // ensure the extension is provided
        testTargets.forEach(function(target, index) {
            // if no extension is present then include one with a filetype to the end
            // of the current test targets
            if (path.extname(target) === '') {
                // insert the minified version of the library at the start of the
                // targets list (will be 2nd preferred after non minified version is added)
                testTargets.unshift(target + '.min.' + rigger.filetype);

                // insert the default version of the library to the start of the list
                testTargets.unshift(target + '.' + rigger.filetype);
            }
        });

        // find the first of the targets that actually exists
        async.detect(testTargets, _exists, function(realTarget) {
            if (! realTarget) {
                // if the rigger is tolerant, emit the include:error event
                if (tolerant) {
                    rigger.emit('include:error', target);
                }

                return attemptFallback(tolerant ? null : new Error('Unable to find target for: ' + target));
            }

            // determine the type of the real target
            fs.stat(realTarget, function(err, stats) {
                if (err) return attemptFallback(err);

                // update the current scope directory
                rigger.csd = path.dirname(realTarget);

                // if it is a file, then read the file and pass the content back
                if (stats.isFile()) {
                    rigger._fork([realTarget], attemptFallback);
                }
                // otherwise, if the target is a directory, read the files and then read the 
                // valid file types from the specified directory
                else if (stats.isDirectory()) {
                    rigger.emit('include:dir', realTarget);
                    debug('reading directory contents: ' + realTarget);
                    fs.readdir(realTarget, function(dirErr, files) {
                        // get only the files that match the current file type
                        files = (files || []).filter(function(file) {
                            var ext = path.extname(file).slice(1).toLowerCase(),
                                valid = ext === rigger.filetype;

                            // additionally include those files that can be
                            // converted to the target file type
                            Object.keys(converters).forEach(function(key) {
                                valid = valid || key === (ext + '2' + rigger.filetype);
                            });

                            debug('found file: ' + file + ' + valid: ' + valid);
                            return valid;
                        })
                        // explicitlly sort the files
                        .sort()
                        // turn into the fully resolved path
                        .map(function(file) {
                            return path.join(realTarget, file);
                        });

                        // fork a subrigger
                        rigger._fork(files, attemptFallback);
                    });
                }
            });            
        });
    }


};

Rigger.prototype._normalizeExt = function(ext) {
    return (ext || '').replace(reLeadingDot, '').toLowerCase();
};

var rig = exports = module.exports = function(targetFile, opts, callback) {
    var parser;

    // if we have no arguments passed to the function, then return a new rigger instance
    if (typeof targetFile == 'undefined' || (typeof targetFile == 'object' && (! (targetFile instanceof String)))) {
        return new Rigger(targetFile);
    }

    // remap arguments if required
    if (typeof opts == 'function') {
        callback = opts;
        opts = {};
    }

    // initialise the options
    opts = _.extend({}, opts || {});

    // initialise the default encoding
    opts.encoding = opts.encoding || 'utf8';

    // add the additional rigger options
    // initialise the filetype based on the extension of the target file
    opts.filetype = opts.filetype || path.extname(targetFile);

    // initialise the basename
    opts.basename = opts.basename || path.basename(targetFile, opts.filetype);

    // pass the rigger the cwd which will be provided to getit
    opts.cwd = opts.cwd || path.dirname(targetFile);

    // create the parser
    parser = new Rigger(opts);

    // attach the callback
    _attachCallback(parser, opts, callback);

    // pipe the input to the parser
    debug('loading file contents and passing to a rigger instance: ' + targetFile);
    getit(targetFile, parser.opts).pipe(parser);

    // return the parser instance
    return parser;
};

// export a manual processing helper
exports.process = function(data, opts, callback) {
    var rigger;

    // remap args if required
    if (typeof opts == 'function') {
        callback = opts;
        opts = {};
    }

    // create a new rigger
    rigger = new Rigger(opts);

    // handle the callback appropriately
    _attachCallback(rigger, opts, callback);

    process.nextTick(function() {
        // write the data into the rigger
        rigger.write(data);
        rigger.end();
    });

    // return the rigger instance
    return rigger;
};

// export the rigger class
exports.Rigger = Rigger;

// expose the regexes for tweaking
exports.regexes = includeRegexes;

// patch in the default converters
fs.readdirSync(path.resolve(__dirname, 'converters')).forEach(function(converterFile) {
    converters[path.basename(converterFile, '.js')] = require('./converters/' + converterFile);
});

// map the default converters to the rigger export
exports.converters = converters;

/* private helpers */

function _attachCallback(rigger, opts, callback) {
    var output = [],
        settings = {},
        abortOnError = true,
        aborted = false;

    // ensure the options are defined
    opts = opts || {};

    // determine whether we should abort on error
    if (typeof opts.abortOnError != 'undefined') {
        abortOnError = opts.abortOnError;
    }

    // if we have a callback, then process the data and handle end and error events
    if (callback) {
        rigger
            .on('data', function(data) {
                output[output.length] = data.toString(opts.encoding || 'utf8');
            })

            .on('setting', function(name, value) {
                settings[name] = value;
            })

            // on error, trigger the callback
            .on('error', function(err) {
                debug('rigger produced error condition: ', err);

                // determine whether the build process is aborted in this condition
                aborted = abortOnError;
                if (aborted) {
                    callback(err);
                }
            })

            // on end emit the data
            .on('end', function() {
                if (callback && (! aborted)) {
                    callback(null, output.join(lineEnding), settings);
                }
            });
    }
}