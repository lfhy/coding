import { createRequire } from "node:module";
import { execFile, execFileSync, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { access, chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Define a non-enumerable writable property and return the object. */
function defineProperty(object, key, value) {
	return Object.defineProperty(object, key, {
		writable: true,
		value,
		enumerable: false
	});
}
//#endregion
//#region vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
function tokenize(source, delimiters, delimiter) {
	const output = [];
	let state = 0;
	for (let i = 0; i < source.length; i++) {
		const code = source.charCodeAt(i);
		if (code >= 65 && code <= 90) {
			if (state === 1) {
				const next = source.charCodeAt(i + 1);
				if (next >= 97 && next <= 122) output.push(delimiter);
				output.push(code + 32);
			} else {
				if (state !== 0) output.push(delimiter);
				output.push(code + 32);
			}
			state = 1;
		} else if (code >= 97 && code <= 122) {
			output.push(code);
			state = 2;
		} else if (delimiters.includes(code)) {
			if (state !== 0) output.push(delimiter);
			state = 0;
		} else output.push(code);
	}
	return String.fromCharCode(...output);
}
/** Convert text to dash-delimited parameter case. */
function paramCase(source) {
	return tokenize(source, [45, 95], 45);
}
/** Runtime alias for `paramCase`. */
const hyphenate = paramCase;
//#endregion
//#region vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region vendor/cordis/src/utils.ts
/** Ordered collection of disposable values with O(1) deletion by value. */
var DisposableList = class {
	sn = 0;
	map = /* @__PURE__ */ new Map();
	weak = /* @__PURE__ */ new WeakMap();
	get length() {
		return this.map.size;
	}
	push(value) {
		const sn = ++this.sn;
		this.map.set(sn, value);
		this.weak.set(value, sn);
		return () => this.map.delete(sn);
	}
	delete(value) {
		const sn = this.weak.get(value);
		if (!sn) return false;
		return this.map.delete(sn);
	}
	clear() {
		const values = [...this.map.values()];
		this.map.clear();
		return values.reverse();
	}
	[Symbol.iterator]() {
		return this.map.values();
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return [...this];
	}
};
/** Shared symbols used to avoid public property-name collisions. */
const symbols = {
	shadow: Symbol.for("cordis.shadow"),
	receiver: Symbol.for("cordis.receiver"),
	original: Symbol.for("cordis.original"),
	metadata: Symbol.for("cordis.metadata"),
	initHooks: Symbol.for("cordis.initHooks"),
	checkProto: Symbol.for("cordis.checkProto"),
	effect: Symbol.for("cordis.effect"),
	filter: Symbol.for("cordis.filter"),
	isolate: Symbol.for("cordis.isolate"),
	intercept: Symbol.for("cordis.intercept"),
	init: Symbol.for("cordis.init"),
	check: Symbol.for("cordis.check"),
	config: Symbol.for("cordis.config"),
	invoke: Symbol.for("cordis.invoke"),
	extend: Symbol.for("cordis.extend"),
	tracker: Symbol.for("cordis.tracker"),
	resolveConfig: Symbol.for("cordis.resolveConfig")
};
const GeneratorFunction = function* () {}.constructor;
const AsyncGeneratorFunction = async function* () {}.constructor;
/** Return true when a plugin callback should be constructed with `new`. */
function isConstructor(func) {
	if (!func.prototype) return false;
	if (func instanceof GeneratorFunction) return false;
	if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
	return true;
}
/** Merge two prototype chains while preserving descriptors from `proto1`. */
function joinPrototype(proto1, proto2) {
	if (proto1 === Object.prototype) return proto2;
	const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
	for (const key of Reflect.ownKeys(proto1)) Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
	return result;
}
/** Return true for non-null objects and functions. */
function isObject$1(value) {
	return value && (typeof value === "object" || typeof value === "function");
}
/** Find a property descriptor by walking an object's prototype chain. */
function getPropertyDescriptor(target, prop) {
	let proto = target;
	while (proto) {
		const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
		if (desc) return desc;
		proto = Object.getPrototypeOf(proto);
	}
}
/** Wrap services/functions so method calls see the caller's active context. */
function getTraceable(ctx, value) {
	if (!isObject$1(value)) return value;
	if (Object.hasOwn(value, symbols.shadow)) return Object.getPrototypeOf(value);
	const tracker = value[symbols.tracker];
	if (!tracker) return value;
	return createTraceable(ctx, value, tracker);
}
/** Return a proxy that overlays readonly or writable properties onto a target. */
function withProps(target, props) {
	if (!props) return target;
	return new Proxy(target, {
		get: (target, prop, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
			return Reflect.get(target, prop, receiver);
		},
		set: (target, prop, value, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
			return Reflect.set(target, prop, value, receiver);
		}
	});
}
function withProp(target, prop, value) {
	return withProps(target, Object.defineProperty(Object.create(null), prop, {
		value,
		writable: false
	}));
}
function createShadow(ctx, target, property, receiver) {
	if (!property) return receiver;
	const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value;
	if (!origin) return receiver;
	return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }));
}
function createShadowMethod(ctx, value, outer, shadow) {
	return new Proxy(value, { apply: (target, thisArg, args) => {
		if (thisArg === outer) thisArg = shadow;
		return getTraceable(ctx, Reflect.apply(target, thisArg, args));
	} });
}
function createTraceable(ctx, value, tracker) {
	if (ctx[symbols.shadow] && !tracker.noShadow) ctx = Object.getPrototypeOf(ctx);
	const proxy = new Proxy(value, {
		get: (target, prop, receiver) => {
			if (prop === symbols.original) return target;
			if (prop === tracker.property) return ctx;
			if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
			if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
			let shadow, innerValue;
			const desc = getPropertyDescriptor(target, prop);
			if (desc && "value" in desc) innerValue = desc.value;
			else {
				shadow = createShadow(ctx, target, tracker.property, receiver);
				innerValue = Reflect.get(target, prop, shadow);
			}
			const innerTracker = innerValue?.[symbols.tracker];
			if (innerTracker) return createTraceable(ctx, innerValue, innerTracker);
			else if (!tracker.noShadow && typeof innerValue === "function") {
				shadow ??= createShadow(ctx, target, tracker.property, receiver);
				return createShadowMethod(ctx, innerValue, receiver, shadow);
			} else return innerValue;
		},
		set: (target, prop, value, receiver) => {
			if (prop === symbols.original) return false;
			if (prop === tracker.property) return false;
			if (typeof prop === "symbol") return Reflect.set(target, prop, value, receiver);
			if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver));
			const shadow = createShadow(ctx, target, tracker.property, receiver);
			return Reflect.set(target, prop, value, shadow);
		},
		apply: (target, thisArg, args) => {
			return applyTraceable(proxy, target, thisArg, args);
		}
	});
	return proxy;
}
function applyTraceable(proxy, value, thisArg, args) {
	if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
	return value[symbols.invoke].apply(proxy, args);
}
/** Create a callable service object that dispatches through `symbols.invoke`. */
function createCallable(name, proto, tracker) {
	const self = function(...args) {
		return applyTraceable(createTraceable(self["ctx"], self, tracker), self, this, args);
	};
	defineProperty(self, "name", name);
	return Object.setPrototypeOf(self, proto);
}
function handleError(info, reason, getOuterStack) {
	const innerLines = info.error.stack.split("\n");
	if (typeof reason?.stack !== "string") {
		const outerError = new Error(reason);
		const lines = outerError.stack.split("\n");
		lines.splice(1, Infinity, ...getOuterStack());
		outerError.stack = lines.join("\n");
		throw outerError;
	}
	const lines = reason.stack.split("\n");
	let index = lines.indexOf(innerLines[2]);
	if (index === -1) throw reason;
	index -= info.offset;
	while (index > 0) {
		if (!lines[index - 1].endsWith(" (<anonymous>)")) break;
		index -= 1;
	}
	lines.splice(index, Infinity, ...getOuterStack());
	reason.stack = lines.join("\n");
	throw reason;
}
/** Run a callback and splice outer call-site frames into thrown async errors. */
function composeError(callback, getOuterStack = buildOuterStack()) {
	const info = {
		offset: 1,
		error: /* @__PURE__ */ new Error()
	};
	try {
		const result = callback(info);
		if (isObject$1(result) && "then" in result) return result.then(void 0, (reason) => handleError(info, reason, getOuterStack));
		else return result;
	} catch (reason) {
		handleError(info, reason, getOuterStack);
	}
}
/** Capture a lazy stack-frame supplier for later error composition. */
function buildOuterStack(offset = 0) {
	const outerError = /* @__PURE__ */ new Error();
	return () => outerError.stack.split("\n").slice(3 + offset);
}
//#endregion
//#region vendor/cordis/src/events.ts
/**
* Return whether an event result should stop a bail-style dispatch.
*
* @param value — a listener's return value.
* @returns `true` unless `value` is `null`, `false`, or `undefined`.
*/
function isBailed(value) {
	return value !== null && value !== false && value !== void 0;
}
/**
* Event bus installed as `ctx.events` and mixed into every context.
*
* The service supports concurrent, synchronous, serial, bail, and waterfall
* dispatch and automatically disposes listeners with their owning fiber.
*/
var EventsService = class {
	ctx;
	_hooks = {};
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.on("internal/listener", function(name, listener, options) {
			if (name === "internal/update" && !options.global) return (this.fiber._hooks["internal/update"] ??= new DisposableList())[options.prepend ? "unshift" : "push"](listener);
		});
		this.on("internal/update", function(config, noSave, next) {
			const cbs = [...this._hooks["internal/update"] || []];
			const _next = () => {
				return (cbs.shift() ?? next).call(this, config, noSave, _next);
			};
			return _next();
		}, {
			global: true,
			prepend: true
		});
	}
	/**
	* Resolve listeners for one dispatch and apply context filtering.
	*
	* @param type — the dispatch mode, reported on `internal/dispatch`.
	* @param args — the raw dispatch arguments; consumed up to the event name.
	* @returns the matching listener callbacks, bound to the dispatch `this`.
	*/
	dispatch(type, args) {
		const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
		const name = args.shift();
		if (!name.startsWith("internal/")) this.emit("internal/dispatch", type, name, args, thisArg);
		const filter = thisArg?.[Context.filter];
		return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback.bind(thisArg));
	}
	/**
	* Run listeners concurrently and wait for all of them.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns a promise resolving once every listener has settled.
	*/
	async parallel(...args) {
		const errors = (await Promise.allSettled(this.dispatch("emit", args).map(async (cb) => cb(...args)))).filter((result) => result.status === "rejected");
		if (errors.length) throw new AggregateError(errors.map((error) => error.reason));
	}
	/**
	* Run listeners synchronously without waiting for returned promises.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	*/
	emit(...args) {
		this.dispatch("emit", args).map((cb) => cb(...args));
	}
	/**
	* Run listeners in order, awaiting each, until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	async serial(...args) {
		for (const cb of this.dispatch("serial", args)) {
			const result = await cb(...args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Run listeners synchronously until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	bail(...args) {
		for (const cb of this.dispatch("bail", args)) {
			const result = cb(...args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Compose listeners around the final `next` callback.
	*
	* The last dispatch argument is treated as the innermost `next`. Listeners
	* run outermost-first; a listener that does not call `next()` vetoes the
	* rest of the chain, including the built-in behavior.
	*
	* @param args — optional `this`, the event name, listener arguments, then `next`.
	* @returns the outermost listener's return value.
	*/
	waterfall(...args) {
		const cbs = this.dispatch("waterfall", args);
		const inner = args.pop();
		const next = () => {
			return (cbs.shift() ?? inner)(...args);
		};
		args.push(next);
		return next();
	}
	/**
	* Store a listener record as an effect on the current fiber.
	*
	* @param label — effect label shown in fiber diagnostics.
	* @param hooks — the listener list for one event.
	* @param callback — the listener to store.
	* @param options — placement and filtering options.
	* @returns a disposer that unregisters the listener.
	*/
	register(label, hooks, callback, options) {
		const method = options.prepend ? "unshift" : "push";
		return this.ctx.fiber.effect(() => {
			hooks[method]({
				ctx: this.ctx,
				callback,
				...options
			});
			return () => this.unregister(hooks, callback);
		}, label);
	}
	/**
	* Remove a stored listener record.
	*
	* @param hooks — the listener list for one event.
	* @param callback — the listener to remove.
	* @returns `true` if the listener was found and removed.
	*/
	unregister(hooks, callback) {
		const index = hooks.findIndex((hook) => hook.callback === callback);
		if (index >= 0) {
			hooks.splice(index, 1);
			return true;
		}
	}
	/**
	* Register an event listener owned by the current fiber.
	*
	* The listener is removed automatically when the fiber unloads. Throws
	* `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
	*
	* @param name — the event name to listen for.
	* @param listener — called with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	on(name, listener, options) {
		if (typeof options !== "object") options = { prepend: options };
		this.ctx.fiber.assertActive();
		listener = this.ctx.reflect.bind(listener);
		const result = this.bail(this.ctx, "internal/listener", name, listener, options);
		if (result) return result;
		const hooks = this._hooks[name] ||= [];
		const label = `ctx.on(${typeof name === "string" ? JSON.stringify(name) : name.toString()})`;
		return this.register(label, hooks, listener, options);
	}
	/**
	* Register an event listener that disposes itself after the first call.
	*
	* @param name — the event name to listen for.
	* @param listener — called at most once with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	once(name, listener, options) {
		const dispose = this.on(name, function(...args) {
			dispose();
			return listener.apply(this, args);
		}, options);
		return dispose;
	}
};
/** Built-in placeholder formatters used by `Logger.format()`. */
const defaultFormatters = {
	s: (value) => String(value),
	d: (value) => Math.trunc(Number(value)),
	i: (value) => Math.trunc(Number(value)),
	f: (value) => Number(value),
	o: (value) => JSON.stringify(value),
	O: (value) => JSON.stringify(value),
	c: () => "",
	C: (value, exporter, message) => {
		return Logger.color(exporter, Logger.code(message.name, exporter.colors), value);
	}
};
function isAggregateError(error) {
	return error instanceof Error && Array.isArray(error["errors"]);
}
/** Logger facade for one named subsystem. */
var Logger = class {
	service;
	static color(exporter, code, value, decoration = "") {
		if (!exporter.colors) return "" + value;
		return `\u001b[3${code < 8 ? code : "8;5;" + code}${exporter.colors >= 2 ? decoration : ""}m${value}\u001b[0m`;
	}
	static code(name, level) {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash << 3) - hash + name.charCodeAt(i) + 13;
			hash |= 0;
		}
		const colors = !level ? [] : level >= 2 ? c256 : c16;
		return colors[Math.abs(hash) % colors.length];
	}
	static format(exporter, message) {
		const args = message.args.slice();
		if (args[0] instanceof Error) {
			args[0] = args[0].stack || args[0].message;
			args.unshift("%s");
		} else if (typeof args[0] !== "string") args.unshift("%o");
		let format = args.shift();
		format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
			if (match === "%%") return "%";
			const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
			if (typeof formatter === "function") return formatter(args.shift(), exporter, message);
			return match;
		});
		const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
		for (let arg of args) {
			if (typeof arg === "object" && arg) arg = oFormatter(arg, exporter, message);
			format += " " + arg;
		}
		const { maxLength = 10240 } = exporter;
		return format.split(/\r?\n/g).map((line) => {
			return line.slice(0, maxLength) + (line.length > maxLength ? "..." : "");
		}).join("\n");
	}
	constructor(options, service) {
		this.service = service;
		Object.assign(this, options);
		this.error = this._method("error", 0);
		this.info = this._method("info", 1);
		this.warn = this._method("warn", 2);
		this.debug = this._method("debug", 3);
	}
	_method(type, level) {
		return (...args) => {
			if (args.length === 1 && args[0] instanceof Error) {
				if (args[0].cause) this[type](args[0].cause);
				else if (isAggregateError(args[0])) {
					args[0].errors.forEach((error) => this[type](error));
					return;
				}
			}
			const sn = ++this.service._snMessage;
			const ts = Date.now();
			for (const exporter of this.service.exporters.values()) {
				if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 1) < level) continue;
				const message = {
					sn,
					ts,
					type,
					level,
					name: this.name,
					...this.meta,
					args
				};
				exporter.export(message);
			}
		};
	}
};
/** ANSI 16-color palette indexes used for logger name coloring. */
const c16 = [
	6,
	2,
	3,
	4,
	5,
	1
];
/** ANSI 256-color palette indexes used for logger name coloring. */
const c256 = [
	20,
	21,
	26,
	27,
	32,
	33,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
	45,
	56,
	57,
	62,
	63,
	68,
	69,
	74,
	75,
	76,
	77,
	78,
	79,
	80,
	81,
	92,
	93,
	98,
	99,
	112,
	113,
	129,
	134,
	135,
	148,
	149,
	160,
	161,
	162,
	163,
	164,
	165,
	166,
	167,
	168,
	169,
	170,
	171,
	172,
	173,
	178,
	179,
	184,
	185,
	196,
	197,
	198,
	199,
	200,
	201,
	202,
	203,
	204,
	205,
	206,
	207,
	208,
	209,
	214,
	215,
	220,
	221
];
/**
* Built-in logging service.
*
* Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
* directly to log with the current fiber-derived name.
*/
var LoggerService = class LoggerService {
	bufferSize = 1e3;
	buffer = [];
	ctx;
	_snMessage = 0;
	_snExporter = 0;
	exporters = /* @__PURE__ */ new Map();
	constructor(ctx) {
		const tracker = {
			property: "ctx",
			noShadow: true
		};
		const self = createCallable("logger", joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		Object.assign(self, this);
		self.ctx = ctx;
		defineProperty(self, symbols.tracker, tracker);
		self.exporter({
			colors: 3,
			export: (message) => {
				self.buffer.push(message);
				if (self.buffer.length > self.bufferSize) self.buffer = self.buffer.slice(-self.bufferSize);
			}
		});
		return self;
	}
	/**
	* Register an exporter and dispose it with the current fiber.
	*
	* @param exporter — the sink that receives structured log messages.
	* @returns a disposer that removes the exporter.
	*/
	exporter(exporter) {
		return this.ctx.effect(() => {
			this.exporters.set(++this._snExporter, exporter);
			return () => this.exporters.delete(this._snExporter);
		}, "ctx.logger.exporter()");
	}
	_resolveConfig() {
		let intercept = this.ctx[symbols.intercept];
		const configs = [];
		while ("logger" in intercept) {
			if (Object.hasOwn(intercept, "logger")) configs.unshift(intercept["logger"]);
			intercept = Object.getPrototypeOf(intercept);
		}
		return Object.assign({}, ...configs);
	}
	[symbols.invoke](name) {
		const config = this._resolveConfig();
		const fiber = (this.ctx[symbols.shadow] ?? this.ctx).fiber;
		name ??= config.name;
		name ??= hyphenate(fiber.name);
		return new Logger({
			name,
			level: config.level,
			meta: { fiber: new WeakRef(fiber) }
		}, this);
	}
	static {
		for (const type of [
			"error",
			"info",
			"warn",
			"debug"
		]) LoggerService.prototype[type] = function(...args) {
			return this()[type](...args);
		};
	}
};
//#endregion
//#region vendor/cordis/src/fiber.ts
const kValidationError$1 = Symbol.for("ValidationError");
/** Error raised when plugin configuration fails standard-schema validation. */
var ValidationError$1 = class extends TypeError {
	name = "ValidationError";
	/**
	* Build the aggregated message from schema issues.
	*
	* @param issues — the standard-schema issues, one message line each.
	*/
	constructor(issues) {
		super(`invalid config:\n` + issues.map((issue) => {
			if (issue.path) return `  - ${issue.message} (at ${issue.path.join(".")})`;
			else return `  - ${issue.message}`;
		}).join("\n"));
	}
};
Object.defineProperty(ValidationError$1.prototype, kValidationError$1, { value: true });
/**
* Validate and normalize config for a plugin runtime before it starts.
*
* @param runtime — the plugin runtime whose `Config` schema to apply.
* @param config — the raw user config.
* @returns the validated config, or `config` unchanged if the runtime has no schema.
* @throws {ValidationError} when validation reports issues.
*/
function resolveConfig$1(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError$1(result.issues);
	else return result.value;
}
const effectInertia = /* @__PURE__ */ new WeakMap();
function runDisposable(dispose) {
	const result = dispose();
	return effectInertia.get(dispose)?.() ?? result;
}
/** Notify plugin teardown without allowing one observer to break ownership cleanup. */
function emitPluginDisposed(context, fiber) {
	const args = ["internal/plugin", fiber];
	let callbacks;
	try {
		callbacks = context.events.dispatch("emit", args);
	} catch (error) {
		context.logger.error(error);
		return;
	}
	for (const callback of callbacks) try {
		const returned = callback(...args);
		Promise.resolve(returned).catch((error) => context.logger.error(error));
	} catch (error) {
		context.logger.error(error);
	}
}
/** Framework error with a stable machine-readable code. */
var CordisError = class CordisError extends Error {
	code;
	/**
	* @param code — the stable error code; also the default message.
	* @param message — optional human-readable override.
	*/
	constructor(code, message) {
		super(message ?? CordisError.Code[code]);
		this.code = code;
	}
};
(function(_CordisError) {
	_CordisError.Code = { INACTIVE_EFFECT: "cannot create effect on inactive context" };
})(CordisError || (CordisError = {}));
const INACTIVE = "__INACTIVE__";
/**
* Runtime instance of one plugin application.
*
* A fiber tracks dependency state, validated config, lifecycle effects, and
* cleanup for the plugin context returned by `ctx.plugin()`.
*/
var Fiber = class {
	parent;
	inject;
	runtime;
	/** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
	uid;
	/** The context this fiber's plugin runs in (extends the parent context). */
	ctx;
	/** The validated plugin config (updated by `update()`). */
	config;
	/** The raw plugin config, re-resolved before each activation. */
	_config;
	/** Current lifecycle state; transitions emit `internal/status`. */
	state = 0;
	/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
	dispose;
	/** Snapshot of required service implementations while loaded; `undefined` otherwise. */
	store;
	/** The in-flight load/unload transition, if one is currently running. */
	inertia;
	_hooks = Object.create(null);
	_disposables = new DisposableList();
	context;
	_error;
	_runner;
	_store = Object.create(null);
	/**
	* Create a fiber. Plugin authors normally obtain fibers from `ctx.plugin()`
	* rather than constructing them directly.
	*
	* @param parent — the context the plugin was loaded from.
	* @param config — raw config, validated against the runtime's schema.
	* @param inject — resolved dependency map (service name → intercept config).
	* @param runtime — the shared plugin runtime, or `null` for the root fiber.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	*/
	constructor(parent, config, inject, runtime, getOuterStack) {
		this.parent = parent;
		this.inject = inject;
		this.runtime = runtime;
		this._config = config;
		const collect = (dispose) => {
			this._disposables.push(dispose);
		};
		if (runtime) {
			this.uid = parent.registry.counter;
			this.ctx = this.context = parent.extend({ fiber: this });
			const injectEntries = Object.entries(this.inject);
			if (injectEntries.length) {
				this.ctx[Context.intercept] = Object.create(parent[Context.intercept]);
				for (const [name, config] of injectEntries) {
					if (isNullable(config)) continue;
					this.ctx[Context.intercept][name] = config;
				}
			}
			this._runner = {
				epoch: INACTIVE,
				getOuterStack,
				execute: function() {
					if (isConstructor(runtime.callback)) {
						const instance = new runtime.callback(this.ctx, this.config);
						for (const hook of instance?.[symbols.initHooks] ?? []) hook();
						return instance?.[symbols.init]?.();
					} else return runtime.callback(this.ctx, this.config);
				},
				collect
			};
			this.dispose = parent.fiber.effect(() => {
				const remove = runtime.fibers.push(this);
				return async () => {
					this.uid = null;
					emitPluginDisposed(this.context, this);
					if (this.ctx.registry.has(runtime.callback)) {
						remove();
						if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback);
					}
					this._setEpoch(INACTIVE);
					if (!this.inertia) this._updateState(() => {
						this.inertia = this._unload();
						return 5;
					});
					while (this.inertia) await this.inertia;
				};
			}, "ctx.plugin()");
			try {
				this.context.emit("internal/plugin", this);
			} catch (error) {
				Promise.resolve(this.dispose()).catch((reason) => this.ctx.logger.error(reason));
				throw error;
			}
			if (this.uid !== null && parent.fiber.state !== 5) {
				for (const name of Object.keys(this.inject)) this._checkImpl(name);
				this._refresh();
			}
		} else {
			this.uid = 0;
			this.ctx = this.context = parent;
			this.state = 2;
			this.store = Object.create(null);
			this._runner = {
				epoch: "",
				getOuterStack,
				execute: () => {},
				collect
			};
			this.dispose = () => this.restart();
		}
	}
	/** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
	get name() {
		let fiber = this;
		do {
			if (fiber.runtime?.name) return fiber.runtime.name;
			fiber = fiber.parent.fiber;
		} while (fiber !== fiber.parent.fiber);
		return "root";
	}
	/**
	* Throw if the fiber has already been disposed.
	*
	* @returns nothing when the fiber is still active.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
	*/
	assertActive() {
		if (this.uid !== null) return;
		throw new CordisError("INACTIVE_EFFECT");
	}
	_execute(runner) {
		const oldEpoch = runner.epoch;
		return composeError((info) => {
			const safeCollect = (dispose) => {
				if (typeof dispose === "function") runner.collect(dispose);
				else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
			};
			const effect = runner.execute.call(this);
			if (typeof effect === "function") return runner.collect(effect);
			else if (isNullable(effect)) {} else if (!isObject$1(effect)) throw new TypeError("Invalid effect");
			else if ("then" in effect) return effect.then(safeCollect);
			else if (Symbol.iterator in effect) {
				info.error = /* @__PURE__ */ new Error();
				const iter = effect[Symbol.iterator]();
				while (true) {
					const result = iter.next();
					safeCollect(result.value);
					if (result.done) return;
				}
			} else if (Symbol.asyncIterator in effect) {
				const iter = effect[Symbol.asyncIterator]();
				return (async () => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					while (true) {
						if (runner.epoch !== oldEpoch) return;
						const result = await iter.next();
						safeCollect(result.value);
						if (result.done) return;
					}
				})();
			} else throw new TypeError("Invalid effect");
		}, runner.getOuterStack);
	}
	effect(execute, label = "anonymous") {
		this.assertActive();
		if (this.state === 5) throw new CordisError("INACTIVE_EFFECT");
		const disposables = [];
		let disposing = false;
		let disposalTask;
		const dispose = () => {
			if (disposing) return disposalTask;
			disposing = true;
			let task;
			for (const disposable of disposables.splice(0).reverse()) if (task) task = task.then(() => runDisposable(disposable));
			else {
				const result = runDisposable(disposable);
				if (isObject$1(result) && "then" in result) task = result;
			}
			return disposalTask = task;
		};
		const meta = {
			label,
			children: []
		};
		const runner = {
			execute,
			epoch: true,
			collect: (dispose) => {
				disposables.push(dispose);
				this._disposables.delete(dispose);
				if (dispose[symbols.effect]) meta.children.push(dispose[symbols.effect]);
			},
			getOuterStack: buildOuterStack()
		};
		let task;
		let executing = true;
		let resolveSetup;
		let rejectSetup;
		let setupBarrier;
		let setupFailed = false;
		let inFlight;
		let removeWrapper = () => false;
		const waitForSetup = () => {
			setupBarrier ??= new Promise((resolve, reject) => {
				resolveSetup = resolve;
				rejectSetup = reject;
			});
			return setupBarrier;
		};
		const disposeAfter = (setup) => {
			return Promise.resolve(setup).then(() => dispose(), async (reason) => {
				await dispose();
				throw reason;
			});
		};
		const finalizeDisposal = (callback) => {
			let result;
			try {
				result = callback();
			} catch (error) {
				removeWrapper();
				throw error;
			}
			if (isObject$1(result) && "then" in result) {
				const pending = Promise.resolve(result).finally(() => {
					removeWrapper();
					if (inFlight === pending) inFlight = void 0;
				});
				return inFlight = pending;
			}
			removeWrapper();
			return result;
		};
		const wrapper = defineProperty(() => {
			if (!runner.epoch) return setupFailed ? inFlight : void 0;
			runner.epoch = false;
			return finalizeDisposal(() => {
				if (executing) return disposeAfter(waitForSetup());
				return task ? disposeAfter(task) : dispose();
			});
		}, symbols.effect, meta);
		effectInertia.set(wrapper, () => inFlight);
		removeWrapper = this._disposables.push(wrapper);
		try {
			task = this._execute(runner);
		} catch (reason) {
			executing = false;
			setupFailed = true;
			runner.epoch = false;
			let cleanup;
			try {
				cleanup = finalizeDisposal(dispose);
			} finally {
				rejectSetup?.(reason);
			}
			if (isObject$1(cleanup) && "then" in cleanup) cleanup.catch((error) => this.ctx.logger.error(error));
			throw reason;
		}
		executing = false;
		if (setupBarrier) Promise.resolve(task).then(resolveSetup, rejectSetup);
		task?.catch(() => {
			if (!runner.epoch) return dispose();
			return finalizeDisposal(dispose);
		}).catch((error) => this.ctx.logger.error(error));
		const disposeAsync = () => {
			if (!runner.epoch) return;
			runner.epoch = false;
			return finalizeDisposal(dispose);
		};
		wrapper.then = async (onFulfilled, onRejected) => {
			return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
		};
		return wrapper;
	}
	/**
	* Return metadata for currently registered effects.
	*
	* @returns one {@link EffectMeta} tree per labeled live effect.
	*/
	getEffects() {
		return [...this._disposables].map((dispose) => dispose[symbols.effect]).filter(Boolean);
	}
	_getState() {
		if (this.uid === null) return 4;
		if (this._error) return 3;
		if (this._runner.epoch !== INACTIVE) return 2;
		return 0;
	}
	_updateState(callback) {
		const oldState = this.state;
		this.state = callback() ?? this._getState();
		if (oldState === this.state) return;
		this.context.emit("internal/status", this, oldState);
		if (oldState !== 2 && this.state !== 2) return;
		for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
			const impl = this.ctx.reflect.store[key];
			if (impl.fiber !== this) continue;
			this.ctx.reflect.notify([impl.name]);
		}
	}
	_checkImpl(name) {
		const impl = this.ctx.reflect._getImpl(name, true);
		if (!impl) return delete this._store[name];
		try {
			if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) return delete this._store[name];
		} catch (error) {
			impl.fiber.ctx.logger.error(error);
			return delete this._store[name];
		}
		this._store[name] = impl;
	}
	_refresh() {
		let epoch = false;
		epoch = "";
		for (const name of Object.keys(this.inject)) {
			const impl = this._store[name];
			if (!impl) {
				epoch = INACTIVE;
				break;
			}
			epoch += ":" + impl.fiber.uid;
		}
		this._setEpoch(epoch);
	}
	_setEpoch(epoch) {
		const oldEpoch = this._runner.epoch;
		if (epoch === oldEpoch) return;
		this._runner.epoch = epoch;
		if (this.inertia) return;
		this._updateState(() => {
			if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
				this.inertia = this._reload();
				return 1;
			} else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	_resolveConfig(config) {
		config = this.context.waterfall(this, "internal/config", config, () => config);
		return this.runtime ? resolveConfig$1(this.runtime, config) : config;
	}
	async _reload() {
		this.store = { ...this._store };
		const oldEpoch = this._runner.epoch;
		try {
			await Promise.resolve();
			if (this._runner.epoch === oldEpoch) {
				this.config = this._resolveConfig(this._config);
				await this._execute(this._runner);
				this._error = void 0;
			}
		} catch (reason) {
			this.ctx.logger.error(reason);
			this._error = reason;
			this._runner.epoch = INACTIVE;
		}
		this._updateState(() => {
			if (this._runner.epoch === oldEpoch) this.inertia = void 0;
			else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	async _unload() {
		await Promise.all(this._disposables.clear().map(async (dispose) => {
			try {
				await composeError(async (info) => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					await runDisposable(dispose);
				}, this._runner.getOuterStack);
			} catch (reason) {
				this.ctx.logger.error(reason);
			}
		}));
		this.store = void 0;
		this._updateState(() => {
			if (this._runner.epoch === INACTIVE) this.inertia = void 0;
			else {
				this.inertia = this._reload();
				return 1;
			}
		});
	}
	/**
	* Wait for current lifecycle work and rethrow startup errors.
	*
	* @returns this fiber, once it has settled into a stable state.
	* @throws the config-validation or plugin-startup error, if any.
	*/
	async await() {
		while (this.inertia) await this.inertia;
		if (this._error) throw this._error;
		return this;
	}
	/**
	* Dispose and immediately reload this plugin with its current config.
	*
	* @returns a promise resolving once the reload settled.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
	*/
	async restart() {
		this.assertActive();
		this._setEpoch(INACTIVE);
		this._refresh();
		await this.await();
	}
	/**
	* Validate and apply new config, then restart the plugin.
	*
	* Runs the `internal/update` waterfall first, so update hooks (and HMR)
	* can veto or replace the restart.
	*
	* @param config — the new raw config; validated before anything restarts.
	* @param noSave — hint for persistence hooks not to write the change back.
	* @returns the update waterfall result; the default restart returns a promise.
	* @throws when validation, an update listener, or the restarted plugin fails.
	*/
	update(config, noSave = false) {
		this.assertActive();
		this._config = config;
		if (this.state !== 2) {
			this._error = void 0;
			this._setEpoch(INACTIVE);
			this._refresh();
			return;
		}
		config = this._resolveConfig(config);
		return this.context.waterfall(this, "internal/update", config, noSave, () => {
			this.config = config;
			this._error = void 0;
			return this.restart();
		});
	}
};
//#endregion
//#region vendor/cordis/src/reflect.ts
function enhanceError(error) {
	const lines = error.stack.split("\n");
	lines.splice(0, 2, `Error: ${error.message}`);
	error.stack = lines.join("\n");
	return error;
}
const RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
	return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}
/**
* Reflection and service-resolution layer installed as `ctx.reflect`.
*
* This service powers the context proxy, service registration, accessors, and
* the mixins that expose core service methods directly on `ctx`.
*/
var ReflectService = class {
	ctx;
	/** Proxy traps implementing service resolution for every context object. */
	static handler = {
		get: (target, prop, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
			if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
			const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
			try {
				const def = target.reflect.props[prop];
				if (def?.type === "accessor") return def.get.call(ctx, ctx[symbols.receiver], error);
				if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false);
				return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
					const key = target[symbols.isolate][prop];
					let fiber = (ctx[symbols.shadow] ?? ctx).fiber;
					while (true) {
						const impl = fiber.store?.[prop];
						if (impl) return getTraceable(ctx, impl.value);
						if (prop in fiber.inject) {
							error.message = `cannot get required service "${prop}" in inactive context`;
							throw error;
						}
						if (!fiber.runtime) throw error;
						if (fiber.parent[symbols.isolate][prop] !== key) throw error;
						fiber = fiber.parent.fiber;
					}
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		set: (target, prop, value, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.set(target, prop, value, ctx);
			const error = /* @__PURE__ */ new Error(`cannot set property "${prop}" without provide`);
			const def = target.reflect.props[prop];
			if (!def) {
				if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx);
				throw enhanceError(error);
			}
			try {
				if (def.type === "accessor") {
					if (!def.set) return false;
					return def.set.call(ctx, value, ctx[symbols.receiver], error);
				}
				return ctx.events.waterfall("internal/set", ctx, prop, value, error, () => {
					return ctx.reflect.set(prop, value, error);
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		has: (target, prop) => {
			if (isSpecialProperty(prop)) return Reflect.has(target, prop);
			if (Reflect.has(target, prop)) return true;
			return !!target.reflect.props[prop];
		}
	};
	/** Service implementations, keyed by isolation label. */
	store = Object.create(null);
	/** Declared context properties (services and accessors), by name. */
	props = Object.create(null);
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.mixin("reflect", [
			"get",
			"set",
			"provide",
			"accessor",
			"mixin"
		]);
		this.mixin("fiber", ["runtime", "effect"]);
		this.mixin("registry", ["inject", "plugin"]);
		this.mixin("events", [
			"on",
			"once",
			"parallel",
			"emit",
			"serial",
			"bail",
			"waterfall"
		]);
	}
	/**
	* Read a service from the store without the inject requirement.
	*
	* @param name — the service name.
	* @param strict — when `true`, only return implementations whose providing
	* fiber is currently active.
	* @returns the service value, or `undefined` when not (yet) provided.
	*/
	get(name, strict = true) {
		return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
	}
	_getImpl(name, strict = true) {
		const key = this.ctx[symbols.isolate][name];
		const impl = key && this.store[key];
		if (!impl) return;
		if (strict && impl.fiber.state !== 2) return;
		return impl;
	}
	/**
	* Overwrite a provided service's value.
	*
	* @param name — the service name.
	* @param value — the new service value.
	* @param error — carrier for the caller stack in diagnostics.
	* @returns `true` on success.
	* @throws when `name` was never provided, or was provided by another fiber.
	*/
	set(name, value, error) {
		const key = this.ctx[symbols.isolate][name];
		const impl = this.store[key];
		if (!impl) throw new Error(`cannot set property "${name}" without provide`);
		if (impl.fiber !== this.ctx.fiber) throw new Error(`cannot set property "${name}" in multiple fibers`);
		impl.value = value;
		return true;
	}
	/**
	* Register a service implementation owned by the current fiber.
	*
	* See the `ctx.provide()` overload above for the full contract.
	*
	* @param name — the service name.
	* @param value — the service value.
	* @param check — optional availability predicate for dependents.
	* @returns a disposer that unregisters the service.
	*/
	provide(name, value, check) {
		return this.ctx.fiber.effect(() => {
			if (!this.props[name]) this.props[name] ??= { type: "service" };
			else if (this.props[name].type !== "service") throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = { type: "service" };
			this.ctx.root[symbols.isolate][name] ??= Symbol(name);
			const key = this.ctx[symbols.isolate][name];
			const impl = {
				name,
				value,
				fiber: this.ctx.fiber,
				check
			};
			if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`);
			this.store[key] = impl;
			this.ctx.fiber.store[name] = impl;
			if (this.ctx.fiber.state === 2) this.notify([name]);
			return async () => {
				delete this.store[key];
				const fibers = this.notify([name]);
				await Promise.allSettled(fibers.map((fiber) => fiber.await()));
				delete this.ctx.fiber.store[name];
			};
		}, `ctx.provide(${JSON.stringify(name)})`);
	}
	/**
	* Re-evaluate every fiber that requires one of the given services.
	*
	* @param names — the service names that changed.
	* @param filter — restricts notification to matching isolation scopes.
	* @returns the fibers whose dependency state was refreshed.
	*/
	notify(names, filter = (ctx, name) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
		const fibers = [];
		for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
			let hasUpdate = false;
			for (const name of names) {
				if (!(name in fiber.inject)) continue;
				if (!filter(fiber.ctx, name)) continue;
				hasUpdate = true;
				fiber._checkImpl(name);
			}
			if (!hasUpdate) continue;
			fiber._refresh();
			fibers.push(fiber);
		}
		for (const name of names) {
			const self = Object.create(this.ctx);
			self[symbols.filter] = (target) => filter(target, name);
			this.ctx.events.emit(self, "internal/service", name, this._getImpl(name, false)?.value);
		}
		return fibers;
	}
	/**
	* Define a computed context property backed by get/set hooks.
	*
	* @param name — the context property name.
	* @param options — the `get` hook and optional `set` hook.
	* @returns a disposer that removes the accessor.
	*/
	accessor(name, options) {
		return this.ctx.fiber.effect(() => {
			if (name in this.props) throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = {
				type: "accessor",
				...options
			};
			return () => delete this.props[name];
		}, `ctx.accessor(${JSON.stringify(name)})`);
	}
	/**
	* Expose selected members of a service directly on `ctx`.
	*
	* See the `ctx.mixin()` overload above for the full contract.
	*
	* @param source — a context property name or a source object.
	* @param mixins — keys to forward, or a source-key → ctx-key map.
	* @returns a disposer that removes all created accessors.
	*/
	mixin(source, mixins) {
		const self = this;
		return this.ctx.fiber.effect(function* () {
			const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
			const getTarget = (ctx, error) => {
				return ctx[source];
			};
			for (const [key, value] of entries) yield self.accessor(value, {
				get(receiver, error) {
					const service = getTarget(this, error);
					if (isNullable(service)) return service;
					const mixin = receiver ? withProps(receiver, service) : service;
					const value = Reflect.get(service, key, mixin);
					if (typeof value !== "function") return value;
					return value.bind(mixin ?? service);
				},
				set(value, receiver, error) {
					const service = getTarget(this, error);
					const mixin = receiver ? withProps(receiver, service) : service;
					return Reflect.set(service, key, value, mixin);
				}
			});
		}, `ctx.mixin(${JSON.stringify(source)})`);
	}
	/**
	* Attach this context's tracing wrapper to a value.
	*
	* @param value — the value to wrap.
	* @returns the traceable wrapper (or the value itself when not applicable).
	*/
	trace(value) {
		return getTraceable(this.ctx, value);
	}
	/**
	* Wrap a callback so calls trace `this` and arguments to this context.
	*
	* @param callback — the function to wrap.
	* @returns a proxy delegating to `callback` with traced values.
	*/
	bind(callback) {
		return new Proxy(callback, {
			apply: (target, thisArg, args) => {
				return Reflect.apply(target, this.trace(thisArg), args.map((arg) => this.trace(arg)));
			},
			construct: (target, args, newTarget) => {
				return Reflect.construct(target, args.map((arg) => this.trace(arg)), newTarget);
			}
		});
	}
};
//#endregion
//#region vendor/cordis/src/registry.ts
function isApplicable(object) {
	return object && typeof object === "object" && typeof object.apply === "function";
}
/**
* Decorator for declaring service dependencies on classes or class methods.
*
* On classes it contributes to the plugin's static `inject` map. On methods it
* delays the method call until the declared services are available.
*/
/**
* @param name — the required service name.
* @param config — optional intercept config applied for that service.
* @returns the class or method decorator.
*/
function Inject(name, config) {
	return function(value, decorator) {
		if (decorator.kind === "class") {
			if (!Object.hasOwn(value, "inject")) {
				defineProperty(value, "inject", Object.create(Object.getPrototypeOf(value).inject ?? null));
				defineProperty(value.inject, symbols.checkProto, true);
			}
			value.inject[name] = config;
		} else if (decorator.kind === "method") {
			const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null);
			inject[name] = config;
			decorator.addInitializer(function() {
				const property = this[symbols.tracker]?.property;
				(this[symbols.initHooks] ??= []).push(() => {
					this.ctx.inject(inject, (ctx) => {
						return value.call(property ? withProps(this, { [property]: ctx }) : this);
					});
				});
			});
		} else throw new Error("@Inject() can only be used on class or class methods");
	};
}
(function(_Inject) {
	function resolve(inject, result = Object.create(null)) {
		if (!inject) return result;
		if (Array.isArray(inject)) for (const name of inject) result[name] = null;
		else if (Reflect.has(inject, symbols.checkProto)) {
			Object.assign(result, resolve(Object.getPrototypeOf(inject)));
			for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		} else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		return result;
	}
	_Inject.resolve = resolve;
})(Inject || (Inject = {}));
/**
* Plugin registry installed as `ctx.registry` and mixed into every context.
*
* It normalizes plugin shapes, tracks plugin runtimes, starts fibers, and
* exposes map-like inspection over active plugin callbacks.
*/
var RegistryService = class {
	ctx;
	_counter = 0;
	_internal = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
	}
	/** Allocate the next fiber uid (increments on every read). */
	get counter() {
		return ++this._counter;
	}
	/** Number of registered plugin runtimes. */
	get size() {
		return this._internal.size;
	}
	/**
	* Resolve a supported plugin shape to its executable callback.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @returns the callback identifying the plugin, or `undefined` if invalid.
	*/
	resolve(plugin) {
		try {
			if (typeof plugin === "function") return plugin;
			if (isApplicable(plugin)) return plugin.apply;
		} catch {}
	}
	/**
	* Look up the runtime record for a plugin.
	*
	* @param plugin — any supported plugin shape.
	* @returns the runtime, or `undefined` when the plugin is not registered.
	*/
	get(plugin) {
		const key = this.resolve(plugin);
		return key && this._internal.get(key);
	}
	/**
	* Check whether a plugin has a registered runtime.
	*
	* @param plugin — any supported plugin shape.
	* @returns `true` when at least one fiber of the plugin exists.
	*/
	has(plugin) {
		const key = this.resolve(plugin);
		return !!key && this._internal.has(key);
	}
	/**
	* Dispose every running fiber for a plugin and remove its runtime record.
	*
	* @param plugin — any supported plugin shape.
	* @returns the removed runtime, or `undefined` when none was registered.
	*/
	delete(plugin) {
		const key = this.resolve(plugin);
		const runtime = key && this._internal.get(key);
		if (!runtime) return;
		this._internal.delete(key);
		for (const fiber of runtime.fibers) fiber.dispose();
		return runtime;
	}
	/** Iterate the registered plugin callbacks. */
	keys() {
		return this._internal.keys();
	}
	/** Iterate the registered plugin runtimes. */
	values() {
		return this._internal.values();
	}
	/** Iterate `[callback, runtime]` pairs. */
	entries() {
		return this._internal.entries();
	}
	/**
	* Visit every registered runtime.
	*
	* @param callback — receives each runtime and its identifying callback.
	*/
	forEach(callback) {
		return this._internal.forEach(callback);
	}
	/**
	* Start a callback once the requested dependencies are available.
	*
	* @param inject — required services, as an array or a name → config map.
	* @param callback — plugin body called with `(ctx, config)`.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	inject(inject, callback) {
		return this.plugin({
			inject,
			apply: callback,
			name: callback.name
		});
	}
	/**
	* Start a plugin in the current context and return its fiber.
	*
	* Creates (or reuses) the plugin's runtime record, then starts a new fiber
	* under the current context. Throws if `plugin` is not a supported shape or
	* if the current fiber is already disposed.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @param config — the plugin config, validated against its `Config` schema.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	plugin(plugin, config, getOuterStack = buildOuterStack()) {
		const callback = this.resolve(plugin);
		if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
		this.ctx.fiber.assertActive();
		let runtime = this._internal.get(callback);
		if (!runtime) {
			let name = plugin.name;
			if (name === "apply") name = void 0;
			runtime = {
				name,
				callback,
				fibers: new DisposableList(),
				Config: plugin.Config
			};
			this._internal.set(callback, runtime);
		}
		const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
		const wrapped = Object.create(fiber);
		wrapped.then = (onFulfilled, onRejected) => {
			return fiber.await().then(onFulfilled, onRejected);
		};
		return wrapped;
	}
};
//#endregion
//#region vendor/cordis/src/context.ts
/**
* Root and child dependency containers for Cordis plugins.
*
* A context is a proxy: normal property reads go through the service resolver,
* while `extend()`, `isolate()`, and `intercept()` create scoped child
* contexts without mutating their parent.
*/
var Context = class Context {
	/** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
	static effect = symbols.effect;
	/** Symbol key for a context's listener filter, consulted on every event dispatch. */
	static filter = symbols.filter;
	/** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
	static isolate = symbols.isolate;
	/** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
	static intercept = symbols.intercept;
	/**
	* Returns true for Cordis context proxies and context prototypes.
	*
	* Works across realms and across multiple copies of cordis, because the
	* brand is keyed by a global symbol rather than by `instanceof`.
	*
	* @param value — the value to test.
	* @returns `true` if `value` is a Cordis context, narrowing its type.
	*/
	static is(value) {
		return !!value?.[Context.is];
	}
	static {
		Context.is[Symbol.toPrimitive] = () => Symbol.for("cordis.is");
		Context.prototype[Context.is] = true;
	}
	/** Create the root context and install the built-in services. */
	constructor() {
		this[symbols.isolate] = Object.create(null);
		this[symbols.intercept] = Object.create(null);
		const self = new Proxy(this, ReflectService.handler);
		this.root = self;
		this.baseUrl = void 0;
		this.fiber = new Fiber(self, {}, Object.create(null), null, () => []);
		this.reflect = new ReflectService(self);
		this.registry = new RegistryService(self);
		this.events = new EventsService(self);
		this.logger = new LoggerService(self);
		this.fiber._disposables.clear();
		return self;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return `Context <${this.fiber.name}>`;
	}
	/**
	* Create a child context with extra metadata on top of the current scope.
	*
	* The child prototypally inherits every property of this context; own
	* properties of `meta` shadow the inherited ones. The parent is not mutated.
	*
	* @param meta — own properties (including symbol keys) to define on the child.
	* @returns a child context inheriting from this one.
	*/
	extend(meta = {}) {
		const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
		const self = Object.create(getTraceable(this, this));
		for (const prop of Reflect.ownKeys(meta)) Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop));
		if (!shadow) return self;
		return Object.assign(Object.create(self), { [symbols.shadow]: shadow });
	}
	/**
	* Create a child context with an independent service scope for `name`.
	*
	* Below the returned context, reads and writes of the service `name`
	* resolve against the new label instead of the parent's, so a different
	* implementation can be provided without affecting the parent scope.
	* Passing the same `label` to two `isolate()` calls joins their scopes.
	*
	* @param name — the service name to isolate.
	* @param label — scope label to join; defaults to a fresh unique symbol.
	* @returns a child context whose `name` service resolves in the new scope.
	*/
	isolate(name, label) {
		const shadow = Object.create(this[symbols.isolate]);
		shadow[name] = label ?? Symbol(name);
		return this.extend({ [symbols.isolate]: shadow });
	}
	intercept(name, config) {
		const intercept = Object.create(this[symbols.intercept]);
		intercept[name] = config;
		return this.extend({ [symbols.intercept]: intercept });
	}
};
//#endregion
//#region vendor/cordis/src/service.ts
/**
* Base class for services that expose a named API on `ctx`.
*
* Subclasses call `super(ctx, name)` from their constructor. The service is
* registered immediately and is automatically removed with the owning fiber.
*/
var Service = class Service {
	ctx;
	/** Symbol key of an instance method run after construction (class plugins). */
	static init = symbols.init;
	/** Symbol key of the availability predicate passed to `ctx.provide()`. */
	static check = symbols.check;
	/** Symbol key of the phantom intercept-config type parameter. */
	static config = symbols.config;
	/** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
	static invoke = symbols.invoke;
	/** Symbol key of the helper deriving an extended service instance. */
	static extend = symbols.extend;
	/** Symbol key of the tracker metadata used for context tracing. */
	static tracker = symbols.tracker;
	/** Symbol key of the intercept-config resolution helper below. */
	static resolveConfig = symbols.resolveConfig;
	/** The service name this instance is registered under. */
	name;
	/**
	* Register this instance as `name` in the current context.
	*
	* Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
	* service is unregistered automatically when the owning fiber unloads.
	* Services with a `[Service.invoke]` body return a callable instance.
	*
	* @param ctx — the context to register in (stored as `this.ctx`).
	* @param name — the service name; defaults to the static `provide` field.
	*/
	constructor(ctx, name) {
		this.ctx = ctx;
		name ??= this.constructor["provide"];
		let self = this;
		const tracker = {
			associate: name,
			property: "ctx"
		};
		if (self[symbols.invoke]) self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		self.ctx = ctx;
		self.name = name;
		defineProperty(self, symbols.tracker, tracker);
		self.ctx.reflect.provide(name, self, this[symbols.check]);
		return self;
	}
	[symbols.filter](ctx) {
		return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
	}
	[symbols.extend](props) {
		let self;
		if (this[Service.invoke]) self = createCallable(this.name, this, this[symbols.tracker]);
		else self = Object.create(this);
		return Object.assign(self, props);
	}
	/**
	* Merge intercept config from ancestors with optional base and head values.
	*
	* Entries added closer to the root apply first; `base` is prepended and
	* `head` appended. Uses `Config.merge` when the service declares one,
	* otherwise a shallow `Object.assign`.
	*
	* @param base — lowest-precedence config merged before all intercepts.
	* @param head — highest-precedence config merged after all intercepts.
	* @returns the merged config.
	*/
	[symbols.resolveConfig](base, head) {
		let intercept = this.ctx[Context.intercept];
		const configs = [];
		while (this.name in intercept) {
			if (Object.hasOwn(intercept, this.name)) configs.unshift(intercept[this.name]);
			intercept = Object.getPrototypeOf(intercept);
		}
		if (base) configs.unshift(base);
		if (head) configs.push(head);
		if (this["Config"]?.merge) return this["Config"].merge(...configs);
		else return Object.assign({}, ...configs);
	}
	static [Symbol.hasInstance](instance) {
		if (!instance) return false;
		let constructor = instance.constructor;
		while (constructor) {
			constructor = constructor.prototype?.constructor;
			if (constructor === this) return true;
			constructor &&= Object.getPrototypeOf(constructor);
		}
		return false;
	}
};
//#endregion
//#region vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region packages/core/scope/src/store.ts
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name) {
		return this.data.get(name);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name) {
		return this.data.has(name);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
//#endregion
//#region packages/core/scope/src/index.ts
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = /* @__PURE__ */ new WeakMap();
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
//#endregion
//#region packages/llm/llm/src/brand.ts
/**
* Brand a message identifier.
* @param id - the opaque message identifier.
* @returns the same string, branded; no validation is performed.
*/
function MessageId(id) {
	return id;
}
/**
* Brand a string as a {@link CallId}.
* @param id - the provider-issued (or synthesized) call id.
* @returns the same string, branded; no validation is performed.
*/
function CallId(id) {
	return id;
}
/**
* Deep-freeze a value in place with an iterative traversal, guarding cycles,
* so later mutation throws without imposing a JavaScript call-stack depth cap.
* {@link AbortSignal} objects are deliberately skipped because they are the
* request's live cancellation channel and freezing them breaks abort.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return freezeMessage({
		...input,
		id: MessageId(crypto.randomUUID())
	});
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region packages/llm/llm/src/error.ts
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module coding-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
//#endregion
//#region packages/llm/llm/src/retry-policy.ts
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module coding-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = Schema.object({
	initialDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = Schema.object({
	mode: Schema.const("normal").required(),
	maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = Schema.object({
	mode: Schema.const("always").required(),
	backoff: backoffSchema
});
Schema.union([normalPolicySchema, alwaysPolicySchema]);
new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
//#endregion
//#region packages/llm/llm/src/attribution.ts
/**
* 模型提供方请求共用的非秘密应用标识和 User-Agent。
* @module coding-llm/attribution
*/
const { version: version$1 } = createRequire(import.meta.url)("../package.json");
//#endregion
//#region packages/llm/llm/src/never.ts
/**
* Exhaustiveness helper for closed core unions. Use {@link assertNever} at the default branch so a
* new variant fails compilation at every required handler. Do not use it for declaration-merged
* unions such as session events or content blocks: handle known variants and explicitly fall
* through because plugins may add valid unknown cases.
* @module coding-llm/never
*/
/**
* Mark an unreachable closed-union branch. A newly unhandled typed variant fails at the call site;
* a value that escaped its type throws with diagnostics at runtime.
* @param value - the impossible value; typed `never` so an unhandled variant fails compilation at the call site.
* @param context - optional label (e.g. the switch site) prefixed into the throw message.
* @returns never — it always throws, with the offending value JSON-rendered in the message.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
//#endregion
//#region packages/llm/llm/src/content.ts
/** Model-facing stand-in for an image removed to fit a provider request bound. */
const OFFLOADED_IMAGE_TEXT = "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]";
/**
* True when typed model content contains an image block, walking nested
* tool-result content. This is the one recursive image walk shared by every
* image policy (capability gating, text-only serialization, compaction
* survey), so a consumer cannot silently diverge on nesting depth.
* @param content - typed model content blocks.
* @returns whether any nested block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image" || block.type === "tool-result" && contentHasImage(block.content));
}
/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes) {
	return Math.ceil(bytes / 3) * 4;
}
/** Collect base64 payload lengths in request and nested-block order. */
function collectImageLengths(blocks, lengths) {
	for (const block of blocks) if (block.type === "image") lengths.push(base64Length(block.attachment.bytes));
	else if (block.type === "tool-result") collectImageLengths(block.content, lengths);
}
/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(blocks, remaining) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image" && remaining.count > 0) {
			remaining.count -= 1;
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: OFFLOADED_IMAGE_TEXT
			});
			continue;
		}
		if (block.type === "tool-result") {
			const content = replaceOldestImages(block.content, remaining);
			if (content !== block.content) {
				next ??= blocks.slice(0, index);
				next.push({
					...block,
					content
				});
				continue;
			}
		}
		next?.push(block);
	}
	return next ?? blocks;
}
//#endregion
//#region packages/core/session/src/json.ts
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype$1(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target = detach ? [] : void 0;
			if (target !== void 0) assign(task.destination, target);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target === void 0 ? {} : { target }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property, so a stateful
* getter cannot change between validation and copying. Traversal is iterative,
* so valid nesting is bounded by available memory rather than the JavaScript
* call stack. Accepts ordinary arrays, plain or null-prototype objects, and JSON
* scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
* Getter throws propagate.
*
* @param value - the candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not
*   losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON boundary as {@link snapshotJsonValue} without
* detaching it. Only own enumerable string properties participate; `toJSON`
* is ignored and getters run, so persistence boundaries use the snapshotter.
* @param value - the candidate event data to test.
* @returns whether `value` survives JSON round-trip losslessly.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
new Set([
	"user/message",
	"assistant/message",
	"tool/result"
]);
/**
* Deep structural equality over the session-event JSON value domain
* (null/boolean/number/string, arrays, plain objects). Replaces
* `node:util`'s isDeepStrictEqual to keep this module browser-safe.
*/
function isDeepEqualJson(a, b) {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => isDeepEqualJson(item, b[i]));
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aKeys = Object.keys(a);
	const bRecord = b;
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], bRecord[key]));
}
new Set([
	"agent-preset/selected",
	"agent/inbox/spliced",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"assistant/chunk",
	"assistant/message",
	"command/done",
	"command/run",
	"compaction/end",
	"compaction/prune",
	"compaction/start",
	"compaction/summary",
	"feedback/record",
	"goal/change",
	"hook/invoked",
	"hook/result",
	"image-gen/canvas",
	"image-gen/created",
	"llm/retry",
	"llm/retry-started",
	"permission/preset",
	"plan/mode",
	"ppt/project-opened",
	"request/context",
	"request/header",
	"sandbox/mode",
	"schedule/change",
	"session/end-seed",
	"session/title",
	"session/title-llm-request",
	"status/set",
	"step/end",
	"step/start",
	"subagent/descriptor",
	"team/member",
	"team/message/delivered",
	"team/message/queued",
	"team/task",
	"todo/write",
	"tool-workflow/agent-end",
	"tool-workflow/agent-start",
	"tool-workflow/run-end",
	"tool-workflow/run-start",
	"tool/call",
	"tool/code-dispatch",
	"tool/code-dispatch-start",
	"tool/result",
	"turn/end",
	"turn/start",
	"user/message",
	"vision/description",
	"vision/request",
	"web/deepseek-search-llm-request"
]);
new Set(["reasoningEffort", "maxTokens"]);
//#endregion
//#region packages/core/tools/src/json-schema.ts
/**
* Enforced JSON Schema subset shared by tool outputs, generated Code Mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
//#endregion
//#region packages/core/tools/src/schema.ts
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of":
			destination.target[destination.index] = node;
			break;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
//#endregion
//#region packages/core/tools/src/code-mode.ts
/**
* Code Mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module coding-tools/src/code-mode
*/
/** The model-facing name of the Code Mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Takes one required argument, `code` — the BODY of an async function (erasable syntax only; top-level `await` and `return` work) — plus an optional `description`, a short summary of what the program does. `require` loads Node built-in modules only, and only in a local workspace; a remote isolate has none, so shell, file and network work goes through the tools — `await tools.name(args)` per the declarations in the system prompt. Only what you print or return is program output — curate it. Image-bearing subtool results are attached after the run.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Takes one required argument, `code` — the BODY of an async function (top-level `await` and `return` work) — plus an optional `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Use `print(...)` and/or `return <value>` for program output — curate it. Image-bearing subtool results are attached after the run.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift. 该字段只用于界面展示，可以省略；省略时卡片标题回退到程序首行。
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Optional clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Omit to show the program's first line. Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
/**
* 折叠行与卡片标题使用的展示说明：模型给了非空 `description` 就用它，
* 否则取程序第一行，避免运行代码的调用在界面上没有标题。
* @param args - 已解析的调用参数。
* @returns 非空的单行说明。
*/
function runCodeLabel(args) {
	const description = args.description?.trim() ?? "";
	if (description !== "") return description;
	const firstLine = args.code.split(/[\r\n]/, 1)[0]?.trim() ?? "";
	return firstLine === "" ? RUN_CODE_NAME : firstLine;
}
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requireCodeRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requireCodeRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name) => JSON.stringify(name)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* CommonJS globals a program reaches for out of habit. `require` exists only in
* the local Node worker and only for built-ins, so a remote isolate answers
* every one of them with a bare `ReferenceError` that reads as a broken
* deployment; the failure text names the replacement route.
*/
const COMMONJS_GLOBALS = [
	"require",
	"module",
	"exports",
	"__dirname",
	"__filename"
];
/**
* The tools redirect appended to a missing-CommonJS-global failure, or an
* empty string for every other failure (whose message already names its own
* cause).
* @param message - the runtime's exception text for this run.
* @returns the hint line, newline-prefixed, or `''`.
*/
function moduleAccessHint(message) {
	const missing = COMMONJS_GLOBALS.find((name) => message.includes(`ReferenceError: ${name} is not defined`));
	if (missing === void 0) return "";
	return `\n(\`${missing}\` is not available: \`run_code\` programs are not CommonJS modules. Node built-ins come from \`require('node:…')\` in a local workspace; the shell, files and network are tool calls)`;
}
/** 从可能尚未附加 session 的 Agent 句柄读取工作目录。 */
function agentWorkspaceCwd(agent) {
	return agent?.session?.header?.cwd;
}
/**
* Build the `run_code` {@link ToolDefinition}: required `code` plus an optional
* display-only `description`, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			description: {
				type: "string",
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" }
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			const runtime = requireRuntime();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (name) => async (...callArgs) => {
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(callArgs.length === 0 ? {} : callArgs[0]);
				const n = ++dispatches;
				const subCallId = CallId(`${String(exec.callId)}:code:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_RUNTIME_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/code-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged,
								isError: result.isError,
								content: logged
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/code-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							if (!result.isError && result.content.some((block) => block.type === "image")) exec.deferContext(createUserMessage({
								content: result.content,
								source: {
									kind: "plugin",
									plugin: "tools-code-mode"
								}
							}));
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(schema.name)
				});
			}
			try {
				let result;
				try {
					const cwd = agentWorkspaceCwd(exec.agent);
					result = await runtime.run({
						program: args.code,
						...cwd !== void 0 ? { cwd } : {},
						bindings: [{
							global: "tools",
							functions,
							noArgsAsEmptyObject: true,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal
					});
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					const hint = result.error.kind === "exception" ? moduleAccessHint(result.error.message) : "";
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${hint}${logsText}`);
				}
				return {
					logs: result.logs,
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: runCodeLabel(args),
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => resolveFlavor(peekRuntime).description
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			description: {
				type: "string",
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		})
	});
	return definition;
}
//#endregion
//#region packages/core/tools/src/ts-types.ts
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
	return IDENTIFIER$1.test(name) ? name : JSON.stringify(name);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts.push(child);
				}
				finish(typeDocumentFrom(parts));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name)}${required.has(name) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			/* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the Code Mode design record's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

- \`require\` loads Node built-in modules only (\`node:fs\`, \`child_process\`, \`path\`), and only in a local workspace: a remote isolate has none, and a child process the program spawns gets no environment variables. Shell, file and network work is a tool call.
- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	return `${SDK_INSTRUCTIONS$1}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${[
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n")}\n\`\`\``;
}
//#endregion
//#region packages/core/tools/src/py-types.ts
/**
* Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link coding-code-runtime#CodeRuntime.language | code
* runtime's language}.
* Under `mode: 'code'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
* alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module coding-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'code'` is this generated text.
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch design record records the deferral.
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name) {
	return IDENTIFIER.test(name) && name.normalize("NFKC") === name;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'code'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — Code Mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name = capped;
	if (state.usedClassNames.has(name)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name);
	return name;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema, className, listDepth) => ({
		schema,
		className,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node = frame.node;
				const name = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node === void 0 || name === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node.required);
				const lines = [`class ${name}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith("__") && !name.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				/* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. Only what you print and return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
//#endregion
//#region packages/core/tools/src/display-description-value.ts
/** 无运行时服务依赖的工具调用说明读取契约，供 Host 与浏览器共同重放。 */
/** 支持自定义操作说明的模型工具共用的可选字段。 */
const TOOL_SUMMARY_KEY = "summary";
const DESCRIPTION_TOOLS = new Set([
	"bash",
	"exec_command",
	"pwsh",
	"run_code",
	"spawn_agent",
	"spawn_teammate",
	"subagent",
	"subagent_fork"
]);
const STATIC_SUMMARY_TOOLS = new Set([
	"structured_output",
	"wait_agent",
	"list_agents",
	"list_subagent_models",
	"ask_user_question",
	"report",
	"memory_list",
	"memory_read",
	"memory_delete",
	"memory_save",
	"memory_update",
	"read",
	"write",
	"edit",
	"read_image",
	"grep",
	"glob",
	"web_search",
	"web_fetch",
	"apply_patch",
	"str_replace_editor",
	"write_stdin",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"job_list",
	"job_output",
	"job_kill",
	"update_plan",
	"todo_write",
	"set_status",
	"skill",
	"skill_read",
	"context_compact",
	"render_ui",
	"image_gen",
	"edit_image",
	"validate_gen_ui",
	"create_goal",
	"get_goal",
	"update_goal",
	"exit_plan_mode",
	"browser_close",
	"browser_screenshot",
	"browser_snapshot",
	"browser_auth_flush",
	"browser_doctor",
	"browser_status",
	"computer_list_apps",
	"computer_confirm",
	"cordis_inspect_list",
	"cordis_define",
	"terminal_list",
	"canvas_state",
	"ppt_templates",
	"schedule_list",
	"team_task_create",
	"workflow"
]);
/**
* 判断工具是否需要额外的单次动作说明，静态动作及业务摘要保持原契约。
* @param name 模型可调用的工具名。
* @returns 允许注入展示摘要时为 true。
*/
function supportsToolSummary(name) {
	return !name.startsWith("mcp__") && !DESCRIPTION_TOOLS.has(name) && !STATIC_SUMMARY_TOOLS.has(name);
}
/** 模型可见的字段说明；调用者不要把它当作授权依据。 */
const TOOL_SUMMARY_SCHEMA = {
	type: "string",
	description: "Optional short, user-friendly summary of what this call is doing now. Omit when the action is self-explanatory. Do not include secrets, raw JSON, or internal identifiers."
};
//#endregion
//#region packages/core/tools/src/display-description.ts
/** 剥离工具展示参数，业务工具只接收其余原参数。 */
/**
* 从模型参数中分离展示字段；非对象参数保留给原工具的验证器。
*
* `summary` 只是展示元数据：空白、超长或非字符串一律按“没有说明”处理，
* 直接从业务参数里剥掉，绝不因为展示字段让调用失败。
* @param args - 已解析的调用参数。
* @returns 业务参数，未提供展示字段时保持原引用。
*/
function toolBusinessArgs(args, hasSummary = true) {
	if (!hasSummary || typeof args !== "object" || args === null || Array.isArray(args) || !Object.hasOwn(args, "summary")) return args;
	const record = args;
	const business = Object.create(null);
	for (const [key, value] of Object.entries(record)) if (key !== "summary") business[key] = value;
	return business;
}
//#endregion
//#region packages/core/tools/src/index.ts
/**
* Tool registry, model presentation modes, and pre/guard/around/post/result
* execution pipeline.
* @module coding-tools
*/
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link CodeSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-code-runtime` README pair, its
* `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
/**
* Prompt order of the `code` collapse statement: after the persona and before
* the 100-199 per-tool guidance band, so the model reads which tools it may
* call before it reads what each one is for.
*/
const COLLAPSE_SECTION_ORDER = 99;
/**
* The model-facing statement of the `code` collapse. Names the consequence
* (the call fails) and the route (inside the program), because a rule the
* model can only discover by being denied is one it corrects too late.
*/
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`;
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_RUNTIME_SCHEDULER = Symbol("coding-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	/**
	* @param toolName - the name the caller asked for.
	* @param reachableFrom - how the model reaches this tool instead, when the
	*   name IS visible and only the presentation denies calling it directly.
	*   Omitted for a name that is registered nowhere.
	*/
	constructor(toolName, reachableFrom) {
		super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
(class extends Service {
	static inject = ["systemPrompt"];
	static Config = Schema.object({
		mode: Schema.union([
			"native",
			"code",
			"both"
		]).default("native"),
		maxParallelSubCalls: Schema.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_RUNTIME_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a code mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	codeTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") {
			ctx.systemPrompt.section(this.collapseSection());
			ctx.systemPrompt.section(this.sdkSection());
		}
	}
	/**
	* The prompt statement of the `code` executor collapse, registered wherever
	* {@link sdkSection} is and rendering empty outside an effective `code`.
	* Every tool contributes its own guidance section naming its tool, none of
	* them qualify how that tool is reached, and they all render before the SDK
	* (orders 100-199 against {@link SDK_SECTION_ORDER}). Without this the model
	* reads a catalog of tools it is told to use and no statement that only
	* `run_code` may be called, so it emits a native call, receives
	* `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
	* deployment is inconsistent. {@link COLLAPSE_SECTION_ORDER} places the rule
	* before that guidance rather than after it.
	* `both` renders empty: native calls do execute there, so the rule is false.
	* @returns the section registration.
	*/
	collapseSection() {
		return {
			name: "tools:code-only",
			order: COLLAPSE_SECTION_ORDER,
			text: (context) => this.modeFor(context.scope) === "code" ? CODE_ONLY_INSTRUCTION : ""
		};
	}
	/**
	* The generated-SDK prompt section, registered globally by a code-mode
	* deployment and per scope by {@link presentAs}.
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a code-mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: 150,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requireCodeRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requireCodeTransport() {
		this.codeTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
			peekRuntime: () => this.ctx.get("codeRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.codeTransport;
	}
	/**
	* Present the calling scope's tools in `mode` instead of the deployment
	* default. Nearest scope on the chain wins, so a preset's standing
	* declaration covers every agent joined under it.
	* Scoped only, and one declaration per scope: this is how an agent preset
	* composes Code Mode agents beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation the covered agents' models see.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") {
				yield ctx.systemPrompt.section(this.collapseSection());
				yield ctx.systemPrompt.section(this.sdkSection());
			}
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition)),
			knownNames: [...view.knownNames]
		};
		this.requireCodeRuntime(mode);
		const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition));
		if (mode === "code") return {
			schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
		return {
			schemas,
			knownNames: [...view.knownNames, RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the code runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a code runtime existing even under `mode:
	* 'native'` (the loop's optional-backend idiom, same as
	* `sessionPersistence`).
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable); rationale in the
	* language-dispatch note.
	*/
	requireCodeRuntime(mode) {
		const runtime = this.ctx.get("codeRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. coding-code-runtime-worker-thread) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name) => JSON.stringify(name)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const parameters = definition.parameters;
		if (parameters.type !== "object" || parameters.oneOf !== void 0) throw new TypeError(`tool "${name}" parameters must have an object root to support summary`);
		if (this.hasSummaryParameter(definition) && Object.hasOwn(parameters.properties ?? {}, "summary")) throw new TypeError(`tool "${name}" parameters already declare reserved field summary`);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's reporting and structured-output
	* tools into the child's own layer, and a filter naming the capabilities the
	* child may use must not strip the machinery it answers through.
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, definition] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
		}
		if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope) {
		return this.view(scope).visible.get(name);
	}
	/**
	* Resolve the definition that MAY EXECUTE for a call, applying the mode
	* collapse at the operation boundary that owns it. The registry view
	* (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
	* may only name the reserved `run_code` transport, while a nested
	* sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
	* it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
	* through the executor, matching an absent definition.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	* @returns the definition that may run, or undefined when the call must be rejected.
	*/
	resolveExecution(name, scope, nested) {
		const tool = this.get(name, scope);
		if (tool === void 0) return void 0;
		if (this.collapses(name, scope, nested)) return void 0;
		return tool;
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition));
	}
	/** Project visible callable tools onto the generated Code Mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	hasSummaryParameter(definition) {
		return definition.summaryParameter !== false && supportsToolSummary(definition.name);
	}
	/** 仅为缺少现成友好说明的工具投影展示字段。 */
	schemaOf(definition) {
		const { name, description, parameters } = definition;
		const detached = snapshotJsonValue(parameters);
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		if (detached.type !== "object" || detached.oneOf !== void 0 || this.hasSummaryParameter(definition) && Object.hasOwn(detached.properties ?? {}, "summary")) throw new TypeError(`tool "${name}" parameters must have an object root without reserved field summary`);
		if (this.hasSummaryParameter(definition)) detached.properties = {
			...detached.properties,
			[TOOL_SUMMARY_KEY]: { ...TOOL_SUMMARY_SCHEMA }
		};
		return {
			name,
			description,
			parameters: detached
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(toolBusinessArgs(exec.arguments, this.hasSummaryParameter(tool))) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/code-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/code-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Whether the `code` mode collapse denies a model-direct call: only the
	* reserved `run_code` transport may be named. Nested sub-dispatches (a
	* `parent` token set) bypass the collapse. One home for the
	* security-relevant predicate, shared by {@link resolveExecution} and
	* {@link createExecution} so the two can never drift apart.
	* Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `code`
	* by an agent preset under a native deployment is the composition
	* `dsh-agent-tool-presentation` exists for, and reading the deployment default would
	* leave exactly that agent uncollapsed — announcing one surface while
	* executing another, which is the bypass this collapse closes.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope whose effective presentation mode applies.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	*/
	collapses(name, scope, nested) {
		return !nested && this.modeFor(scope) === "code" && name !== "run_code";
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const visible = this.get(name, agent);
		const collapsed = visible !== void 0 && this.collapses(name, agent, parent !== void 0);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const finalizerFor = () => collapsed && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const hasSummary = visible !== void 0 && this.hasSummaryParameter(visible);
			const execution = {
				...base,
				arguments: deepFreeze(toolBusinessArgs(detached, hasSummary))
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (collapsed) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`))
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const postResult = await this.postExecute(exec, result);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
});
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/worker/cdp-client.ts
var CdpClient = class {
	ws;
	nextId;
	pending;
	events;
	constructor(ws) {
		this.ws = ws;
		this.nextId = 0;
		this.pending = /* @__PURE__ */ new Map();
		this.events = /* @__PURE__ */ new Map();
		ws.addEventListener("message", (event) => this.#handleMessage(event));
		const close = () => this.#rejectPending(/* @__PURE__ */ new Error("CDP connection closed"));
		ws.addEventListener("close", close, { once: true });
		ws.addEventListener("error", close, { once: true });
	}
	#handleMessage(event) {
		let message;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		if (message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const error = new Error(message.error.message || `CDP error ${message.error.code}`);
				error.code = message.error.code;
				error.data = message.error.data;
				pending.reject(error);
			} else pending.resolve(message.result || {});
			return;
		}
		if (!message.method) return;
		for (const handler of this.events.get(message.method) || []) try {
			handler(message.params || {}, message.sessionId);
		} catch {}
	}
	#rejectPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	call(method, params = {}, sessionId, timeoutMs = 6e3) {
		const id = ++this.nextId;
		const payload = {
			id,
			method,
			params
		};
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	on(method, handler) {
		if (!this.events.has(method)) this.events.set(method, /* @__PURE__ */ new Set());
		this.events.get(method).add(handler);
		return () => {
			this.events.get(method)?.delete(handler);
		};
	}
};
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/login-import.ts
/**
* ego-browser login-import — copy login cookies from the system's daily-use
* Chromium (Chrome/Edge/Brave) into the running ego agent browser (issue #46).
*
* #69 made the original design unsafe: it booted the REAL profile through a
* junction alias and hard-killed the instance, which could wipe extensions /
* reset settings. That path is gone. There are now two safe routes:
*
*  1. Extension bridge (recommended, modern Chrome/Edge): the companion
*     `extension/` folder reads cookies via the browser's `cookies` API and
*     POSTs them to a loopback receiver. No profile copy, no browser close,
*     no ABE decryption — see login-extension.ts.
*
*  2. Safe copy (legacy browsers / closed browser): copy ONLY `Local State`
*     and the Cookies DB into a throwaway profile and read it with a headless
*     browser. The real profile is never opened, so no writes can occur.
*     Chrome/Edge 127+ use App-Bound Encryption bound to the original profile
*     path, so this copy reads 0 cookies; the caller reports that explicitly
*     instead of falling back to the old destructive boot.
*
* Then filter by domain and write into the ego browser's persistent profile
* with `Storage.setCookies`. `closeSource:true` still gracefully closes a
* running source browser — only because Windows locks the cookie DB for the
* copy (the browser is not opened on the profile).
*
* Security contract:
*   - cookie VALUES never appear in logs, tool output, or reports — only
*     domain names and counts;
*   - the source profile is never opened by a browser and never written;
*   - import is a one-shot snapshot, never a continuous sync.
*/
const execFile$1 = promisify(execFile);
/** All candidate (exe, profile) pairs for the platform — existence NOT checked. */
function chromiumCandidates(env = process.env, platform = process.platform) {
	if (platform === "win32") {
		const la = env.LOCALAPPDATA || "";
		const pf = env["ProgramFiles"] || "C:\\Program Files";
		const pfx = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
		return [
			{
				id: "chrome",
				label: "Google Chrome",
				exePath: `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
				userDataDir: `${la}\\Google\\Chrome\\User Data`
			},
			{
				id: "chrome",
				label: "Google Chrome",
				exePath: `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
				userDataDir: `${la}\\Google\\Chrome\\User Data`
			},
			{
				id: "edge",
				label: "Microsoft Edge",
				exePath: `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`,
				userDataDir: `${la}\\Microsoft\\Edge\\User Data`
			},
			{
				id: "edge",
				label: "Microsoft Edge",
				exePath: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
				userDataDir: `${la}\\Microsoft\\Edge\\User Data`
			},
			{
				id: "brave",
				label: "Brave",
				exePath: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
				userDataDir: `${la}\\BraveSoftware\\Brave-Browser\\User Data`
			}
		];
	}
	if (platform === "darwin") {
		const home = env.HOME || "";
		return [{
			id: "chrome",
			label: "Google Chrome",
			exePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			userDataDir: `${home}/Library/Application Support/Google/Chrome`
		}, {
			id: "edge",
			label: "Microsoft Edge",
			exePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			userDataDir: `${home}/Library/Application Support/Microsoft Edge`
		}];
	}
	const home = env.HOME || "";
	return [
		{
			id: "chrome",
			label: "Google Chrome",
			exePath: "/usr/bin/google-chrome",
			userDataDir: `${home}/.config/google-chrome`
		},
		{
			id: "chrome",
			label: "Chromium",
			exePath: "/usr/bin/chromium",
			userDataDir: `${home}/.config/chromium`
		},
		{
			id: "edge",
			label: "Microsoft Edge",
			exePath: "/usr/bin/microsoft-edge",
			userDataDir: `${home}/.config/microsoft-edge`
		},
		{
			id: "brave",
			label: "Brave",
			exePath: "/usr/bin/brave-browser",
			userDataDir: `${home}/.config/BraveSoftware/Brave-Browser`
		}
	];
}
/** Candidates that actually exist on disk (exe + Local State present). */
function detectSystemBrowsers(env = process.env, platform = process.platform) {
	const seen = /* @__PURE__ */ new Set();
	return chromiumCandidates(env, platform).filter((b) => {
		if (seen.has(b.exePath)) return false;
		seen.add(b.exePath);
		return existsSync(b.exePath) && existsSync(join(b.userDataDir, "Local State"));
	});
}
function profilesFromLocalState(localStateJson, userDataDir) {
	try {
		const cache = JSON.parse(localStateJson).profile?.info_cache || {};
		const out = Object.entries(cache).map(([dirName, info]) => ({
			dir: join(userDataDir, dirName),
			dirName,
			name: info && typeof info.name === "string" && info.name || dirName
		}));
		return out.length ? out : [{
			dir: join(userDataDir, "Default"),
			dirName: "Default",
			name: "Default"
		}];
	} catch {
		return [{
			dir: join(userDataDir, "Default"),
			dirName: "Default",
			name: "Default"
		}];
	}
}
/** Domain filter: "bilibili.com" matches ".bilibili.com" and any subdomain. */
function cookieMatchesDomains(cookieDomain, domains) {
	if (!domains || domains.length === 0) return true;
	const host = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
	return domains.some((raw) => {
		const d = String(raw || "").replace(/^\./, "").trim().toLowerCase();
		return d !== "" && (host === d || host.endsWith("." + d));
	});
}
/** Convert a CDP Network.Cookie to a Storage.setCookies CookieParam. */
function toCookieParam(c) {
	if (!c || typeof c.name !== "string" || c.name === "" || typeof c.value !== "string" || typeof c.domain !== "string" || c.domain === "") return null;
	const p = {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
		secure: !!c.secure,
		httpOnly: !!c.httpOnly
	};
	if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") p.sameSite = c.sameSite;
	if (!c.session && typeof c.expires === "number" && c.expires > 0) p.expires = c.expires;
	return p;
}
/** First line of DevToolsActivePort is the port number. */
function parseDevToolsActivePort(text) {
	const line = String(text || "").split(/\r?\n/)[0]?.trim();
	const n = Number(line);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
function resolveEgoStateDir(env = process.env, platform = process.platform) {
	const home = env.HOME || env.USERPROFILE || "";
	if (env.EGO_LINUX_STATE_DIR) return env.EGO_LINUX_STATE_DIR;
	return platform === "win32" ? (env.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${env.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`;
}
async function connectCdp(wsUrl, timeoutMs) {
	const WsImpl = globalThis.WebSocket;
	if (!WsImpl) throw new Error("global WebSocket is unavailable (Node >= 22 required)");
	const ws = new WsImpl(wsUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`CDP websocket open timed out: ${wsUrl}`)), timeoutMs);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`CDP websocket connect failed: ${wsUrl}`));
		}, { once: true });
	});
	return {
		client: new CdpClient(ws),
		close: () => {
			try {
				ws.close();
			} catch {}
		}
	};
}
async function browserWsUrl(port) {
	const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3e3) });
	if (!r.ok) throw new Error(`/json/version HTTP ${r.status} on port ${port}`);
	const j = await r.json();
	if (!j.webSocketDebuggerUrl) throw new Error("browser did not expose webSocketDebuggerUrl");
	return j.webSocketDebuggerUrl;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* Is the source browser currently running ON THE TARGET PROFILE? For a real
