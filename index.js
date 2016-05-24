"use strict";

/**
 * Module dependencies.
 */

const EventEmitter = require('events').EventEmitter;
const util = require('util');
const Fs = require('fs');
const Path = require('path');

/**
 * Initialize a new `Option` with the given `flags` and `description`.
 *
 * @param {String} flags
 * @param {String} description
 * @api public
 */

function Option(flags, description) {
	this.flags = flags;
	this.required = ~flags.indexOf('<');
	this.optional = ~flags.indexOf('[');
	this.bool = !~flags.indexOf('-no-');
	flags = flags.split(/[ ,|]+/);
	if (flags.length > 1 && !/^[[<]/.test(flags[1])) this.short = flags.shift();
	this.long = flags.shift();
	this.description = description || '';
}

/**
 * Return option name.
 *
 * @return {String}
 * @api private
 */

Option.prototype.name = function() {
	return this.long
		.replace('--', '')
		.replace('no-', '');
};

/**
 * Initialize a new `BotCommand`.
 *
 * @param {String} name
 * @api public
 */

function BotCommand(name) {
	this.prefixes = null;
	this.parseOpts = {
		send: null,
		allowUnknownOption: false,
		showHelpOnError: true
	};
	this._showHelpOnEmpty = false;
	this.commands = [];
	this.options = [];
	this._execs = {};
	this._args = [];
	this._name = name || '';
	this._alias = null;
	this._msgBuffer = '';
}

util.inherits(BotCommand, EventEmitter);

/**
 * Overwrite all parse options for a command and the subcommands created afterwards
 * @param {Object} options A new set of parse options (send function, allowUnknownOption and showHelpOnError)
 * @api public
 */
BotCommand.prototype.setParseOptions = function(options) {
	this.parseOpts = options;
}

/**
 * Sets the prefix to search when parsing a line of text, this option is not inherited by subcommands otherwise it would
 * require double prefix for subcomands something like !command !subcommad
 * 
 * @param  {String or array} prefix A single string or an Array of strings to be used as prefixes	
 * @return {BotCommand}        This object for chaining
 * @api public
 */
BotCommand.prototype.prefix = function(prefix) {
	if (typeof prefix === 'string') {
		this.prefixes = [prefix];
	} else {
		this.prefixes = prefix;
	}
	return this;
}

/**
 * Add command `name`.
 *
 * The `.action()` callback is invoked when the command `name` is specified in the line parsed,
 * and the remaining arguments are applied to the function for access if they are not passed 
 * null arguments will be aplied.
 * A first argument with the metadata received on parsing will be apllied to every action.
 *
 * Examples:
 *
 *      program
 *        .option('-C, --chdir <path>', 'change the working directory')
 *        .option('-c, --config <path>', 'set config path. defaults to ./deploy.conf')
 *        .option('-T, --no-tests', 'ignore test hook')
 *
 *      program
 *        .command('setup')
 *        .description('run remote setup commands')
 *        .action(function() {
 *          console.log('setup');
 *        });
 *
 *      program
 *        .command('exec <cmd>')
 *        .description('run the given remote command')
 *        .action(function(meta, cmd) {
 *          console.log('exec "%s"', cmd);
 *        });
 *
 *      program
 *        .command('teardown <dir> [otherDirs...]')
 *        .description('run teardown commands')
 *        .action(function(meta, dir, otherDirs) {
 *          console.log('dir "%s"', dir);
 *          if (otherDirs) {
 *            otherDirs.forEach(function (oDir) {
 *              console.log('dir "%s"', oDir);
 *            });
 *          }
 *        });
 *
 *
 *      program.parse(line, metadata);
 *
 * @param {String} name
 * @param {Object} option object, currently only used to disable help on this command
 * @return {Command} the new command
 * @api public
 */
BotCommand.prototype.command = function(name, opts) {
	opts = opts || {};
	var args = name.split(/ +/);

	//If there is at least one command always add and implicit help command
	if (this.commands.length === 0 && args[0] !== 'help') {
		// implicit command help
		this.addImplicitHelpCommand();
	}
	var cmd = new BotCommand(args[0]);
	cmd.setParseOptions(this.parseOpts);
	cmd.showHelpOnEmpty();
	cmd._noHelp = !!opts.noHelp;
	this.commands.push(cmd);
	cmd.parseExpectedArgs(name.substring(args[0].length).trim());
	cmd.parent = this;

	return cmd;
};

/**
 * Define argument syntax for the top-level command.
 *
 * @api public
 */

BotCommand.prototype.arguments = function(desc) {
	return this.parseExpectedArgs(desc);
};

/**
 * Add an implicit `help [cmd]` subcommand
 * which invokes `--help` for the given command.
 *
 * @api private
 */

BotCommand.prototype.addImplicitHelpCommand = function() {
	this.command('help [cmd]')
		.description('display help for [cmd]');
};

/**
 * Parse expected `args`.
 *
 * For example `["[type]"]` becomes `[{ required: false, name: 'type' }]`.
 *
 * @param {Array} args
 * @return {Command} for chaining
 * @api public
 */

BotCommand.prototype.parseExpectedArgs = function(argString) {
	let args = argString.match(/(<.+?>)|(\[.+?\])/g);

	if (!args || !args.length) return;
	var self = this;
	args.forEach(function(arg, index) {
		var argDetails = {
			required: false,
			name: '',
			variadic: false
		};

		switch (arg[0]) {
			case '<':
				argDetails.required = true;
				argDetails.name = arg.slice(1, -1);
				break;
			case '[':
				argDetails.name = arg.slice(1, -1);
				break;
		}
		var newName = arg.match(/(\".+?\")|(\'.+?\')/g);
		if (newName) {
			argDetails.name = newName;
		}

		if (argDetails.name.length > 3 && argDetails.name.slice(-3) === '...') {
			argDetails.variadic = true;
			argDetails.name = argDetails.name.slice(0, -3);
			if (index != args.length - 1) {
				throw new Error(`error: variadic arguments must be last ${argDetails.name}`);
			}
		}
		if (argDetails.name) {
			self._args.push(argDetails);
		}
	});
	return this;
};

/**
 * Register callback `fn` for the command.
 *
 * Examples:
 *
 *      program
 *        .command('help')
 *        .description('display verbose help')
 *        .action(function() {
 *           // output help here
 *        });
 *
 * @param {Function} fn
 * @return {Command} for chaining
 * @api public
 */
BotCommand.prototype.action = function(fn) {
	let self = this;
	const listener = function(args, unknown, metadata) {
		// Parse any so-far unknown options
		args = args || [];
		unknown = unknown || [];

		const parsed = self.parseOptions(unknown);
		if (parsed.error.length > 0) {
			self._checkShowHelp(parsed.error);
			self.send(metadata, parsed.error.join('\n'));
			return;
		}
		// Output help if necessary
		if (outputHelpIfNecessary(self, parsed.unknown, metadata)) {
			return;
		}

		// If there are still any unknown options, then we simply
		// die, unless someone asked for help, in which case we give it
		// to them, and then we die.
		if (parsed.unknown.length > 0 && !self.parseOpts.allowUnknownOption) {
			let msg = [];
			msg.push(self.unknownOption(parsed.unknown[0]));
			self._checkShowHelp(msg);
			self.send(metadata, msg.join('\n'));
			return;
		}

		// Leftover arguments need to be pushed back. Fixes issue #56
		if (parsed.args.length) args = parsed.args.concat(args);

		let error = [];
		self._args.forEach(function(arg, i) {
			if (args[i] && args[i].match(/["'].+["']/)) {
				args[i] = args[i].substring(1, args[i].length - 1);
			}
			if (arg.required && null == args[i]) {
				error.push(self.missingArgument(arg.name));
			} else if (arg.variadic) {
				args[i] = args.splice(i);
			}
		});
		if (error.length > 0) {
			self._checkShowHelp(error);
			self.send(metadata, error.join('\n'));
			return;
		}
		for (let i = args.length; i < self._args.length; i++) {
			args.push(null);
		}
		args.push(self.opts());
		args.unshift(metadata);
		fn.apply(self, args);
	};
	let parent = this.parent || this;
	let name = parent === this ? '*' : this._name;
	parent.on(name, listener);
	if (this._alias) parent.on(this._alias, listener);
	return this;
};

/**
 * Define option with `flags`, `description` and optional
 * coercion `fn`.
 *
 * The `flags` string should contain both the short and long flags,
 * separated by comma, a pipe or space. The following are all valid
 * all will output this way when `--help` is used.
 *
 *    "-p, --pepper"
 *    "-p|--pepper"
 *    "-p --pepper"
 *
 * Examples:
 *
 *     // simple boolean defaulting to false
 *     program.option('-p, --pepper', 'add pepper');
 *
 *     --pepper
 *     program.pepper
 *     // => Boolean
 *
 *     // simple boolean defaulting to true
 *     program.option('-C, --no-cheese', 'remove cheese');
 *
 *     program.cheese
 *     // => true
 *
 *     --no-cheese
 *     program.cheese
 *     // => false
 *
 *     // required argument
 *     program.option('-C, --chdir <path>', 'change the working directory');
 *
 *     --chdir /tmp
 *     program.chdir
 *     // => "/tmp"
 *
 *     // optional argument
 *     program.option('-c, --cheese [type]', 'add cheese [marble]');
 *
 * @param {String} flags
 * @param {String} description
 * @param {Function|Mixed} fn or default
 * @param {Mixed} defaultValue
 * @return {Command} for chaining
 * @api public
 */

BotCommand.prototype.option = function(flags, description, fn, defaultValue) {
	let self = this,
		option = new Option(flags, description),
		oname = option.name(),
		name = camelcase(oname);

	// default as 3rd arg
	if (typeof fn != 'function') {
		if (fn instanceof RegExp) {
			var regex = fn;
			fn = function(val, def) {
				var m = regex.exec(val);
				return m ? m[0] : def;
			}
		} else {
			defaultValue = fn;
			fn = null;
		}
	}

	// preassign default value only for --no-*, [optional], or <required>
	if (false == option.bool || option.optional || option.required) {
		// when --no-* we make sure default is true
		if (false == option.bool) defaultValue = true;
		// preassign only if we have a default
		if (undefined !== defaultValue) self[name] = defaultValue;
	}

	// register the option
	this.options.push(option);
	// when it's passed assign the value
	// and conditionally invoke the callback
	this.on(oname, function(val) {
		// coercion
		if (null !== val && fn) {
			val = fn(val, undefined === self[name] ? defaultValue : self[name]);
		}

		// unassigned or bool
		if ('boolean' == typeof self[name] || 'undefined' == typeof self[name]) {
			// if no value, bool true, and we have a default, then use it!
			if (null == val) {
				self[name] = option.bool ? defaultValue || true : false;
			} else {
				self[name] = val;
			}
		} else if (null !== val) {
			// reassign
			self[name] = val;
		}
	});

	return this;
};

/**
 * Allow unknown options on the command line.
 *
 * @param {Boolean} arg if `true` or omitted, no error will be thrown
 * for unknown options.
 * @api public
 */
BotCommand.prototype.allowUnknownOption = function(arg) {
	this.parseOpts.allowUnknownOption = arguments.length === 0 || arg;
	return this;
};

/**
 * Configure output function for errors
 * 
 * @param {Function} cb the callback function to be called for output
 * @api public
 */
BotCommand.prototype.setSend = function(cb) {
	this.parseOpts.send = cb;
	return this;
}

/**
 * Show full command help when an error occurs
 *
 * @param {Boolean} arg if `true` or omitted it will show the full help when an error occurs 
 * @api public
 */
BotCommand.prototype.showHelpOnError = function(arg) {
	this.parseOpts.showHelpOnError = arguments.length === 0 || arg;
	return this;
};

/**
 * Show full command help when no command is found
 *
 * @param {Boolean} arg if `true` or omitted it will show the full help when no command is found
 * @api public
 */
BotCommand.prototype.showHelpOnEmpty = function(arg) {
	this._showHelpOnEmpty = arguments.length === 0 || arg;
	return this;
};

/**
 * Parse line of text, settings options and invoking commands actions when defined.
 * If there is no command defined in the line or there is some error the help will be sent.
 *
 * @param {String} line of text
 * @param {Object} metadata to be passed to send function and actions
 * @return {Command} for chaining
 * @api public
 */
BotCommand.prototype.parse = function(line, metadata) {
	if (this.prefixes) {
		let prefixFound = this.prefixes.find(prefix => line.startsWith(prefix));
		//Nothing to do if there was no prefix found
		if (!prefixFound) {
			return;
		}
		line = line.substring(prefixFound.length);
	}

	const argv = line.split(/(\".+?\")|(\'.+?\')|\s+/g).filter(a => (a && a.length > 0));;
	// store raw args
	this.rawArgs = argv;

	// process argv
	const parsed = this.parseOptions(this.normalize(argv));
	if (parsed.error.length > 0) {
		this._checkShowHelp(parsed.error);
		this.send(metadata, parsed.error.join('\n'));
		return;
	}
	this.args = parsed.args;
	this.parseArgs(this.args, parsed.unknown, metadata);
}

/**
 * Normalize `args`, splitting joined short flags. For example
 * the arg "-abc" is equivalent to "-a -b -c".
 * This also normalizes equal sign and splits "--abc=def" into "--abc def".
 *
 * @param {Array} args
 * @return {Array}
 * @api private
 */

BotCommand.prototype.normalize = function(args) {
	var ret = [],
		arg, lastOpt, index;

	for (var i = 0, len = args.length; i < len; ++i) {
		arg = args[i];
		if (i > 0) {
			lastOpt = this.optionFor(args[i - 1]);
		}

		if (arg === '--') {
			// Honor option terminator
			ret = ret.concat(args.slice(i));
			break;
		} else if (lastOpt && lastOpt.required) {
			ret.push(arg);
		} else if (arg.length > 1 && '-' == arg[0] && '-' != arg[1]) {
			let value = null;
			if (~(index = arg.indexOf('='))) {
				value = arg.slice(index + 1);
				arg = arg.slice(0, index);
			}
			arg.slice(1).split('').forEach(function(c) {
				ret.push('-' + c);
			});
			if (value) {
				ret.push(value);
			}
		} else if (/^--/.test(arg) && ~(index = arg.indexOf('='))) {
			ret.push(arg.slice(0, index), arg.slice(index + 1));
		} else {
			ret.push(arg);
		}
	}
	return ret;
};


/**
 * Parse command `args`.
 *
 * If help it is requested or there is no argument to parse sends help, otherwise tries to invoke listener(s) when available, then it
 * checks if a subcommand is the first arg and delegates the parsing to that subcomand, otherwise the "*"
 * event is emitted and those actions are invoked.
 *
 * @param {Array} args
 * @param {Array} unknown options and arguments unknown for this command probably defined on subcommands
 * @param {Object} metadata to be passed to send function and actions
 * @return {Command} for chaining
 * @api private
 */

BotCommand.prototype.parseArgs = function(args, unknown, metadata) {
	var name;
	if (args.length && args[0] != '') {
		name = args[0];
		if ('help' == name && 1 == args.length) {
			this.outputHelp(metadata);
			return;
		} else if ('help' == name) {
			args.shift();
			name = args[0];
			unknown.push('--help');
			this.rawArgs = this.rawArgs.slice(1);
			this.rawArgs.push('--help');
		}
		if (this.listeners(name).length) {
			this.emit(args.shift(), args, unknown, metadata);
		} else {
			let command = this.commands.find(cmd => cmd._name === name || cmd._alias === name);
			if (command) {
				let line = this.rawArgs.slice(1).join(' ');
				command.parse(line, metadata);
			} else {
				this.emit('*', args, null, metadata);
			}
		}
	} else {
		if (!outputHelpIfNecessary(this, unknown, metadata) && this._showHelpOnEmpty) {
			this.outputHelp(metadata);
		}
	}
};

/**
 * Return an option matching `arg` if any.
 *
 * @param {String} arg
 * @return {Option}
 * @api private
 */

BotCommand.prototype.optionFor = function(arg) {
	return this.options.find(opt => opt.long === arg || opt.short === arg);
};

/**
 * Parse options from `argv` returning `argv`
 * void of these options.
 *
 * @param {Array} argv
 * @return {Array}
 * @api public
 */

BotCommand.prototype.parseOptions = function(argv) {
	let args = [],
		len = argv.length,
		literal, option, arg, error = [];

	let unknownOptions = [];

	// parse options
	for (var i = 0; i < len; ++i) {
		arg = argv[i];

		// literal args after --
		if ('--' == arg) {
			literal = true;
			continue;
		}

		if (literal) {
			args.push(arg);
			continue;
		}

		// find matching Option
		option = this.optionFor(arg);
		// option is defined
		if (option) {
			// requires arg
			if (option.required) {
				arg = argv[++i];
				if (null == arg) {
					error.push(this.optionMissingArgument(option));
				}
				this.emit(option.name(), arg);
				// optional arg
			} else if (option.optional) {
				arg = argv[i + 1];
				if (null == arg || ('-' == arg[0] && '-' != arg)) {
					arg = null;
				} else {
					++i;
				}
				this.emit(option.name(), arg);
				// bool
			} else {
				this.emit(option.name());
			}
			continue;
		}

		// looks like an option
		if (arg.length > 1 && '-' == arg[0]) {
			unknownOptions.push(arg);

			// If the next argument looks like it might be
			// an argument for this option, we pass it on.
			// If it isn't, then it'll simply be ignored
			if (argv[i + 1] && '-' != argv[i + 1][0]) {
				unknownOptions.push(argv[++i]);
			}
			continue;
		}

		// arg
		args.push(arg);
	}
	return {
		error: error,
		args: args,
		unknown: unknownOptions
	};
};

/**
 * Return an object containing options as key-value pairs
 *
 * @return {Object}
 * @api public
 */
BotCommand.prototype.opts = function() {
	let self = this;
	return this.options.reduce((res, opt) => {
		const key = camelcase(opt.name());
		res[key] = this[key];
		return res;
	}, {});
};

/**
 * Argument `name` is missing.
 *
 * @param {String} name
 * @api private
 */

BotCommand.prototype.missingArgument = function(name) {
	return `  error: missing required argument ${name}`;
};


/**
 * `Option` is missing an argument, but received `flag` or nothing.
 *
 * @param {String} option
 * @api private
 */

BotCommand.prototype.optionMissingArgument = function(option) {
	return `  error: option ${option.flags} argument missing`;
}

/**
 * Unknown option `flag`.
 *
 * @param {String} flag
 * @api private
 */

BotCommand.prototype.unknownOption = function(flag) {
	return `  error: unknown option ${flag}`;
};

/**
 * Set the description to `str`.
 *
 * @param {String} str
 * @return {String|Command}
 * @api public
 */

BotCommand.prototype.description = function(str) {
	if (0 === arguments.length) return this._description;
	this._description = str;
	return this;
};

/**
 * Set an alias for the command
 *
 * @param {String} alias
 * @return {String|Command}
 * @api public
 */

BotCommand.prototype.alias = function(alias) {
	if (0 == arguments.length) return this._alias;
	this._alias = alias;
	return this;
};

/**
 * Set / get the command usage `str`.
 *
 * @param {String} str
 * @return {String|Command}
 * @api public
 */

BotCommand.prototype.usage = function(str) {
	var args = this._args.map(function(arg) {
		return humanReadableArgName(arg);
	});

	var usage = '[options]' + (this.commands.length ? ' [command]' : '') + (this._args.length ? ' ' + args.join(' ') : '');

	if (0 == arguments.length) return this._usage || usage;
	this._usage = str;

	return this;
};

/**
 * Get the name of the command
 *
 * @param {String} name
 * @return {String|Command}
 * @api public
 */

BotCommand.prototype.name = function() {
	return this._name;
};

/**
 * Return the largest option length.
 *
 * @return {Number}
 * @api private
 */

BotCommand.prototype.largestOptionLength = function() {
	return this.options.reduce(function(max, option) {
		return Math.max(max, option.flags.length);
	}, 0);
};

/**
 * Return help for options.
 *
 * @return {String}
 * @api private
 */

BotCommand.prototype.optionHelp = function() {
	var width = this.largestOptionLength();

	// Prepend the help information
	return [pad('-h, --help', width) + '  ' + 'output usage information']
		.concat(this.options.map(function(option) {
			return pad(option.flags, width) + '  ' + option.description;
		}))
		.join('\n');
};

/**
 * Return command help documentation.
 *
 * @return {String}
 * @api private
 */

BotCommand.prototype.commandHelp = function() {
	if (!this.commands.length) return '';

	var commands = this.commands.filter(function(cmd) {
		return !cmd._noHelp;
	}).map(function(cmd) {
		var args = cmd._args.map(function(arg) {
			return humanReadableArgName(arg);
		}).join(' ');

		return [
			cmd._name + (cmd._alias ? '|' + cmd._alias : '') + (cmd.options.length ? ' [options]' : '') + ' ' + args, cmd.description()
		];
	});

	var width = commands.reduce(function(max, command) {
		return Math.max(max, command[0].length);
	}, 0);

	return [
		'', '  Commands:', '', commands.map(function(cmd) {
			var desc = cmd[1] ? '  ' + cmd[1] : '';
			return pad(cmd[0], width) + desc;
		}).join('\n').replace(/^/gm, '    '), ''
	].join('\n');
};

/**
 * Return command help documentation.
 *
 * @return {String}
 * @api public
 */

BotCommand.prototype.help = function() {
	var desc = [];
	if (this._description) {
		desc = [
			'  ' + this._description, ''
		];
	}

	var cmdName = this._name;
	if (this._alias) {
		cmdName = cmdName + '|' + this._alias;
	}
	var usage = [
		'', '  Usage: ' + cmdName + ' ' + this.usage(), ''
	];

	var cmds = [];
	var commandHelp = this.commandHelp();
	if (commandHelp) cmds = [commandHelp];

	var options = [
		'  Options:', '', '' + this.optionHelp().replace(/^/gm, '    '), '', ''
	];

	return usage
		.concat(cmds)
		.concat(desc)
		.concat(options)
		.join('\n');
};

/**
 * Output help information for this command
 *
 * @api public
 */

BotCommand.prototype.outputHelp = function(metadata) {
	this.send(metadata, this.help());
};

/**
 * Sends a message using the configured send function
 *
 * @param  {Object} metadata Maybe needed by the send function
 * @param  {String} msg      Message to be sent
 * @api public 
 */
BotCommand.prototype.send = function(metadata, msg) {
	if (msg && msg.length > 0) {
		this.parseOpts.send(metadata, msg);
	}
};

/**
 * Checks if showHelpOnError is true and in that case adds the help to the error string
 * 
 * @param  {Array} arr Array with all the errors detected 
 * @api private
 */
BotCommand.prototype._checkShowHelp = function(arr) {
	if (this.parseOpts.showHelpOnError) {
		arr.push(this.help());
	}
};

/**
 * Tries to load a file passing this to be able to add subcommands
 *
 * Example of a included file:
 *
 * exports bot => {
 *   bot.command('test')
 *      .description('test command')
 *      .action( a => console.log('test'));
 * }
 * 
 * @param  {String} path Parent folder of the file
 * @param  {String} file Name of the file to load
 * @api public
 */
BotCommand.prototype.loadFile = function(path, file) {
	let absPath = Path.resolve(path);
	const ext = Path.extname(file);
	const full = Path.join(absPath, Path.basename(file, ext));
	if (require.extensions[ext]) {
		try {
			let script = require(full);
			if (typeof script == 'function') {
				script(this);
			}
		} catch (error) {
			throw new Error(`Unable to load ${full}: ${error.stack}`);
		}
	}
	return this;
}

/**
 * Load all files in a path to be able to include subcommands
 * 
 * @param  {String} path Where to search for include files
 * @return {BotCommand}      This to allow chaining
 * @api public
 */
BotCommand.prototype.load = function(path) {
	let absPath = Path.resolve(path);
	Fs.accessSync(absPath);
	Fs.readdirSync(absPath).sort().forEach(file => {
		this.loadFile(absPath, file);
	});
	return this;
}

/**
 * Camel-case the given `flag`
 *
 * @param {String} flag
 * @return {String}
 * @api private
 */

function camelcase(flag) {
	return flag.split('-').reduce(function(str, word) {
		return str + word[0].toUpperCase() + word.slice(1);
	});
}

/**
 * Pad `str` to `width`.
 *
 * @param {String} str
 * @param {Number} width
 * @return {String}
 * @api private
 */

function pad(str, width) {
	var len = Math.max(0, width - str.length);
	return str + Array(len + 1).join(' ');
}

/**
 * Output help information if necessary
 *
 * @param {Command} command to output help for
 * @param {Array} array of options to search for -h or --help
 * @api private
 */

function outputHelpIfNecessary(cmd, opts, metadata) {
	const options = opts || [];
	if (options.find(opt => opt == '--help' || opt == '-h')) {
		cmd.outputHelp(metadata);
		return true;
	}
	return false;
}

/**
 * Takes an argument an returns its human readable equivalent for help usage.
 *
 * @param {Object} arg
 * @return {String}
 * @api private
 */

function humanReadableArgName(arg) {
	var nameOutput = arg.name + (arg.variadic === true ? '...' : '');

	return arg.required ? '<' + nameOutput + '>' : '[' + nameOutput + ']'
}

/**
 * Expose the root command.
 */

exports = module.exports = new BotCommand();

/**
 * Expose `BotCommand`.
 */

exports.BotCommand = BotCommand;

/**
 * Expose `Option`.
 */

exports.Option = Option;