* source (default profile) that means instances WITHOUT --user-data-dir; for
* an override/synthetic profile it means instances whose command line names
* THAT directory. Only main processes count (renderer/GPU helpers carry
* --type= and follow the main process).
*/
async function sourceBrowserPids(browserExe, userDataDir = null, platform = process.platform) {
	const exeBase = basename(browserExe);
	try {
		if (platform === "win32") {
			const filter = userDataDir ? `$_.CommandLine -match [regex]::Escape('--user-data-dir=${userDataDir}') -or $_.CommandLine -match [regex]::Escape('--user-data-dir="${userDataDir}"')` : `$_.CommandLine -notmatch '--user-data-dir='`;
			const ps = [
				`Get-CimInstance Win32_Process -Filter "Name='${exeBase}'"`,
				`| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and (${filter}) }`,
				`| Select-Object -ExpandProperty ProcessId`
			].join(" ");
			const { stdout } = await execFile$1("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(ps, "utf16le").toString("base64")
			], { timeout: 1e4 });
			return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
		}
		const { stdout } = await execFile$1("pgrep", ["-x", exeBase.replace(/\.exe$/, "")], { timeout: 1e4 }).catch(() => ({ stdout: "" }));
		return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		return [];
	}
}
/**
* Gracefully close the source browser on its default profile: WM_CLOSE to the
* main process(es) (helpers follow on their own), then wait for exit.
* The ego agent browser (different --user-data-dir) is never touched.
*/
async function closeSourceBrowser(browserExe, platform = process.platform) {
	try {
		const pids = await sourceBrowserPids(browserExe, null, platform);
		if (pids.length === 0) return true;
		if (platform === "win32") for (const pid of pids) await execFile$1("taskkill", ["/PID", String(pid)], { timeout: 8e3 }).catch(() => null);
		else for (const pid of pids) try {
			process.kill(pid, "SIGTERM");
		} catch {}
		const deadline = Date.now() + 15e3;
		while (Date.now() < deadline) {
			if ((await sourceBrowserPids(browserExe, null, platform)).length === 0) return true;
			await sleep(500);
		}
		return false;
	} catch {
		return false;
	}
}
const BATCH$1 = 200;
/** Copy ONLY the files a headless Chrome needs to open the cookie jar. The
*  source profile is never opened by a browser, so #69's destructive write path
*  cannot run. ABE-bound cookies (Chrome/Edge 127+) will read as 0; the caller
*  reports that explicitly instead of booting the real profile. */
async function copyProfileForImport(browser, profile) {
	const { copyFile } = await import("node:fs/promises");
	const dest = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}`);
	await mkdir(join(dest, profile.dirName, "Network"), { recursive: true });
	const localState = join(browser.userDataDir, "Local State");
	if (existsSync(localState)) await mkdir(dest, { recursive: true }).then(() => copyFile(localState, join(dest, "Local State")));
	const cookieFiles = [[join(profile.dir, "Network", "Cookies"), join(dest, profile.dirName, "Network", "Cookies")], [join(profile.dir, "Cookies"), join(dest, profile.dirName, "Cookies")]];
	let copied = false;
	for (const [src, dst] of cookieFiles) {
		if (!existsSync(src)) continue;
		try {
			await copyFile(src, dst);
			copied = true;
		} catch (err) {
			throw new Error(`cannot copy the ${browser.label} cookie store (${err?.message || err}); quit ${browser.label} completely and retry`);
		}
	}
	if (!copied) throw new Error(`no Cookies database found in ${browser.label} profile ${profile.dirName}`);
	return dest;
}
async function importLoginCookies(opts, deps) {
	const timeoutMs = opts.timeoutMs ?? 2e4;
	let browser;
	if (opts.browserOverride) browser = opts.browserOverride;
	else {
		const browsers = detectSystemBrowsers();
		if (browsers.length === 0) return {
			ok: false,
			error: "no system Chromium browser found (looked for Chrome/Edge/Brave profile + binary)"
		};
		const wanted = !opts.source || opts.source === "auto" ? null : opts.source;
		browser = wanted ? browsers.find((b) => b.id === wanted) : browsers[0];
		if (!browser) return {
			ok: false,
			error: `source "${wanted}" not found on this machine; detected: ${browsers.map((b) => b.id).join(", ")}`
		};
	}
	let profile;
	try {
		const profiles = profilesFromLocalState(await readFile(join(browser.userDataDir, "Local State"), "utf8"), browser.userDataDir);
		profile = (opts.profile ? profiles.find((p) => p.dirName === opts.profile || p.name === opts.profile) : void 0) || profiles[0];
		if (opts.profile && !profiles.some((p) => p.dirName === profile.dirName)) return {
			ok: false,
			error: `profile "${opts.profile}" not found in ${browser.label}; available: ${profiles.map((p) => p.dirName).join(", ")}`
		};
	} catch (err) {
		return {
			ok: false,
			error: `cannot read ${browser.label} Local State: ${err?.message || err}`
		};
	}
	let closedSource = false;
	let srcHandle = null;
	let tempCdp = null;
	let egoCdp = null;
	let linkDir = null;
	try {
		if ((await sourceBrowserPids(browser.exePath, opts.browserOverride ? browser.userDataDir : null)).length > 0) {
			if (opts.browserOverride) return {
				ok: false,
				error: "an instance is already running on the override profile — close it and retry"
			};
			if (!opts.closeSource) return {
				ok: false,
				error: `${browser.label} is running — fully quit it (check the system tray) and retry, or call with closeSource=true to let the tool close it gracefully for you (windows restore on next launch)`
			};
			if (!await closeSourceBrowser(browser.exePath)) return {
				ok: false,
				error: `failed to close ${browser.label} automatically — quit it manually and retry`
			};
			closedSource = true;
		}
		linkDir = await copyProfileForImport(browser, profile);
		if (process.platform === "win32") {
			const ps = [
				`Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
				`| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
				`| Select-Object -ExpandProperty ProcessId`
			].join(" ");
			const drainDeadline = Date.now() + 8e3;
			let leftover = [];
			while (Date.now() < drainDeadline) {
				try {
					const { stdout } = await execFile$1("powershell.exe", [
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(ps, "utf16le").toString("base64")
					], { timeout: 8e3 });
					leftover = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
					if (leftover.length === 0) break;
				} catch {
					break;
				}
				await sleep(600);
			}
			if (leftover.length > 0) {
				for (const line of leftover) {
					const pid = Number(line);
					if (Number.isInteger(pid) && pid > 0) await execFile$1("taskkill", [
						"/PID",
						String(pid),
						"/F"
					], { timeout: 5e3 }).catch(() => null);
				}
				await sleep(1e3);
			}
		}
		let port = null;
		for (let attempt = 0; attempt < 2 && port === null; attempt++) {
			if (attempt > 0) {
				await sleep(2e3);
				try {
					await rm(linkDir, {
						recursive: true,
						force: true
					});
				} catch {}
				linkDir = await copyProfileForImport(browser, profile);
			}
			const portFile = join(linkDir, "DevToolsActivePort");
			await rm(portFile, { force: true }).catch(() => null);
			srcHandle = deps.subprocess.spawn({
				argv: [
					browser.exePath,
					"--headless=new",
					`--user-data-dir=${linkDir}`,
					`--profile-directory=${profile.dirName}`,
					"--remote-debugging-port=0",
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-background-networking",
					"--disable-sync",
					"--hide-crash-restore-bubble",
					"about:blank"
				],
				cwd: tmpdir(),
				env: { ...process.env },
				stdio: {
					stdin: { data: "" },
					stdout: { maxBytes: 2048 },
					stderr: { maxBytes: 4096 }
				},
				graceMs: 8e3
			});
			srcHandle.done.catch(() => null);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				try {
					port = parseDevToolsActivePort(await readFile(portFile, "utf8"));
					if (port !== null) break;
				} catch {}
				await sleep(250);
			}
		}
		if (port === null) return {
			ok: false,
			closedSource,
			error: `${browser.label} headless instance did not expose a DevTools port within ${timeoutMs}ms (another instance may be holding the profile)`
		};
		tempCdp = await connectCdp(await browserWsUrl(port), 5e3);
		let all = [];
		let stable = 0;
		let lastCount = -1;
		const readDeadline = Date.now() + timeoutMs;
		while (Date.now() < readDeadline) {
			const got = await tempCdp.client.call("Storage.getCookies");
			all = Array.isArray(got.cookies) ? got.cookies : [];
			if (all.length > 0 && all.length === lastCount) {
				stable += 1;
				if (stable >= 2) break;
			} else stable = 0;
			lastCount = all.length;
			await sleep(800);
		}
		if (all.length === 0) return {
			ok: false,
			source: browser.label,
			profile: profile.dirName,
			dryRun: opts.dryRun === true,
			closedSource,
			totalRead: 0,
			matched: 0,
			written: 0,
			domains: [],
			error: `0 cookies readable from the temporary copy of ${browser.label}. Chrome/Edge 127+ use App-Bound Encryption bound to the original profile path, so a copied profile cannot be decrypted (the source profile was NOT modified). Use the Chrome extension bridge (A) or log in once inside the agent browser; the old real-profile boot path has been removed.`
		};
		const matched = all.filter((c) => cookieMatchesDomains(c.domain, opts.domains || []));
		const byDomain = /* @__PURE__ */ new Map();
		for (const c of matched) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
		const domainStats = [...byDomain.entries()].map(([domain, cookies]) => ({
			domain,
			cookies
		})).sort((a, b) => b.cookies - a.cookies);
		if (opts.dryRun) return {
			ok: true,
			source: browser.label,
			profile: profile.dirName,
			dryRun: true,
			closedSource,
			totalRead: all.length,
			matched: matched.length,
			written: 0,
			domains: domainStats
		};
		const stateDir = opts.stateDir || resolveEgoStateDir();
		let egoPort;
		try {
			const bj = JSON.parse(await readFile(join(stateDir, "browser.json"), "utf8"));
			if (typeof bj.port !== "number" || bj.port <= 0) throw new Error("no port in browser.json");
			egoPort = bj.port;
		} catch {
			return {
				ok: false,
				closedSource,
				error: "agent browser is not running (no browser.json) — call ego_status or any ego_* tool first, then retry the import"
			};
		}
		egoCdp = await connectCdp(await browserWsUrl(egoPort), 5e3);
		const params = matched.map(toCookieParam).filter((p) => p !== null);
		const egoClient = egoCdp.client;
		const jarTargets = [void 0];
		try {
			const spacesRaw = await readFile(join(stateDir, "task-spaces.json"), "utf8");
			const parsed = JSON.parse(spacesRaw);
			for (const space of parsed.spaces ?? []) {
				const id = space?.browserContextId;
				if (typeof id === "string" && id !== "") jarTargets.push(id);
			}
		} catch {}
		const jarKey = (domain, name, path) => `${String(name)}|${String(domain).replace(/^\./, "")}|${String(path ?? "/")}`;
		const writeJar = async (contextId) => {
			const scoped = contextId === void 0 ? {} : { browserContextId: contextId };
			for (let i = 0; i < params.length; i += BATCH$1) await egoClient.call("Storage.setCookies", {
				cookies: params.slice(i, i + BATCH$1),
				...scoped
			});
			const back = await egoClient.call("Storage.getCookies", scoped);
			const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)));
			return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length;
		};
		let written;
		try {
			written = await writeJar(void 0);
			for (const contextId of jarTargets.slice(1)) try {
				await writeJar(contextId);
			} catch {}
		} catch {
			written = -1;
		}
		if (params.length > 0 && written === 0) return {
			ok: false,
			source: browser.label,
			profile: profile.dirName,
			dryRun: false,
			closedSource,
			totalRead: all.length,
			matched: matched.length,
			written: 0,
			error: "the agent browser accepted no cookies — its CDP endpoint may belong to a stale or replaced instance; restart the agent browser (ego_status after closing it) and retry"
		};
		return {
			ok: true,
			source: browser.label,
			profile: profile.dirName,
			dryRun: false,
			closedSource,
			totalRead: all.length,
			matched: matched.length,
			written,
			domains: domainStats
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err?.message || err)
		};
	} finally {
		try {
			tempCdp?.close();
		} catch {}
		try {
			egoCdp?.close();
		} catch {}
		if (srcHandle) {
			try {
				await Promise.race([srcHandle.done, sleep(8e3)]);
			} catch {}
			if (process.platform === "win32" && linkDir) try {
				const ps = [
					`Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
					`| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
					`| Select-Object -ExpandProperty ProcessId`
				].join(" ");
				const { stdout } = await execFile$1("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					Buffer.from(ps, "utf16le").toString("base64")
				], { timeout: 8e3 });
				for (const line of String(stdout).split(/\r?\n/)) {
					const pid = Number(line.trim());
					if (Number.isInteger(pid) && pid > 0) await execFile$1("taskkill", [
						"/PID",
						String(pid),
						"/F"
					], { timeout: 5e3 }).catch(() => null);
				}
			} catch {}
		}
		if (linkDir) try {
			await rm(linkDir, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
const MAX_BODY = 5 * 1024 * 1024;
const BATCH = 100;
function loginExtensionTokenPath(stateDir = resolveEgoStateDir()) {
	return join(stateDir, "login-extension-token");
}
/** Per-install bearer token shared with the companion extension. */
async function getOrCreateLoginExtensionToken(stateDir = resolveEgoStateDir()) {
	const file = loginExtensionTokenPath(stateDir);
	try {
		const existing = (await readFile(file, "utf8")).trim();
		if (existing.length >= 16) return existing;
	} catch {}
	const token = randomBytes(24).toString("hex");
	await mkdir(dirname(file), { recursive: true }).catch(() => null);
	await writeFile(file, token, {
		encoding: "utf8",
		mode: 384
	}).catch(() => null);
	return token;
}
function sendJson$1(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type, x-ego-token",
		"cache-control": "no-store"
	});
	res.end(text);
}
async function readJsonBody$2(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_BODY) throw new Error("request body too large");
		chunks.push(buf);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function tokenMatches(expected, got) {
	if (typeof got !== "string") return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(got);
	return a.length === b.length && timingSafeEqual(a, b);
}
function toCdpCookie(raw) {
	if (!raw || typeof raw !== "object") return null;
	const c = raw;
	if (typeof c.name !== "string" || c.name === "" || typeof c.value !== "string") return null;
	if (typeof c.domain !== "string" || c.domain === "") return null;
	const rawSite = c.sameSite;
	const sameSite = rawSite === "strict" ? "Strict" : rawSite === "lax" ? "Lax" : rawSite === "none" || rawSite === "no_restriction" ? "None" : void 0;
	const expires = typeof c.expirationDate === "number" ? c.expirationDate : void 0;
	return {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
		secure: c.secure === true,
		httpOnly: c.httpOnly === true,
		sameSite: sameSite === "Strict" || sameSite === "Lax" || sameSite === "None" ? sameSite : void 0,
		session: expires === void 0,
		...expires !== void 0 ? { expires } : {}
	};
}
/** Write CDP cookies into the running agent browser (default jar + spaces). */
async function writeCookiesToEgo(cookies, stateDir = resolveEgoStateDir()) {
	let egoPort;
	try {
		const bj = JSON.parse(await readFile(join(stateDir, "browser.json"), "utf8"));
		if (typeof bj.port !== "number" || bj.port <= 0) throw new Error("no port in browser.json");
		egoPort = bj.port;
	} catch {
		return {
			written: 0,
			error: "agent browser is not running (no browser.json) — call ego_status or any ego_* tool first, then retry"
		};
	}
	const egoCdp = await connectCdp(await browserWsUrl(egoPort), 5e3);
	const params = cookies.map(toCookieParam).filter((p) => p !== null);
	const jarTargets = [void 0];
	try {
		const spacesRaw = await readFile(join(stateDir, "task-spaces.json"), "utf8");
		const parsed = JSON.parse(spacesRaw);
		for (const space of parsed.spaces ?? []) {
			const id = space?.browserContextId;
			if (typeof id === "string" && id !== "") jarTargets.push(id);
		}
	} catch {}
	const jarKey = (domain, name, path) => `${String(name)}|${String(domain).replace(/^\./, "")}|${String(path ?? "/")}`;
	const writeJar = async (contextId) => {
		const scoped = contextId === void 0 ? {} : { browserContextId: contextId };
		for (let i = 0; i < params.length; i += BATCH) await egoCdp.client.call("Storage.setCookies", {
			cookies: params.slice(i, i + BATCH),
			...scoped
		});
		const back = await egoCdp.client.call("Storage.getCookies", scoped);
		const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)));
		return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length;
	};
	try {
		let written = await writeJar(void 0);
		for (const contextId of jarTargets.slice(1)) try {
			await writeJar(contextId);
		} catch {}
		if (params.length > 0 && written === 0) return {
			written: 0,
			error: "the agent browser accepted no cookies — restart it (ego_status after closing it) and retry"
		};
		return { written };
	} catch (err) {
		return {
			written: -1,
			error: String(err?.message || err)
		};
	} finally {
		try {
			egoCdp.close();
		} catch {}
	}
}
/** #69 (A): import cookies from the companion Chrome extension (bridge v2). */
async function importLoginCookiesFromExtension(opts = {}) {
	return await (await startLoginExtensionJob(opts)).done;
}
let bridge = null;
let bridgeStarting = null;
let jobSeq = 0;
async function buildExtensionReport(cookies, received, dryRun, stateDir) {
	const byDomain = /* @__PURE__ */ new Map();
	for (const c of cookies) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
	const domains = [...byDomain.entries()].map(([domain, count]) => ({
		domain,
		cookies: count
	})).sort((a, b) => b.cookies - a.cookies);
	if (dryRun) return {
		ok: true,
		source: "Chrome extension",
		profile: "extension",
		dryRun: true,
		closedSource: false,
		totalRead: received,
		matched: cookies.length,
		written: 0,
		domains
	};
	const write = await writeCookiesToEgo(cookies, stateDir);
	if (write.error !== void 0) return {
		ok: false,
		source: "Chrome extension",
		profile: "extension",
		dryRun: false,
		closedSource: false,
		totalRead: received,
		matched: cookies.length,
		written: write.written,
		domains,
		error: write.error
	};
	return {
		ok: true,
		source: "Chrome extension",
		profile: "extension",
		dryRun: false,
		closedSource: false,
		totalRead: received,
		matched: cookies.length,
		written: write.written,
		domains
	};
}
function settlement(job, report) {
	job.state = "done";
	job.report = report;
	const waiter = bridge?.waiters.get(job.id);
	if (waiter) {
		bridge.waiters.delete(job.id);
		waiter(report);
	}
}
async function ensureBridge() {
	if (bridge) return bridge;
	if (bridgeStarting) return await bridgeStarting;
	bridgeStarting = (async () => {
		const port = Number(process.env.EGO_LOGIN_EXTENSION_PORT) || 53820;
		const token = await getOrCreateLoginExtensionToken(resolveEgoStateDir());
		const state = {
			server: createServer(() => {}),
			token,
			port,
			lastSeenAt: 0,
			pairCode: "",
			pairExpiresAt: 0,
			jobs: /* @__PURE__ */ new Map(),
			waiters: /* @__PURE__ */ new Map(),
			started: Promise.resolve()
		};
		state.server = createServer(async (req, res) => {
			try {
				if (req.method === "OPTIONS") {
					sendJson$1(res, 204, {});
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				if (req.method === "GET" && (url.pathname === "/ping" || url.pathname === "/health")) {
					sendJson$1(res, 200, {
						ok: true,
						app: "ego-browser-login",
						port: state.port,
						paired: Date.now() - state.lastSeenAt < 2e4
					});
					return;
				}
				if (req.method === "POST" && url.pathname === "/pair") {
					const body = await readJsonBody$2(req);
					if (typeof body.code !== "string" || body.code !== state.pairCode || Date.now() > state.pairExpiresAt) {
						sendJson$1(res, 403, {
							ok: false,
							error: "pairing code expired or invalid"
						});
						return;
					}
					state.lastSeenAt = Date.now();
					sendJson$1(res, 200, {
						ok: true,
						token: state.token,
						port: state.port
					});
					return;
				}
				if (req.method === "GET" && url.pathname === "/pending") {
					const token = req.headers["x-ego-token"];
					if (!tokenMatches(state.token, token)) {
						sendJson$1(res, 403, {
							ok: false,
							error: "bad token"
						});
						return;
					}
					state.lastSeenAt = Date.now();
					const job = [...state.jobs.values()].find((j) => j.state === "waiting");
					if (!job) {
						sendJson$1(res, 204, {});
						return;
					}
					sendJson$1(res, 200, {
						jobId: job.id,
						domains: job.domains,
						dryRun: job.dryRun
					});
					return;
				}
				if (req.method === "POST" && url.pathname === "/cookies") {
					const body = await readJsonBody$2(req);
					if (!tokenMatches(state.token, body.token)) {
						sendJson$1(res, 403, {
							ok: false,
							error: "bad token"
						});
						return;
					}
					state.lastSeenAt = Date.now();
					const jobs = [...state.jobs.values()].filter((j) => j.state === "waiting");
					const job = (typeof body.jobId === "string" ? state.jobs.get(body.jobId) : void 0) || jobs[0];
					if (!job || job.state !== "waiting") {
						sendJson$1(res, 409, {
							ok: false,
							error: "no waiting import job"
						});
						return;
					}
					const cookies = (Array.isArray(body.cookies) ? body.cookies : []).map(toCdpCookie).filter((c) => c !== null);
					const filtered = cookies.filter((c) => cookieMatchesDomains(c.domain, job.domains));
					sendJson$1(res, 200, {
						ok: true,
						received: cookies.length,
						matched: filtered.length
					});
					buildExtensionReport(filtered, cookies.length, job.dryRun, resolveEgoStateDir()).then((report) => settlement(job, report));
					return;
				}
				sendJson$1(res, 404, {
					ok: false,
					error: "not found"
				});
			} catch (err) {
				sendJson$1(res, 400, {
					ok: false,
					error: String(err?.message || err)
				});
			}
		});
		await new Promise((resolve, reject) => {
			state.server.once("error", (err) => reject(/* @__PURE__ */ new Error(`could not start login-extension bridge on 127.0.0.1:${port}: ${err.message}`)));
			state.server.listen(port, "127.0.0.1", () => resolve());
		});
		bridge = state;
		return state;
	})();
	try {
		return await bridgeStarting;
	} catch (err) {
		bridgeStarting = null;
		throw err;
	}
}
async function getLoginExtensionHealth() {
	try {
		const state = await ensureBridge();
		return {
			ok: true,
			paired: Date.now() - state.lastSeenAt < 2e4,
			port: state.port,
			tokenPath: loginExtensionTokenPath(),
			extensionPath: fileURLToPath(new URL("../extension", import.meta.url))
		};
	} catch (err) {
		return {
			ok: false,
			paired: false,
			port: Number(process.env.EGO_LOGIN_EXTENSION_PORT) || 53820,
			tokenPath: loginExtensionTokenPath(),
			extensionPath: fileURLToPath(new URL("../extension", import.meta.url)),
			error: String(err?.message || err)
		};
	}
}
async function createLoginExtensionPairingCode() {
	try {
		const state = await ensureBridge();
		state.pairCode = String(Math.floor(1e5 + Math.random() * 9e5));
		state.pairExpiresAt = Date.now() + 6e5;
		return {
			ok: true,
			code: state.pairCode,
			expiresAt: state.pairExpiresAt,
			port: state.port
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err?.message || err)
		};
	}
}
async function startLoginExtensionJob(opts = {}) {
	const state = await ensureBridge();
	const timeoutMs = opts.timeoutMs ?? 12e4;
	const job = {
		id: "job-" + ++jobSeq,
		domains: opts.domains ?? [],
		dryRun: opts.dryRun === true,
		state: "waiting",
		createdAt: Date.now()
	};
	state.jobs.set(job.id, job);
	const done = new Promise((resolve) => {
		state.waiters.set(job.id, resolve);
		setTimeout(() => {
			if (job.state !== "waiting") return;
			settlement(job, {
				ok: false,
				source: "Chrome extension",
				profile: "extension",
				dryRun: job.dryRun,
				closedSource: false,
				totalRead: 0,
				matched: 0,
				written: 0,
				domains: [],
				error: `the Chrome extension did not pick up the job within ${Math.round(timeoutMs / 1e3)}s — pair it once in the extension popup (code from the panel) and keep Chrome running`
			});
		}, timeoutMs).unref?.();
	});
	if (state.jobs.size > 20) {
		for (const [id, old] of state.jobs) if (old.state !== "waiting" && id !== job.id) state.jobs.delete(id);
	}
	return {
		jobId: job.id,
		done
	};
}
async function getLoginExtensionJob(jobId) {
	try {
		const job = (await ensureBridge()).jobs.get(jobId);
		if (!job) return {
			ok: false,
			error: "job not found"
		};
		return {
			ok: true,
			state: job.state,
			...job.report ? { report: job.report } : {}
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err?.message || err)
		};
	}
}
function stopLoginExtensionBridge() {
	try {
		bridge?.server.close();
	} catch {}
	bridge = null;
	bridgeStarting = null;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/text.ts
/** Remove escape sequences before controls, preserving printable layout spaces. */
function terminalText(value) {
	return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
/** Compact a scalar locator or detail into a single terminal-safe line. */
function sanitizeText(value) {
	return terminalText(value).replace(/\s+/g, " ").trim();
}
const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function graphemeWidth(value) {
	if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 2;
	let width = 0;
	for (const char of value) {
		if (/\p{Mark}|\p{Cf}/u.test(char)) continue;
		const cp = char.codePointAt(0);
		width += cp >= 4352 && (cp <= 4447 || cp === 9001 || cp === 9002 || cp >= 11904 && cp <= 42191 && cp !== 12351 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65040 && cp <= 65049 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 131072 && cp <= 262141) ? 2 : 1;
	}
	return width;
}
function displayWidth(text) {
	return [...segmenter.segment(terminalText(text))].reduce((sum, part) => sum + graphemeWidth(part.segment), 0);
}
/** Truncate without splitting combining sequences, emoji or terminal-wide cells. */
function truncateCells(text, maxCells) {
	const clean = terminalText(text);
	const limit = Math.max(0, Math.floor(maxCells));
	if (!limit) return "";
	if (displayWidth(clean) <= limit) return clean;
	let result = "", cells = 0;
	for (const part of segmenter.segment(clean)) {
		const width = graphemeWidth(part.segment);
		if (cells + width > limit - 1) break;
		cells += width;
		result += part.segment;
	}
	return result + "…";
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/browser-state.ts
/** Pure per-activation state: no process, filesystem, network or timer ownership. */
var BrowserStateStore = class {
	snapshot = Object.freeze({
		version: 0,
		recent: Object.freeze([]),
		spaces: Object.freeze([]),
		frameRelayDisabled: false
	});
	listeners = /* @__PURE__ */ new Set();
	running = /* @__PURE__ */ new Map();
	nextToken = 0;
	getSnapshot = () => this.snapshot;
	subscribe = (listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	publish(patch) {
		this.snapshot = Object.freeze({
			...this.snapshot,
			...patch,
			version: this.snapshot.version + 1
		});
		for (const listener of [...this.listeners]) try {
			listener();
		} catch {}
	}
	startTool(name, summary, at = Date.now()) {
		const token = ++this.nextToken;
		const activeTool = Object.freeze({
			name,
			summary: truncateCells(summary, 48),
			startedAt: at
		});
		this.running.set(token, activeTool);
		this.publish({ activeTool });
		return token;
	}
	finishTool(token, outcome, at = Date.now()) {
		const activity = this.running.get(token);
		if (!activity) return;
		this.running.delete(token);
		const error = outcome.error ? truncateCells(outcome.error, 160) : void 0;
		const item = Object.freeze({
			name: activity.name,
			summary: activity.summary,
			ok: outcome.ok,
			ms: Math.max(0, at - activity.startedAt),
			at,
			...error ? { error } : {}
		});
		this.publish({
			activeTool: [...this.running.values()].at(-1),
			recent: Object.freeze([...this.snapshot.recent, item].slice(-10)),
			...error ? { lastError: error } : {}
		});
	}
	update(patch) {
		const next = { ...patch };
		if (patch.browser) next.browser = Object.freeze({ ...patch.browser });
		if (patch.capture) next.capture = Object.freeze({ ...patch.capture });
		if (patch.spaces) next.spaces = Object.freeze(patch.spaces.map((space) => Object.freeze({
			name: space.name,
			tabs: Object.freeze(space.tabs.map((tab) => Object.freeze({
				...tab,
				...tab.humanCheck ? { humanCheck: Object.freeze({ ...tab.humanCheck }) } : {}
			})))
		})));
		if (patch.lastError !== void 0) next.lastError = truncateCells(patch.lastError, 160);
		if (Object.keys(next).every((key) => JSON.stringify(this.snapshot[key]) === JSON.stringify(next[key]))) return;
		this.publish(next);
	}
};
const tuiSettingsSection = {
	ns: "ego-browser",
	title: "Agent Browser",
	descriptions: { zh: "Agent 浏览器" },
	page: {
		id: "ego-browser",
		title: "Agent Browser",
		descriptions: { zh: "Agent 浏览器" }
	},
	fields: {
		"commands": [],
		"x-dsh-tui": [{
			"apiVersion": "tui.dsh/v1alpha1",
			"kind": "SettingsSection",
			"id": "dsh-ego-browser.settings",
			"name": "ego_browser_settings",
			"spec": {
				"namespace": "ego-browser",
				"title": "Agent 浏览器",
				"titles": {
					"en": "Agent Browser",
					"zh": "Agent 浏览器"
				},
				"fields": [
					{
						"path": ["isolateSpaces"],
						"label": "Space isolation",
						"kind": "boolean",
						"hint": "Use a temporary isolated profile; off keeps the persistent login profile.",
						"titles": {
							"en": "Space isolation",
							"zh": "任务空间沙盒隔离"
						},
						"hintTitles": {
							"en": "Use a temporary isolated profile; off keeps the persistent login profile.",
							"zh": "使用临时隔离空间；关闭时使用持久化登录配置。"
						}
					},
					{
						"path": ["idleTimeoutMin"],
						"label": "Idle auto-stop (minutes)",
						"kind": "number",
						"hint": "Stop the browser after N minutes without tool calls; 0 disables. Watching is not activity.",
						"titles": {
							"en": "Idle auto-stop (minutes)",
							"zh": "空闲自动回收（分钟）"
						},
						"hintTitles": {
							"en": "Stop the browser after N minutes without tool calls; 0 disables. Watching is not activity.",
							"zh": "N 分钟没有工具调用后关闭浏览器；0 表示关闭回收。观看不算活动。"
						}
					},
					{
						"path": ["residentExecutor"],
						"label": "Resident executor",
						"kind": "boolean",
						"hint": "Reuse the execution process; default off.",
						"titles": {
							"en": "Resident executor",
							"zh": "常驻执行进程"
						},
						"hintTitles": {
							"en": "Reuse the execution process; default off.",
							"zh": "复用执行进程；默认关闭。"
						}
					},
					{
						"path": ["residentIdleMin"],
						"label": "Resident idle stop (minutes)",
						"kind": "number",
						"hint": "Stop the resident executor after N idle minutes; 0 keeps it until unload.",
						"titles": {
							"en": "Resident idle stop (minutes)",
							"zh": "常驻空闲停止（分钟）"
						},
						"hintTitles": {
							"en": "Stop the resident executor after N idle minutes; 0 keeps it until unload.",
							"zh": "空闲 N 分钟后停止常驻执行进程；0 表示保留到卸载。"
						}
					},
					{
						"path": ["disableFrameRelay"],
						"label": "Disable live preview frames",
						"kind": "boolean",
						"hint": "No watch panel frames, no screencast capture and no cast worker. Handy in TUI/headless setups. ego_* tools keep working.",
						"titles": {
							"en": "Disable live preview frames",
							"zh": "关闭实时画面传输"
						},
						"hintTitles": {
							"en": "No watch panel frames, no screencast capture and no cast worker. Handy in TUI/headless setups. ego_* tools keep working.",
							"zh": "不传输观察窗画面、不做 screencast 采集、不启动 cast worker；适合 TUI/无头环境，ego_* 工具不受影响。"
						}
					},
					{
						"path": ["egoBin"],
						"label": "Runtime script (egoBin)",
						"kind": "text",
						"hint": "Node-executable script (.mjs/.js); NOT the official ego-browser.exe. Empty = bundled runtime.",
						"titles": {
							"en": "Runtime script (egoBin)",
							"zh": "运行时脚本（egoBin）"
						},
						"hintTitles": {
							"en": "Node-executable script (.mjs/.js); NOT the official ego-browser.exe. Empty = bundled runtime.",
							"zh": "Node 可执行脚本（.mjs/.js），不是官方 ego-browser.exe；留空使用内置运行时。"
						}
					},
					{
						"path": ["chromePath"],
						"label": "Browser binary path",
						"kind": "text",
						"hint": "Path to Chrome, Chromium or Edge. Empty means auto-detect.",
						"titles": {
							"en": "Browser binary path",
							"zh": "浏览器程序路径"
						},
						"hintTitles": {
							"en": "Path to Chrome, Chromium or Edge. Empty means auto-detect.",
							"zh": "Chrome、Chromium 或 Edge 路径；留空自动检测。"
						}
					},
					{
						"path": ["captureBackend"],
						"label": "Capture backend",
						"kind": "select",
						"options": [
							{
								"value": "auto",
								"label": "Auto"
							},
							{
								"value": "cdp",
								"label": "CDP"
							},
							{
								"value": "ffmpeg",
								"label": "FFmpeg"
							}
						],
						"titles": {
							"en": "Capture backend",
							"zh": "画面采集后端"
						},
						"hint": "Choose automatic detection, CDP or FFmpeg.",
						"hintTitles": {
							"en": "Choose automatic detection, CDP or FFmpeg.",
							"zh": "选择自动检测、CDP 或 FFmpeg。"
						}
					},
					{
						"path": ["streamProfile"],
						"label": "Quality profile",
						"kind": "select",
						"options": [
							{
								"value": "low",
								"label": "Low",
								"titles": { "zh": "低" }
							},
							{
								"value": "balanced",
								"label": "Balanced",
								"titles": { "zh": "均衡" }
							},
							{
								"value": "high",
								"label": "High",
								"titles": { "zh": "高" }
							}
						],
						"titles": {
							"en": "Quality profile",
							"zh": "画质预设"
						},
						"hint": "Low reduces bandwidth; balanced is the default; high improves detail.",
						"hintTitles": {
							"en": "Low reduces bandwidth; balanced is the default; high improves detail.",
							"zh": "低画质减少带宽；均衡为默认；高画质保留更多细节。"
						}
					},
					{
						"path": ["ffmpegPath"],
						"label": "FFmpeg binary path",
						"kind": "text",
						"hint": "Path to FFmpeg. Empty means auto-detect or on-demand installation.",
						"titles": {
							"en": "FFmpeg binary path",
							"zh": "FFmpeg 程序路径"
						},
						"hintTitles": {
							"en": "Path to FFmpeg. Empty means auto-detect or on-demand installation.",
							"zh": "FFmpeg 路径；留空自动检测或按需安装。"
						}
					},
					{
						"path": ["tuiAutoOpenPanel"],
						"label": "Auto-open TUI browser panel",
						"titles": {
							"en": "Auto-open TUI browser panel",
							"zh": "自动打开 TUI 浏览器面板"
						},
						"kind": "boolean",
						"hint": "Off by default. Open the panel on the first ego_* call; otherwise show a badge and status only.",
						"hintTitles": {
							"en": "Off by default. Open the panel on the first ego_* call; otherwise show a badge and status only.",
							"zh": "默认关闭。开启后首次 ego_* 调用打开面板；关闭时仅显示角标和状态。"
						}
					}
				]
			}
		}]
	}["x-dsh-tui"].find((section) => section.kind === "SettingsSection").spec.fields.map(({ titles, hintTitles, options, ...field }) => ({
		...field,
		...titles ? { descriptions: titles } : {},
		...hintTitles ? { hintDescriptions: hintTitles } : {},
		...options ? { options: options.map(({ titles: optionTitles, ...option }) => ({
			...option,
			...optionTitles ? { descriptions: optionTitles } : {}
		})) } : {}
	}))
};
function installTuiSettings(ctx) {
	ctx.inject?.(["tuiSettingsSections"], (sctx) => {
		const dispose = sctx.tuiSettingsSections.register(tuiSettingsSection);
		sctx.effect?.(() => dispose);
	});
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/integration.ts
/** Service discovery stays inside independently injected activation scopes. */
function installTui(ctx, store) {
	installTuiSettings(ctx);
	let override;
	let refreshStatus;
	let deliverToast;
	ctx.inject?.(["tuiStatus"], (sctx) => {
		let previous = "";
		let previousClick;
		let disposeField;
		const render = () => {
			const snapshot = store.getSnapshot();
			const active = snapshot.activeTool;
			const lastError = snapshot.lastError ?? snapshot.recent.findLast((result) => result.error)?.error;
			const text = override?.text ?? (active ? `◎ ${active.name}` : "◎ idle");
			const tone = override?.tone ?? (active ? "accent" : "dim");
			const detail = truncateCells(override?.detail ?? (active ? [[active.name, active.summary].filter(Boolean).join(" · "), lastError].filter(Boolean).join(" | ") : lastError ?? "Agent Browser is idle"), 160);
			const key = JSON.stringify([
				text,
				tone,
				detail
			]);
			if (key === previous && previousClick === override?.onClick) return;
			previous = key;
			previousClick = override?.onClick;
			disposeField?.();
			disposeField = sctx.tuiStatus.setField("ego-browser", text, {
				slot: "right-head",
				tone,
				maxCells: 24,
				detail,
				...override?.onClick ? { onClick: override.onClick } : {}
			});
		};
		refreshStatus = render;
		render();
		const off = store.subscribe(render);
		sctx.effect?.(() => () => {
			off();
			disposeField?.();
			if (refreshStatus === render) refreshStatus = void 0;
		});
	});
	ctx.inject?.(["tuiToast"], (sctx) => {
		let sent = [];
		const deliver = (text, color) => {
			const now = Date.now();
			sent = sent.filter((at) => now - at < 6e4);
			if (sent.length >= 20) return;
			sent.push(now);
			try {
				sctx.tuiToast.show(truncateCells(text, 200), {
					color,
					timeoutMs: 4e3
				});
			} catch {}
		};
		deliverToast = deliver;
		sctx.effect?.(() => () => {
			if (deliverToast === deliver) deliverToast = void 0;
		});
	});
	return {
		toast: (text, color) => deliverToast?.(text, color),
		hasToast: () => deliverToast !== void 0,
		setStatusOverride: (value) => {
			override = value;
			refreshStatus?.();
		}
	};
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/panel-controller.ts
/** The worker currently calls its flat target list `spaces`; do not invent task spaces. */
function parseSpaces(value, groups = []) {
	if (!value || typeof value !== "object") return [];
	const rows = value.spaces;
	if (!Array.isArray(rows)) return [];
	const parseTabs = (values) => values.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const tab = value;
		if (typeof tab.targetId !== "string") return [];
		return [{
			targetId: tab.targetId,
			url: sanitizeText(typeof tab.url === "string" ? tab.url : ""),
			title: sanitizeText(typeof tab.title === "string" ? tab.title : ""),
			active: tab.active === true,
			humanCheck: tab.humanCheck && typeof tab.humanCheck === "object" && tab.humanCheck.detected === true ? {
				detected: true,
				kind: typeof tab.humanCheck.kind === "string" ? sanitizeText(tab.humanCheck.kind) : void 0
			} : void 0
		}];
	});
	if (rows.some((row) => row && typeof row === "object" && Array.isArray(row.tabs))) return rows.filter((row) => row && typeof row === "object" && Array.isArray(row.tabs)).map((row) => ({
		name: sanitizeText(typeof row.name === "string" ? row.name : "Unnamed space"),
		tabs: parseTabs(row.tabs)
	}));
	const tabs = parseTabs(rows);
	const remaining = new Map(tabs.map((tab) => [tab.targetId, tab]));
	const spaces = groups.flatMap((group) => {
		const members = group.targetIds.flatMap((id) => {
			const tab = remaining.get(id);
			if (!tab) return [];
			remaining.delete(id);
			return [tab];
		});
		return members.length ? [{
			name: sanitizeText(group.name),
			tabs: members
		}] : [];
	});
	if (!spaces.length) return [{
		name: "Global/default group",
		tabs
	}];
	if (remaining.size) spaces.push({
		name: "Unassigned / global",
		tabs: [...remaining.values()]
	});
	return spaces;
}
/** Optional capture status comes from the existing spaces response, never a new request. */
function parseCapture(value) {
	if (!value || typeof value !== "object") return void 0;
	const capture = value.capture;
	if (!capture || typeof capture !== "object") return void 0;
	const fields = capture;
	if (typeof fields.backend !== "string" || typeof fields.state !== "string") return void 0;
	return {
		backend: truncateCells(sanitizeText(fields.backend), 40),
		state: truncateCells(sanitizeText(fields.state), 40),
		...typeof fields.code === "string" ? { code: truncateCells(sanitizeText(fields.code), 40) } : {}
	};
}
/** One lifecycle owner for polling; component hooks stop it immediately on hide/unmount. */
function createPanelController(store, config, transport) {
	let disposed = false;
	let visible = false;
	let generation = 0;
	let timer;
	let pending;
	let queued = false;
	const refresh = () => {
		if (disposed) return Promise.resolve();
		if (pending) {
			queued = true;
			return pending;
		}
		const epoch = generation;
		pending = (async () => {
			const browser = await transport.readBrowserState();
			if (disposed || epoch !== generation) return;
			store.update({
				browser,
				frameRelayDisabled: false
			});
			if (!browser.running) {
				store.update({
					spaces: [],
					capture: void 0
				});
				return;
			}
			const port = await transport.ensureWorker();
			if (disposed || epoch !== generation) return;
			if (!port) {
				store.update({ lastError: "Browser worker unavailable" });
				return;
			}
			const payload = await transport.get(port, "/api/spaces");
			if (disposed || epoch !== generation) return;
			const groups = payload ? await transport.readTaskSpaceGroups?.() ?? [] : [];
			if (disposed || epoch !== generation) return;
			store.update(payload ? {
				spaces: parseSpaces(payload, groups),
				capture: parseCapture(payload),
				lastError: void 0
			} : { lastError: "Could not refresh browser tabs" });
		})().catch((error) => {
			if (!disposed && epoch === generation) store.update({ lastError: sanitizeText(String(error)) });
		}).finally(() => {
			pending = void 0;
			if (queued) {
				queued = false;
				refresh();
			}
		});
		return pending;
	};
	const post = async (path, body) => {
		if (disposed) return;
		const port = await transport.ensureWorker();
		if (!port || disposed) return;
		const result = await transport.post(port, path, body);
		if (disposed) return;
		if (!result || result.status < 200 || result.status >= 300) {
			store.update({ lastError: path === "/api/close" ? "Could not close tab" : "Could not flush browser cookies" });
			return;
		}
		await refresh();
	};
	let latest = store.getSnapshot().recent.at(-1);
	const unsubscribe = store.subscribe(() => {
		const next = store.getSnapshot().recent.at(-1);
		if (next === latest) return;
		latest = next;
		if (next) refresh();
	});
	return {
		setVisible(next) {
			if (disposed || next === visible) return;
			visible = next;
			if (!visible) queued = false;
			generation++;
			if (timer) clearInterval(timer);
			timer = void 0;
			if (visible) {
				refresh();
				timer = setInterval(() => void refresh(), 2e3);
			}
		},
		refresh,
		close: (targetId) => post("/api/close", { targetId }).catch((error) => {
			if (!disposed) store.update({ lastError: sanitizeText(String(error)) });
		}),
		flush: () => post("/api/flush", {}).catch((error) => {
			if (!disposed) store.update({ lastError: sanitizeText(String(error)) });
		}),
		dispose() {
			disposed = true;
			queued = false;
			generation++;
			if (timer) clearInterval(timer);
			unsubscribe();
		}
	};
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/panel-layout.ts
/**
* Host `ui.Text` props for a row. dsh-TUI's themed Text resolves `color` as a
* theme key (bare names such as 'red' resolve to nothing) and dims via
* `dimColor`; every non-dim tone here is also a theme key.
*/
function rowTextProps(row) {
	return row.tone === "dim" || row.tone === void 0 ? {
		dimColor: row.tone === "dim",
		wrap: "truncate"
	} : {
		dimColor: false,
		color: row.tone,
		wrap: "truncate"
	};
}
function panelTabs(snapshot) {
	return (snapshot.spaces ?? []).flatMap((space) => space.tabs);
}
function hasHumanCheck(snapshot) {
	return panelTabs(snapshot).some((tab) => tab.humanCheck?.detected === true);
}
/** Pure, cell-bounded text layout. Selection scrolls within the available tab rows. */
function layoutPanel(snapshot, width, height, selected) {
	const rows = [];
	const add = (text, tone) => rows.push({
		text: truncateCells(text, width),
		tone
	});
	const tabs = panelTabs(snapshot);
	const active = tabs.find((tab) => tab.active);
	add(snapshot.spaces?.length === 1 ? `◎ Agent Browser · ${snapshot.spaces[0]?.name ?? ""}` : "◎ Agent Browser", "dim");
	if (snapshot.browser) add(snapshot.browser.running ? `◎ running${snapshot.browser.headless === void 0 ? "" : snapshot.browser.headless ? " · headless" : " · windowed"}` : "◎ stopped", snapshot.browser.running ? "success" : "dim");
	if (active) {
		add(active.title || "(untitled)", "accent");
		add(active.url, "dim");
	}
	if (hasHumanCheck(snapshot)) add("! Human check · o to take over", "warning");
	if (snapshot.activeTool) add(`▶ ${snapshot.activeTool.name} · ${snapshot.activeTool.summary}`, "accent");
	if (snapshot.lastError) add(`! ${snapshot.lastError}`, "error");
	const actions = snapshot.recent.slice(-Math.min(5, Math.max(3, height - rows.length - 6)));
	const tabBudget = Math.max(0, height - rows.length - actions.length - 3);
	const flattened = (snapshot.spaces ?? []).flatMap((space) => space.tabs.map((tab) => ({
		tab,
		group: space.name
	})));
	const tabRows = Math.max(0, tabBudget - 1);
	const start = Math.max(0, Math.min(selected - tabRows + 1, flattened.length - tabRows));
	if (tabBudget > 0) {
		add(`Tabs (${tabs.length}) · ${snapshot.spaces?.length === 1 ? snapshot.spaces[0]?.name : "groups"}`, "dim");
		for (let i = start; i < Math.min(flattened.length, start + tabRows); i++) {
			const item = flattened[i];
			const group = (snapshot.spaces?.length ?? 0) > 1 ? `[${item.group}] ` : "";
			add(`${i === selected ? "›" : " "} ${item.tab.active ? "*" : " "} ${group}${item.tab.title || item.tab.url}`, i === selected ? "accent" : void 0);
		}
	}
	if (actions.length) add("Recent actions", "dim");
	for (const action of actions) add(`${action.ok ? "✓" : "✗"} ${action.ms}ms ${action.name} · ${action.summary}`, action.ok ? "success" : "error");
	const hint = {
		text: truncateCells("↑↓ select · o open · x close · f login · r refresh", width),
		tone: "dim"
	};
	return [...rows.slice(0, Math.max(0, height - 1)), hint].slice(0, Math.max(0, height));
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/panel.ts
/** All optional services are resolved in their own declared injection scope. */
function installBrowserPanel(ctx, config, store, tui, dependencies) {
	let dialogs;
	ctx.inject?.(["tuiDialogs"], (dctx) => {
		dialogs = dctx.tuiDialogs;
		dctx.effect?.(() => () => {
			dialogs = void 0;
		});
	});
	ctx.inject?.(["tuiPanels"], (pctx) => {
		const panels = pctx.tuiPanels;
		if (!panels) return;
		const controller = createPanelController(store, config, dependencies.createTransport());
		let host;
		let disposed = false;
		let firstTool = false;
		let previousHuman = false;
		let lastOpen = -Infinity;
		let panelId = "";
		const openPanel = () => {
			if (!panelId || disposed || Date.now() - lastOpen < 5e3) return;
			lastOpen = Date.now();
			panels.open(panelId);
		};
		const notify = (level) => {
			if (host) host.notify(level, 1);
			else if (panelId) panels.badge(panelId, {
				level,
				unread: 1
			});
		};
		const onSnapshot = () => {
			const snapshot = store.getSnapshot();
			if (!firstTool && snapshot.activeTool) {
				firstTool = true;
				notify("info");
				if (config.tuiAutoOpenPanel) openPanel();
			}
			const human = hasHumanCheck(snapshot);
			if (human && !previousHuman) {
				notify("warning");
				tui.toast("Browser needs human verification. Press o in Agent Browser to take over.", "warning");
			}
			if (human !== previousHuman) {
				previousHuman = human;
				tui.setStatusOverride(human ? {
					text: "◎ human check",
					tone: "warning",
					detail: "Human verification required. Open Agent Browser, then press o to take over.",
					onClick: openPanel
				} : void 0);
			}
		};
		const unsubscribe = store.subscribe(onSnapshot);
		function BrowserPanel(props) {
			const { React, ui } = props;
			const [snapshot, setSnapshot] = React.useState(store.getSnapshot);
			const [selectedId, setSelectedId] = React.useState(void 0);
			const [closeArmed, setCloseArmed] = React.useState(void 0);
			const [message, setMessage] = React.useState("");
			const closing = React.useRef(false);
			const mounted = React.useRef(true);
			React.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			React.useEffect(() => {
				if (!props.visible) return;
				setSnapshot(store.getSnapshot());
				return store.subscribe(() => setSnapshot(store.getSnapshot()));
			}, [props.visible]);
			React.useEffect(() => {
				host = props.host;
				return () => {
					if (host === props.host) host = void 0;
				};
			}, [props.host]);
			React.useEffect(() => {
				controller.setVisible(props.visible);
				return () => controller.setVisible(false);
			}, [props.visible]);
			const tabs = panelTabs(snapshot);
			let selection = tabs.findIndex((tab) => tab.targetId === selectedId);
			if (selection < 0) selection = tabs.findIndex((tab) => tab.active);
			if (selection < 0) selection = 0;
			const targetId = tabs[selection]?.targetId;
			const move = (delta) => {
				if (tabs.length === 0) return;
				const id = tabs[Math.max(0, Math.min(tabs.length - 1, selection + delta))]?.targetId;
				if (id) setSelectedId(id);
				setCloseArmed(void 0);
			};
			React.useEffect(() => {
				setCloseArmed(void 0);
			}, [
				targetId,
				props.visible,
				props.focused
			]);
			React.useEffect(() => {
				if (!props.visible || !props.focused) return;
				return props.host.onKey((event) => {
					if (event.key.ctrl || event.key.meta) return;
					let action;
					if (event.key.upArrow) action = () => move(-1);
					else if (event.key.downArrow) action = () => move(1);
					else if (event.input === "o") action = () => {
						setCloseArmed(void 0);
						dependencies.openAgentWindow().then((result) => {
							if (!disposed && mounted.current && !result.ok) setMessage(result.error || "Could not open browser window");
						}).catch((error) => {
							if (!disposed && mounted.current) setMessage(String(error));
						});
					};
					else if (event.input === "r") action = () => {
						setCloseArmed(void 0);
						controller.refresh();
					};
					else if (event.input === "f") action = () => {
						setCloseArmed(void 0);
						controller.flush();
					};
					else if (event.input === "x" && targetId) action = () => {
						if (closing.current) return;
						if (!dialogs && closeArmed !== targetId) {
							setCloseArmed(targetId);
							return;
						}
						closing.current = true;
						(async () => {
							if ((dialogs ? await dialogs.confirm({
								title: "Close browser tab?",
								message: truncateCells(tabs[selection]?.title || tabs[selection]?.url || targetId, 200),
								confirmLabel: "Close tab",
								cancelLabel: "Keep tab"
							}) : true) && !disposed && mounted.current) await controller.close(targetId);
						})().finally(() => {
							closing.current = false;
							if (mounted.current) setCloseArmed(void 0);
						});
					};
					if (!action) {
						setCloseArmed(void 0);
						return;
					}
					event.preventDefault();
					action();
				});
			}, [
				props.host,
				props.visible,
				props.focused,
				snapshot,
				selection,
				closeArmed,
				targetId
			]);
			const rows = layoutPanel(snapshot, props.width, props.height, selection);
			if (closeArmed && rows.length) rows[rows.length - 1] = {
				text: truncateCells("Press x again to close this tab", props.width),
				tone: "warning"
			};
			else if (message && rows.length) rows[rows.length - 1] = {
				text: truncateCells(message, props.width),
				tone: "error"
			};
			return React.createElement(ui.Box, {
				flexDirection: "column",
				width: props.width,
				height: props.height
			}, ...rows.map((row, index) => React.createElement(ui.Text, {
				key: index,
				...rowTextProps(row)
			}, row.text)));
		}
		const unregister = panels.register({
			apiVersion: 1,
			id: "browser",
			title: "Agent Browser",
			icon: "◎",
			minColumns: 28,
			component: BrowserPanel
		});
		panelId = panels.list().find((panel) => panel.id.endsWith(":browser"))?.id ?? "";
		pctx.effect?.(() => () => {
			disposed = true;
			controller.dispose();
			unsubscribe();
			tui.setStatusOverride(void 0);
			if (typeof unregister === "function") unregister();
		});
	});
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/worker-client.ts
/** Shared lazy worker client. Importing this module performs no I/O. */
const WORKER_BIN = fileURLToPath(new URL("../bin/ego-cast-worker.mjs", import.meta.url));
function castStatePath() {
	const e = process.env;
	const isWin = process.platform === "win32";
	const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : "/root");
	const stateHome = e.EGO_LINUX_STATE_DIR || (isWin ? e.LOCALAPPDATA || `${home}\\AppData\\Local` : e.XDG_STATE_HOME || `${home}/.local/state`);
	return stateHome.endsWith("ego-lite-linux") ? `${stateHome}/ego-cast.json` : `${stateHome}/ego-lite-linux/ego-cast.json`;
}
/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
async function proxyFrom(port, path) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4e3) });
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}
/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
async function proxyPost(port, path, body, timeoutMs = 4e3) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		return {
			status: r.status,
			body: await r.json().catch(() => ({
				ok: false,
				error: `worker returned ${r.status}`
			}))
		};
	} catch {
		return null;
	}
}
/** Read the worker's { port, pid } from ego-cast.json, if any. */
async function knownWorkerState() {
	try {
		const { readFile } = await import("node:fs/promises");
		const state = JSON.parse(await readFile(castStatePath(), "utf8"));
		return {
			port: typeof state.port === "number" ? state.port : null,
			pid: typeof state.pid === "number" ? state.pid : null
		};
	} catch {
		return {
			port: null,
			pid: null
		};
	}
}
/** Is a process with this pid alive? (false for our own / empty / signals fail) */
function isProcessAlive$1(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err;
		return e && e.code === "EPERM";
	}
}
function captureConfig(cfg, ffmpegManager) {
	const ffmpegStatus = ffmpegManager?.status();
	const unavailable = cfg.captureBackend === "ffmpeg" && !ffmpegStatus?.canSelectFfmpeg;
	return {
		captureBackend: unavailable ? "cdp" : cfg.captureBackend,
		ffmpegFallbackReason: unavailable ? ffmpegStatus?.reason || "FFmpeg is unavailable" : "",
		streamProfile: cfg.streamProfile,
		cdpFps: cfg.cdpFps,
		cdpQuality: cfg.cdpQuality,
		cdpMaxWidth: cfg.cdpMaxWidth,
		cdpBackstopIntervalMs: cfg.cdpBackstopIntervalMs,
		ffmpegFps: cfg.ffmpegFps,
		ffmpegMaxWidth: cfg.ffmpegMaxWidth,
		ffmpegBitrateKbps: cfg.ffmpegBitrateKbps,
		ffmpegEncoder: cfg.ffmpegEncoder,
		ffmpegPath: cfg.ffmpegPath,
		ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? ffmpegStatus.path || "" : ""
	};
}
/**
* Ensure a single ego-cast worker is running (idempotent). Launches it via
* ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
* pid no longer alive or its /api/health does not answer), so a crashed
* worker is brought back without a host restart. Spawn is rate-limited to
* avoid hot-looping while a headless container has no browser yet.
*/
function makeEnsureWorker(ctx, cfg, ffmpegManager) {
	let lastAttempt = 0;
	async function launchedWorkerPort() {
		const state = await knownWorkerState();
		if (state.pid === null || !isProcessAlive$1(state.pid)) return null;
		return await proxyFrom(state.port, "/api/health") ? state.port : null;
	}
	return async function ensureWorker() {
		const running = await launchedWorkerPort();
		if (running !== null) return running;
		const now = Date.now();
		if (now - lastAttempt > 8e3) {
			lastAttempt = now;
			try {
				await ffmpegManager?.check({
					configuredPath: cfg.ffmpegPath,
					requestedEncoder: cfg.ffmpegEncoder
				}).catch(() => null);
				const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager));
				ctx.subprocess.spawn({
					argv: [
						process.execPath,
						WORKER_BIN,
						initCfg
					],
					cwd: process.cwd(),
					env: process.versions.electron ? {
						...process.env,
						ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1"
					} : void 0,
					stdio: {
						stdin: { data: "" },
						stdout: { maxBytes: 8192 },
						stderr: { maxBytes: 4096 }
					},
					graceMs: 12e3
				}).done.catch(() => null);
				const deadline = Date.now() + 8e3;
				while (Date.now() < deadline) {
					const ready = await launchedWorkerPort();
					if (ready !== null) return ready;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				return null;
			} catch {
				return null;
			}
		}
		return null;
	};
}
/** Read-only membership metadata; never reconcile, prune, or mutate task spaces. */
async function readTaskSpaceGroups() {
	try {
		const { readFile } = await import("node:fs/promises");
		const state = JSON.parse(await readFile(join(resolveEgoStateDir(), "task-spaces.json"), "utf8"));
		if (!Array.isArray(state.spaces)) return [];
		return state.spaces.flatMap((value) => {
			if (!value || typeof value !== "object" || typeof value.name !== "string" || !Array.isArray(value.targetIds)) return [];
			return [{
				name: value.name,
				targetIds: value.targetIds.filter((id) => typeof id === "string")
			}];
		});
	} catch {
		return [];
	}
}
/** Read browser metadata without launching the browser or the cast worker. */
async function readBrowserState() {
	try {
		const { readFile } = await import("node:fs/promises");
		const state = JSON.parse(await readFile(join(resolveEgoStateDir(), "browser.json"), "utf8"));
		return {
			running: typeof state.pid === "number" && isProcessAlive$1(state.pid),
			...typeof state.headless === "boolean" ? { headless: state.headless } : {}
		};
	} catch {
		return { running: false };
	}
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/tui/presentation.ts
const selectorTools = new Set([
	"ego_click",
	"ego_fill",
	"ego_screenshot",
	"ego_wait_for_selector",
	"ego_hover",
	"ego_read_element",
	"ego_select",
	"ego_scroll",
	"ego_upload",
	"ego_check"
]);
const urlTools = new Set([
	"ego_navigate",
	"ego_http",
	"ego_wait_for_response"
]);
/** Only locator fields are eligible; values, headers, bodies and executable source never are. */
function safeLocatorSummary(name, value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
	const args = value;
	let summary = "";
	if (selectorTools.has(name) && typeof args.selector === "string") summary = args.selector;
	else if (urlTools.has(name) && typeof args.url === "string") try {
		const url = new URL(args.url);
		if (url.protocol === "http:" || url.protocol === "https:") summary = url.host + url.pathname;
	} catch {}
	else if (name === "ego_drag" && typeof args.from === "string" && typeof args.to === "string") summary = `${args.from} → ${args.to}`;
	else if (name === "ego_download" && typeof args.triggerSelector === "string") summary = args.triggerSelector;
	return truncateCells(sanitizeText(summary), 48);
}
function toolCallTitle(name, args) {
	const summary = safeLocatorSummary(name, args);
	return summary ? `${name} · ${summary}` : name;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/cast-server.ts
/**
* ego-browser cast-server — host half of the realtime watch panel.
*
* Bridges the client UI (/api/ego/*) to the ego-cast worker
* (bin/ego-cast-worker.mjs) that attaches to the agent's live browser and
* streams screencast JPEGs. Everything the agent's own browser does is pushed;
* this host route only *reads* the worker's loopback JSON. No navigation, no
* writes, no host env changes — consistent with the plugin's read-only stance.
*
* Lifecycle: the worker is launched lazily (only once), on the first request,
* when a live agent browser is expected. If no browser.json exists yet it
* exits cleanly; we surface an empty spaces list so the panel says
* "no live browser right now" instead of erroring.
*/
const EGO_SPACES_ROUTE = "/api/ego/spaces";
const EGO_STREAM_ROUTE = "/api/ego/stream";
const EGO_HEALTH_ROUTE = "/api/ego/health";
const EGO_CLOSE_ROUTE = "/api/ego/close";
const EGO_FLUSH_ROUTE = "/api/ego/flush";
const EGO_RAISE_ROUTE = "/api/ego/raise";
const EGO_LOGIN_IMPORT_ROUTE = "/api/ego/login-import";
const EGO_INPUT_ROUTE = "/api/ego/input";
const EGO_WINDOW_SIZE_ROUTE = "/api/ego/window-size";
const EGO_WATCH_START_ROUTE = "/api/ego/watch/start";
const EGO_WATCH_SWITCH_ROUTE = "/api/ego/watch/switch";
const EGO_WATCH_STOP_ROUTE = "/api/ego/watch/stop";
const EGO_WATCH_STATUS_ROUTE = "/api/ego/watch/status";
const EGO_VIDEO_ROUTE = "/api/ego/video";
const EGO_VIDEO_STATUS_ROUTE = "/api/ego/video/status";
let toolCallCount = 0;
const sseClients = /* @__PURE__ */ new Set();
/** Timestamp of the last ego_* tool call — the idle reaper's activity signal. */
let lastEgoActivity = 0;
function getLastEgoActivity() {
	return lastEgoActivity;
}
function markEgoToolCall(sessionId) {
	toolCallCount += 1;
	lastEgoActivity = Date.now();
	const frame = `event: tool-call\ndata: ${JSON.stringify(sessionId === void 0 || sessionId === "" ? { count: toolCallCount } : {
		count: toolCallCount,
		sessionId
	})}\n\n`;
	for (const res of sseClients) try {
		res.write(frame);
	} catch {
		sseClients.delete(res);
	}
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
/**
* Bridge the worker's SSE stream to the DSH watch panel.
*
* The host's webServer calls this as a plain HTTP handler and then returns, so
* we write the `text/event-stream` headers, start consuming the worker's
* /api/stream body, and forward every SSE line verbatim onto `res` from a
* background loop. The connection stays open until the worker stream ends or
* the client disconnects. If the worker is unreachable we still emit a valid
* empty SSE stream (the panel stays quiet instead of erroring).
*
* Each `res` is also registered in the module-level `sseClients` set so
* markEgoToolCall() can inject `tool-call` events directly into the live
* stream (the sidebar auto-open signal), without the client polling.
*/
function proxyWorkerStream(port, res, path, retry, retryDelayMs = 1500) {
	let cancelled = false;
	let ended = false;
	let timer = null;
	let upstream = null;
	const endOnce = () => {
		if (ended) return;
		ended = true;
		sseClients.delete(res);
		try {
			res.end();
		} catch {}
	};
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	});
	res.write(":ok\n\n");
	sseClients.add(res);
	const onClose = () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			upstream?.destroy();
		} catch {}
	};
	if (!Number.isInteger(port) || port <= 0) {
		res.on("close", () => {
			cancelled = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			sseClients.delete(res);
		});
		if (retry) {
			const attempt = () => {
				if (cancelled || ended) return;
				retry().then((next) => {
					if (cancelled || ended) return;
					if (typeof next === "number" && next > 0) {
						res.on("close", onClose);
						attach(next);
					} else timer = setTimeout(attempt, Math.max(20, retryDelayMs));
				}).catch(() => {
					if (!cancelled && !ended) timer = setTimeout(attempt, Math.max(20, retryDelayMs));
				});
			};
			timer = setTimeout(attempt, Math.max(20, retryDelayMs));
			return () => {
				cancelled = true;
				if (timer !== null) {
					clearTimeout(timer);
					timer = null;
				}
				sseClients.delete(res);
			};
		}
		return () => {
			sseClients.delete(res);
		};
	}
	function attach(workerPort) {
		upstream = request({
			host: "127.0.0.1",
			port: workerPort,
			path,
			method: "GET",
			headers: { accept: "text/event-stream" }
		}, (upRes) => {
			upRes.on("data", (chunk) => {
				if (cancelled || ended) return;
				try {
					if (!res.write(chunk)) {
						upRes.pause();
						res.once("drain", () => {
							if (!cancelled && !ended) upRes.resume();
						});
					}
				} catch {
					cancelled = true;
					endOnce();
				}
			});
			upRes.on("end", endOnce);
			upRes.on("error", endOnce);
		});
		upstream.on("error", endOnce);
		upstream.setTimeout(5e3, () => {
			try {
				upstream?.destroy();
			} catch {}
			endOnce();
		});
		upstream.end();
	}
	res.on("close", onClose);
	attach(port);
	return () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			upstream?.destroy();
		} catch {}
	};
}
function proxyWorkerVideo(port, req, res) {
	const generation = new URL(req.url || "/api/ego/video", "http://dsh.internal").searchParams.get("generation");
	const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ""}`;
	let upstream;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		try {
			res.end();
		} catch {}
	};
	upstream = request({
		host: "127.0.0.1",
		port,
		path,
		method: "GET",
		headers: { accept: "video/mp4" }
	}, (upRes) => {
		res.writeHead(upRes.statusCode || 502, {
			"content-type": upRes.headers["content-type"] || "application/octet-stream",
			"cache-control": "no-store",
			...upRes.headers["x-ego-generation"] ? { "x-ego-generation": upRes.headers["x-ego-generation"] } : {},
			...upRes.headers["x-ego-backend"] ? { "x-ego-backend": upRes.headers["x-ego-backend"] } : {}
		});
		upRes.on("data", (chunk) => {
			if (ended) return;
			try {
				if (!res.write(chunk)) {
					upRes.pause();
					res.once("drain", () => {
						if (!ended) upRes.resume();
					});
				}
			} catch {
				upstream.destroy();
				end();
			}
		});
		upRes.on("end", end);
		upRes.on("error", end);
	});
	upstream.on("error", () => {
		if (!res.headersSent) sendJson(res, 502, {
			ok: false,
			error: "video worker unavailable"
		});
		else end();
	});
	upstream.setTimeout(5e3, () => {
		try {
			upstream.destroy();
		} catch {}
		if (!res.headersSent) sendJson(res, 504, {
			ok: false,
			error: "video worker timeout"
		});
		else end();
	});
	upstream.end();
	res.on("close", () => {
		ended = true;
		try {
			upstream.destroy();
		} catch {}
	});
}
async function readJsonBody$1(req, maxBytes = 8192) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error("body too large");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Reason string every frame-relay route answers with while the relay is off. */
const FRAME_RELAY_DISABLED = "frame relay disabled";
/**
* Stop a running ego-cast worker (SIGTERM). The worker owns the CDP
* screencast / WGC capture and the ffmpeg pull, so killing it is what actually
* turns the frame relay off when the setting is flipped while it is running —
* no HTTP shutdown route exists in bin/ego-cast-worker.mjs (it exits on
* SIGTERM/SIGINT). A stale ego-cast.json is harmless: ensureWorker() proves the
* pid is alive before trusting the recorded port.
*/
async function stopCastWorker() {
	const state = await knownWorkerState();
	if (state.pid === null || !isProcessAlive$1(state.pid)) return false;
	try {
		process.kill(state.pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
/**
* Push the current cast config to a running worker via POST /api/config.
* Best-effort: if the worker is unreachable or the POST fails, the config
* will take effect on the next worker spawn (argv seed). Called whenever the
* settings layer reports a change.
*/
function makePushConfig(ensureWorker, ffmpegManager) {
	let lastPush = "";
	return async function pushConfig(cfg) {
		await ffmpegManager?.check({
			configuredPath: cfg.ffmpegPath,
			requestedEncoder: cfg.ffmpegEncoder
		}).catch(() => null);
		const port = await ensureWorker();
		if (port === null) return;
		const payload = JSON.stringify(captureConfig(cfg, ffmpegManager));
		if (payload === lastPush) return;
		lastPush = payload;
		try {
			const result = await proxyPost(port, "/api/config", JSON.parse(payload));
			if (!result || result.status >= 400) throw new Error("worker config update failed");
		} catch {}
	};
}
/**
* Register the watch-panel routes. Call inside plugin apply() with the real
* ctx; dispose is returned for ctx.effect cleanup.
*
* `bridge` is the settings bridge — its `onChange` is used to react to
* live settings saves and push the new config to a running worker.
*/
function initCastServer(ctx, cfg, bridge, ffmpegManager, openAgentWindow = async () => ({
	ok: false,
	error: "raise not supported by this host build"
}), loginImport = async () => ({
	ok: false,
	error: "login import not supported by this host build"
}), getExecutorStatus = () => ({})) {
	const ensureWorker = makeEnsureWorker(ctx, cfg, ffmpegManager);
	const pushConfig = makePushConfig(ensureWorker, ffmpegManager);
	const rawServer = ctx.get?.("webServer");
	if (!rawServer || typeof rawServer.register !== "function") return;
	const isTrustedRequest = (req) => {
		const remote = req.socket.remoteAddress ?? "";
		if (![
			"127.0.0.1",
			"::1",
			"::ffff:127.0.0.1"
		].includes(remote)) return false;
		const authority = req.headers.host ?? "";
		if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(authority)) return false;
		if (req.headers.origin !== void 0 && req.headers.origin !== `http://${authority}`) return false;
		return /(?:^|;\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie ?? ""));
	};
	const guardHandler = (handler) => async (req, resRaw) => {
		const res = resRaw;
		if (!isTrustedRequest(req)) {
			res.statusCode = 401;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end("{\"ok\":false,\"error\":\"unauthorized\"}");
			return;
		}
		return handler(req, res);
	};
	const rawRegister = rawServer.register.bind(rawServer);
	const externallyOwned = new Set([
		"/api/ego/spaces",
		"/api/ego/stream",
		"/api/ego/input",
		"/api/ego/close",
		"/api/ego/status",
		"/api/ego/history",
		"/api/ego/frame",
		"/api/ego/activity"
	]);
	const server = Object.assign(Object.create(Object.getPrototypeOf(rawServer)), rawServer, { register: (opts) => externallyOwned.has(opts.path) ? () => {} : rawRegister({
		...opts,
		handler: opts.handler ? guardHandler(opts.handler) : opts.handler
	}) });
	const relayDisabled = () => cfg.disableFrameRelay === true;
	const refuseFrameRelay = (res, extra = {}) => {
		sendJson(res, 200, {
			ok: false,
			reason: FRAME_RELAY_DISABLED,
			frameRelay: false,
			...extra
		});
	};
	if (typeof bridge?.onChange === "function") {
		const off = bridge.onChange(() => {
			if (relayDisabled()) {
				stopCastWorker();
				return;
			}
			pushConfig(cfg);
		});
		if (typeof off === "function") ctx.effect?.(() => () => {
			try {
				off();
			} catch {}
		});
	}
	const disposeSpaces = server.register({
		kind: "exact",
		path: EGO_SPACES_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, {
				spaces: [],
				toolCallCount
			});
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "no live agent browser",
				frameRelay: true
			});
			const data = await proxyFrom(port, "/api/spaces");
			if (!data) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "worker not ready",
				frameRelay: true
			});
			return sendJson(res, 200, {
				...data,
				toolCallCount,
				frameRelay: true
			});
		}
	});
	const disposeStream = server.register({
		kind: "exact",
		path: EGO_STREAM_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res);
			proxyWorkerStream(await ensureWorker() ?? -1, res, "/api/stream", ensureWorker);
		}
	});
	const disposeInput = server.register({
		kind: "exact",
		path: EGO_INPUT_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/input", await readJsonBody$1(req).catch(() => ({})));
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "input worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeWindowSize = server.register({
		kind: "exact",
		path: EGO_WINDOW_SIZE_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const body = await readJsonBody$1(req).catch(() => ({}));
			const width = Number(body.width);
			const delta = Number(body.delta);
			const height = Number(body.height);
			const dy = Number(body.dy);
			const aspect = Number(body.aspect);
			if (!Number.isFinite(width) && !Number.isFinite(delta) && !Number.isFinite(height) && !Number.isFinite(dy) && !Number.isFinite(aspect)) return sendJson(res, 400, {
				ok: false,
				error: "width, delta, height, dy or aspect is required"
			});
			const result = await proxyPost(port, "/api/window-size", {
				...Number.isFinite(width) ? { width } : {},
				...Number.isFinite(delta) ? { delta } : {},
				...Number.isFinite(height) && height > 0 ? { height } : {},
				...Number.isFinite(dy) ? { dy } : {},
				...Number.isFinite(aspect) && aspect > 0 ? { aspect } : {},
				...typeof body.targetId === "string" && body.targetId ? { targetId: body.targetId } : {}
			});
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "window-size worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeClose = server.register({
		kind: "exact",
		path: EGO_CLOSE_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const body = await readJsonBody$1(req).catch(() => ({}));
			const targetId = typeof body.targetId === "string" ? body.targetId : "";
			if (!targetId) return sendJson(res, 400, {
				ok: false,
				error: "targetId required"
			});
			const result = await proxyPost(port, "/api/close", { targetId });
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "close worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeFlush = server.register({
		kind: "exact",
		path: EGO_FLUSH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/flush", {});
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "flush worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeRaise = server.register({
		kind: "exact",
		path: EGO_RAISE_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			try {
				const result = await openAgentWindow();
				return sendJson(res, result.ok ? 200 : 500, result);
			} catch (err) {
				return sendJson(res, 500, {
					ok: false,
					error: String(err?.message || err)
				});
			}
		}
	});
	const disposeLoginImport = server.register({
		kind: "exact",
		path: EGO_LOGIN_IMPORT_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const body = await readJsonBody$1(req).catch(() => ({}));
			try {
				const result = await loginImport({
					source: [
						"chrome",
						"edge",
						"brave",
						"auto"
					].includes(String(body.source)) ? String(body.source) : "auto",
					domains: Array.isArray(body.domains) ? body.domains.map(String) : void 0,
					profile: typeof body.profile === "string" && body.profile !== "" ? body.profile : void 0,
					closeSource: body.closeSource === true,
					dryRun: body.dryRun === true
				});
				return sendJson(res, result.ok ? 200 : 400, result);
			} catch (err) {
				return sendJson(res, 500, {
					ok: false,
					error: String(err?.message || err)
				});
			}
		}
	});
	const disposeHealth = server.register({
		kind: "exact",
		path: EGO_HEALTH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED });
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, { ok: false });
			return sendJson(res, 200, await proxyFrom(port, "/api/health") || { ok: false });
		}
	});
	const watchRoutes = [
		[EGO_WATCH_START_ROUTE, "/api/watch/start"],
		[EGO_WATCH_SWITCH_ROUTE, "/api/watch/switch"],
		[EGO_WATCH_STOP_ROUTE, "/api/watch/stop"]
	].map(([path, workerPath]) => server.register({
		kind: "exact",
		path,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, {
				error: FRAME_RELAY_DISABLED,
				state: "disabled"
			});
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 409, {
				ok: false,
				error: "worker not ready"
			});
			const timeoutMs = workerPath === "/api/watch/start" || workerPath === "/api/watch/switch" ? 3e4 : 4e3;
			const result = await proxyPost(port, workerPath, await readJsonBody$1(req).catch(() => ({})), timeoutMs);
			return result ? sendJson(res, result.status, result.body) : sendJson(res, 502, {
				ok: false,
				error: "worker request failed"
			});
		}
	}));
	const disposeWatchStatus = server.register({
		kind: "exact",
		path: EGO_WATCH_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, {
				error: FRAME_RELAY_DISABLED,
				state: "disabled"
			});
			const port = await ensureWorker();
			return sendJson(res, 200, {
				...(port === null ? null : await proxyFrom(port, "/api/watch/status")) || {
					ok: false,
					state: "idle",
					reason: "worker not ready"
				},
				frameRelay: true
			});
		}
	});
	const disposeVideoStatus = server.register({
		kind: "exact",
		path: EGO_VIDEO_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res, {
				error: FRAME_RELAY_DISABLED,
				state: "disabled"
			});
			const port = await ensureWorker();
			return sendJson(res, 200, (port === null ? null : await proxyFrom(port, "/api/video/status")) || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposeVideo = server.register({
		kind: "exact",
		path: EGO_VIDEO_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			if (relayDisabled()) return refuseFrameRelay(res);
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 502, {
				ok: false,
				error: "worker not ready"
			});
			proxyWorkerVideo(port, req, res);
		}
	});
	const disposeExecutor = server.register({
		kind: "exact",
		path: "/api/ego/executor",
		handler: async (_req, resRaw) => {
			const res = resRaw;
			let status = {};
			try {
				status = getExecutorStatus();
			} catch {}
			return sendJson(res, 200, {
				ok: true,
				...status
			});
		}
	});
	const disposeLoginBridge = [
		server.register({
			kind: "exact",
			path: "/api/ego/login-extension/health",
			handler: async (_req, resRaw) => {
				const res = resRaw;
				try {
					return sendJson(res, 200, await getLoginExtensionHealth());
				} catch (err) {
					return sendJson(res, 500, {
						ok: false,
						error: String(err?.message || err)
					});
				}
			}
		}),
		server.register({
			kind: "exact",
			path: "/api/ego/login-extension/pair-code",
			handler: async (_req, resRaw) => {
				const res = resRaw;
				try {
					return sendJson(res, 200, await createLoginExtensionPairingCode());
				} catch (err) {
					return sendJson(res, 500, {
						ok: false,
						error: String(err?.message || err)
					});
				}
			}
		}),
		server.register({
			kind: "exact",
			path: "/api/ego/login-extension/import",
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				try {
					const body = await readJsonBody$1(req).catch(() => ({}));
					const domains = Array.isArray(body.domains) ? body.domains.map(String).filter(Boolean) : [];
					if (domains.length === 0) return sendJson(res, 400, {
						ok: false,
						error: "domains is required"
					});
					return sendJson(res, 200, {
						ok: true,
						jobId: (await startLoginExtensionJob({ domains })).jobId
					});
				} catch (err) {
					return sendJson(res, 500, {
						ok: false,
						error: String(err?.message || err)
					});
				}
			}
		}),
		server.register({
			kind: "exact",
			path: "/api/ego/login-extension/status",
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				try {
					const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? "";
					if (!id) return sendJson(res, 400, {
						ok: false,
						error: "id is required"
					});
					return sendJson(res, 200, await getLoginExtensionJob(id));
				} catch (err) {
					return sendJson(res, 500, {
						ok: false,
						error: String(err?.message || err)
					});
				}
			}
		})
	];
	ctx.effect?.(() => () => {
		try {
			disposeSpaces();
		} catch {}
		try {
			disposeStream();
		} catch {}
		try {
			disposeInput();
		} catch {}
		try {
			disposeWindowSize();
		} catch {}
		try {
			disposeExecutor();
		} catch {}
		try {
			disposeLoginBridge.forEach((dispose) => dispose());
		} catch {}
		try {
			stopLoginExtensionBridge();
		} catch {}
		try {
			disposeClose();
		} catch {}
		try {
			disposeFlush();
		} catch {}
		try {
			disposeRaise();
		} catch {}
		try {
			disposeLoginImport();
		} catch {}
		try {
			disposeHealth();
		} catch {}
		for (const dispose of watchRoutes) try {
			dispose();
		} catch {}
		try {
			disposeWatchStatus();
		} catch {}
		try {
			disposeVideoStatus();
		} catch {}
		try {
			disposeVideo();
		} catch {}
	});
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/help.ts
/**
* src/help.ts — tool index copy (EGO_HELP_INDEX).
*
* Pure data module: the `topic` lookup table for the ego_help tool. When you
* add/change a tool, remember to sync an entry here or ego_help won't find it.
*/
const EGO_HELP_INDEX = {
	overview: "ego-browser 结构化浏览器工具。导航/交互/观察/表单/网络/等待/键鼠皆有专项工具，另提供 ego_help(本索引)、ego_doctor(体检)、ego_cli/ego_script(自由脚本逃生舱)。分类见: tools / navigate / observe / input / keyboard-mouse / form / wait / network / login / script / doctor。用 `topic` 查询，或直接给工具名。",
	tools: "工具清单: ego_status, ego_space_open, ego_space_close, ego_snapshot, ego_navigate, ego_tabs, ego_click(+double), ego_fill, ego_js, ego_cdp, ego_screenshot(+selector), ego_page_info, ego_wait, ego_wait_for_selector, ego_wait_for_url, ego_wait_for_response, ego_wait_for_human, ego_key(+text/type), ego_hover, ego_read_element, ego_select, ego_drag, ego_scroll, ego_upload, ego_check, ego_dialog, ego_download, ego_http, ego_captcha, ego_auth_flush, ego_login_import, ego_help, ego_doctor, ego_cli, ego_script。",
	navigate: "ego_navigate: 打开URL或切tab(同任务复用当前tab)。ego_wait_for_url: 等跳转(登录/分页)。ego_tabs: 列出/切换/新建/关闭标签页(list/switch/open/close)。",
	tabs: "ego_tabs: 标签页管理。action=list 列出所有标签(targetId/title/url/active); switch 用 targetId 切换; open 用 url 新建标签(默认 about:blank); close 用 targetId 关闭。targetId 来自 list/open/ego_space_open/ego_navigate 的返回。依赖运行时提供 browser.listTabs/switchTab/closeTab 与 ego.createTab；官方 ego lite 若缺少这些 API 会返回明确错误（内置运行时完整支持）。",
	observe: "ego_snapshot: 整页语义树(带[ref]/loc供点击); ego_page_info: url/标题/视口/滚动/对话框/人机验证; ego_read_element: 读单元素文本/HTML/值/属性/可见性/计数; ego_screenshot(+selector): 整页或元素截图。",
	input: "ego_click(selector/坐标, double双击); ego_fill(填框); ego_key(press组合键 或 text连续键入); ego_check(勾选/取消); ego_select(下拉); ego_upload(文件上传); ego_dialog(接受/取消JS对话框)。",
	"keyboard-mouse": "ego_key: 键盘(press/text); ego_hover: 悬停; ego_drag: 拖拽(元素或坐标); ego_scroll: 滚轮/滚到元素; ego_click: 点击/双击。",
	form: "ego_fill 填输入框; ego_select 下拉; ego_check checkbox/radio; ego_upload 文件; ego_key 回车/Tab导航; ego_dialog 处理提交弹窗。",
	wait: "ego_wait(固定毫秒); ego_wait_for_selector(等元素出现/消失); ego_wait_for_url(等跳转); ego_wait_for_response(等网络响应并可读body)。",
	network: "ego_http: 发HTTP请求(默认浏览器上下文 fetch.browser, mode=server走Node fetch.server); ego_wait_for_response: 等并读接口响应。",
	download: "ego_download: 等下载事件并落到指定路径(triggerSelector/triggerScript + 可选 savePath)。",
	captcha: "ego_captcha: 检测页面人机验证(CAPTCHA)并返回{detected,kind}; 检测到请让用户去 ego 浏览器完成; ego_page_info 也附带 humanCheck。ego_wait_for_human: 先告诉用户要做什么，然后阻塞轮询直到验证码消失/登录完成(可选 selector 作为“登录成功”信号)，超时返回 resolved:false 而不是报错；不要走审批（never 策略会自动拒绝）。",
	login: "ego_auth_flush: 把登录cookie落盘到ego profile; 观察窗登录引导条+『已登录,保存』按钮触发同一动作。ego_login_import: 按域名导入系统浏览器登录cookie——现代 Chrome/Edge 用 source=extension：先在 Agent 浏览器面板点「连接 Chrome 登录态」，按 6 位配对码在扩展里配对一次，之后面板按钮/该工具即可自动导入（扩展后台轮询，30 秒内）；旧版或已关闭浏览器用 source=chrome|edge|brave 安全复制（Chrome/Edge 127+ 的 ABE 会读到 0 并明确报错，源 profile 不会被打开/写入）。先 dryRun 看可导入项；ego 浏览器须已在运行。",
	script: "ego_cli / ego_script: 原样运行任意 ego-browser nodejs heredoc脚本(page/browser/taskSpaces/site/fetch/cdp预载)。ego_script额外返回 duration/timedOut。注意 page 是本 runtime 的页面门面、不是 Playwright API：可用 goto/reload/info/url/title/locator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId/waitForTimeout/waitForLoadState/waitForSelector/waitForFunction/waitForURL/waitForRequest/waitForResponse/waitForEvent/evaluate/screenshot/snapshot/snapshotRaw/elementCenter/drainEvents/screencast/keyboard/mouse；没有 fill/click/type/press——交互用 ego_fill/ego_click 或 page.locator(...)。page.goto() 不返回 Playwright Response，取状态码用 ego_wait_for_response 或 page.info()。",
	doctor: "ego_doctor: 体检环境(浏览器候选、vendored runtime、状态目录、CDP端口、任务空间)。"
};
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/captcha.ts
/**
* src/captcha.ts — human-verification (CAPTCHA) detection probe.
*
* Standalone data module: HUMAN_CHECK_PROBE is a string that gets serialized
* into a `page.evaluate` call to identify reCAPTCHA / hCaptcha / Turnstile /
* Cloudflare / generic captcha. When changing probe heuristics, note that
* bin/ego-cast-worker.mjs (now src/worker/ego-cast-worker.ts) has a similar
* probe (HUMAN_PROBE_JS) — the two must stay in sync.
*/
const HUMAN_CHECK_PROBE = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const html = (el.outerHTML || '') + (el.closest('body') && el.closest('body').innerHTML ? '' : '');
    const s = String(html);
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile|cf-turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare|challenge-form/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  // [#62] Text-only fallback. It used to match a bare /captcha/ word, which
  // fires on ANY page that merely discusses captchas — including a local
  // dashboard rendering an agent session whose transcript quotes this plugin's
  // own source. Two guards: loopback origins are never text-probed (a locally
  // served page is the user's own tooling, not a challenge page), and the
  // pattern requires a challenge *phrase* rather than the bare noun.
  const loc = String(location.hostname || '');
  if (loc === 'localhost' || loc === '127.0.0.1' || loc === '::1' || loc === '[::1]' || loc.endsWith('.localhost')) {
    return { detected: false, kind: null };
  }
  const txt = (document.body ? document.body.innerText || '' : '').slice(0, 120000);
  const lower = txt.toLowerCase();
  if (/verify (that )?you are (a )?human|your activity looks unusual|i.?m not a robot|confirm you.?re human|人机验证|安全验证|我是人类|滑块验证|拖动滑块|点击.{0,8}验证/.test(lower)) {
    return { detected: true, kind: 'captcha' };
  }
  return { detected: false, kind: null };
})()`;
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/config.ts
const backend = Schema.union([
	"auto",
	"cdp",
	"ffmpeg"
]);
const profile = Schema.union([
	"low",
	"balanced",
	"high"
]);
/**
* Label the page cursor carries by default. The model driving the browser is
* chosen per session, so the label names the role rather than a vendor.
*/
const DEFAULT_CURSOR_NAME = "Agent";
const encoder = Schema.union([
	"auto",
	"software",
	"h264_mf",
	"h264_nvenc",
	"h264_qsv",
	"h264_amf",
	"h264_videotoolbox",
	"h264_vaapi"
]);
const prefs = {
	tuiAutoOpenPanel: Schema.boolean().description("Open the TUI Agent Browser panel on the first ego_* call. Default off; activity still appears in the badge and status."),
	isolateSpaces: Schema.boolean().description("Space isolation: false = persistent profile (keep logins across restarts); true = isolated sandbox."),
	sessionScopedSpaces: Schema.boolean().description("Give each DSH session its own task space (dsh-agent-<session>) so concurrent sessions and subagents do not share tabs or steal each other's active tab. Off = one shared space."),
	idleTimeoutMin: Schema.number().min(0).max(1440).step(1).description("Auto-stop the backing browser after N minutes without an ego_* call (0 = off). Relaunches on demand at the next call."),
	disableFrameRelay: Schema.boolean().description("Disable the live frame relay (watch panel): no ego-cast worker, no screencast capture and no /api/ego stream routes. ego_* tools keep working."),
	residentExecutor: Schema.boolean().description("Reuse one resident `ego-browser --serve` process across ego_* calls: the first call pays startup, later calls skip it (~16ms). Off = spawn per call. A dead resident falls back to a fresh spawn automatically."),
	residentIdleMin: Schema.number().min(0).max(1440).step(1).description("Stop the resident process after N minutes without an ego_* call (0 = keep it until the plugin unmounts). The browser itself is unaffected."),
	chromePath: Schema.string().description("Path to Chrome/Chromium. Empty = auto-detect."),
	headless: Schema.boolean().description("Run the backing browser without a window: the workspace panel is the only view, and the browser cannot take focus from your work. Turn it off to watch a real window."),
	cursorName: Schema.string().description("Label drawn next to the agent cursor on the page. Empty = no label."),
	captureBackend: backend.description("Capture backend: auto, cdp, or ffmpeg."),
	streamProfile: profile.description("Capture quality profile."),
	cdpFps: Schema.number().min(5).max(30).step(1).description("CDP preview FPS."),
	cdpQuality: Schema.number().min(1).max(100).step(1).description("CDP JPEG quality."),
	cdpMaxWidth: Schema.number().min(320).max(2560).step(40).description("CDP frame max width."),
	cdpBackstopIntervalMs: Schema.number().min(1e3).max(1e4).step(100).description("CDP recovery screenshot interval."),
	ffmpegFps: Schema.number().min(5).max(30).step(1).description("FFmpeg video FPS."),
	ffmpegMaxWidth: Schema.number().min(320).max(1920).step(40).description("FFmpeg video max width."),
	ffmpegBitrateKbps: Schema.number().min(500).max(2e4).step(250).description("FFmpeg target video bitrate in kbps."),
	ffmpegEncoder: encoder.description("FFmpeg H.264 encoder."),
	ffmpegPath: Schema.string().description("Custom FFmpeg path. Empty = detect PATH or managed install."),
	githubMirror: Schema.string().description("HTTPS base replacing https://github.com for managed downloads."),
	egoCliArgs: Schema.string().description("Extra args appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call."),
	chromeArgs: Schema.string().description("Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton)."),
	viewportWidth: Schema.number().min(0).max(3840).step(10).description("Fixed CSS viewport width for agent pages, e.g. 1440. 0 = use the browser window size."),
	viewportHeight: Schema.number().min(0).max(2160).step(10).description("Fixed CSS viewport height for agent pages, e.g. 900. 0 = use the browser window size."),
	deviceScaleFactor: Schema.number().min(0).max(4).step(.25).description("Device pixel ratio for the fixed viewport. 0 = the browser default.")
};
const volatilePrefs = Object.fromEntries(Object.entries(prefs).map(([key, field]) => {
	const mark = field.volatile;
	return [key, typeof mark === "function" ? mark.call(field) : field];
}));
const Config$1 = Schema.object({
	...volatilePrefs,
	/** Optional Node-executable runtime script (not the official .exe). */
	egoBin: Schema.string(),
	castFpsCap: Schema.number().min(0).max(60).step(1),
	screencastQuality: Schema.number().min(1).max(100).step(1),
	screencastMaxWidth: Schema.number().min(320).max(2560).step(40),
	backstopIntervalMs: Schema.number().min(200).max(1e4).step(100)
});
/**
* `egoBin` is executed as `node <egoBin> …`; a browser executable such as the
* official `ego-browser.exe` cannot work directly (issue #87). Keep the check
* pure so settings, tools and ego_doctor can share it.
*/
function validateEgoBinPath(value) {
	const p = typeof value === "string" ? value.trim() : "";
	if (!p) return {
		ok: false,
		reason: "egoBin is empty"
	};
	if (/\.(exe|cmd|bat)$/i.test(p)) return {
		ok: false,
		reason: "egoBin must be a Node-executable script (.mjs/.js/.cjs), not a Windows executable. The official ego-browser.exe needs a Node bridge; use the bundled runtime or set egoBin to a .mjs bridge."
	};
	return { ok: true };
}
/**
* Flags the user must NOT put in `egoCliArgs`: these ego-browser subcommands
* exit before the heredoc runs (--status/--stop/--help/...) or steal the
* browser window (--open), so appending them would break every ego_* tool.
* `--headless` is managed by EGO_LINUX_HEADLESS; `--sdk-path` is allowed.
*/
const EGO_CLI_BLOCKED = new Set([
	"--status",
	"--stop",
	"--open",
	"--spaces",
	"--spaces-daemon",
	"--prune-spaces",
	"--import-chrome-profile",
	"--install-desktop-entry",
	"--help",
	"-h"
]);
/**
* Flags the user must NOT put in `chromeArgs`: these are managed by the
* launcher / EGO_LINUX_PROXY and overriding them would break CDP control,
* profile isolation, or the proxy bypass list. `--proxy-server` should go
* through EGO_LINUX_PROXY (which also sets the bypass list).
*/
const CHROME_BLOCKED = new Set([
	"--user-data-dir",
	"--remote-debugging-port",
	"--remote-allow-origins",
	"--headless",
	"--no-startup-window",
	"--proxy-server",
	"--proxy-bypass-list"
]);
/**
* Shell-like tokenizer for user-supplied arg strings. Handles single/double
* quotes and backslash escapes; bare whitespace separates tokens. Returns []
* for empty/whitespace-only input. Used for both `egoCliArgs` and `chromeArgs`
* (mirrored in runtime/ego-linux/src/chrome.mjs for the Chrome side, since the
* runtime must not import from src/).
*/
function tokenizeArgs(input) {
	if (typeof input !== "string") return [];
	const out = [];
	let cur = "";
	let i = 0;
	let quote = null;
	while (i < input.length) {
		const c = input[i];
		if (quote) {
			if (c === "\\") {
				const next = input[i + 1];
				if (next !== void 0) {
					cur += next;
					i += 2;
					continue;
				}
			} else if (c === quote) {
				quote = null;
				i += 1;
				continue;
			}
			cur += c;
			i += 1;
			continue;
		}
		if (c === "\"" || c === "'") {
			quote = c;
			i += 1;
			continue;
		}
		if (c === "\\") {
			const next = input[i + 1];
			if (next !== void 0) {
				cur += next;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (c === " " || c === "	" || c === "\n" || c === "\r") {
			if (cur !== "") {
				out.push(cur);
				cur = "";
			}
			i += 1;
			continue;
		}
		cur += c;
		i += 1;
	}
	if (cur !== "") out.push(cur);
	return out;
}
/**
* Split a raw arg string into tokens, dropping any token (and, for `--flag
* value` pairs, its value) that appears in `blocked`. A "blocked" token with a
* `=` attached (e.g. `--headless=new`) is also dropped. Returns the surviving
* tokens. Exposed for tests and for the runtime to mirror.
*/
function filterArgs(raw, blocked) {
	const tokens = tokenizeArgs(raw);
	const kept = [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
		if (blocked.has(key)) {
			if (!tok.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i += 1;
			continue;
		}
		kept.push(tok);
	}
	return kept;
}
const finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
function oneOf(value, values, fallback) {
	return typeof value === "string" && values.includes(value) ? value : fallback;
}
/**
* DSH 0.1.7 wraps a `.volatile()` field in a cosmokit `Volatile` reference: a
* plain object exposing `get()` plus a `Symbol(cosmokit.volatile.write)` slot.
* `typeof`/`JSON.stringify` see an opaque `{}`, so a raw read would silently
* fall back to the default instead of the value the user saved. Reading through
* `get()` also picks up later live commits, because the reference stays put and
* only its value moves.
*/
function unwrapVolatile(value) {
	if (value === null || typeof value !== "object") return value;
	const candidate = value;
	if (typeof candidate.get !== "function") return value;
	if (!Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes("cosmokit.volatile"))) return value;
	try {
		return candidate.get();
	} catch {
		return value;
	}
}
/** Unwrap every volatile reference so `resolveConfig` sees plain values. */
function normalizeVolatile(config) {
	const source = config;
	const plain = {};
	for (const key of Object.keys(source)) plain[key] = unwrapVolatile(source[key]);
	return plain;
}
function resolveConfig(config = {}) {
	config = normalizeVolatile(config);
	const legacyFps = finiteIn(config.castFpsCap, 0, 60) ? config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)) : 20;
	const selectedProfile = oneOf(config.streamProfile, [
		"low",
		"balanced",
		"high"
	], "balanced");
	const profileDefaults = selectedProfile === "low" ? {
		fps: 15,
		width: 960,
		bitrateKbps: 2e3
	} : selectedProfile === "high" ? {
		fps: 30,
		width: 1600,
		bitrateKbps: 8e3
	} : {
		fps: 20,
		width: 1280,
		bitrateKbps: 4e3
	};
	return {
		chromePath: typeof config.chromePath === "string" ? config.chromePath : "",
		headless: typeof config.headless === "boolean" ? config.headless : true,
		cursorName: typeof config.cursorName === "string" ? config.cursorName : DEFAULT_CURSOR_NAME,
		captureBackend: oneOf(config.captureBackend, [
			"auto",
			"cdp",
			"ffmpeg"
		], "auto"),
		streamProfile: selectedProfile,
		cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
		cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 92,
		cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 2560) ? config.cdpMaxWidth : finiteIn(config.screencastMaxWidth, 320, 2560) ? config.screencastMaxWidth : 2560,
		cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1e3, 1e4) ? config.cdpBackstopIntervalMs : finiteIn(config.backstopIntervalMs, 200, 1e4) ? Math.max(1e3, config.backstopIntervalMs) : 3e3,
		ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
		ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
		ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 2e4) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
		ffmpegEncoder: oneOf(config.ffmpegEncoder, [
			"auto",
			"software",
			"h264_mf",
			"h264_nvenc",
			"h264_qsv",
			"h264_amf",
			"h264_videotoolbox",
			"h264_vaapi"
		], "auto"),
		ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
		githubMirror: typeof config.githubMirror === "string" ? config.githubMirror : "",
		egoCliArgs: typeof config.egoCliArgs === "string" ? config.egoCliArgs : "",
		chromeArgs: typeof config.chromeArgs === "string" ? config.chromeArgs : "",
		viewportWidth: finiteIn(config.viewportWidth, 0, 3840) ? config.viewportWidth : 0,
		viewportHeight: finiteIn(config.viewportHeight, 0, 2160) ? config.viewportHeight : 0,
		deviceScaleFactor: finiteIn(config.deviceScaleFactor, 0, 4) ? config.deviceScaleFactor : 0,
		isolateSpaces: typeof config.isolateSpaces === "boolean" ? config.isolateSpaces : config.isolateSpaces === "true" || config.isolateSpaces === "1" || config.isolateSpaces === 1,
		sessionScopedSpaces: typeof config.sessionScopedSpaces === "boolean" ? config.sessionScopedSpaces : !(config.sessionScopedSpaces === "false" || config.sessionScopedSpaces === "0" || config.sessionScopedSpaces === 0),
		keepBrowserRunning: config.keepBrowserRunning === true,
		idleTimeoutMin: finiteIn(config.idleTimeoutMin, 0, 1440) ? config.idleTimeoutMin : 0,
		disableFrameRelay: typeof config.disableFrameRelay === "boolean" ? config.disableFrameRelay : config.disableFrameRelay === "true" || config.disableFrameRelay === "1" || config.disableFrameRelay === 1,
		residentExecutor: typeof config.residentExecutor === "boolean" ? config.residentExecutor : config.residentExecutor === "true" || config.residentExecutor === "1" || config.residentExecutor === 1,
		tuiAutoOpenPanel: typeof config.tuiAutoOpenPanel === "boolean" ? config.tuiAutoOpenPanel : config.tuiAutoOpenPanel === "true" || config.tuiAutoOpenPanel === "1" || config.tuiAutoOpenPanel === 1,
		residentIdleMin: finiteIn(config.residentIdleMin, 0, 1440) ? config.residentIdleMin : 30
	};
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/settings.ts
const SETTINGS_NAMESPACE = "ego-browser";
const SHARED_SCOPE_KEY = Symbol.for("dsh-ego-browser.settings-scope");
function getSharedScope() {
	const existing = globalThis[SHARED_SCOPE_KEY];
	if (existing) return existing;
	const fresh = {
		scope: null,
		refs: 0
	};
	globalThis[SHARED_SCOPE_KEY] = fresh;
	return fresh;
}
/**
* Mirror of the dsh-settings internal `isUnloading` guard. The cordis const
* enum for fiber state is erased at compile time, so the literal states are
* matched numerically: 4 = DISPOSED, 5 = UNLOADING.
*/
function isUnloading(ctx) {
	const state = ctx.fiber?.state;
	return state === 4 || state === 5;
}
/**
* Install the `ego-browser` settings namespace and return the bridge.
*
* The settings service is reached through `ctx.inject(['settings'], ...)` so a
* composition without a settings provider still loads the plugin (entry-source
* fallback, no persistence). Multi-fiber dedupe is handled by catching the
* `"already registered"` rejection — host composition may mount several
* concurrent fibers of this plugin, and only the first registration owns the
* namespace.
*
* [DSH 0.1.7] The registrable settings namespace was replaced by a forms service
* over the profile's own entries: `ctx.settings` still exists (describe/revisions)
* but `register` is gone, and the live user values sit on the loader-owned row
* config instead. A plugin that keeps reading the mount-time composition snapshot
* sees every write as "accepted but unchanged", so when `register` is absent the
* bridge switches to the caller-supplied live source.
*/
function installEgoBrowserSettings(ctx, entry, live) {
	const listeners = /* @__PURE__ */ new Set();
	let source = () => entry;
	/** 0.1.7 形态：settings 服务不再有 register，活值由 loader 的 config 提供。 */
	const liveSource = () => {
		let values;
		try {
			values = live?.();
		} catch {
			values = void 0;
		}
		if (values === void 0 || values === null) return entry;
		return {
			...entry,
			...values
		};
	};
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	ctx.inject?.(["settings"], (sctx) => {
		const sharedScope = getSharedScope();
		let scope = sharedScope.scope;
		const service = sctx.settings;
		if (service === void 0 || typeof service.register !== "function") {
			source = liveSource;
			const subscribe = sctx.on;
			const offUpdate = typeof subscribe === "function" ? subscribe.call(sctx, "settings/document-updated", (ns) => {
				if (ns !== "ego-browser" || isUnloading(ctx)) return;
				notify();
			}) : void 0;
			if (typeof offUpdate === "function") sctx.effect?.(() => () => {
				try {
					offUpdate();
				} catch {}
			});
			notify();
			return;
		}
		if (!scope) try {
			scope = sctx.settings.register(SETTINGS_NAMESPACE, Config$1, { base: entry });
			sharedScope.scope = scope;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
			ctx.logger?.("ego-browser")?.warn("settings namespace already registered outside the shared bridge");
			return;
		}
		sharedScope.refs += 1;
		source = () => scope.get();
		const offScopeWatch = scope.watch(() => {
			if (isUnloading(ctx)) return;
			notify();
		});
		sctx.effect?.(() => () => {
			offScopeWatch?.();
			sharedScope.refs = Math.max(0, sharedScope.refs - 1);
			if (sharedScope.refs === 0 && sharedScope.scope === scope) sharedScope.scope = null;
			if (isUnloading(ctx)) return;
			source = () => entry;
			notify();
		});
		notify();
	});
	return {
		source: () => source(),
		onChange: (cb) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		}
	};
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-manifest.ts
const BTBN_TAG = "autobuild-2026-08-17-13-05";
const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const STATIC_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const FFMPEG_MANIFEST = Object.freeze({
	"win32-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 170641412,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-win64-gpl.zip`,
		sha256: "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"win32-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 116275753,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-winarm64-gpl.zip`,
		sha256: "451d181c0774f19dc7c30711911f3aad4f4ee4feb1cecb7b5efc1b895e093c67",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"linux-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 127977972,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linux64-gpl.tar.xz`,
		sha256: "646080fba1f295446fdf35fbdd4bad6ab934a30f9fcb86f3e96ad50eaff06c82",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"linux-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 109615592,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linuxarm64-gpl.tar.xz`,
		sha256: "7cda2218fe0107e449631eb6b850146a4522ebf4ed13733010d0aada9858b119",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"darwin-x64": Object.freeze({
		provider: "evermeet",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 25296431,
		url: `${STATIC_BASE}/ffmpeg-darwin-x64.gz`,
		sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
		executableName: "ffmpeg"
	}),
	"darwin-arm64": Object.freeze({
		provider: "osxexperts",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 19246198,
		url: `${STATIC_BASE}/ffmpeg-darwin-arm64.gz`,
		sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
		executableName: "ffmpeg"
	})
});
function platformManifest(platform = process.platform, arch = process.arch) {
	return FFMPEG_MANIFEST[`${platform}-${arch}`] ?? null;
}
function rewriteGithubUrl(url, mirror = "") {
	if (!mirror || !url.startsWith("https://github.com/")) return url;
	let parsed;
	try {
		parsed = new URL(mirror);
	} catch {
		throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be a valid HTTPS URL");
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be an HTTPS base URL without credentials, query, or fragment");
	return `${parsed.toString().replace(/\/+$/, "")}${url.slice(18)}`;
}
function codedError$2(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/gateway.ts
/** HTTP route prefix owning every ego-browser API request. */
const API_PREFIX = "/ego/api";
/** Config keys the `set` endpoint accepts (allow-list; unknown keys are dropped). */
const ALLOWED_KEYS = new Set([
	"isolateSpaces",
	"idleTimeoutMin",
	"disableFrameRelay",
	"residentExecutor",
	"residentIdleMin",
	"chromePath",
	"captureBackend",
	"streamProfile",
	"cdpFps",
	"cdpQuality",
	"cdpMaxWidth",
	"cdpBackstopIntervalMs",
	"ffmpegFps",
	"ffmpegMaxWidth",
	"ffmpegBitrateKbps",
	"ffmpegEncoder",
	"ffmpegPath",
	"githubMirror",
	"egoCliArgs",
	"chromeArgs"
]);
/**
* Register the `/ego/api` HTTP route on the host's web server.
*
* The route reads/writes the `ego-browser` settings namespace in-process
* through the bridge + `ctx.settings`. The settings service is optional:
* when absent, `get` degrades to the entry source and `set` returns a
* clear error.
*/
function registerEgoBrowserGateway(ctx, bridge, ffmpegManager) {
	let settings;
	ctx.inject?.(["settings"], (sctx) => {
		settings = sctx.settings;
		return () => {
			settings = void 0;
		};
	});
	ctx.effect?.(() => {
		const webServer = ctx.get?.("webServer");
		if (!webServer || typeof webServer.register !== "function") return;
		return webServer.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				if (req.method !== "POST") {
					writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
					return;
				}
				const origin = req.headers.origin;
				if (origin) {
					let originHost;
					try {
						originHost = new URL(origin).host;
					} catch {
						writeJson(res, 400, envelopeError("invalid-origin", "invalid Origin header"));
						return;
					}
					if (!req.headers.host || originHost !== req.headers.host) {
						writeJson(res, 403, envelopeError("origin-not-allowed", "same-origin requests only"));
						return;
					}
				}
				if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, envelopeError("content-type-not-supported", "application/json required"));
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : void 0;
				if (method === void 0 || method.includes("/")) {
					writeJson(res, 404, envelopeError("not-found", "unknown ego-browser API method"));
					return;
				}
				try {
					const body = await readJsonBody(req);
					if (method === "get") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({
							config,
							ffmpegStatus: ffmpegManager ? await ffmpegManager.check({
								configuredPath: config.ffmpegPath,
								requestedEncoder: config.ffmpegEncoder
							}) : null
						}));
					} else if (method === "set") writeJson(res, 200, envelopeOk(await handleSet(body, settings, bridge, ffmpegManager)));
					else if (method === "ffmpeg-status") writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegManager?.status() || null }));
					else if (method === "ffmpeg-check") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({ ffmpegStatus: await ffmpegManager?.check({
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						}) || null }));
					} else if (method === "ffmpeg-install") {
						const config = resolveConfig(bridge.source());
						const githubMirror = typeof body.githubMirror === "string" ? body.githubMirror : config.githubMirror;
						const ffmpegStatus = ffmpegManager?.startInstall({
							githubMirror,
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						});
						writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegStatus || null }));
					} else writeJson(res, 404, envelopeError("not-found", `unknown ego-browser API method "${method}"`));
				} catch (error) {
					const e = error;
					const message = e instanceof Error ? e.message : String(error);
					writeJson(res, e?.code === "ffmpeg-unavailable" ? 409 : e?.code === "ffmpeg-mirror-invalid" ? 400 : 500, envelopeError(e?.code || "internal", message));
				}
			}
		});
	}, "ego-browser: /ego/api routes");
}
/**
* Handle the `set` method: validate the patch, write the user layer, return
* the new resolved config.
*/
async function handleSet(body, settings, bridge, ffmpegManager) {
	const patch = extractPatch(body);
	if (Object.keys(patch).length === 0) return {
		config: resolveConfig(bridge.source()),
		ffmpegStatus: ffmpegManager?.status() || null
	};
	if (settings === void 0 || !settings.update) throw new Error("ego-browser: settings service is unavailable — configuration cannot be written");
	const next = resolveConfig({
		...resolveConfig(bridge.source()),
		...patch
	});
	if (patch.githubMirror) rewriteGithubUrl("https://github.com/example/repo/releases/download/tag/file", patch.githubMirror);
	if ((patch.captureBackend === "ffmpeg" || (Object.hasOwn(patch, "ffmpegPath") || Object.hasOwn(patch, "ffmpegEncoder")) && next.captureBackend === "ffmpeg") && ffmpegManager) {
		const status = await ffmpegManager.check({
			configuredPath: next.ffmpegPath,
			requestedEncoder: next.ffmpegEncoder
		});
		if (!status.canSelectFfmpeg) {
			const error = new Error(status.reason || "FFmpeg is not installed or does not satisfy capture requirements");
			error.code = "ffmpeg-unavailable";
			throw error;
		}
	}
	await settings.update(SETTINGS_NAMESPACE, patch);
	const ffmpegStatus = Object.hasOwn(patch, "ffmpegPath") && ffmpegManager ? await ffmpegManager.check({
		configuredPath: next.ffmpegPath,
		requestedEncoder: next.ffmpegEncoder
	}) : ffmpegManager?.status() || null;
	return {
		config: resolveConfig(bridge.source()),
		ffmpegStatus
	};
}
/**
* Extract and validate the patch from the request body.
*
* JSON wire boundary: null = "delete" (filtered), undefined never crosses
* JSON. Unknown keys are dropped (the settings service is non-strict and
* would otherwise store them). String keys (chromePath) are accepted.
*/
function extractPatch(body) {
	if (!isObject(body)) return {};
	const raw = Reflect.get(body, "patch");
	if (!isObject(raw)) return {};
	const normalized = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!ALLOWED_KEYS.has(key)) continue;
		if (value === null || value === void 0) continue;
		if (typeof value === "string") normalized[key] = value;
		else if (typeof value === "boolean") normalized[key] = value;
		else if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
	}
	return normalized;
}
/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req, maxBytes = 16384) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	return JSON.parse(text);
}
/** Write a JSON response envelope. */
function writeJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(json);
}
/** Build a success envelope. */
function envelopeOk(value) {
	return {
		ok: true,
		value
	};
}
/** Build an error envelope. */
function envelopeError(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
/** Narrow unknown to a non-null object. */
function isObject(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/resident.ts
/**
* Resident `ego-browser --serve` transport (issue #56).
*
* The one-shot path pays Node startup + harness import on EVERY tool call
* (~300-400 ms measured). `--serve` accepts one JSON request per line
* (`{"id","code"}`) and answers with one JSON line per request
* (`{"id","ok","stdout","stderr"}`), paying that cost once.
*
* This class is only the transport: the plugin keeps the per-call spawn path as
* the fallback and turns the resident on with an explicit setting, so a host
* where the resident misbehaves degrades to exactly today's behaviour.
*
* Two failure rules matter:
*
*  - A request that was never written (process already dead) throws
*    `ResidentNotRunningError`; the caller MAY retry it through the one-shot
*    path, because nothing ran.
*  - A request that was written and then failed/timeout is NOT retryable: the
*    script may have half-executed, and replaying a click would double-fire it.
*    The process is killed instead — a wedged resident is worse than none.
*
* The CLI restores globals around each request (see the serve loop), so
* between-call state isolation is the runtime's job, not this class's.
*/
/** Thrown when a request was NOT written because the process is not running. */
var ResidentNotRunningError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ResidentNotRunningError";
	}
};
const MAX_STDERR_BYTES = 512e3;
var ResidentProcess = class {
	opts;
	pending = /* @__PURE__ */ new Map();
	child = null;
	stdoutBuffer = "";
	stderrText = "";
	nextId = 1;
	idleTimer = null;
	deadReason = null;
	stopping = false;
	constructor(opts) {
		this.opts = opts;
	}
	get alive() {
		return this.child !== null && this.deadReason === null;
	}
	/** PID of the live resident (null when stopped/never started). */
	get pid() {
		return this.child?.pid ?? null;
	}
	/** Spawn the process if it is not running. Idempotent. */
	start() {
		if (this.alive || this.stopping) return;
		this.deadReason = null;
		this.stdoutBuffer = "";
		this.stderrText = "";
		const [executable, ...args] = this.opts.argv;
		if (executable === void 0) throw new Error("resident: empty argv");
		const child = spawn(executable, args, {
			cwd: this.opts.cwd,
			env: this.opts.env,
			stdio: "pipe",
			windowsHide: true
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.onStdout(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderrText += chunk;
			if (this.stderrText.length > MAX_STDERR_BYTES) this.stderrText = this.stderrText.slice(-512e3);
		});
		child.on("error", (error) => this.die(`resident process error: ${error.message}`));
		child.on("exit", (code, signal) => this.die(`resident process exited (${code === null ? `signal ${String(signal)}` : `code ${code}`})`));
	}
	/**
	* Send one script and await its frame.
	*
	* @throws ResidentNotRunningError when the request was not written (retryable).
	* @throws Error on timeout/abort/process death (NOT retryable — the process is
	*         killed so a half-executed script cannot keep running).
	*/
	async run(script, { signal, graceMs } = {}) {
		this.start();
		if (!this.alive || this.child === null) throw new ResidentNotRunningError(this.deadReason ?? "resident is not running");
		const child = this.child;
		const id = String(this.nextId++);
		const timeoutMs = graceMs !== void 0 && graceMs > 0 ? graceMs : this.opts.graceMs;
		return await new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				this.die(`resident request timed out after ${timeoutMs}ms`);
			}, timeoutMs);
			const onAbort = () => {
				this.die("ego-browser tool aborted");
			};
			const finish = (fn) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (signal !== void 0) signal.removeEventListener("abort", onAbort);
				if (this.pending.get(id) === entry) this.pending.delete(id);
				fn();
			};
			const entry = {
				resolve: (frame) => finish(() => {
					this.touchIdle();
					resolve(frame);
				}),
				reject: (error) => finish(() => reject(error))
			};
			this.pending.set(id, entry);
			if (signal !== void 0) {
				if (signal.aborted) {
					finish(() => reject(/* @__PURE__ */ new Error("ego-browser tool aborted")));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			try {
				child.stdin.write(`${JSON.stringify({
					id,
					code: script
				})}\n`);
			} catch (error) {
				finish(() => reject(new ResidentNotRunningError(`could not write to the resident process: ${error?.message ?? String(error)}`)));
			}
		});
	}
	/** Gracefully end stdin, then force-kill if it ignores that. */
	stop() {
		this.stopping = true;
		this.clearIdle();
		const child = this.child;
		this.child = null;
		this.deadReason = "resident stopped";
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(/* @__PURE__ */ new Error("resident stopped"));
		if (child === null) return;
		try {
			child.stdin.end();
		} catch {}
		setTimeout(() => {
			try {
				child.kill();
			} catch {}
		}, 1500).unref?.();
	}
	onStdout(chunk) {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.trim() === "") continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame === null || typeof frame !== "object" || typeof frame.id !== "string") continue;
			const entry = this.pending.get(frame.id);
			if (entry === void 0) continue;
			this.pending.delete(frame.id);
			entry.resolve({
				id: frame.id,
				ok: frame.ok === true,
				stdout: typeof frame.stdout === "string" ? frame.stdout : "",
				stderr: typeof frame.stderr === "string" ? frame.stderr : "",
				...typeof frame.error === "string" ? { error: frame.error } : {}
			});
		}
	}
	die(reason) {
		if (this.deadReason !== null) return;
		this.deadReason = reason;
		this.clearIdle();
		const child = this.child;
		this.child = null;
		try {
			child?.kill();
		} catch {}
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(/* @__PURE__ */ new Error(`${reason}${this.stderrText.trim() === "" ? "" : `: ${this.stderrText.trim().slice(-1e3)}`}`));
		if (!this.stopping) this.opts.onExit?.(reason);
	}
	touchIdle() {
		this.clearIdle();
		if (this.opts.idleMs <= 0 || this.pending.size > 0 || !this.alive) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.pending.size === 0) this.stop();
		}, this.opts.idleMs);
		this.idleTimer.unref?.();
	}
	clearIdle() {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
};
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-probe.ts
function runFfmpegProbe(path, argv, { spawn: spawn$2 = spawn, timeoutMs = 3e3 } = {}) {
	return new Promise((resolve) => {
		let child;
		let output = "";
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok,
				output
			});
		};
		try {
			child = spawn$2(path, argv, {
				shell: false,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch {
			resolve({
				ok: false,
				output
			});
			return;
		}
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(false);
		}, timeoutMs);
	});
}
async function probeFfmpeg(path, { platform = process.platform, env = process.env, spawn: spawn$3 = spawn, requestedEncoder = "auto" } = {}) {
	const versionResult = await runFfmpegProbe(path, ["-version"], { spawn: spawn$3 });
	if (!versionResult.ok) throw codedError$1("ffmpeg-not-executable", `FFmpeg is not executable: ${path}`);
	const version = versionResult.output.split(/\r?\n/, 1)[0] || "FFmpeg";
	if (platform === "win32") {
		const support = await runFfmpegProbe(path, [
			"-hide_banner",
			"-h",
			"filter=gfxcapture"
		], { spawn: spawn$3 });
		if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError$1("ffmpeg-gfxcapture-unavailable", "FFmpeg does not support Windows gfxcapture");
	} else if (platform === "darwin") {
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$3 });
		if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support avfoundation capture");
	} else if (platform === "linux") {
		if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw codedError$1("ffmpeg-platform-unsupported", "Wayland capture is not supported");
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$3 });
		if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support x11grab capture");
	}
	const encoders = requestedEncoder === "auto" ? platform === "win32" ? [
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"libx264"
	] : platform === "darwin" ? ["h264_videotoolbox", "libx264"] : [
		"h264_nvenc",
		"h264_vaapi",
		"h264_qsv",
		"libx264"
	] : [requestedEncoder === "software" ? "libx264" : requestedEncoder];
	for (const encoder of encoders) if ((await runFfmpegProbe(path, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=size=64x64:rate=1",
		"-frames:v",
		"1",
		"-c:v",
		encoder,
		"-f",
		"null",
		"-"
	], {
		spawn: spawn$3,
		timeoutMs: 5e3
	})).ok) return {
		version,
		encoder
	};
	throw codedError$1("ffmpeg-encoder-unavailable", "FFmpeg has no usable H.264 encoder");
}
function codedError$1(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/ffmpeg-installation.ts
function defaultFfmpegCacheRoot(home = homedir()) {
	return join(home, ".dsh", "cache", "ego-browser", "ffmpeg");
}
const SHARED_MANAGERS_KEY = Symbol.for("dsh-ego-browser.ffmpeg-installation-managers");
function getSharedManagers() {
	const existing = globalThis[SHARED_MANAGERS_KEY];
	if (existing) return existing;
	const fresh = /* @__PURE__ */ new Map();
	globalThis[SHARED_MANAGERS_KEY] = fresh;
	return fresh;
}
function getSharedFfmpegInstallationManager(options = {}) {
	const platform = options.platform || process.platform;
	const arch = options.arch || process.arch;
	const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot();
	const key = `${platform}:${arch}:${cacheRoot}`;
	const managers = getSharedManagers();
	if (!managers.has(key)) managers.set(key, new FfmpegInstallationManager({
		...options,
		platform,
		arch,
		cacheRoot
	}));
	return managers.get(key);
}
var FfmpegInstallationManager = class {
	getConfig;
	platform;
	arch;
	env;
	cacheRoot;
	fetch;
	spawn;
	manifest;
	installPromise;
	checkPromise;
	checkKey;
	statusValue;
	constructor({ getConfig = () => ({}), platform = process.platform, arch = process.arch, env = process.env, cacheRoot = defaultFfmpegCacheRoot(), fetchImpl = globalThis.fetch, spawn: spawn$1 = spawn } = {}) {
		this.getConfig = getConfig;
		this.platform = platform;
		this.arch = arch;
		this.env = env;
		this.cacheRoot = cacheRoot;
		this.fetch = fetchImpl;
		this.spawn = spawn$1;
		this.manifest = platformManifest(platform, arch);
		this.installPromise = null;
		this.checkPromise = null;
		this.checkKey = null;
		this.statusValue = this.#baseStatus();
	}
	#baseStatus() {
		const unsupported = this.platform === "linux" && (this.env.XDG_SESSION_TYPE === "wayland" || this.env.WAYLAND_DISPLAY);
		return {
			state: unsupported ? "unsupported" : "missing",
			source: null,
			path: null,
			version: null,
			encoder: null,
			progress: null,
			canDownload: !unsupported && !!this.manifest,
			canSelectFfmpeg: false,
			updateAvailable: false,
			reason: unsupported ? "Wayland capture is not supported" : null,
			candidates: [],
			platform: this.platform,
			arch: this.arch,
			buildId: this.manifest?.buildId || null
		};
	}
	status() {
		return structuredClone(this.statusValue);
	}
	managedPath() {
		if (!this.manifest) return null;
		return join(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName);
	}
	async check({ configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.status();
		const key = JSON.stringify([configuredPath ?? "", requestedEncoder]);
		if (this.checkPromise) {
			if (this.checkKey === key) return this.checkPromise;
			await this.checkPromise.catch(() => {});
		}
		if (this.statusValue.state === "unsupported") return this.status();
		this.checkKey = key;
		const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
			if (this.checkPromise === promise) {
				this.checkPromise = null;
				this.checkKey = null;
			}
		});
		this.checkPromise = promise;
		return this.checkPromise;
	}
	async #check(configuredPath, requestedEncoder = "auto") {
		this.#set({
			state: "checking",
			reason: null,
			progress: null,
			canSelectFfmpeg: false
		});
		const custom = configuredPath ?? this.getConfig().ffmpegPath ?? "";
		const candidates = [];
		if (custom) candidates.push({
			source: "custom",
			path: custom
		});
		candidates.push({
			source: "system",
			path: "ffmpeg"
		});
		const managed = this.managedPath();
		if (managed) candidates.push({
			source: "managed",
			path: managed
		});
		const results = [];
		for (const candidate of candidates) try {
			const probe = await probeFfmpeg(candidate.path, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			results.push({
				...candidate,
				usable: true,
				version: probe.version,
				encoder: probe.encoder
			});
			this.#set({
				state: "ready",
				source: candidate.source,
				path: candidate.path,
				version: probe.version,
				encoder: probe.encoder,
				canSelectFfmpeg: true,
				canDownload: !!this.manifest,
				reason: null,
				candidates: results,
				updateAvailable: candidate.source === "managed" && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || ""))
			});
			return this.status();
		} catch (error) {
			const e = error;
			results.push({
				...candidate,
				usable: false,
				code: e.code || "ffmpeg-unavailable",
				reason: e.message
			});
		}
		this.#set({
			...this.#baseStatus(),
			state: "missing",
			candidates: results,
			reason: results[0]?.reason || "No compatible FFmpeg installation was found"
		});
		return this.status();
	}
	async resolvedPath() {
		const status = this.statusValue.state === "ready" ? this.status() : await this.check();
		return status.canSelectFfmpeg ? status.path : null;
	}
	install({ githubMirror, configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.installPromise;
		if (!this.manifest) return Promise.reject(codedError("ffmpeg-platform-unsupported", `No managed FFmpeg build for ${this.platform}-${this.arch}`));
		this.installPromise = this.#install(githubMirror ?? this.getConfig().githubMirror ?? "", configuredPath ?? this.getConfig().ffmpegPath ?? "", requestedEncoder).finally(() => {
			this.installPromise = null;
		});
		return this.installPromise;
	}
	startInstall(options = {}) {
		this.install(options).catch(() => {});
		return this.status();
	}
	async #install(githubMirror, configuredPath, requestedEncoder) {
		const manifest = this.manifest;
		const platformRoot = join(this.cacheRoot, `${this.platform}-${this.arch}`);
		const tempRoot = join(platformRoot, `.install-${randomUUID()}`);
		const archivePath = join(tempRoot, `archive.${manifest.archiveType === "gzip" ? "gz" : "pkg"}`);
		const extractedPath = join(tempRoot, manifest.executableName);
		const finalRoot = join(platformRoot, manifest.buildId);
		const finalPath = join(finalRoot, manifest.executableName);
		let releaseLock = null;
		let backup = null;
		let published = false;
		try {
			await mkdir(platformRoot, { recursive: true });
			releaseLock = await acquireInstallLock(platformRoot);
			await cleanupInterruptedInstalls(platformRoot);
			if (manifest.archiveType === "tar") await ensureTarAvailable(this.spawn);
			await mkdir(tempRoot, { recursive: true });
			const url = rewriteGithubUrl(manifest.url, githubMirror);
			this.#set({
				state: "downloading",
				reason: null,
				progress: {
					receivedBytes: 0,
					totalBytes: manifest.size,
					percent: 0
				},
				canSelectFfmpeg: false
			});
			const digest = await downloadFile(url, archivePath, {
				fetchImpl: this.fetch,
				expectedSize: manifest.size,
				onProgress: (progress) => this.#set({
					state: "downloading",
					progress
				})
			});
			this.#set({
				state: "verifying",
				progress: null
			});
			if (digest !== manifest.sha256) throw codedError("ffmpeg-checksum-mismatch", "Downloaded FFmpeg archive failed SHA-256 verification");
			this.#set({ state: "extracting" });
			if (manifest.archiveType === "gzip") await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 493 }));
			else await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable, this.spawn);
			if (this.platform !== "win32") await chmod(extractedPath, 493);
			if (this.platform === "darwin") await prepareMacExecutable(extractedPath, this.arch, this.spawn);
			this.#set({ state: "probing" });
			const probe = await probeFfmpeg(extractedPath, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			const executableSha256 = await hashFile(extractedPath);
			await writeFile(join(tempRoot, "install.json"), JSON.stringify({
				provider: manifest.provider,
				buildId: manifest.buildId,
				archiveSha256: manifest.sha256,
				executableSha256,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				version: probe.version,
				encoder: probe.encoder
			}, null, 2));
			await rm(archivePath, { force: true });
			backup = `${finalRoot}.old-${randomUUID()}`;
			let hadExisting = false;
			try {
				await rename(finalRoot, backup);
				hadExisting = true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await mkdir(dirname(finalRoot), { recursive: true });
			await rename(tempRoot, finalRoot);
			published = true;
			await access(finalPath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
			if (hadExisting) await rm(backup, {
				recursive: true,
				force: true
			});
			backup = null;
			return await this.#check(configuredPath, requestedEncoder);
		} catch (error) {
			if (published) await rm(finalRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			if (backup) await rename(backup, finalRoot).catch(() => {});
			await rm(tempRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			const e = error;
			this.#set({
				state: "failed",
				reason: e.message,
				progress: null,
				canSelectFfmpeg: false,
				canDownload: true
			});
			throw error;
		} finally {
			await releaseLock?.();
		}
	}
	#set(patch) {
		this.statusValue = {
			...this.statusValue,
			...patch
		};
	}
};
async function acquireInstallLock(platformRoot) {
	const lockPath = join(platformRoot, ".install.lock");
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			token,
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return async () => {
			await handle.close().catch(() => {});
			if ((await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null))?.token === token) await rm(lockPath, { force: true }).catch(() => {});
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
		if (!owner?.pid || !isProcessAlive(owner.pid)) {
			await rm(lockPath, { force: true });
			continue;
		}
		throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
	}
	throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
}
function isProcessAlive(pid) {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
async function cleanupInterruptedInstalls(platformRoot) {
	const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => {
		return error.code === "ENOENT" ? [] : Promise.reject(error);
	});
	await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".install-")).map((entry) => rm(join(platformRoot, entry.name), {
		recursive: true,
		force: true
	})));
}
async function downloadFile(url, target, { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {}, maxBytes = 250 * 1024 * 1024 } = {}) {
	let current = url;
	let response;
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		assertSafeDownloadUrl(current);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15e3);
		try {
			response = await fetchImpl(current, {
				redirect: "manual",
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(response.status)) break;
		const location = response.headers.get("location");
		if (!location) throw codedError("ffmpeg-download-failed", "FFmpeg download redirect omitted Location");
		current = new URL(location, current).toString();
		await response.body?.cancel().catch(() => {});
		if (!current.startsWith("https://")) throw codedError("ffmpeg-download-failed", "FFmpeg download refused a non-HTTPS redirect");
		if (redirects === 5) throw codedError("ffmpeg-download-failed", "Too many FFmpeg download redirects");
	}
	if (!response?.ok || !response.body) throw codedError("ffmpeg-download-failed", `FFmpeg download failed with HTTP ${response?.status || 0}`);
	const declared = Number(response.headers.get("content-length")) || expectedSize || null;
	const hash = createHash("sha256");
	const file = await open(target, "w");
	let received = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await readChunk(reader, 3e4);
			if (done) break;
			const buffer = Buffer.from(value);
			received += buffer.length;
			if (received > maxBytes) throw codedError("ffmpeg-download-failed", "FFmpeg archive exceeds the allowed size");
			hash.update(buffer);
			await file.write(buffer);
			onProgress({
				receivedBytes: received,
				totalBytes: declared,
				percent: declared ? Math.min(100, Math.round(received * 100 / declared)) : null
			});
		}
	} finally {
		await reader.cancel().catch(() => {});
		await file.close();
	}
	return hash.digest("hex");
}
async function ensureTarAvailable(spawn) {
	try {
		await runCommand("tar", ["--version"], spawn, 5e3);
	} catch {
		throw codedError("ffmpeg-extractor-unavailable", "The managed FFmpeg archive requires the system tar extractor");
	}
}
function assertSafeDownloadUrl(value) {
	const url = new URL(value);
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) throw codedError("ffmpeg-download-failed", "FFmpeg downloads require a public HTTPS destination");
}
function isPrivateIp(host) {
	const family = isIP(host);
	if (family === 4) {
		const [a, b] = host.split(".").map(Number);
		return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
	}
	if (family === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
	return false;
}
async function extractWithTar(archivePath, tempRoot, destination, matcher, spawn) {
	const matches = (await runCommand("tar", ["-tf", archivePath], spawn, 15e3)).stdout.split(/\r?\n/).filter(Boolean).filter((entry) => safeArchiveEntry(entry) && matcher.test(entry));
	if (matches.length !== 1) throw codedError("ffmpeg-executable-missing", `Expected one FFmpeg executable in archive, found ${matches.length}`);
	const entry = matches[0];
	await runCommand("tar", [
		"-xf",
		archivePath,
		"-C",
		tempRoot,
		entry
	], spawn, 6e4);
	const extracted = resolve(tempRoot, normalize(entry));
	if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError("ffmpeg-archive-unsafe", "FFmpeg archive path escaped the install directory");
	await copyFile(extracted, destination);
}
function safeArchiveEntry(entry) {
	const value = entry.replaceAll("\\", "/");
	return value !== "" && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes("..");
}
async function prepareMacExecutable(path, arch, spawn) {
	await runCommand("xattr", [
		"-d",
		"com.apple.quarantine",
		path
	], spawn, 5e3).catch(() => {});
	if (arch === "arm64") await runCommand("codesign", [
		"--force",
		"--sign",
		"-",
		path
	], spawn, 15e3).catch(() => {});
}
async function hashFile(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
function readChunk(reader, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(codedError("ffmpeg-download-timeout", "FFmpeg download stalled")), timeoutMs);
		reader.read().then((value) => {
			clearTimeout(timer);
			resolvePromise(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
function runCommand(command, argv, spawn, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, argv, {
			shell: false,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => finish(reject, error));
		child.once("exit", (code) => code === 0 ? finish(resolvePromise, {
			stdout,
			stderr
		}) : finish(reject, codedError("ffmpeg-archive-invalid", stderr || `${command} exited with ${code}`)));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(reject, codedError("ffmpeg-archive-invalid", `${command} timed out`));
		}, timeoutMs);
	});
}
function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/util.ts
/**
* src/util.ts — shared small helpers (sentinel / type coercion / JSON helpers).
*
* Factored out of index.ts for reuse by other modules. No ctx/cfg dependency,
* no side effects.
*/
const SENTINEL = "@@DSH_RESULT@@";
const j = (v) => JSON.stringify(v);
const str = (v, fallback) => typeof v === "string" && v !== "" ? v : fallback;
const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN = "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";
/** Read an entire subprocess reader's buffered output. */
function readAll(reader) {
	if (!reader) return "";
	return reader.readFrom(0).text;
}
//#endregion
//#region packages/browser/browser-ego-host/third-party/upstream/src/index.ts
/**
* ego-browser — DSH integration plugin for the ego-lite browser
* (https://github.com/CitroLabs/ego-lite, MIT).
*
* ego lite is a Chromium browser built for AI agents: agents work in isolated
* "task spaces" that inherit your real login state without stealing your tabs.
* The official connection layer is the `ego-browser` CLI: `ego-browser nodejs`
* reads a JS heredoc on stdin and runs it in a Node runtime with page-driving
* facades preloaded (page/browser/taskSpaces/site/fetch, raw cdp).
*
* This plugin turns that CLI into structured HARNESS tools. Every action tool
* builds a small script from its arguments, pipes it to `ego-browser nodejs`
* through ctx.subprocess, and parses the result payload. Scripts target the
* shared harness facade surface (preloaded by the ego-browser runtime itself):
* taskSpaces.useOrCreate / .complete, browser.openOrReuseTab, page.info(),
* page.snapshot(), page.evaluate(), page.waitForTimeout(), page.screenshot(),
* page.locator(...).click()/.fill(), page.mouse.click(x, y), and the raw cdp().
* Output is reported through console.log with a sentinel payload.
*
* Runtime requirements:
*   - the `ego-browser` command on PATH (ego lite app, or the
*     `ego-browser-v2` npm package; Node >= 22), and
*   - a reachable ego lite browser (the app is macOS-only today; Linux is on
*     the ego-lite roadmap, PR #202).
*
* == 文件内部结构（改动前先看 docs/ARCH.md）==
*   顶部常量     : SENTINEL / HUMAN_CHECK_PROBE / 默认值
*   withEgoLock  : 全插件互斥锁（工具串行，防争浏览器）
*   chrome/env   : Chrome 探测 / 环境自适应
*   runEgoScript : 脚本执行引擎 + 哨兵解析 + 冷启动重试
*   defineEgoTool: t() 工具封装基座（自动加锁 + 重试）
*   registerActionTools   : 大部分 ego_* 工具（用 t() 逐个注册）
*   registerHelpAndDoctor : ego_help/doctor/script/captcha
*   EGO_HELP_INDEX / HUMAN_CHECK_PROBE : 工具索引文案 / 人机验证探针
* 加工具：在 registerActionTools 里 reg(t({...}))，并同步 EGO_HELP_INDEX，跑 npm run build。
*/
const name = "ego-browser";
const inject = ["tools", "subprocess"];
const Config = Config$1;
const DEFAULT_EGO_BIN = fileURLToPath(new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url));
const DEFAULT_SPACE = "dsh-agent";
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 15e3;
const TOOL_TIMEOUT_MS = 12e4;
/** Build the script that runs the probe and emits a sentinel payload. */
function humanCheckScript(space) {
	return `${useSpace(space)}${ensureRealTab()}let __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))\n`;
}
/**
* Script that blocks until the human clears a challenge.
*
* Polls the page (rather than sleeping once) so it returns as soon as the user
* solves the CAPTCHA or completes the login. When `selector` is given, that
* element must also exist — the usual "logged in now" signal. Returns a
* structured payload, never an error: `resolved:false` is the honest answer
* when the deadline passes.
*/
function waitForHumanScript(space, opts) {
	const selector = opts.selector ?? "";
	const selectorCheck = selector === "" ? "  const __selOk = true\n" : `  let __selOk = false\n  try { __selOk = (await page.count(${j(selector)})) > 0 } catch { __selOk = false }\n`;
	return `${useSpace(space)}${ensureRealTab()}const __wb = Date.now()\nlet __saw = false, __resolved = false, __polls = 0, __last = null\nfor (;;) {\n  let __hc = null\n  try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\n  if (__hc && __hc.detected) __saw = true\n  __last = __hc\n` + selectorCheck + `  if (!(__hc && __hc.detected) && __selOk) { __resolved = true; break }\n  if (Date.now() - __wb >= ${opts.timeoutMs}) break\n  __polls++\n  await page.waitForTimeout(${opts.pollMs})\n}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, needed: __saw, resolved: __resolved, waitedMs: Date.now() - __wb, polls: __polls, detected: !!(__last && __last.detected), kind: (__last && __last.kind) || null, url: await page.url().catch(() => null) }))\n`;
}
function createActiveSpaceTracker(defaultSpace = DEFAULT_SPACE) {
	let activeSpace = defaultSpace;
	let activeName = typeof defaultSpace === "string" ? defaultSpace : null;
	return {
		current: () => activeSpace,
		opened: (args, result) => {
			activeName = result?.name ?? str(args?.name, defaultSpace) ?? null;
			activeSpace = result?.id ?? activeName ?? defaultSpace;
		},
		selected: (space) => {
			if (space !== void 0 && space !== "") {
				activeSpace = space;
				activeName = typeof space === "string" ? space : null;
			}
		},
		closed: (space, done) => {
			if (done && (String(space) === String(activeSpace) || activeName !== null && String(space) === String(activeName))) {
				activeSpace = defaultSpace;
				activeName = typeof defaultSpace === "string" ? defaultSpace : null;
			}
		},
		resetToName: () => {
			activeSpace = activeName ?? defaultSpace;
		}
	};
}
/**
* The session whose tool call is currently being prepared. Set for the whole
* `execute` of a tool (buildScript runs synchronously inside it), so the space
* tracker can answer "what is THIS session's default space?" without threading
* a parameter through 30 buildScript closures.
*/
let pendingSessionId;
/** The session id a tool call belongs to (undefined for host-initiated runs). */
function currentSessionId() {
	return pendingSessionId;
}
/**
* Per-session default space name.
*
* Two DSH sessions (or two subagents) that both omit `space` used to share one
* task space — and therefore one tab set and one cursor — so they stole each
* other's pages. With session-scoped spaces each session gets its own space
* (`dsh-agent-<sid8>`), hence its own browser context and window.
*/
function spaceNameForSession(sessionId, baseDefault, scoped) {
	if (!scoped || sessionId === void 0 || sessionId === "") return baseDefault;
	return `coding-ego-${createHash("sha256").update(String(sessionId)).digest("hex")}`;
}
/**
* Cursor key for the tab tracker. The session is part of the key so two
* sessions sharing one space (session scoping off) still keep their own tab.
*/
function scopedTargetKey(sessionId, space) {
	return `${sessionId ?? ""}\u0000${String(space)}`;
}
/**
* A space tracker per DSH session, lazily created.
*
* `isScoped` is a live getter: the setting can be flipped without rebuilding
* the tracker map, and existing sessions keep the space they already selected.
*/
function createSessionScopedSpaceTracker(baseDefault = DEFAULT_SPACE, isScoped = () => true) {
	const bySession = /* @__PURE__ */ new Map();
	const trackerFor = (sessionId) => {
		const key = sessionId ?? "";
		let tracker = bySession.get(key);
		if (tracker === void 0) {
			tracker = createActiveSpaceTracker(spaceNameForSession(sessionId, baseDefault, isScoped()));
			bySession.set(key, tracker);
		}
		return tracker;
	};
	return {
		forSession: trackerFor,
		current: () => trackerFor(pendingSessionId).current(),
		opened: (args, result) => trackerFor(pendingSessionId).opened(args, result),
		selected: (space) => trackerFor(pendingSessionId).selected(space),
		closed: (space, done) => trackerFor(pendingSessionId).closed(space, done),
		resetToName: () => trackerFor(pendingSessionId).resetToName()
	};
}
/**
* The ego-lite host is a single persistent browser shared by every tool call;
* concurrent tool executions would race on the same task space / tabs. All
* ego_* executions are therefore serialized through one in-process lock.
*/
let egoLockChain = Promise.resolve();
function withEgoLock(fn) {
	const run = egoLockChain.then(() => fn(), () => fn());
	egoLockChain = run.then(() => void 0, () => void 0);
	return run;
}
/**
* Build the env handed to `ego-browser nodejs` spawns.
*
* The vendored ego-linux CLI reads EGO_LINUX_CHROME (bare Chrome binary/wrapper
* path) and EGO_LINUX_HEADLESS (=1 to run headless) from the process env. When a
* host does not set them — the common case on root / Docker / CI boxes — Chrome
* silently fails to start, and consumers see a 20s `DevTools port` timeout.
*
* This function makes the plugin self-sufficient WITHOUT touching the host or
* other plugins:
*
*  - It is a pure function: only reads the current process env, never mutates
*    it, never writes files, and returns a fresh env to pass to the one spawn.
*  - It INCREMENTALLY FILLS GAPS: it uses `??` on every value, so an env var the
*    user already set is always respected and never overridden ("user wins").
*  - It only compensates for missing pieces, so behavior on a correctly set-up
*    host is byte-for-byte identical to before.
*  - It is idempotent: the same env yields the same result every call.
*  - An opt-out switch EGO_BROWSER_AUTO_ADAPT (set to "0"/"false"/"no") restores
*    the original "inherit host env verbatim" behavior.
*/
const BUNDLED_WRAPPER = fileURLToPath(new URL("../bin/ego-chrome-wrapper.sh", import.meta.url));
const IS_WIN = process.platform === "win32";
const IS_DARWIN = process.platform === "darwin";
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(process.env.EGO_BROWSER_AUTO_ADAPT ?? "");
const COMMON_CHROME_BINS = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/google-chrome"
];
/** Windows registry-free probe of the usual install dirs (no subprocess). */
function windowsChromeCandidates() {
	const pf = process.env.ProgramFiles;
	const pfx86 = process.env["ProgramFiles(x86)"];
	const local = process.env.LOCALAPPDATA;
	local || `${process.env.USERPROFILE || process.env.HOME || ""}`;
	const b = (p) => p ? p.replace(/\\+$/, "") : p;
	return [
		b(pf) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pfx86) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(local) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pf) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(local) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		b(local) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
	].filter(Boolean);
}
/**
* macOS registry-free probe of the usual `.app` bundles (no subprocess).
*
* Chrome on macOS is never on PATH: the launcher lives inside the bundle at
* `<App>.app/Contents/MacOS/<binary>`. Both the system-wide and per-user
* `/Applications` locations are probed, Chrome first so that a machine with
* several browsers picks the same one the README documents.
*/
function darwinChromeCandidates() {
	const roots = ["/Applications"];
	if (process.env.HOME) roots.push(`${process.env.HOME}/Applications`);
	const bundles = [
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Chromium.app/Contents/MacOS/Chromium",
		"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"Brave Browser.app/Contents/MacOS/Brave Browser"
	];
	const out = [];
	for (const root of roots) for (const bundle of bundles) out.push(`${root}/${bundle}`);
	return out;
}
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
function findChromeBinary() {
	if (process.env.EGO_LINUX_CHROME) return process.env.EGO_LINUX_CHROME;
	if (IS_WIN) {
		for (const p of windowsChromeCandidates()) try {
			if (existsSync(p)) return p;
		} catch {}
		const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);
		const dirs = (process.env.PATH ?? "").split(";").map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
		for (const dir of dirs) for (const name of [
			"chrome",
			"msedge",
			"brave"
		]) for (const ext of exts) try {
			const p = `${dir}\\${name}${ext}`;
			if (existsSync(p)) return p;
		} catch {}
		return;
	}
	if (IS_DARWIN) {
		for (const p of darwinChromeCandidates()) try {
			if (existsSync(p)) return p;
		} catch {}
		return;
	}
	for (const name of COMMON_CHROME_BINS) if (name.includes("/")) try {
		if (existsSync(name)) return name;
	} catch {}
	else for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = `${dir}/${name}`;
		try {
			if (existsSync(p)) return p;
		} catch {}
	}
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot(platform = process.platform) {
	const uid = process.getuid?.();
	return typeof uid === "number" && uid === 0 && platform !== "win32";
}
/** No display server → headless is required (Linux headless servers). */
function isHeadlessDetected(platform = process.platform, env = process.env) {
	if (platform === "win32" || platform === "darwin") return false;
	return env.DISPLAY === void 0 || env.DISPLAY === "";
}
/**
* Build the env handed to `ego-browser nodejs` spawns. See the block comment
* above ("environment self-adaptation") for the design contract.
*
* Platform/env are injectable for testing; production calls use process defaults.
*/
function resolveEgoEnv(cfg, { platform = process.platform, baseEnv = process.env } = {}) {
	if (AUTO_ADAPT_OFF) return baseEnv;
	const env = { ...baseEnv };
	if (process.versions.electron && env.ELECTRON_RUN_AS_NODE === void 0) env.ELECTRON_RUN_AS_NODE = "1";
	const chrome = findChromeBinary();
	const configChrome = cfg?.chromePath;
	if (env.EGO_LINUX_CHROME === void 0 && configChrome) env.EGO_LINUX_CHROME = configChrome;
	if (env.EGO_LINUX_CHROME === void 0 && isPosixRoot(platform) && chrome) env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
	if (env.EGO_LINUX_CHROME === void 0 && (platform === "win32" || platform === "darwin") && chrome) env.EGO_LINUX_CHROME = chrome;
	if (env.EGO_LINUX_HEADLESS === void 0 && isHeadlessDetected(platform, env)) env.EGO_LINUX_HEADLESS = "1";
	const configChromeArgs = cfg?.chromeArgs;
	if (env.EGO_LINUX_EXTRA_ARGS === void 0 && typeof configChromeArgs === "string" && configChromeArgs.trim() !== "") env.EGO_LINUX_EXTRA_ARGS = configChromeArgs;
	if (env.EGO_ISOLATE_SPACES === void 0 && cfg?.isolateSpaces !== void 0) env.EGO_ISOLATE_SPACES = cfg.isolateSpaces ? "1" : "0";
	if (cfg?.keepBrowserRunning) {
		env.EGO_LINUX_SPACE_IDLE_MIN = "0";
		env.EGO_KEEP_SESSION_PAGES = "1";
	}
	if (env.EGO_LINUX_HEADLESS === void 0 && cfg?.headless !== void 0) env.EGO_LINUX_HEADLESS = cfg.headless ? "1" : "0";
	if (env.EGO_LINUX_CURSOR_NAME === void 0 && typeof cfg?.cursorName === "string" && cfg.cursorName !== "") env.EGO_LINUX_CURSOR_NAME = cfg.cursorName;
	return env;
}
function describeStderr(stderr) {
	const tail = stderr.trim();
	return tail === "" ? "" : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2e3)}`;
}
function describeSpawnFailure(err) {
	const msg = err instanceof Error ? err.message : String(err);
	if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(msg)) return "ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. " + msg;
	return `failed to start ego-browser: ${msg}`;
}
/**
* Error signatures that indicate a TRANSIENT browser cold-start / channel
* not-yet-ready problem rather than a real defect. The ego-lite host is a
* single persistent Chromium that cold-starts on the first tool call of a
* session; a probe that arrives while the DevTools/CDP channel is still
* coming up can fail with one of these. Such failures are safe to retry
* briefly (the browser keeps warming up in the background). Anything else
* must pass through immediately — never mask a genuine error.
*/
const COLD_START_SIGNS = [
	/CDP channel is not open/i,
	/DevTools.*(port|timeout|active)/i,
	/could not connect to/i,
	/browser (was |is )?not (reachable|running|ready)/i,
	/target.*(closed|not found|detached|crashed)/i,
	/ECONNREFUSED/i
];
/** @internal exported for tests (also the contract the resident error relies on) */
function isColdStartError(message) {
	return COLD_START_SIGNS.some((re) => re.test(message));
}
/**
* Run `fn` (a per-call `ego-browser` spawn) up to `tries` times with a short
* backoff, retrying ONLY when the failure matches a transient cold-start
* signature. Real errors return on their first occurrence so they are never
* masked. Each retry re-spawns a fresh process, which is exactly what lets a
* warmed-up browser connect on a later attempt.
*/
async function withWarmupRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		const result = await fn();
		if (result.ok || !isColdStartError(result.error ?? "")) return result;
		last = result;
		if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
	}
	return last;
}
/**
* Run an ego script, recovering once from a stale space pointer: a browser
* restart wipes the runtime's space table, so the tracker's remembered numeric
* id dangles and the runtime hard-fails with "task space not found: N".
* Reset the tracker to the space's name (useOrCreate recreates it) and retry.
*/
/**
* Idle reaper decision (issue #47), pure for tests. Reaps only when the
* feature is on AND at least one ego_* call has ever happened (a never-used
* browser is not running anyway).
* @internal exported for tests
*/
function shouldReapBrowser(nowMs, lastActivityMs, idleTimeoutMin) {
	if (!(idleTimeoutMin > 0) || !(lastActivityMs > 0)) return false;
	return nowMs - lastActivityMs > idleTimeoutMin * 6e4;
}
/**
* Pop the agent browser out as a REAL visible window (issue #51). The
* runtime's `--open` subcommand replaces a headless instance with a headed
* one on the same profile (tabs restore) or just raises the existing window.
* `--open` is on the egoCliArgs blocklist only because USER-supplied args
* must not steal the window — here it is an explicit user action from the
* watch panel. --open stops+relaunches when headless, so give it real time.
*/
async function openAgentWindow(ctx, cfg) {
	try {
		const handle = ctx.subprocess.spawn({
			argv: [
				process.execPath,
				cfg.egoBin,
				"--open"
			],
			cwd: process.cwd(),
			env: resolveEgoEnv(cfg),
			stdio: {
				stdin: { data: "" },
				stdout: { maxBytes: 4096 },
				stderr: { maxBytes: 4096 }
			},
			graceMs: 25e3
		});
		const outcome = await handle.done;
		if (outcome.exitCode !== 0) return {
			ok: false,
			error: readAll(handle.collected.stderr).trim() || `ego-browser --open exited with code ${outcome.exitCode}`
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err)
		};
	}
}
/** @internal exported for tests */
async function runWithStaleSpaceRetry(ctx, cfg, exec, buildScript, graceOverrideMs) {
	let result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
	if (!result.ok && /task space not found: \d+/.test(result.error ?? "")) {
		cfg.spaceTracker.resetToName();
		result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, buildScript(), exec, cfg, graceOverrideMs));
	}
	if (!result.ok && isColdStartError(result.error ?? "")) cfg.onColdStartFailure?.();
	return result;
}
/** Find the last line carrying the sentinel and JSON-parse its payload. */
function parseSentinel(stdout) {
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const idx = lines[i].indexOf(SENTINEL);
		if (idx === -1) continue;
		const payload = lines[i].slice(idx + 14).trim();
		try {
			return JSON.parse(payload);
		} catch {
			return;
		}
	}
}
/**
* Parse the result of one script run: the sentinel payload when present, else
* the last parseable JSON line as a rescue path (#71: a script that succeeded
* but printed plain JSON used to be reported as a hard failure). The sentinel
* stays the primary contract; `fallback` marks the rescue so callers can say so.
* Exported for tests.
*/
function parseSentinelOrLastJson(stdout) {
	const sentinel = parseSentinel(stdout);
	if (sentinel !== void 0) return {
		value: sentinel,
		fallback: false
	};
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i].trim();
		if (text === "" || !/^[[{]/.test(text)) continue;
		try {
			return {
				value: JSON.parse(text),
				fallback: true
			};
		} catch {}
	}
}
let residentTransport = null;
let residentTransportKey = "";
/**
* While a resident's CDP channel is dead (browser stopped, relaunch still
* settling), this timestamp parks the resident and lets the one-shot path do
* the call — it carries the launch retries. Without it every retry would spawn
* another doomed resident before the browser is back.
*/
let residentCooldownUntil = 0;
let residentConsecutiveFailures = 0;
let residentStartedAt = 0;
let residentLastRebuildReason = "not started";
let residentParkReason = null;
/** @internal exported for tests: the supervision state machine. */
function superviseResidentFailure(failures, error) {
	const next = failures + 1;
	return {
		failures: next,
		parkReason: next >= 3 ? `resident failed ${next} times in a row; last error: ${error}` : null
	};
}
/** @internal exported for tests (also used by /api/ego/executor + ego_status). */
function residentDiagnostics(cfg) {
	const running = residentTransport !== null && residentTransport.alive;
	const active = cfg.residentExecutor === true && residentParkReason === null && Date.now() >= residentCooldownUntil;
	return {
		enabled: cfg.residentExecutor === true,
		mode: !active ? "one-shot" : running ? "resident" : "starting",
		running,
		pid: running ? residentTransport?.pid ?? null : null,
		ageMs: running && residentStartedAt > 0 ? Date.now() - residentStartedAt : null,
		consecutiveFailures: residentConsecutiveFailures,
		lastRebuildReason: residentLastRebuildReason,
		parked: residentParkReason !== null,
		parkReason: residentParkReason
	};
}
/** @internal exported for tests */
function resetResidentTransportForTests() {
	const transport = residentTransport;
	residentTransport = null;
	residentTransportKey = "";
	residentCooldownUntil = 0;
	residentConsecutiveFailures = 0;
	residentStartedAt = 0;
	residentLastRebuildReason = "not started";
	residentParkReason = null;
	transport?.stop();
}
function stopResidentTransport() {
	const transport = residentTransport;
	residentTransport = null;
	residentTransportKey = "";
	transport?.stop();
}
/**
* Return the live resident for this configuration, creating it when needed.
* @internal exported for tests
*/
function ensureResidentTransport(cfg) {
	const extraCliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
	const key = JSON.stringify([cfg.egoBin, extraCliArgs]);
	if (residentTransport !== null && residentTransportKey === key && residentTransport.alive) return residentTransport;
	const rebuilding = residentTransport !== null;
	stopResidentTransport();
	residentTransportKey = key;
	residentTransport = new ResidentProcess({
		argv: [
			process.execPath,
			cfg.egoBin,
			"nodejs",
			"--serve",
			...extraCliArgs
		],
		env: resolveEgoEnv(cfg),
		cwd: process.cwd(),
		graceMs: cfg.graceMs,
		idleMs: cfg.residentIdleMin > 0 ? cfg.residentIdleMin * 6e4 : 0,
		onExit: () => {}
	});
	residentTransport.start();
	residentStartedAt = Date.now();
	residentLastRebuildReason = rebuilding ? "rebuilt: configuration changed" : "created";
	return residentTransport;
}
/** Map a resident frame onto the shape the one-shot spawn path returns. */
function residentFrameToResult(frame) {
	const stdout = frame.stdout;
	const stderr = frame.stderr;
	if (!frame.ok) return {
		ok: false,
		error: `ego-browser script failed: ${frame.error ?? "unknown failure"}${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	const parsed = parseSentinelOrLastJson(stdout);
	if (parsed === void 0) return {
		ok: false,
		error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	return {
		ok: true,
		value: parsed.fallback ? {
			...parsed.value,
			fallback: true
		} : parsed.value,
		stdout,
		stderr
	};
}
async function runEgoScript(subprocess, script, exec, cfg, graceOverrideMs) {
	const egoBinCheck = validateEgoBinPath(cfg.egoBin);
	if (!egoBinCheck.ok) return {
		ok: false,
		error: `egoBin is not usable: ${egoBinCheck.reason}`,
		stdout: "",
		stderr: ""
	};
	if (cfg.residentExecutor && Date.now() >= residentCooldownUntil) {
		let transport = null;
		try {
			transport = ensureResidentTransport(cfg);
		} catch {
			transport = null;
		}
		if (transport !== null) try {
			const result = residentFrameToResult(await transport.run(script, {
				...exec.signal !== void 0 ? { signal: exec.signal } : {},
				...Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? { graceMs: graceOverrideMs } : {}
			}));
			if (result.ok) {
				residentConsecutiveFailures = 0;
				residentParkReason = null;
				return result;
			}
			if (!isColdStartError(result.error ?? "")) return result;
			const supervision = superviseResidentFailure(residentConsecutiveFailures, result.error ?? "cold start");
			residentConsecutiveFailures = supervision.failures;
			residentLastRebuildReason = `cold-start failure: ${result.error ?? "unknown"}`;
			if (supervision.parkReason !== null) {
				residentParkReason = supervision.parkReason;
				residentCooldownUntil = Number.MAX_SAFE_INTEGER;
			} else residentCooldownUntil = Date.now() + 1e4;
			stopResidentTransport();
		} catch (err) {
			if (!(err instanceof ResidentNotRunningError)) return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				stdout: "",
				stderr: ""
			};
		}
	} else if (!cfg.residentExecutor) {
		if (residentTransport !== null) stopResidentTransport();
		if (residentParkReason !== null || residentConsecutiveFailures !== 0) {
			residentConsecutiveFailures = 0;
			residentParkReason = null;
			residentLastRebuildReason = "disabled by setting";
		}
	}
	let handle;
	try {
		const extraCliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
		handle = subprocess.spawn({
			argv: [
				process.execPath,
				cfg.egoBin,
				"nodejs",
				...extraCliArgs
			],
			cwd: process.cwd(),
			env: resolveEgoEnv(cfg),
			stdio: {
				stdin: { data: script },
				stdout: {
					maxBytes: cfg.maxOutputBytes,
					spill: { maxBytes: cfg.maxOutputBytes }
				},
				stderr: {
					maxBytes: 512e3,
					spill: { maxBytes: 2e6 }
				}
			},
			graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? graceOverrideMs : cfg.graceMs,
			...exec.signal !== void 0 ? { signal: exec.signal } : {}
		});
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	let outcome;
	try {
		outcome = await handle.done;
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	const stdout = readAll(handle.collected.stdout);
	const stderr = readAll(handle.collected.stderr);
	if (exec.signal !== void 0 && exec.signal.aborted) return {
		ok: false,
		error: "ego-browser tool aborted (harness timeout or cancellation)",
		stdout,
		stderr
	};
	if (outcome.exitCode !== 0) return {
		ok: false,
		error: /Cannot find module|MODULE_NOT_FOUND/i.test(stderr) ? describeSpawnFailure(/* @__PURE__ */ new Error(`node could not load ${cfg.egoBin}`)) : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	const parsed = parseSentinelOrLastJson(stdout);
	if (parsed === void 0) return {
		ok: false,
		error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	return {
		ok: true,
		value: parsed.fallback ? {
			...parsed.value,
			fallback: true
		} : parsed.value,
		stdout,
		stderr
	};
}
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name) => `const task = await taskSpaces.useOrCreate(${j(name)})\n`;
/**
* Optional `tab` parameter shared by every tool that can be pinned to one tab.
* Declared at module scope so both registration functions can reuse it.
*/
const tabParam = {
	type: "string",
	description: "Optional tab targetId (from ego_tabs list). Omit to use the tab Chrome reports as active, falling back to the first real page."
};
/**
* Side-channel line the prelude prints with the target it actually chose.
* The host records it per space so the NEXT call — a brand-new process — can
* re-pin the same tab. Chrome's own `active` flag is not enough: it resets to
* the first tab when the previous CDP client disconnects, so a new process
* cannot tell which tab the last call used.
*/
const TARGET_MARKER = "@@EGO_TARGET@@";
function createTargetTracker() {
	const bySpace = /* @__PURE__ */ new Map();
	return {
		get: (space) => bySpace.get(space),
		set: (space, targetId) => {
			if (space !== "" && targetId !== "") bySpace.set(space, targetId);
		}
	};
}
/**
* The pin the tool wrapper feeds to `ensureRealTab()` for the current
* buildScript call. Module-level because buildScript signatures are
* (args) => string and every page tool calls the same shared helper.
*/
let pendingTargetPin;
/** Viewport applied by `ensureRealTab()` for the current buildScript call. */
let pendingViewport;
/** Record the target a finished call actually used. */
function recordPinnedTarget(tracker, space, stdout) {
	const at = stdout.lastIndexOf(TARGET_MARKER);
	if (at === -1) return;
	const id = stdout.slice(at + 14).split(/\s/)[0];
	if (id !== void 0 && id !== "") tracker.set(space, id);
}
/** Drop the pin side-channel from stdout returned to the model. */
function stripTargetMarkers(text) {
	if (!text.includes(TARGET_MARKER)) return text;
	return text.split("\n").filter((line) => !line.includes(TARGET_MARKER)).join("\n");
}
/**
* Record produced files as session deliverables.
*
* This emits the same `deliverables/presented` event the `present` tool emits,
* so a screenshot or a downloaded file shows up as a card the user can open in
* the Sidebar instead of a bare `/tmp/...` path they must copy from the chat.
*
* Entirely best-effort: a host without the projection service, a tool call
* with no initiating agent, or a session that rejects the append must never
* turn a successful screenshot into a failed tool call.
*
* @returns true when the event was appended.
*/
function deliverToSession(ctx, exec, files) {
	if (files.length === 0) return false;
	const session = (exec?.agent)?.session;
	if (session === void 0 || typeof session.append !== "function") return false;
	try {
		const turn = (ctx.get?.("sessionProjections"))?.stateOf?.(session, "turnBoundary")?.lastTurn;
		if (typeof turn !== "number") return false;
		session.append("deliverables/presented", {
			turn,
			callId: exec?.callId,
			files
		});
		return true;
	} catch {
		return false;
	}
}
/**
* JS snippet that makes the harness act on a real page tab.
*
* The Linux host does not persist "current tab" across CLI invocations: every
* ego_* call is a fresh process, and Chrome reports the first tab as active
* again once the previous CDP client goes away. Selecting a tab before acting
* is therefore mandatory for deterministic cross-process behaviour.
*
* Selection order (first match wins):
*  1. an explicit `tab` targetId supplied by the caller,
*  2. this space's cursor — the tab the previous call used (self-healing: a
*     closed tab no longer matches, so selection falls through),
*  3. the tab Chrome reports as active (correct within one process, and for
*     a human who just clicked a tab),
*  4. the first non-blank page (last-resort fallback).
*
* Before 0.9.5 there were no steps 1–2 and step 3 did not exist: the prelude
* always jumped to the FIRST real tab, silently retargeting every call
* whenever more than one tab was open.
*
* The viewport override is emitted AFTER the switch on purpose: `cdp()` needs
* an attached session, and before the first tab exists (a cold browser) there
* is nothing to attach to — running it first failed every tool with
* "no active tab to attach session".
*/
const ensureRealTab = (preferred, viewport) => {
	const pin = (preferred !== void 0 && preferred !== "" ? preferred : void 0) ?? pendingTargetPin;
	const spec = viewport ?? pendingViewport;
	return `const __tabs = await browser.listTabs()\nconst __want = ${pin !== void 0 ? j(pin) : "null"}\nconst __active = __want ? __tabs.find(t => t.targetId === __want) : __tabs.find(t => t.active === true)\nconst __real = __active ?? __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\nif (__real) await browser.switchTab(__real.targetId)\nif (__real) console.log('${TARGET_MARKER}' + __real.targetId)\n` + (spec ? `if (__real) {\n${viewportPrelude(spec)}}\n` : "");
};
/**
* JS snippet that pins the page viewport with CDP emulation.
*
* A one-shot `ego-browser nodejs` process dies with the call, and a
* session-scoped `Emulation.setDeviceMetricsOverride` dies with it — the next
* call starts from the raw window size again. Emitting the override at the
* head of every script keeps a configured viewport stable across calls, and
* also fixes hosts whose display scaling shrinks the CSS viewport into a
* site's mobile breakpoint.
*/
const viewportPrelude = (cfg) => {
	const width = Math.round(cfg.viewportWidth ?? 0);
	const height = Math.round(cfg.viewportHeight ?? 0);
	if (!(width > 0) || !(height > 0)) return "";
	return `await cdp('Emulation.setDeviceMetricsOverride', { width: ${width}, height: ${height}, deviceScaleFactor: ${cfg.deviceScaleFactor !== void 0 && cfg.deviceScaleFactor > 0 ? cfg.deviceScaleFactor : 1}, mobile: false })\n`;
};
/**
* Prelude for the raw heredoc tools (ego_cli / ego_script).
*
* These tools do NOT go through buildScript, so before this helper they ran
* with no tab selection at all and a fresh process could attach to a stale
* target. The prelude restores the same guarantees the structured tools get,
* but is wrapped in try/catch: a diagnostic script that never touches `page`
* must keep working even when no browser is up.
*/
const rawScriptPrelude = (cfg, tab) => `try {\n${ensureRealTab(tab, cfg)}} catch {}\n`;
/**
* selectOption with value → label → index fallback.
*
* `selectOption` matches option VALUES; a caller passing the visible label
* ("Two" for `<option value="2">Two</option>`) used to fail with
* `could not find option "Two"` even though the tool documented label support.
* Try the value first (cheap, the common case), then the label, then — for a
* numeric argument — the index.
*/
const selectOptionScript = (selector, value) => `const __sel = ${j(selector)}\nconst __v = ${j(value ?? "")}\nconst __pick = async (v) => {\n  try { return await page.locator(__sel).selectOption(v) } catch (__e) {\n    if (typeof v === 'string') { try { return await page.locator(__sel).selectOption({ label: v }) } catch {} }\n    if (typeof v === 'number') { try { return await page.locator(__sel).selectOption({ index: v }) } catch {} }\n    throw __e\n  }\n}\nconst __list = Array.isArray(__v) ? __v : [__v]\nlet __picked = []\ntry { __picked = await page.locator(__sel).selectOption(__v) } catch { __picked = [] }\nif (!Array.isArray(__picked) || __picked.length === 0) {\n  for (const __one of __list) { const __r = await __pick(__one); __picked = Array.isArray(__r) ? __r : [__r] }\n}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, select: __sel, values: __picked }))\n`;
/**
* Page function that locates the first CSS match across open shadow roots and
* same-origin frames and returns its viewport centre.
*
* `page.locator(css)` only queries the top document, so a target inside a
* shadow root or an iframe is reported as "element not found" even though the
* snapshot shows it with a usable ref. Mouse helpers retry through this
* function after the native path fails, which keeps real CDP input (the page's
* own handlers still see trusted events) while covering both cases.
*
* Returns `{ ok: true, x, y }`, or `{ ok: false, reason }` with reason
* `invalid` (bad selector), `not-found`, `multiple` (ambiguous selector —
* the native path reports the same error), or `hidden` (zero-size box).
*/
const CSS_PIERCE_FN = `(selector) => {
  const matches = []
  let invalid = false
  const walk = (root, offsetX, offsetY) => {
    if (matches.length > 0 || invalid) return
    let list
    try { list = root.querySelectorAll(selector) } catch { invalid = true; return }
    if (list.length > 0) {
      for (const el of list) matches.push({ el, offsetX, offsetY })
      return
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, offsetX, offsetY)
      if (matches.length > 0 || invalid) return
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null
        try { doc = el.contentDocument } catch { doc = null }
        if (doc && doc.documentElement) {
          const rect = el.getBoundingClientRect()
          walk(doc, offsetX + rect.left, offsetY + rect.top)
          if (matches.length > 0 || invalid) return
        }
      }
    }
  }
  const locate = () => { matches.length = 0; invalid = false; walk(document, 0, 0) }
  locate()
  if (invalid) return { ok: false, reason: 'invalid' }
  if (matches.length === 0) return { ok: false, reason: 'not-found' }
  if (matches.length > 1) return { ok: false, reason: 'multiple', count: matches.length }
  try { matches[0].el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
  // Scrolling can move an enclosing iframe, so the offsets are recomputed.
  locate()
  if (matches.length !== 1) return { ok: false, reason: 'not-found' }
  const found = matches[0]
  const rect = found.el.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return { ok: false, reason: 'hidden' }
  return { ok: true, x: found.offsetX + rect.left + rect.width / 2, y: found.offsetY + rect.top + rect.height / 2 }
}`;
/**
* Native locator call for a CSS target, with one coordinate retry through
* `CSS_PIERCE_FN`.
*
* The retry runs only after the native path threw, so ordinary selectors keep
* their current behaviour. A selector that matched nothing, or matched several
* elements, still fails with the original error: the fallback must never
* silently act on a different element.
*
* @param kind - Which pointer action to perform.
* @param selector - CSS selector supplied by the caller.
* @param label - Optional progress label shown by the watch panel.
* @returns Script lines that perform the action.
*/
function cssPierceFallback(kind, selector, label) {
	const native = kind === "hover" ? `await page.locator(${j(selector)}).hover()` : `await page.locator(${j(selector)}).${kind}(${label === "" ? "" : `{ label: ${j(label)} }`})`;
	const retry = kind === "hover" ? `await page.mouse.move(__cssPoint.x, __cssPoint.y)` : `await page.mouse.${kind}(__cssPoint.x, __cssPoint.y)`;
	return `let __cssPoint = null
try {
  ${native}
} catch (__cssErr) {
  try { __cssPoint = await page.evaluate(${CSS_PIERCE_FN}, ${j(selector)}) } catch { __cssPoint = null }
  if (!__cssPoint || __cssPoint.ok !== true) throw __cssErr
  ${retry}
}`;
}
function renderText(_args, value) {
	const v = value;
	if (v !== null && typeof v === "object" && v.ok === true && typeof v.text === "string") return [{
		type: "text",
		text: v.text
	}];
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
const commonOutputSchema = {
	type: "object",
	additionalProperties: true,
	properties: { ok: {
		type: "boolean",
		required: true
	} }
};
/**
* The calling session id — the scope the client's sidebar auto-open binds to.
* Read structurally (`exec.agent` is typed `unknown` in this plugin's own
* seam); a call with no initiating agent simply leaves the open unscoped.
*/
function callingSessionId(exec) {
	const id = (exec?.agent)?.session?.id;
	return typeof id === "string" && id !== "" ? id : void 0;
}
function observeEgoTool(cfg, name, args, run) {
	return cfg.observeTool ? cfg.observeTool(name, args, run) : Promise.resolve().then(run);
}
function defineEgoTool(ctx, cfg, opts) {
	return defineTool({
		name: opts.name,
		description: opts.description,
		parameters: opts.parameters,
		output: {
			schema: commonOutputSchema,
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, opts.name, args, async () => {
			const sessionId = callingSessionId(exec);
			pendingSessionId = sessionId;
			try {
				markEgoToolCall(sessionId);
				const spaceKey = scopedTargetKey(sessionId, str(args.space, cfg.defaultSpace));
				const buildScript = () => {
					pendingTargetPin = cfg.targetTracker.get(spaceKey);
					pendingViewport = cfg;
					try {
						return opts.buildScript(args);
					} finally {
						pendingTargetPin = void 0;
						pendingViewport = void 0;
					}
				};
				const result = await runWithStaleSpaceRetry(ctx, cfg, exec, buildScript);
				if (!result.ok) throw new Error(result.error);
				recordPinnedTarget(cfg.targetTracker, spaceKey, result.stdout);
				if (typeof opts.afterExecute === "function") opts.afterExecute(args, result.value);
				if (typeof opts.deliverFiles === "function") deliverToSession(ctx, exec, opts.deliverFiles(args, result.value));
				return result.value;
			} finally {
				pendingSessionId = void 0;
			}
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle(opts.name, args),
			kind: "other",
			rawInput: null
		})
	});
}
function apply(ctx, config = {}) {
	const bridge = installEgoBrowserSettings(ctx, Object.fromEntries([
		"chromePath",
		"headless",
		"cursorName",
		"captureBackend",
		"streamProfile",
		"cdpFps",
		"cdpQuality",
		"cdpMaxWidth",
		"cdpBackstopIntervalMs",
		"ffmpegFps",
		"ffmpegMaxWidth",
		"ffmpegBitrateKbps",
		"ffmpegEncoder",
		"ffmpegPath",
		"githubMirror",
		"egoCliArgs",
		"chromeArgs",
		"castFpsCap",
		"screencastQuality",
		"screencastMaxWidth",
		"backstopIntervalMs",
		"idleTimeoutMin",
		"disableFrameRelay",
		"tuiAutoOpenPanel",
		"residentExecutor",
		"residentIdleMin"
	].filter((key) => config[key] !== void 0).map((key) => [key, config[key]])), () => {
		let live;
		try {
			live = ctx.config;
		} catch {
			live = void 0;
		}
		return live ?? config;
	});
	const ffmpegManager = getSharedFfmpegInstallationManager();
	const initialFfmpegConfig = resolveConfig(bridge.source());
	if (initialFfmpegConfig.captureBackend === "ffmpeg") ffmpegManager.check({
		configuredPath: initialFfmpegConfig.ffmpegPath,
		requestedEncoder: initialFfmpegConfig.ffmpegEncoder
	}).catch(() => {});
	const spaceTracker = createSessionScopedSpaceTracker(config.defaultSpace ?? DEFAULT_SPACE, () => resolveConfig(bridge.source()).sessionScopedSpaces);
	const cfg = {
		egoBin: typeof config.egoBin === "string" && config.egoBin !== "" ? config.egoBin : DEFAULT_EGO_BIN,
		configuredDefaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
		spaceTracker,
		targetTracker: createTargetTracker(),
		get defaultSpace() {
			return this.spaceTracker.current();
		},
		maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
		get chromePath() {
			return resolveConfig(bridge.source()).chromePath;
		},
		get headless() {
			return resolveConfig(bridge.source()).headless;
		},
		get cursorName() {
			return resolveConfig(bridge.source()).cursorName;
		},
		get captureBackend() {
			return resolveConfig(bridge.source()).captureBackend;
		},
		get streamProfile() {
			return resolveConfig(bridge.source()).streamProfile;
		},
		get cdpFps() {
			return resolveConfig(bridge.source()).cdpFps;
		},
		get cdpQuality() {
			return resolveConfig(bridge.source()).cdpQuality;
		},
		get cdpMaxWidth() {
			return resolveConfig(bridge.source()).cdpMaxWidth;
		},
		get cdpBackstopIntervalMs() {
			return resolveConfig(bridge.source()).cdpBackstopIntervalMs;
		},
		get ffmpegFps() {
			return resolveConfig(bridge.source()).ffmpegFps;
		},
		get ffmpegMaxWidth() {
			return resolveConfig(bridge.source()).ffmpegMaxWidth;
		},
		get ffmpegBitrateKbps() {
			return resolveConfig(bridge.source()).ffmpegBitrateKbps;
		},
		get ffmpegEncoder() {
			return resolveConfig(bridge.source()).ffmpegEncoder;
		},
		get ffmpegPath() {
			return resolveConfig(bridge.source()).ffmpegPath;
		},
		get githubMirror() {
			return resolveConfig(bridge.source()).githubMirror;
		},
		get egoCliArgs() {
			return resolveConfig(bridge.source()).egoCliArgs;
		},
		get chromeArgs() {
			return resolveConfig(bridge.source()).chromeArgs;
		},
		get viewportWidth() {
			return resolveConfig(bridge.source()).viewportWidth;
		},
		get viewportHeight() {
			return resolveConfig(bridge.source()).viewportHeight;
		},
		get deviceScaleFactor() {
			return resolveConfig(bridge.source()).deviceScaleFactor;
		},
		get isolateSpaces() {
			return resolveConfig(bridge.source()).isolateSpaces;
		},
		get sessionScopedSpaces() {
			return resolveConfig(bridge.source()).sessionScopedSpaces;
		},
		get keepBrowserRunning() {
			return resolveConfig(bridge.source()).keepBrowserRunning;
		},
		get idleTimeoutMin() {
			return resolveConfig(bridge.source()).idleTimeoutMin;
		},
		get disableFrameRelay() {
			return resolveConfig(bridge.source()).disableFrameRelay;
		},
		get tuiAutoOpenPanel() {
			return resolveConfig(bridge.source()).tuiAutoOpenPanel;
		},
		get residentExecutor() {
			return resolveConfig(bridge.source()).residentExecutor;
		},
		get residentIdleMin() {
			return resolveConfig(bridge.source()).residentIdleMin;
		}
	};
	ctx.exportBrowserEnv?.(() => resolveEgoEnv(cfg));
	const browserState = new BrowserStateStore();
	const tui = installTui(ctx, browserState);
	installBrowserPanel(ctx, cfg, browserState, tui, {
		createTransport: () => ({
			readBrowserState,
			readTaskSpaceGroups,
			ensureWorker: makeEnsureWorker(ctx, cfg, ffmpegManager),
			get: proxyFrom,
			post: proxyPost
		}),
		openAgentWindow: () => openAgentWindow(ctx, cfg)
	});
	cfg.onColdStartFailure = () => tui.toast("Agent Browser could not start after retrying. Run ego_doctor for details.", "error");
	cfg.observeTool = async (name, args, run) => {
		const token = browserState.startTool(name, safeLocatorSummary(name, args));
		try {
			const value = await run();
			const result = value;
			const error = typeof result?.error === "string" ? result.error : void 0;
			browserState.finishTool(token, {
				ok: result?.ok !== false,
				error
			});
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			browserState.finishTool(token, {
				ok: false,
				error: message
			});
			throw error;
		}
	};
	const reg = (tool) => {
		if ([
			"ego_cli",
			"ego_script",
			"ego_help",
			"ego_doctor"
		].includes(tool.name)) {
			const execute = tool.execute;
			tool.execute = (args, exec) => observeEgoTool(cfg, tool.name, args, () => execute(args, exec));
		}
		const dispose = ctx.tools.register(tool);
		ctx.effect?.(() => dispose);
	};
	registerEgoStatus(ctx, cfg, reg);
	registerAuthFlush(ctx, cfg, reg);
	registerLoginImport(ctx, cfg, reg);
	registerActionTools(ctx, cfg, reg);
	registerHelpAndDoctor(ctx, cfg, reg);
	ctx.inject?.(["webServer"], (wctx) => {
		try {
			initCastServer(wctx, cfg, bridge, ffmpegManager, () => openAgentWindow(ctx, cfg), (opts) => importLoginCookies(opts, { subprocess: ctx.subprocess }), () => residentDiagnostics(cfg));
		} catch (err) {
			ctx.logger?.warn?.(`ego-browser: cast server init failed: ${err?.message ?? err}`);
		}
		try {
			registerEgoBrowserGateway(wctx, bridge, ffmpegManager);
		} catch (err) {
			ctx.logger?.warn?.(`ego-browser: settings gateway init failed: ${err?.message ?? err}`);
		}
	});
	ctx.effect?.(() => {
		if (cfg.keepBrowserRunning || cfg.idleTimeoutMin <= 0) return;
		let reapedFor = 0;
		const timer = setInterval(() => {
			(async () => {
				try {
					const last = getLastEgoActivity();
					if (!shouldReapBrowser(Date.now(), last, cfg.idleTimeoutMin)) return;
					if (last <= reapedFor) return;
					const e = process.env;
					const isWin = process.platform === "win32";
					const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
					const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
					const { readFile } = await import("node:fs/promises");
					let reapedPid;
					try {
						const stateText = await readFile(`${stateDir}/browser.json`, "utf8");
						if (tui.hasToast()) try {
							const pid = JSON.parse(stateText).pid;
							if (Number.isInteger(pid) && pid > 0) {
								process.kill(pid, 0);
								reapedPid = pid;
							}
						} catch {}
					} catch {
						return;
					}
					reapedFor = last;
					ctx.logger?.info?.(`ego-browser: idle reaper stopping the backing browser after ${cfg.idleTimeoutMin}min without ego_* activity`);
					ctx.subprocess.spawn({
						argv: [
							process.execPath,
							cfg.egoBin,
							"--stop"
						],
						cwd: process.cwd(),
						env: resolveEgoEnv(cfg),
						stdio: {
							stdin: { data: "" },
							stdout: { maxBytes: 1024 },
							stderr: { maxBytes: 1024 }
						},
						graceMs: 8e3
					}).done.then((outcome) => {
						if (outcome.exitCode !== 0 || reapedPid === void 0 || !tui.hasToast()) return;
						try {
							process.kill(reapedPid, 0);
						} catch (error) {
							if (error.code === "ESRCH") tui.toast("Agent Browser stopped after the idle timeout.", "success");
						}
					}).catch(() => null);
				} catch {}
			})();
		}, 6e4);
		return () => clearInterval(timer);
	}, "ego-browser: idle reaper");
	ctx.effect?.(() => () => stopResidentTransport(), "ego-browser: resident executor");
	ctx.effect?.(() => () => {
		try {
			ctx.subprocess.spawn({
				argv: [
					process.execPath,
					cfg.egoBin,
					"--stop"
				],
				cwd: process.cwd(),
				env: resolveEgoEnv(cfg),
				stdio: {
					stdin: { data: "" },
					stdout: { maxBytes: 1024 },
					stderr: { maxBytes: 1024 }
				},
				graceMs: 8e3
			}).done.catch(() => {});
		} catch {}
	});
	ctx.logger?.info?.(`ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`);
}
/** `ego_status` probes CLI availability by running the real `--status` path. */
function registerEgoStatus(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_status",
		description: "Check whether the ego-browser CLI is usable (runs `ego-browser --status`). Use this first when other ego_* tools report \"CLI not found\".",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					available: {
						type: "boolean",
						required: true
					},
					path: { type: "string" },
					exitCode: { type: "integer" },
					resident: {
						type: "object",
						additionalProperties: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 25e3,
		execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_status", args, async () => {
			try {
				const handle = ctx.subprocess.spawn({
					argv: [
						process.execPath,
						cfg.egoBin,
						"--status"
					],
					cwd: process.cwd(),
					env: resolveEgoEnv(cfg),
					stdio: {
						stdin: { data: "" },
						stdout: { maxBytes: 4096 },
						stderr: { maxBytes: 4096 }
					},
					graceMs: 25e3
				});
				const outcome = await handle.done;
				const out = readAll(handle.collected.stdout).trim();
				return {
					ok: true,
					available: outcome.exitCode === 0 && out !== "",
					path: cfg.egoBin,
					exitCode: outcome.exitCode,
					resident: residentDiagnostics(cfg)
				};
			} catch (err) {
				return {
					ok: true,
					available: false,
					path: "",
					exitCode: null,
					error: describeSpawnFailure(err)
				};
			}
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_status", args),
			kind: "other",
			rawInput: null
		})
	}));
}
/** `ego_auth_flush` — force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_auth_flush",
		description: "Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart — Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					total: { type: "integer" },
					flushed: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_auth_flush", args, async () => {
			try {
				const { readFile } = await import("node:fs/promises");
				const e = process.env;
				const isWin = process.platform === "win32";
				const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
				const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
				let port = null;
				try {
					const state = JSON.parse(await readFile(`${stateDir}/ego-cast.json`, "utf8"));
					port = typeof state.port === "number" ? state.port : null;
				} catch {
					port = null;
				}
				if (port === null) return {
					ok: false,
					error: "no live ego-cast worker (browser not running)"
				};
				const jbody = await (await fetch(`http://127.0.0.1:${port}/api/flush`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(8e3)
				})).json();
				return {
					ok: !!jbody.ok,
					total: jbody.total ?? 0,
					flushed: jbody.flushed ?? 0,
					...typeof jbody.error === "string" ? { error: jbody.error } : {}
				};
			} catch (err) {
				return {
					ok: false,
					error: String(err?.message || err)
				};
			}
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_auth_flush", args),
			kind: "other",
			rawInput: null
		})
	}));
}
/** `ego_login_import` — copy login cookies from the system browser (issue #46). */
/**
* #69 policy: `ego_login_import` is unsafe on Windows because the import boots
* the REAL profile through a junction alias and hard-kills the instance. Chrome
* App-Bound Encryption (127+) is what makes the data-loss path possible (and
* the cookie read fail), so the guard covers every ABE-capable build, not only
* the 155 build where the damage was first observed. Linux/macOS use a different
* profile-handoff path and stay enabled. The env flag remains a manual override.
*
* Exported for tests.
*/
function loginImportPolicy({ platform, chromeMajor, force }) {
	if (force) return { allowed: true };
	if (platform !== "win32") return { allowed: true };
	if (chromeMajor === null) return {
		allowed: false,
		reason: "could not determine the installed Chrome version on Windows; refusing to risk the source profile (set EGO_LINUX_LOGIN_IMPORT_FORCE=1 to override)"
	};
	if (chromeMajor >= 127) return {
		allowed: false,
		reason: `Chrome ${chromeMajor} on Windows uses App-Bound Encryption (127+), which makes the current import path both unable to read cookies and potentially destructive to the source profile (#69). Set EGO_LINUX_LOGIN_IMPORT_FORCE=1 to override.`
	};
	return { allowed: true };
}
/** Is the manual override set? */
function loginImportForced(env = process.env) {
	return /^(1|true|yes|on)$/i.test(env.EGO_LINUX_LOGIN_IMPORT_FORCE ?? "");
}
/**
* Best-effort major version of the Chrome-family binary the import would use.
*
* Windows: Chrome keeps one `<major>.<minor>.<build>.<patch>` directory under
* the `Application` directory next to chrome.exe — cheap and reliable. Elsewhere
* ask the binary itself (`--version`), which is what the platform expects. Any
* failure returns null; the policy treats null conservatively on Windows.
* Exported for tests.
*/
function detectChromeMajorVersion(binPath) {
	if (!binPath) return null;
	try {
		if (process.platform === "win32") {
			const versions = readdirSync(dirname(binPath)).filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry)).map((entry) => Number(entry.split(".")[0])).filter((major) => Number.isInteger(major) && major > 0);
			return versions.length === 0 ? null : Math.max(...versions);
		}
		const out = execFileSync(binPath, ["--version"], {
			encoding: "utf8",
			timeout: 5e3
		});
		const match = String(out).match(/(\d+)\.\d+\.\d+/);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}
function registerLoginImport(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_login_import",
		description: "Import login cookies from the system browser into the agent browser, so sites open already logged in, with two SAFE routes (#69): (1) source=\"extension\" — load the companion extension/ folder once in Chrome/Edge, keep the browser open, run this with explicit domains and click Export in the extension popup; cookies are read through the browser's own cookies API and POSTed to a loopback receiver (token file: <stateDir>/login-extension-token). This works on modern Chrome/Edge (including Windows 127+ ABE). (2) source=\"chrome\"|\"edge\"|\"brave\"|\"auto\" — the source browser must be closed; the tool copies only Local State + the Cookies DB to a throwaway profile and reads it headless. On Chrome/Edge 127+ (App-Bound Encryption) that copy reads 0 cookies and the tool reports it explicitly; the real profile is never booted or modified. dryRun=true reports what would be imported. The agent browser must be running (call ego_status first). Imported logins persist in the on-disk profile. Cookie values are never shown — only domain names and counts.",
		parameters: {
			source: {
				type: "string",
				description: "extension | chrome | edge | brave | auto (default: auto = first detected browser). Use \"extension\" for modern Chrome/Edge without closing it."
			},
			domains: {
				type: "json",
				description: "Optional array of domains to import, e.g. [\"bilibili.com\",\"zhihu.com\"] (subdomains included). Omit = ALL cookies — prefer an explicit list."
			},
			profile: {
				type: "string",
				description: "Source browser profile directory name, e.g. \"Default\" or \"Profile 1\" (default: the first profile)."
			},
			closeSource: {
				type: "boolean",
				description: "A running source browser holds an exclusive lock on its cookie store (Windows). true = gracefully close it first (its windows/tabs restore on next launch). false (default) = return an actionable error instead."
			},
			dryRun: {
				type: "boolean",
				description: "true = only report what would be imported (domains + cookie counts), write nothing."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					source: { type: "string" },
					profile: { type: "string" },
					dryRun: { type: "boolean" },
					totalRead: { type: "integer" },
					matched: { type: "integer" },
					written: { type: "integer" },
					domains: { type: "json" },
					closedSource: { type: "boolean" },
					disabled: { type: "boolean" },
					error: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 18e4,
		execute: async (args) => withEgoLock(() => observeEgoTool(cfg, "ego_login_import", args, async () => {
			try {
				const domains = Array.isArray(args.domains) ? args.domains.map(String) : void 0;
				const source = typeof args.source === "string" && args.source !== "" ? args.source : "auto";
				if (![
					"chrome",
					"edge",
					"brave",
					"auto",
					"extension"
				].includes(source)) return {
					ok: false,
					error: `invalid source "${source}" — expected chrome|edge|brave|auto|extension`
				};
				if (source === "extension") return await importLoginCookiesFromExtension({
					domains,
					dryRun: args.dryRun === true,
					timeoutMs: 12e4
				});
				const guardBinary = cfg.chromePath || findChromeBinary();
				const policy = loginImportPolicy({
					platform: process.platform,
					chromeMajor: detectChromeMajorVersion(guardBinary),
					force: loginImportForced()
				});
				if (!policy.allowed) return {
					ok: false,
					disabled: true,
					error: `ego_login_import is disabled here: ${policy.reason}`
				};
				return await importLoginCookies({
					source,
					domains,
					profile: typeof args.profile === "string" && args.profile !== "" ? args.profile : void 0,
					closeSource: args.closeSource === true,
					dryRun: args.dryRun === true
				}, { subprocess: ctx.subprocess });
			} catch (err) {
				return {
					ok: false,
					error: String(err?.message || err)
				};
			}
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_login_import", args),
			kind: "other",
			rawInput: null
		})
	}));
}
/** The structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx, cfg, reg) {
	const t = (opts) => defineEgoTool(ctx, cfg, {
		...opts,
		afterExecute: (args, result) => {
			if (!result || result.ok === false) return;
			if (opts.name === "ego_space_open") cfg.spaceTracker.opened(args, result);
			else if (opts.name === "ego_space_close") cfg.spaceTracker.closed(args.name, result.done);
			else if (args && args.space !== void 0 && args.space !== "") cfg.spaceTracker.selected(args.space);
			opts.afterExecute?.(args, result);
		}
	});
	const spaceParam = {
		type: "string",
		description: "Task-space name or numeric id. Omit to use this session’s own space (dsh-agent-<session>) when session-scoped spaces are on (default), otherwise the most recently opened or explicitly selected space."
	};
	reg(t({
		name: "ego_space_open",
		get description() {
			return cfg.isolateSpaces ? "Open (or reuse) an ego-lite task space in isolated sandbox mode." : "Open (or reuse) the ego-lite task space. In persistent profile mode (default), ALWAYS use or reuse the single 'default' space. Login credentials automatically persist on disk across restarts — if a page requires login, prompt user to log in manually in the opened window. DO NOT create numbered spaces like #4, #5.";
		},
		parameters: { name: {
			type: "string",
			required: true,
			get description() {
				return cfg.isolateSpaces ? "Task-space name or numeric id." : "Task-space name. In persistent mode, ALWAYS specify 'default'. Reuse this single space for all browsing tasks.";
			}
		} },
		buildScript: (args) => `${useSpace(str(args.name, cfg.defaultSpace))}console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.defaultSpace))} }))\n`
	}));
	reg(t({
		name: "ego_space_close",
		get description() {
			return cfg.isolateSpaces ? "Complete (close) an ego-lite task space in sandbox mode." : "Close an ego-lite task space. WARNING: In persistent profile mode, DO NOT call this tool when finishing tasks! Keep the space, tabs, and browser window alive so login sessions and streams remain intact. Conclude tasks by replying to the user directly without closing the space.";
		},
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Task-space name or numeric id to close."
			},
			keep: {
				type: "boolean",
				description: "Keep the live page open (default false: close it)."
			}
		},
		buildScript: (args) => `const res = await taskSpaces.complete(${j(str(args.name, cfg.defaultSpace))}, { keep: ${bool(args.keep, false)} })\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j("target space was not agent-owned")} : null }))\n`
	}));
	reg(t({
		name: "ego_snapshot",
		description: "Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.",
		parameters: {
			space: spaceParam,
			scope: {
				type: "string",
				description: "snapshot scope: 'full_page' (default) or 'only_within_viewport'."
			}
		},
		buildScript: (args) => {
			const scope = str(args.scope, "");
			const call = scope === "" ? "await page.snapshotRaw()" : `await page.snapshotRaw({ scope: ${j(scope)} })`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}let s = ${call}\nlet tries = 0\nwhile (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\nconst text = s.content ?? ''\nconsole.log('${SENTINEL}' + JSON.stringify(text === ''\n  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n  : { ok: true, text, tries }))\n`;
		}
	}));
	reg(t({
		name: "ego_navigate",
		description: "Open a URL in the task space, or switch to the existing tab for it. Always prefer reusing existing open tabs before opening duplicate URLs. Waits for document load. Returns resulting page info.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open, e.g. https://example.com/path."
			},
			wait: {
				type: "boolean",
				description: "Wait for document load (default true)."
			},
			timeout: {
				type: "number",
				description: "Load wait timeout in ms (default 20000)."
			},
			tab: tabParam,
			space: spaceParam
		},
		buildScript: (args) => {
			const u = str(args.url, "");
			if (u === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'ego_navigate: url is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab(str(args.tab, ""))}const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(u.split("#")[0])})\nconst tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 2e4)} })\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "ego_click",
		description: "Click an element in the current page. Target with a CSS selector, an xpath=.../loc=.../ref=N value from ego_snapshot, or viewport coordinates.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector, xpath=..., loc=..., or ref=N from the snapshot. Required unless x/y are given."
			},
			x: {
				type: "number",
				description: "Viewport x coordinate for a coordinate click."
			},
			y: {
				type: "number",
				description: "Viewport y coordinate for a coordinate click."
			},
			label: {
				type: "string",
				description: "Short human label for the action, e.g. \"click submit button\"."
			},
			double: {
				type: "boolean",
				description: "Double-click instead of single-click. Useful for opening files/rows or triggering dblclick handlers."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const x = args.x;
			const y = args.y;
			if (sel === "" && !(typeof x === "number" && typeof y === "number")) throw new Error("ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates");
			const dbl = bool(args.double, false);
			let action;
			if (sel !== "") action = cssPierceFallback(dbl ? "dblclick" : "click", sel, str(args.label, ""));
			else action = dbl ? `await page.mouse.dblclick(${x}, ${y})` : `await page.mouse.click(${x}, ${y})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${action}\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "ego_fill",
		description: "Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=N from ego_snapshot.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector, xpath=..., loc=..., or ref=N for the input."
			},
			text: {
				type: "string",
				required: true,
				description: "Text to type into the field."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).fill(${j(str(args.text, ""))})\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`
	}));
	reg(t({
		name: "ego_js",
		description: "Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. \"document.title\", \"document.querySelectorAll('a').length\").",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression string to evaluate in the page."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = await page.evaluate(${j(str(args.expression, ""))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
	}));
	reg(t({
		name: "ego_cdp",
		description: "Issue a raw CDP command on the page target, e.g. cdp(\"Page.handleJavaScriptDialog\", { accept: true }).",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method name, e.g. Page.handleJavaScriptDialog."
			},
			params: {
				type: "object",
				additionalProperties: true,
				description: "CDP method parameters object."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const params = args.params;
			const call = params !== void 0 && params !== null ? `await cdp(${j(str(args.method, ""))}, ${j(params)})` : `await cdp(${j(str(args.method, ""))})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = ${call}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`;
		}
	}));
	reg(t({
		name: "ego_screenshot",
		description: "Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.",
		parameters: {
			selector: {
				type: "string",
				description: "Optional CSS selector of an element to screenshot instead of the whole page."
			},
			path: {
				type: "string",
				description: "Optional absolute output path for the PNG."
			},
			deliver: {
				type: "boolean",
				description: "Surface the PNG as a deliverable card in the conversation (default true). Set false to keep it a bare path."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const pth = str(args.path, "");
			const shot = sel !== "" ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ""})` : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const path = ${shot}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`;
		},
		deliverFiles: (args, value) => {
			const file = value?.path;
			if (args.deliver === false || typeof file !== "string" || file === "") return [];
			const selector = str(args.selector, "");
			return [{
				path: file,
				description: selector === "" ? "Screenshot" : `Screenshot of ${selector}`
			}];
		}
	}));
	reg(t({
		name: "ego_page_info",
		description: "Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` — whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).",
		parameters: { space: spaceParam },
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const pginfo = await page.info()\nlet __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))\n`
	}));
	reg(t({
		name: "ego_tabs",
		description: "List, switch, open, or close agent-browser tabs. Use it to keep tab hygiene: list the open pages, switch to one, open a new tab for a URL, or close scratch tabs. Tab ids are stable target ids (also returned by ego_space_open / ego_navigate).",
		parameters: {
			action: {
				type: "string",
				description: "'list' (default) | 'switch' | 'open' | 'close'."
			},
			targetId: {
				type: "string",
				description: "Tab target id for action=switch / action=close."
			},
			url: {
				type: "string",
				description: "URL for action=open (default: 'about:blank')."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const action = str(args.action, "list");
			const targetId = str(args.targetId, "");
			const url = str(args.url, "");
			const done = (extra) => `const __tabs = await browser.listTabs()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true${extra}, tabs: __tabs }))\n`;
			const fail = (message) => `console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: ${j(message)} }))\n`;
			const guard = (space, expr, missing, body) => `${space}if (${expr}) {\n${fail(`runtime capability missing: ${missing}; use the bundled runtime or extend your bridge with it`)}} else {\n${body}}\n`;
			const readOnlyGuard = (expr, missing, body) => `if (${expr}) {\n${fail(`runtime capability missing: ${missing}; use the bundled runtime or extend your bridge with it`)}} else {\n${body}}\n`;
			const noBrowser = (cap) => `typeof browser === 'undefined' || typeof browser.${cap} !== 'function'`;
			const knownTabs = "const __pre = await browser.listTabs()\nconst __openIds = __pre.map(t => t.targetId).join(', ') || 'none'\n";
			const withKnownTarget = (target, body) => `if (!__pre.some(t => t.targetId === ${target})) {\n  console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: 'targetId ' + ${target} + ' is not open in this task space (open ids: ' + __openIds + '); call action=list and reuse one of them' }))\n} else {\n${body}}\n`;
			if (action === "switch") {
				const space = useSpace(str(args.space, cfg.defaultSpace));
				if (!targetId) return `${space}${fail("targetId is required for action=switch")}`;
				return guard(space, `${noBrowser("switchTab")} || ${noBrowser("listTabs")}`, `${knownTabs}${withKnownTarget(j(targetId), `await browser.switchTab(${j(targetId)})\n${done(`, switched: ${j(targetId)}`)}`)}`);
			}
			if (action === "open") return guard(useSpace(str(args.space, cfg.defaultSpace)), `${noBrowser("listTabs")} || typeof ego === 'undefined' || typeof ego.createTab !== 'function'`, "ego.createTab / browser.listTabs", `let __created = null\ntry { __created = await ego.createTab(${j(url || "about:blank")}) } catch (__openErr) {\n  console.log('${SENTINEL}' + JSON.stringify({ ok: false, error: 'could not open a tab: ' + String((__openErr && __openErr.message) || __openErr) }))\n}\nif (__created) {\n${done(`, created: __created && __created.targetId || null`)}}\n`);
			if (action === "close") {
				const space = useSpace(str(args.space, cfg.defaultSpace));
				if (!targetId) return `${space}${fail("targetId is required for action=close")}`;
				return guard(space, `${noBrowser("closeTab")} || ${noBrowser("listTabs")}`, "browser.closeTab / browser.listTabs", `${knownTabs}${withKnownTarget(j(targetId), `await browser.closeTab(${j(targetId)})\n${done(`, closed: ${j(targetId)}`)}`)}`);
			}
			if (action !== "list") return `${useSpace(str(args.space, cfg.defaultSpace))}${fail(`unknown action: ${action}`)}`;
			return readOnlyGuard(`typeof ego === 'undefined' || typeof ego.listTabsForSpace !== 'function'`, "ego.listTabsForSpace", `const __listed = await ego.listTabsForSpace(${j(str(args.space, cfg.defaultSpace))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, tabs: __listed.tabs || [] }))\n`);
		},
		afterExecute: (args, value) => {
			const v = value;
			const target = str(v?.switched, "") || str(v?.created, "");
			if (target !== "") cfg.targetTracker.set(scopedTargetKey(currentSessionId(), str(args.space, cfg.defaultSpace)), target);
		}
	}));
	reg(t({
		name: "ego_wait",
		description: "Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate's wait option.",
		parameters: { ms: {
			type: "number",
			required: true,
			description: "Milliseconds to wait."
		} },
		buildScript: (args) => `await page.waitForTimeout(${Math.max(0, num(args.ms, 1e3))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(0, num(args.ms, 1e3))} }))\n`
	}));
	reg(t({
		name: "ego_wait_for_selector",
		description: "Wait until an element matching a CSS selector appears (state=visible, default) or disappears (state=hidden). Use instead of a blind fixed wait when a page renders asynchronously.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the element to wait for, e.g. '.results' or '[data-id=done]'."
			},
			state: {
				type: "string",
				description: "Target state: 'visible' (default) | 'attached' | 'hidden' | 'detached'."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "").trim();
			if (sel === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, waited: false, reason: 'ego_wait_for_selector: selector is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.waitForSelector(${j(sel)}, { state: ${j(str(args.state, "visible"))}, timeout: ${num(args.timeout, 1e4)} })\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, waited: true, selector: ${j(sel)}, state: ${j(str(args.state, "visible"))} }))\n`;
		}
	}));
	reg(t({
		name: "ego_wait_for_url",
		description: "Wait until the page navigates to a URL matching a substring / glob / regex. Use to catch login redirects or pagination. IMPORTANT: it only observes navigations that happen DURING this call — if the navigation already finished in a previous ego_* call, read ego_page_info instead. Matching is Playwright semantics: a full URL or a ** glob (\"**/search**\"); a bare substring does not match. The result always carries the current URL.",
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/)."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const p = str(args.pattern, "").trim();
			if (p === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, reason: 'ego_wait_for_url: pattern is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __u0 = await page.url()\nconst __p = ${j(p)}\nconst __isPattern = /[*?[\\\\]]/.test(__p) || __p.startsWith('/')\nconst __already = !__isPattern && __u0.includes(__p)\nconst __ok = __already || await page.waitForURL(__p, { timeout: ${num(args.timeout, 1e4)} }).catch(() => false)\nconst __u = await page.url()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: !!__ok, reached: !!__ok, url: __u, matchedCurrent: __already, hint: __ok ? undefined : 'waitForURL only sees FUTURE navigations: issue the wait in the same ego_script as the action that navigates, and pass a full URL or a ** glob (a bare substring does not match).' }))\n`;
		}
	}));
	reg(t({
		name: "ego_wait_for_response",
		description: "Wait for a network response matching a URL/glob/regex and return it. Optionally return the body (text or JSON) — ideal for scraping API responses or confirming a submission. By default it also matches responses that already finished during the CURRENT document load (includeBuffered), because \"wait for the response of the page I just opened\" is the common case; set includeBuffered=false for strict future-only semantics. Across separate ego_* calls only future responses can be seen — trigger the request and the wait in the same ego_script. On timeout the result carries the current URL and a hint instead of throwing.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "URL/glob/regex to match, e.g. '/api/search' or 'https://*.com/data'."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			body: {
				type: "string",
				description: "Return the response body: 'none' (default) | 'text' | 'json'."
			},
			includeBuffered: {
				type: "boolean",
				description: "Also match responses that already completed during the current document load (default true). Set false to wait only for future responses."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const u = str(args.url, "").trim();
			const mode = str(args.body, "none");
			const wantBody = mode === "text" || mode === "json";
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}let __res = null, __err = null\ntry { __res = await page.waitForResponse(${j(u)}, { timeout: ${num(args.timeout, 1e4)}, includeBuffered: ${bool(args.includeBuffered, true)} }) } catch (e) { __err = String(e && e.message || e) }\nif (!__res) {\n  const __u = await page.url().catch(() => null)\n  console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, url: __u, error: __err, hint: 'no matching response arrived during this call. Include the wait in the same ego_script as the request; a cached response produces no network event (add a cache-busting query); the url pattern is a full URL or glob/regex, not a bare substring.' }))\n} else {\n${wantBody ? `  const __body = ${mode === "json" ? "await __res.json().catch(()=>null)" : "await __res.text().catch(()=>null)"}\n` : ""}  console.log('${SENTINEL}' + JSON.stringify({ ok: true, reached: true, url: __res.url(), status: __res.status()${wantBody ? ", body: __body" : ""} }))\n}\n`;
		}
	}));
	reg(t({
		name: "ego_key",
		description: "Press a keyboard key or shortcut combination on the current page, e.g. 'Enter', 'Tab', 'Control+a', 'Escape', 'ArrowDown'. Useful for forms, shortcuts and navigation. Pass `text` to type a string of characters instead (keyboard.type).",
		parameters: {
			key: {
				type: "string",
				description: "Key or combo: 'Enter', 'Tab', 'Control+c', 'Meta+v', 'ArrowDown', 'Escape', 'F5', etc. (ignored when `text` is given)."
			},
			text: {
				type: "string",
				description: "Type this text character-by-character (keyboard.type). Use instead of `key` for typing words into the focused element."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const txt = str(args.text, "");
			const k = str(args.key, "").trim();
			if (txt !== "") return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.type(${j(txt)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))\n`;
			if (k === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_key: provide key or text to type' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.press(${j(k)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))\n`;
		}
	}));
	reg(t({
		name: "ego_hover",
		description: "Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector, xpath=..., loc=..., or ref=N for the element."
			},
			x: {
				type: "number",
				description: "Viewport x (only with y)."
			},
			y: {
				type: "number",
				description: "Viewport y (only with x)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const hasXY = typeof args.x === "number" && typeof args.y === "number";
			if (sel === "" && !hasXY) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_hover: provide selector or both x and y' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + (sel !== "" ? `${cssPierceFallback("hover", sel, "")}\n` : `await page.mouse.move(${args.x}, ${args.y})\n`) + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "ego_read_element",
		description: "Read a single element (by selector): its text, HTML, input value, an attribute, or visibility/enabled/count. Cheaper and more precise than a full-page snapshot.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the target element."
			},
			what: {
				type: "string",
				description: "What to read: 'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'."
			},
			attribute: {
				type: "string",
				description: "Attribute name when what=attribute."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "").trim();
			const what = str(args.what, "text");
			if (sel === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_read_element: selector is required' }))\n`;
			const selExpr = `page.locator(${j(sel)})`;
			let expr;
			switch (what) {
				case "html":
					expr = `await ${selExpr}.innerHTML()`;
					break;
				case "value":
					expr = `await ${selExpr}.inputValue()`;
					break;
				case "attribute":
					expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ""))})`;
					break;
				case "visible":
					expr = `await ${selExpr}.isVisible()`;
					break;
				case "enabled":
					expr = `await ${selExpr}.isEnabled()`;
					break;
				case "count":
					expr = `await ${selExpr}.count()`;
					break;
				default: expr = `await ${selExpr}.textContent()`;
			}
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const __v = ${expr}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(sel)}, value: safe(__v) }))\n`;
		}
	}));
	reg(t({
		name: "ego_select",
		description: "Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <select> element."
			},
			value: {
				type: "json",
				description: "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + selectOptionScript(str(args.selector, ""), args.value ?? "")
	}));
	reg(t({
		name: "ego_drag",
		description: "Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.",
		parameters: {
			from: {
				type: "string",
				description: "CSS selector of the element to drag from."
			},
			to: {
				type: "string",
				description: "CSS selector of the drop target (used with from)."
			},
			points: {
				type: "array",
				items: { type: "number" },
				description: "Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const pts = Array.isArray(args.points) ? args.points.map(Number).filter((n) => Number.isFinite(n)) : [];
			const hasEl = str(args.from, "") !== "" && str(args.to, "") !== "";
			if (!hasEl && pts.length < 4) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))\n`;
			const action = hasEl ? `await page.locator(${j(str(args.from, ""))}).dragTo(page.locator(${j(str(args.to, ""))}))\n` : `const __pts = ${j(pts)}\nconst __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}\nawait page.mouse.drag(__coords)\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "ego_scroll",
		description: "Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).",
		parameters: {
			deltaX: {
				type: "number",
				description: "Horizontal scroll delta (wheel) in px."
			},
			deltaY: {
				type: "number",
				description: "Vertical scroll delta (wheel) in px."
			},
			selector: {
				type: "string",
				description: "CSS selector to scroll into view (primary if given)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const hasSelector = str(args.selector, "") !== "";
			const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY);
			if (!hasSelector && !hasDelta) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_scroll: provide deltaX/deltaY or a selector' }))\n`;
			const action = hasSelector ? `await page.locator(${j(str(args.selector, ""))}).scrollIntoViewIfNeeded()\n` : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(args.deltaY, 300)})\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `const __p = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))\n`;
		}
	}));
	reg(t({
		name: "ego_upload",
		description: "Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <input type=file> element."
			},
			path: {
				type: "string",
				required: true,
				description: "Absolute path of the file(s) to upload on this machine."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).setInputFiles(${j(str(args.path, ""))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(str(args.selector, ""))} }))\n`
	}));
	reg(t({
		name: "ego_download",
		description: "Wait for a file download triggered by the current action, then return its saved path. Provide `triggerSelector` (a download button/link to click) or `triggerScript` (arbitrary JS that triggers the download). The file is captured into a temp dir and (optionally) copied to `savePath`. Returns { path, suggestedFilename, url }.",
		parameters: {
			triggerSelector: {
				type: "string",
				description: "CSS selector of the element (button/link) whose click starts the download."
			},
			triggerScript: {
				type: "string",
				description: "Full JS snippet that triggers the download (e.g. window.open() or a fetch-to-blob download); runs in the page before waiting for the download."
			},
			savePath: {
				type: "string",
				description: "Optional absolute destination path to also copy the downloaded file to. Otherwise only the temp-captured path is returned."
			},
			timeout: {
				type: "number",
				description: "How long to wait for the download in ms (default 30000)."
			},
			deliver: {
				type: "boolean",
				description: "Surface the downloaded file as a deliverable card in the conversation (default true). Set false to keep it a bare path."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.triggerSelector, "");
			const script = str(args.triggerScript, "");
			const savePath = str(args.savePath, "");
			const timeout = num(args.timeout, 3e4);
			const trigger = sel !== "" ? `await page.locator(${j(sel)}).click()\n` : script !== "" ? `await page.evaluate(() => { ${script} })\n` : "/* no trigger given — the download may be started by an earlier navigation */\n";
			const save = savePath !== "" ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)\n` : `const __final = await __dl.path().catch(()=>null)\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })\n` + trigger + "const __dl = await __dlPromise\nconst __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null\nconst __url = typeof __dl.url === 'function' ? __dl.url() : null\n" + save + `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))\n`;
		},
		deliverFiles: (args, value) => {
			const v = value;
			const file = v?.path;
			if (args.deliver === false || typeof file !== "string" || file === "") return [];
			const name = typeof v?.suggestedFilename === "string" ? v.suggestedFilename : "";
			return [{
				path: file,
				description: name === "" ? "Download" : `Download: ${name}`
			}];
		}
	}));
	reg(t({
		name: "ego_check",
		description: "Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the checkbox/radio."
			},
			checked: {
				type: "boolean",
				description: "true=check (default), false=uncheck."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const chk = bool(args.checked, true);
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).${chk ? "check" : "uncheck"}()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))\n`;
		}
	}));
	reg(t({
		name: "ego_dialog",
		description: "Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. This tool only reaches a dialog that is blocking the page RIGHT NOW — a dialog fired by an earlier ego_* call has already been auto-dismissed across the call boundary. To accept a dialog triggered by a click, do both in one call: page.once(\"dialog\", d => d.accept()); await page.click(selector). If a dialog is blocking the page, page.evaluate/snapshot calls hang until it is handled.",
		parameters: {
			accept: {
				type: "boolean",
				description: "true=Accept/OK (default), false=Dismiss/Cancel."
			},
			text: {
				type: "string",
				description: "Text to type into a prompt dialog."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const accept = bool(args.accept, true);
			const text = str(args.text, "");
			const params = `{ accept: ${accept}${text !== "" ? `, promptText: ${j(text)}` : ""} }`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))\nconst __ok = !!(__r && !__r.error)\nlet __u = null\nif (!__ok) { try { __u = await page.url() } catch {} }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null, url: __u, hint: __ok ? undefined : 'no dialog was blocking the page. Dialogs do not survive the call that triggered them — trigger and handle in one ego_script: page.once("dialog", d => d.accept()); await page.click(...)' }))\n`;
		}
	}));
	reg(t({
		name: "ego_http",
		description: "Make an HTTP request and return status + body. Default runs in the agent page's browser context (cross-origin allowed when the server's CORS permits); set `mode: server` to use Node-side fetch.server. Use to scrape an API, POST data, or hit a service. (Note: on the vendored ego-linux Windows runtime, fetch.server can hit a libuv crash, so prefer the default browser mode there.)",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to request."
			},
			method: {
				type: "string",
				description: "HTTP method, default GET."
			},
			headers: {
				type: "object",
				additionalProperties: true,
				description: "Request headers, e.g. { 'Content-Type': 'application/json' }."
			},
			body: {
				type: "string",
				description: "Request body (for POST/PUT)."
			},
			timeout: {
				type: "number",
				description: "Timeout in ms (default 20000)."
			},
			mode: {
				type: "string",
				description: "'browser' (default) runs via the page context; 'server' uses Node-side fetch.server."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const opts = {
				method: str(args.method, "GET"),
				headers: args.headers && typeof args.headers === "object" ? args.headers : {},
				timeout: num(args.timeout, 2e4)
			};
			if (str(args.body, "") !== "") opts.body = str(args.body, "");
			const mode = str(args.mode, "browser");
			return `${mode === "server" ? "" : `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}`}${SAFE_FN}const __r = await fetch.${mode === "server" ? "server" : "browser"}(${j(str(args.url, ""))}, ${j(opts)})\nconst __status = typeof __r.status !== "undefined" ? __r.status : 200\nlet __body = null\ntry { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(str(args.url, ""))} }))\n`;
		}
	}));
	reg((() => {
		return defineTool({
			name: "ego_cli",
			description: "Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim (facades page/browser/taskSpaces/site/fetch and the raw cdp() are preloaded). Use when the structured ego_* tools do not cover the task. Returns raw stdout plus the parsed console.log payload when present.",
			parameters: {
				script: {
					type: "string",
					required: true,
					description: "Full JS script body for the heredoc; ego-browser helpers are preloaded. End with console.log('@@DSH_RESULT@@' + JSON.stringify({...})) — the literal @@DSH_RESULT@@ sentinel is required. (A trailing plain JSON line is accepted as a fallback, with result.fallback=true.)"
				},
				tab: tabParam
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						stdout: {
							type: "string",
							required: true
						},
						stderr: { type: "string" },
						result: { type: "json" }
					}
				},
				render: renderText
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			execute: async (args, exec) => {
				const sessionId = callingSessionId(exec);
				pendingSessionId = sessionId;
				try {
					markEgoToolCall(sessionId);
					const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => rawScriptPrelude(cfg, str(args.tab, "")) + str(args.script, ""));
					if (!result.ok) throw new Error(result.error);
					recordPinnedTarget(cfg.targetTracker, scopedTargetKey(sessionId, cfg.defaultSpace), result.stdout);
					const stdout = stripTargetMarkers(result.stdout);
					const parsed = parseSentinel(stdout);
					return {
						ok: true,
						stdout,
						stderr: result.stderr,
						result: parsed ?? result.value ?? null
					};
				} finally {
					pendingSessionId = void 0;
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: toolCallTitle("ego_cli", args),
				kind: "other",
				rawInput: null
			})
		});
	})());
}
/** Register ego_help / ego_doctor / ego_script. */
function registerHelpAndDoctor(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_captcha",
		description: "Check the current page for a human-verification (CAPTCHA) challenge — reCAPTCHA / hCaptcha / Cloudflare / Turnstile — and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the 'ego lite - agent' browser window (it is the same live session shown in the watch panel), then continue after they have.",
		parameters: { space: {
			type: "string",
			description: "Task-space name or numeric id; defaults to the configured defaultSpace."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					detected: {
						type: "boolean",
						required: true
					},
					kind: { oneOf: [{ type: "string" }, { type: "null" }] }
				}
			},
			render: renderText
		},
		timeoutMs: 15e3,
		execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, "ego_captcha", args, async () => {
			markEgoToolCall(callingSessionId(exec));
			const result = await runWithStaleSpaceRetry(ctx, cfg, { signal: exec?.signal }, () => humanCheckScript(str(args.space, cfg.defaultSpace)));
			if (!result.ok) return {
				ok: false,
				detected: false,
				kind: null,
				error: result.error
			};
			const hc = (parseSentinel(result.stdout) || {}).humanCheck;
			return {
				ok: true,
				detected: !!hc?.detected,
				kind: hc?.kind ?? null
			};
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_captcha", args),
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "ego_wait_for_human",
		description: "Hand the page to the human for a CAPTCHA / login / 2FA / confirmation, then wait until it is cleared. Say what you need in the conversation FIRST (\"solve the challenge in the agent browser window, I will wait\"), then call this. It polls the page until the challenge disappears — and, when `selector` is given, until that selector exists — returning { needed, resolved, waitedMs }. A timeout is not an error: resolved=false means \"still not done\", so report back and call again. This is a deliberate blocking wait; do not route it through approval flows, which auto-reject under policy \"never\".",
		parameters: {
			reason: {
				type: "string",
				description: "Why the wait is needed: captcha | login | 2fa | confirm (free text is fine)."
			},
			timeoutSec: {
				type: "number",
				description: "How long to wait in seconds (default 60, clamped to 5–110)."
			},
			pollMs: {
				type: "number",
				description: "Polling interval in ms (default 1500, clamped to 250–10000)."
			},
			selector: {
				type: "string",
				description: "Optional selector that must also exist before returning (e.g. a post-login element). Omitting it waits only for the challenge to clear."
			},
			space: {
				type: "string",
				description: "Task-space name or numeric id; defaults to this session’s space."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					needed: {
						type: "boolean",
						required: true
					},
					resolved: {
						type: "boolean",
						required: true
					},
					waitedMs: {
						type: "number",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => withEgoLock(() => observeEgoTool(cfg, "ego_wait_for_human", args, async () => {
			{
				markEgoToolCall(callingSessionId(exec));
				const timeoutMs = Math.min(11e4, Math.max(5e3, num(args.timeoutSec, 60) * 1e3));
				const pollMs = Math.min(1e4, Math.max(250, num(args.pollMs, 1500)));
				const selector = str(args.selector, "");
				const spaceKey = String(str(args.space, cfg.defaultSpace));
				const build = () => {
					pendingTargetPin = cfg.targetTracker.get(spaceKey);
					pendingViewport = cfg;
					try {
						return waitForHumanScript(str(args.space, cfg.defaultSpace), {
							timeoutMs,
							pollMs,
							selector
						});
					} finally {
						pendingTargetPin = void 0;
						pendingViewport = void 0;
					}
				};
				const result = await runWithStaleSpaceRetry(ctx, cfg, exec, build);
				if (!result.ok) return {
					ok: false,
					needed: true,
					resolved: false,
					waitedMs: 0,
					reason: str(args.reason, "confirm"),
					error: result.error
				};
				recordPinnedTarget(cfg.targetTracker, spaceKey, result.stdout);
				const p = parseSentinel(result.stdout) || {};
				const resolved = !!p.resolved;
				return {
					ok: true,
					needed: !!p.needed,
					resolved,
					waitedMs: typeof p.waitedMs === "number" ? p.waitedMs : 0,
					polls: typeof p.polls === "number" ? p.polls : 0,
					detected: !!p.detected,
					kind: p.kind ?? null,
					url: p.url ?? null,
					reason: str(args.reason, "confirm"),
					...resolved ? {} : { hint: "still waiting after the timeout. Make sure the user knows which window to use (the agent browser window / watch panel), say what to click, then call ego_wait_for_human again." }
				};
			}
		})),
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_wait_for_human", args),
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "ego_help",
		description: "Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. ego_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use.",
		parameters: { topic: {
			type: "string",
			description: "Category or tool name to look up; omitted/all returns the overview index."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					topic: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async (args) => {
			const q = str(args.topic, "").trim().toLowerCase();
			const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : "";
			const text = key ? EGO_HELP_INDEX[key] : q ? `未找到 topic "${q}"。可用: ` + Object.keys(EGO_HELP_INDEX).filter((k) => k !== "overview").join(", ") + "\n\noverview: " + EGO_HELP_INDEX.overview : EGO_HELP_INDEX.overview;
			return {
				ok: true,
				topic: q || "overview",
				text
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_help", args),
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "ego_doctor",
		description: "Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					report: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 25e3,
		execute: async () => {
			const lines = [];
			lines.push(`egoBin: ${cfg.egoBin}`);
			try {
				lines.push(`egoBin exists: ${existsSync(cfg.egoBin)}`);
			} catch {
				lines.push("egoBin exists: n/a");
			}
			const egoBinCheck = validateEgoBinPath(cfg.egoBin);
			lines.push(`egoBin kind: ${egoBinCheck.ok ? "node-script" : "invalid"}`);
			if (!egoBinCheck.ok) lines.push(`egoBin warning: ${egoBinCheck.reason}`);
			const chrome = findChromeBinary();
			const configured = cfg.chromePath;
			if (configured) lines.push(`browser binary: ${configured} (from settings)`);
			else lines.push(`browser binary: ${chrome || "(none found — set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave; on Termux/Android: pkg install chromium)"}`);
			const cliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
			const chrArgs = filterArgs(cfg.chromeArgs ?? "", CHROME_BLOCKED);
			lines.push(`egoCliArgs (effective): ${cliArgs.length ? cliArgs.join(" ") : "(none)"}`);
			lines.push(`chromeArgs (effective, next cold start): ${chrArgs.length ? chrArgs.join(" ") : "(none)"}`);
			const isWin = process.platform === "win32";
			const e = process.env;
			const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
			const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
			lines.push(`state dir: ${stateDir} (exists: ${existsSync(stateDir)})`);
			const bjson = `${stateDir}/browser.json`;
			let browserReport = "browser.json: (none — agent browser not running)";
			if (existsSync(bjson)) try {
				const { readFile } = await import("node:fs/promises");
				const b = JSON.parse(await readFile(bjson, "utf8"));
				const alive = b.pid ? await (async () => {
					try {
						process.kill(b.pid, 0);
						return true;
					} catch (x) {
						return x?.code === "EPERM";
					}
				})() : false;
				browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`;
			} catch (err) {
				browserReport = `browser.json: unreadable (${err?.message})`;
			}
			lines.push(browserReport);
			const tjson = `${stateDir}/task-spaces.json`;
			if (existsSync(tjson)) try {
				const { readFile } = await import("node:fs/promises");
				const t = JSON.parse(await readFile(tjson, "utf8"));
				lines.push(`task spaces: ${(t.spaces || []).length}`);
			} catch {}
			lines.push("headless override: " + (e.EGO_LINUX_HEADLESS ? "yes (" + e.EGO_LINUX_HEADLESS + ")" : "no"));
			lines.push("npm/node: " + process.version);
			return {
				ok: true,
				report: lines.join("\n")
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: toolCallTitle("ego_doctor", args),
			kind: "other",
			rawInput: null
		})
	}));
	reg((() => {
		return defineTool({
			name: "ego_script",
			description: "Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (same runtime/API as ego_cli: page/…locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script. NOTE: `page` is the ego runtime page facade, NOT Playwright — it has goto/reload/info/url/title/locator/getBy*/waitFor*/evaluate/screenshot/snapshot/drainEvents/keyboard/mouse but no fill/click/type/press; use ego_fill/ego_click or page.locator(...). page.goto() does not return a Playwright Response; get status via ego_wait_for_response or page.info().",
			parameters: {
				script: {
					type: "string",
					required: true,
					description: "Full JS script body; end with console.log('@@DSH_RESULT@@' + JSON.stringify({...})) — the literal @@DSH_RESULT@@ sentinel is required. (A trailing plain JSON line is accepted as a fallback, with result.fallback=true.)"
				},
				timeoutMs: {
					type: "integer",
					description: "Per-run timeout in ms (default plugin grace)."
				},
				tab: tabParam
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						stdout: {
							type: "string",
							required: true
						},
						stderr: { type: "string" },
						result: { type: "json" },
						durationMs: { type: "integer" },
						timedOut: { type: "boolean" },
						error: { type: "string" }
					}
				},
				render: renderText
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			execute: async (args, exec) => {
				const sessionId = callingSessionId(exec);
				pendingSessionId = sessionId;
				try {
					markEgoToolCall(sessionId);
					const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : void 0;
					const start = Date.now();
					const result = await runWithStaleSpaceRetry(ctx, cfg, exec, () => rawScriptPrelude(cfg, str(args.tab, "")) + str(args.script, ""), timeoutMs);
					const durationMs = Date.now() - start;
					if (!result.ok) return {
						ok: false,
						stdout: stripTargetMarkers(result.stdout),
						stderr: result.stderr,
						durationMs,
						timedOut: false,
						error: result.error
					};
					recordPinnedTarget(cfg.targetTracker, scopedTargetKey(sessionId, cfg.defaultSpace), result.stdout);
					const stdout = stripTargetMarkers(result.stdout);
					const parsed = parseSentinel(stdout);
					return {
						ok: true,
						stdout,
						stderr: result.stderr,
						result: parsed ?? result.value ?? null,
						durationMs,
						timedOut: false
					};
				} finally {
					pendingSessionId = void 0;
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: toolCallTitle("ego_script", args),
				kind: "other",
				rawInput: null
			})
		});
	})());
}
//#endregion
export { Config, apply, createActiveSpaceTracker, createSessionScopedSpaceTracker, createTargetTracker, currentSessionId, deliverToSession, detectChromeMajorVersion, ensureRealTab, ensureResidentTransport, findChromeBinary, inject, isColdStartError, loginImportForced, loginImportPolicy, name, parseSentinelOrLastJson, rawScriptPrelude, recordPinnedTarget, resetResidentTransportForTests, residentDiagnostics, resolveEgoEnv, runWithStaleSpaceRetry, scopedTargetKey, selectOptionScript, shouldReapBrowser, spaceNameForSession, stripTargetMarkers, superviseResidentFailure, tabParam, viewportPrelude, waitForHumanScript };
