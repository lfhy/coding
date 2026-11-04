#!/usr/bin/env node
import { createServer } from "node:http";
import { constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
//#region third-party/host/worker/cdp-client.ts
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
				if (message.error.code !== void 0) error.code = message.error.code;
				if (message.error.data !== void 0) error.data = message.error.data;
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
//#region third-party/host/worker/capture-cdp.ts
var TargetSessions = class {
	cdp;
	sessions;
	detachDestroyed;
	destroyedHandlers;
	constructor(cdp) {
		this.cdp = cdp;
		this.sessions = /* @__PURE__ */ new Map();
		this.detachDestroyed = cdp.on("Target.targetDestroyed", (params) => {
			const { targetId } = params;
			if (!targetId) return;
			this.sessions.delete(targetId);
			for (const handler of this.destroyedHandlers || []) handler(targetId);
		});
		this.destroyedHandlers = /* @__PURE__ */ new Set();
	}
	async ensure(targetId) {
		if (this.sessions.has(targetId)) return this.sessions.get(targetId);
		const result = await this.cdp.call("Target.attachToTarget", {
			targetId,
			flatten: true
		});
		if (!result.sessionId) throw new Error(`CDP did not return a session for ${targetId}`);
		const session = {
			targetId,
			sessionId: result.sessionId,
			viewportW: null,
			viewportH: null
		};
		this.sessions.set(targetId, session);
		await Promise.allSettled([this.cdp.call("Page.enable", {}, session.sessionId), this.cdp.call("Runtime.enable", {}, session.sessionId)]);
		await this.updateViewport(targetId);
		return session;
	}
	get(targetId) {
		return this.sessions.get(targetId) || null;
	}
	onDestroyed(handler) {
		this.destroyedHandlers.add(handler);
		return () => {
			this.destroyedHandlers.delete(handler);
		};
	}
	async updateViewport(targetId) {
		const session = await this.ensure(targetId);
		try {
			const result = await this.cdp.call("Page.getLayoutMetrics", {}, session.sessionId);
			const viewport = result.cssLayoutViewport || result.cssViewport || {};
			if (Number.isFinite(viewport.clientWidth ?? viewport.width)) session.viewportW = viewport.clientWidth ?? viewport.width;
			if (Number.isFinite(viewport.clientHeight ?? viewport.height)) session.viewportH = viewport.clientHeight ?? viewport.height;
		} catch {}
		return session;
	}
	async call(targetId, method, params = {}, timeoutMs = 6e3) {
		const session = await this.ensure(targetId);
		return this.cdp.call(method, params, session.sessionId, timeoutMs);
	}
	async sendInput(targetId, payload) {
		const { type, x, y, button = "left", buttons = 0, deltaX = 0, deltaY = 0, clickCount = 0, modifiers = 0 } = payload || {};
		if (type === "mouseMoved") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			buttons
		});
		else if (type === "mousePressed" || type === "mouseReleased") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button,
			buttons,
			clickCount,
			modifiers
		});
		else if (type === "mouseWheel") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			deltaX,
			deltaY
		});
		else if (type === "insertText") {
			const text = typeof payload?.text === "string" ? payload.text : "";
			if (text === "" || text.length > 1e4) return {
				ok: false,
				error: "text must contain 1-10000 characters"
			};
			await this.call(targetId, "Input.insertText", { text });
		} else if (type === "keyDown" || type === "keyUp") {
			const key = typeof payload?.key === "string" ? payload.key.slice(0, 64) : "";
			const code = typeof payload?.code === "string" ? payload.code.slice(0, 64) : "";
			if (!key) return {
				ok: false,
				error: "key is required"
			};
			const virtualKeyCode = Number.isInteger(payload.windowsVirtualKeyCode) ? payload.windowsVirtualKeyCode : 0;
			await this.call(targetId, "Input.dispatchKeyEvent", {
				type,
				key,
				code,
				modifiers,
				autoRepeat: !!payload.autoRepeat,
				windowsVirtualKeyCode: virtualKeyCode,
				nativeVirtualKeyCode: virtualKeyCode,
				...type === "keyDown" && key === "Enter" ? {
					text: "\r",
					unmodifiedText: "\r"
				} : {}
			});
		} else return {
			ok: false,
			error: `unsupported input type: ${type}`
		};
		return { ok: true };
	}
	async dispose() {
		this.detachDestroyed?.();
		const current = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.allSettled(current.map((session) => this.cdp.call("Target.detachFromTarget", { sessionId: session.sessionId })));
	}
};
var CdpCaptureBackend = class {
	cdp;
	sessions;
	getConfig;
	onStatus;
	onJpegFrame;
	now;
	setTimer;
	clearTimer;
	current;
	pendingFrame;
	sendTimer;
	backstopTimer;
	/**
	* Screencast metadata only carries a fresh viewport size when Chrome decides
	* to include it; after a programmatic window resize the frames kept reporting
	* the old width/height, so panel clicks were mapped into a stale coordinate
	* space. Refresh the real viewport on a slow cadence while streaming.
	*/
	viewportTimer;
	lastSentAt;
	metrics;
	offFrame;
	offDestroyed;
	constructor({ cdp, sessions, getConfig, onStatus, onJpegFrame, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
		this.cdp = cdp;
		this.sessions = sessions;
		this.getConfig = getConfig;
		this.onStatus = onStatus;
		this.onJpegFrame = onJpegFrame;
		this.now = now;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.current = null;
		this.pendingFrame = null;
		this.sendTimer = null;
		this.backstopTimer = null;
		this.viewportTimer = null;
		this.lastSentAt = 0;
		this.metrics = {
			sourceFrames: 0,
			sentFrames: 0,
			droppedFrames: 0,
			ackErrors: 0
		};
		this.offFrame = cdp.on("Page.screencastFrame", (params, targetSessionId) => this.#onFrame(params, targetSessionId));
		this.offDestroyed = sessions.onDestroyed?.((targetId) => {
			if (this.current?.targetId !== targetId) return;
			this.stop("target-destroyed").then(() => this.onStatus({
				backend: "cdp",
				state: "failed",
				targetId,
				code: "capture-target-destroyed",
				message: "The watched target was closed"
			})).catch(() => {});
		});
	}
	async start({ targetId, maxWidth }) {
		await this.stop("restart");
		const session = await this.sessions.ensure(targetId);
		const config = this.getConfig();
		const effectiveMaxWidth = Math.max(320, Math.min(config.cdpMaxWidth, maxWidth && maxWidth > 0 ? Math.round(maxWidth) : config.cdpMaxWidth));
		this.current = {
			targetId,
			sessionId: session.sessionId,
			lastFrameAt: 0,
			startedAt: this.now(),
			maxWidth: effectiveMaxWidth
		};
		this.onStatus({
			backend: "cdp",
			state: "starting",
			targetId
		});
		try {
			await this.cdp.call("Page.startScreencast", {
				format: "jpeg",
				quality: config.cdpQuality,
				maxWidth: effectiveMaxWidth,
				everyNthFrame: Math.max(1, Math.min(8, Math.round(60 / Math.max(1, config.cdpFps))))
			}, session.sessionId);
			this.onStatus({
				backend: "cdp",
				state: "streaming",
				targetId,
				metrics: this.metrics
			});
			this.#scheduleBackstop();
			this.#scheduleViewportSync();
		} catch (error) {
			this.current = null;
			this.onStatus({
				backend: "cdp",
				state: "failed",
				targetId,
				code: "cdp-start-failed",
				message: error.message
			});
			throw error;
		}
	}
	async switchTarget({ targetId, maxWidth }) {
		this.onStatus({
			backend: "cdp",
			state: "switching",
			targetId
		});
		await this.start({
			targetId,
			...maxWidth === void 0 ? {} : { maxWidth }
		});
	}
	async updateConfig() {
		if (this.current) await this.start({
			targetId: this.current.targetId,
			maxWidth: this.current.maxWidth
		});
	}
	async stop(reason = "stopped") {
		this.clearTimer(this.sendTimer);
		this.clearTimer(this.backstopTimer);
		this.clearTimer(this.viewportTimer);
		this.sendTimer = null;
		this.backstopTimer = null;
		this.viewportTimer = null;
		this.pendingFrame = null;
		const current = this.current;
		this.current = null;
		if (current) {
			await this.cdp.call("Page.stopScreencast", {}, current.sessionId).catch(() => {});
			this.onStatus({
				backend: "cdp",
				state: "idle",
				targetId: null,
				message: reason,
				metrics: this.metrics
			});
		}
	}
	status() {
		return {
			backend: "cdp",
			state: this.current ? "streaming" : "idle",
			targetId: this.current?.targetId || null,
			metrics: { ...this.metrics }
		};
	}
	dispose() {
		if (this.viewportTimer) this.clearTimer(this.viewportTimer);
		this.viewportTimer = null;
		this.offFrame?.();
		this.offFrame = null;
		this.offDestroyed?.();
		this.offDestroyed = null;
	}
	async #onFrame(params, targetSessionId) {
		const current = this.current;
		if (!current || current.sessionId !== targetSessionId) return;
		this.metrics.sourceFrames += 1;
		if (params.sessionId === void 0 || params.sessionId === null) this.metrics.ackErrors += 1;
		else this.cdp.call("Page.screencastFrameAck", { sessionId: params.sessionId }, targetSessionId).catch((error) => {
			this.metrics.ackErrors += 1;
			this.onStatus({
				backend: "cdp",
				state: "streaming",
				targetId: current.targetId,
				code: "cdp-ack-failed",
				message: error.message,
				metrics: this.metrics
			});
		});
		if (!params.data) return;
		const metadata = params.metadata || {};
		const session = this.sessions.get(current.targetId);
		if (session) {
			if (Number.isFinite(metadata.visibleViewportWidth)) session.viewportW = metadata.visibleViewportWidth;
			if (Number.isFinite(metadata.visibleViewportHeight)) session.viewportH = metadata.visibleViewportHeight;
		}
		this.pendingFrame = {
			targetId: current.targetId,
			data: params.data,
			vw: session?.viewportW || null,
			vh: session?.viewportH || null,
			ts: this.now()
		};
		current.lastFrameAt = this.now();
		const minGap = 1e3 / this.getConfig().cdpFps;
		const delay = Math.max(0, minGap - (this.now() - (this.lastSentAt || 0)));
		if (delay === 0) this.#flushLatest();
		else if (!this.sendTimer) this.sendTimer = this.setTimer(() => this.#flushLatest(), delay);
		if (delay > 0) this.metrics.droppedFrames += 1;
	}
	#flushLatest() {
		this.sendTimer = null;
		const frame = this.pendingFrame;
		this.pendingFrame = null;
		if (!frame || !this.current || frame.targetId !== this.current.targetId) return;
		this.lastSentAt = this.now();
		this.metrics.sentFrames += 1;
		this.onJpegFrame(frame);
	}
	/**
	* Keep the session's viewport size in sync with the real page. Chrome does
	* not reliably attach fresh viewport metadata to every screencast frame, and
	* the window-size route resizes the window directly; without this poll the
	* frames kept advertising the pre-resize viewport and panel input was mapped
	* to the wrong coordinates.
	*/
	#scheduleViewportSync() {
		if (this.viewportTimer) this.clearTimer(this.viewportTimer);
		this.viewportTimer = this.setTimer(async () => {
			const current = this.current;
			if (!current) return;
			try {
				await this.sessions.updateViewport(current.targetId);
			} catch {}
			if (this.current === current) this.#scheduleViewportSync();
		}, 1e3);
	}
	#scheduleBackstop() {
		this.clearTimer(this.backstopTimer);
		const interval = this.getConfig().cdpBackstopIntervalMs;
		this.backstopTimer = this.setTimer(async () => {
			const current = this.current;
			if (!current) return;
			if (this.now() - current.lastFrameAt >= interval) try {
				const session = await this.sessions.updateViewport(current.targetId);
				const maxWidth = this.current?.maxWidth ?? this.getConfig().cdpMaxWidth;
				const scale = session.viewportW > maxWidth ? maxWidth / session.viewportW : 1;
				const result = await this.cdp.call("Page.captureScreenshot", {
					format: "jpeg",
					quality: this.getConfig().cdpQuality,
					captureBeyondViewport: false,
					...session.viewportW && session.viewportH ? { clip: {
						x: 0,
						y: 0,
						width: session.viewportW,
						height: session.viewportH,
						scale
					} } : {}
				}, current.sessionId);
				if (result.data) this.onJpegFrame({
					targetId: current.targetId,
					data: result.data,
					vw: session.viewportW,
					vh: session.viewportH,
					ts: this.now(),
					backstop: true
				});
			} catch {}
			this.#scheduleBackstop();
		}, interval);
	}
};
//#endregion
//#region third-party/host/worker/capture-manager.ts
var CaptureManager = class {
	backendFactories;
	getConfig;
	onStatus;
	now;
	setTimer;
	clearTimer;
	leaseTtlMs;
	idleGraceMs;
	leases;
	backend;
	backendName;
	targetId;
	generation;
	statusValue;
	transition;
	stopTimer;
	sweepTimer;
	constructor({ backendFactories, getConfig, onStatus, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, leaseTtlMs = 12e4, idleGraceMs = 1500 }) {
		this.backendFactories = backendFactories;
		this.getConfig = getConfig;
		this.onStatus = onStatus;
		this.now = now;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.leaseTtlMs = leaseTtlMs;
		this.idleGraceMs = idleGraceMs;
		this.leases = /* @__PURE__ */ new Map();
		this.backend = null;
		this.backendName = null;
		this.targetId = null;
		this.generation = 0;
		const fallbackReason = this.getConfig().ffmpegFallbackReason;
		this.statusValue = {
			backend: this.#resolvedBackend(),
			state: "idle",
			targetId: null,
			generation: 0,
			...fallbackReason ? {
				code: "ffmpeg-fallback-cdp",
				message: fallbackReason
			} : {}
		};
		this.transition = Promise.resolve();
		this.stopTimer = null;
		this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5e3, this.leaseTtlMs));
	}
	#resolvedBackend(requested) {
		const value = requested || this.getConfig().captureBackend;
		return value === "auto" ? "cdp" : value;
	}
	async startWatch({ clientId, backend, targetId, maxWidth }) {
		if (!clientId || !targetId) throw new Error("clientId and targetId are required");
		this.clearTimer(this.stopTimer);
		this.stopTimer = null;
		const requestedBackend = backend || this.getConfig().captureBackend;
		const existing = this.leases.get(clientId);
		this.leases.set(clientId, {
			clientId,
			backend: requestedBackend,
			targetId,
			expiresAt: this.now() + this.leaseTtlMs,
			...maxWidth && maxWidth > 0 ? { maxWidth } : {}
		});
		if (existing && existing.backend === requestedBackend && existing.targetId === targetId) {
			const resolved = this.#resolvedBackend(requestedBackend);
			if (this.targetId !== targetId || this.backendName && this.backendName !== resolved) return this.status();
			if (this.backend && this.backendName === resolved) return this.status();
		}
		return this.#enqueue(async () => {
			await this.#activate(this.#resolvedBackend(backend), targetId, false, maxWidth);
			return this.status();
		});
	}
	async switchWatch({ clientId, targetId, maxWidth }) {
		const lease = this.leases.get(clientId);
		if (!lease) throw new Error("watch lease not found");
		lease.targetId = targetId;
		lease.expiresAt = this.now() + this.leaseTtlMs;
		if (maxWidth && maxWidth > 0) lease.maxWidth = maxWidth;
		return this.#enqueue(async () => {
			await this.#activate(this.#resolvedBackend(lease.backend), targetId, false, maxWidth ?? lease.maxWidth);
			return this.status();
		});
	}
	async stopWatch({ clientId }) {
		this.leases.delete(clientId);
		if (this.leases.size === 0 && !this.stopTimer) this.stopTimer = this.setTimer(() => {
			this.stopTimer = null;
			if (this.leases.size === 0) this.stop("no-watchers").catch(() => {});
		}, this.idleGraceMs);
		return this.status();
	}
	async updateConfig() {
		const desired = this.#resolvedBackend();
		if (!this.backend) {
			const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
			if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId, true));
			const fallbackReason = this.getConfig().ffmpegFallbackReason;
			this.#setStatus({
				backend: desired,
				state: "idle",
				targetId: null,
				code: fallbackReason ? "ffmpeg-fallback-cdp" : null,
				message: fallbackReason || "config-updated"
			});
			return;
		}
		return this.#enqueue(() => this.#activate(desired, this.targetId, true));
	}
	async browserDisconnected() {
		return this.#enqueue(async () => {
			await this.#stopBackend("browser-disconnected");
			this.#setStatus({
				backend: this.#resolvedBackend(),
				state: "failed",
				targetId: null,
				code: "browser-disconnected",
				message: "Browser disconnected"
			});
		});
	}
	async browserConnected() {
		const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
		if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId));
	}
	async #activate(backendName, targetId, force = false, maxWidth) {
		if (!force && this.backend && this.backendName === backendName && this.targetId === targetId) return;
		await this.#stopBackend("backend-change");
		const factory = this.backendFactories[backendName];
		if (!factory) {
			const message = `${backendName} backend is unavailable`;
			this.#setStatus({
				backend: backendName,
				state: "failed",
				targetId,
				code: "capture-backend-unavailable",
				message
			});
			if (backendName === "ffmpeg" && this.backendFactories.cdp) {
				await this.#activate("cdp", targetId, true, maxWidth);
				if (this.backend && this.backendName === "cdp") this.#setStatus({
					backend: "cdp",
					code: "ffmpeg-fallback-cdp",
					message: `FFmpeg unavailable; using CDP: ${message}`
				});
			}
			return;
		}
		try {
			this.backendName = backendName;
			this.targetId = targetId;
			this.generation += 1;
			const generation = this.generation;
			const fallbackReason = backendName === "cdp" ? this.getConfig().ffmpegFallbackReason : null;
			this.#setStatus({
				backend: backendName,
				state: "starting",
				targetId,
				generation,
				code: fallbackReason ? "ffmpeg-fallback-cdp" : null,
				message: fallbackReason || null
			});
			let candidate;
			candidate = factory({
				generation,
				onStatus: (status) => {
					if (this.backend !== candidate || this.generation !== generation) return;
					this.#setStatus({
						...status,
						generation
					});
				}
			});
			this.backend = candidate;
			await candidate.start({
				targetId,
				generation,
				...maxWidth && maxWidth > 0 ? { maxWidth } : {}
			});
		} catch (error) {
			const e = error;
			const failed = this.backend;
			this.backend = null;
			if (failed) {
				await failed.stop?.("start-failed").catch(() => {});
				await Promise.resolve(failed.dispose?.()).catch(() => {});
			}
			this.#setStatus({
				backend: backendName,
				state: "failed",
				targetId,
				generation: this.generation,
				code: e.code,
				message: e.message
			});
			if (backendName === "ffmpeg" && this.backendFactories.cdp) {
				await this.#activate("cdp", targetId, true, maxWidth);
				if (this.backend && this.backendName === "cdp") this.#setStatus({
					backend: "cdp",
					code: "ffmpeg-fallback-cdp",
					message: `FFmpeg unavailable; using CDP: ${e.message}`
				});
			}
		}
	}
	async #stopBackend(reason = "stopped") {
		const backend = this.backend;
		this.backend = null;
		this.backendName = null;
		this.targetId = null;
		if (backend) {
			await backend.stop(reason);
			await backend.dispose?.();
		}
		this.#setStatus({
			backend: this.#resolvedBackend(),
			state: "idle",
			targetId: null,
			generation: this.generation,
			message: reason
		});
	}
	stop(reason = "stopped") {
		return this.#enqueue(() => this.#stopBackend(reason));
	}
	#enqueue(work) {
		const run = this.transition.then(work, work);
		this.transition = run.catch(() => {});
		return run;
	}
	status() {
		return {
			...this.statusValue,
			watchers: this.leases.size
		};
	}
	#setStatus(status) {
		this.statusValue = {
			...this.statusValue,
			...status
		};
		this.onStatus(this.status());
	}
	#sweep() {
		const now = this.now();
		for (const [clientId, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(clientId);
		if (this.leases.size === 0 && this.backend) this.stop("lease-expired").catch(() => {});
		this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5e3, this.leaseTtlMs));
	}
	async dispose() {
		this.clearTimer(this.stopTimer);
		this.clearTimer(this.sweepTimer);
		this.leases.clear();
		await this.stop("disposed");
	}
};
//#endregion
//#region third-party/host/worker/snapshot.ts
/** A single viewport PNG on the existing control session; never starts a watch. */
async function captureSnapshot(sessions, targetId, maxWidth) {
	const viewport = (await sessions.call(targetId, "Runtime.evaluate", {
		expression: "({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
		returnByValue: true
	})).result?.value;
	if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("viewport unavailable");
	const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
	const scale = Math.min(1, maxWidth / viewport.width) / dpr;
	const image = await sessions.call(targetId, "Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: false,
		clip: {
			x: viewport.x || 0,
			y: viewport.y || 0,
			width: viewport.width,
			height: viewport.height,
			scale
		}
	});
	if (!image.data) throw new Error("snapshot unavailable");
	return Buffer.from(image.data, "base64");
}
//#endregion
//#region third-party/host/worker/frame.ts
/** PNG 单帧的体积预算（base64 字符）；UI 页面通常远低于它，照片类页面超过时改用 JPEG。 */
const PNG_BUDGET = 12e5;
/** base64 只接受标准字母表，避免把任意文本当图片塞进面板。 */
const BASE64 = /^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/**
* 采集当前视口的一帧画面（默认无损 PNG，超预算时退回 JPEG），并附上 CSS 视口尺寸供 Host 换算人工输入坐标。
*
* 采集按设备像素进行：面板用 `Emulation.setDeviceMetricsOverride` 把页面像素比设成
* 显示器像素比，这里不再折算回 CSS 像素，否则 HiDPI 下 1:1 的截图会被面板放大而发虚。
*/
async function captureFrame(sessions, targetId, options) {
	const viewport = (await sessions.call(targetId, "Runtime.evaluate", {
		expression: "({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
		returnByValue: true
	})).result?.value;
	const vw = viewport?.width;
	const vh = viewport?.height;
	if (!Number.isSafeInteger(vw) || !Number.isSafeInteger(vh) || vw < 1 || vw > 8192 || vh < 1 || vh > 8192) throw new Error("viewport unavailable");
	const dpr = Number.isFinite(viewport?.dpr) && viewport?.dpr > 0 ? viewport.dpr : 1;
	const x = viewport?.x ?? 0, y = viewport?.y ?? 0;
	if (![x, y].every(Number.isFinite) || x < 0 || y < 0) throw new Error("viewport unavailable");
	const scale = Math.min(1, options.maxWidth / (vw * dpr));
	const shot = async (format, quality) => {
		const image = await sessions.call(targetId, "Page.captureScreenshot", {
			format,
			...quality === void 0 ? {} : { quality },
			captureBeyondViewport: false,
			clip: {
				x,
				y,
				width: vw,
				height: vh,
				scale
			}
		});
		if (typeof image.data !== "string" || !BASE64.test(image.data) || image.data.length === 0 || image.data.length > 28e5) throw new Error("frame unavailable");
		return image.data;
	};
	const png = await shot("png");
	const lossless = png.length <= PNG_BUDGET;
	return {
		targetId,
		data: lossless ? png : await shot("jpeg", options.quality),
		mime: lossless ? "image/png" : "image/jpeg",
		vw,
		vh,
		ts: Date.now()
	};
}
//#endregion
//#region third-party/host/worker/hover.ts
/** 浏览器指针仅允许标准形态，避免网页 CSS 注入本地资源或自定义游标。 */
const CURSORS = new Set([
	"default",
	"pointer",
	"text",
	"wait",
	"progress",
	"help",
	"move",
	"grab",
	"grabbing",
	"not-allowed",
	"crosshair",
	"cell",
	"vertical-text",
	"zoom-in",
	"zoom-out",
	"ew-resize",
	"ns-resize"
]);
/**
* 每个目标只保留最新坐标；同一目标同时只有一条 Input 命令在途。
*
* 面板、Host 与 worker 都在本机：`Input.dispatchMouseEvent` 唯一的成本是等渲染器确认
* （实测约 16ms），所以不需要额外的节流——上一确认后立刻投递最新坐标，页面拿到的移动
* 节奏与真实指针一致（约 60Hz），同时在途永远只有一条，不会排成队列。
*/
const pendingMoves = /* @__PURE__ */ new Map();
const draining = /* @__PURE__ */ new Set();
/**
* 把排队的最新坐标投递成一条真实鼠标移动，并只保留一条在途命令。
* @param sessions - 只对 Host 已核验的目标调用的 CDP 会话。
* @param targetId - 会话目录中的目标。
*/
function flushMove(sessions, targetId) {
	const next = pendingMoves.get(targetId);
	if (next === void 0 || draining.has(targetId)) return;
	pendingMoves.delete(targetId);
	draining.add(targetId);
	Promise.resolve(sessions.call(targetId, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: next.x,
		y: next.y,
		buttons: 0
	})).catch(() => {}).finally(() => {
		draining.delete(targetId);
		flushMove(sessions, targetId);
	});
}
/**
* 先向当前页面投递真实鼠标移动（合并、不等待确认），再读取指针与悬停提示。
*
* 读取只依赖坐标与元素本身，页面尚未处理完移动也能给出稳定结果；跨源子帧无法读取时保留普通指针。
* @param sessions - 只对 Host 已核验的目标调用的 CDP 会话。
* @param targetId - 会话目录中的目标。
* @param x - CSS 视口水平坐标。
* @param y - CSS 视口垂直坐标。
* @returns 页面当前的标准光标与公开链接／标题，缺失时不向面板暴露任意网页数据。
*/
async function hoverAt(sessions, targetId, x, y) {
	pendingMoves.set(targetId, {
		x,
		y
	});
	flushMove(sessions, targetId);
	const expression = `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    const link = el?.closest('a[href]');
    const style = el ? getComputedStyle(el) : null;
    return { cursor: style?.cursor === 'auto' && el ?
      (el.closest('a[href], button, [role="button"]') ? 'pointer' : el.closest('input, textarea, [contenteditable="true"]') ? 'text' : 'default')
      : style?.cursor ?? 'default', title: el?.closest('[title]')?.getAttribute('title') ?? null,
      href: link?.href ?? null };
  })()`;
	const value = (await sessions.call(targetId, "Runtime.evaluate", {
		expression,
		returnByValue: true
	})).result?.value;
	const cursor = typeof value?.cursor === "string" && CURSORS.has(value.cursor) ? value.cursor : "default";
	const title = typeof value?.title === "string" && value.title.length <= 256 ? value.title : null;
	let href = null;
	if (typeof value?.href === "string" && value.href.length <= 2048) try {
		const parsed = new URL(value.href);
		if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) href = parsed.href;
	} catch {}
	return {
		cursor,
		title,
		href
	};
}
/** 目标关闭后丢弃排队坐标，避免向已消失的页面继续投递输入。 */
function forgetHoverTarget(targetId) {
	pendingMoves.delete(targetId);
}
//#endregion
//#region third-party/host/worker/navigation.ts
/** Dispatch navigation only on an already verified page target; no implicit target selection. */
async function navigateTarget(sessions, command) {
	const targetId = command.targetId;
	if (!targetId) return false;
	switch (command.action) {
		case "navigate": return !(await sessions.call(targetId, "Page.navigate", { url: command.url })).errorText;
		case "reload":
			await sessions.call(targetId, "Page.reload");
			return true;
		case "back":
		case "forward": {
			const history = await sessions.call(targetId, "Page.getNavigationHistory");
			if (!Number.isSafeInteger(history.currentIndex) || !Array.isArray(history.entries)) return false;
			const next = history.currentIndex + (command.action === "back" ? -1 : 1);
			const entry = history.entries[next];
			if (!entry || !Number.isSafeInteger(entry.id)) return false;
			await sessions.call(targetId, "Page.navigateToHistoryEntry", { entryId: entry.id });
			return true;
		}
	}
}
//#endregion
//#region third-party/host/worker/panel-viewport.ts
/** 设备像素比按浮点比较，避免 1.5、1.25 这类比例的抖动反复重建视口。 */
function samePixelRatio(left, right) {
	return Math.abs(left - right) < .01;
}
/** 在页面所在的持久采集会话上设置面板视口；关闭页面后的失败由调用方处理。 */
async function matchPanelViewport(sessions, targetId, desired, measure) {
	const current = await measure();
	if (current !== null && current.width === desired.width && current.height === desired.height && samePixelRatio(current.pixelRatio, desired.pixelRatio)) return current;
	await sessions.call(targetId, "Emulation.setDeviceMetricsOverride", {
		width: desired.width,
		height: desired.height,
		deviceScaleFactor: desired.pixelRatio,
		mobile: false
	});
	const actual = await measure();
	return actual !== null && actual.width === desired.width && actual.height === desired.height ? actual : null;
}
//#endregion
//#region src/session-space.ts
const ID_PATTERN = /^[a-zA-Z0-9._~-]{1,128}$/u;
/** 校验跨 HTTP／工具边界的会话与页面标识。 */
function validId(value) {
	return typeof value === "string" && ID_PATTERN.test(value);
}
//#endregion
//#region src/navigation.ts
/** Host 与 ego-cast worker 共用的人工导航输入校验；任何网页地址都不能绕过 Host 会话检查。 */
/**
* 接受无凭据绝对 HTTP(S) 或严格本地 file:/// 地址，不解析 DNS 或读取文件。
* @param raw - 人工输入的原始地址。
* @returns 可直接交给 CDP 的地址；不合法时返回 null。
*/
function navigationUrl(raw) {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || /[\s\\]/u.test(raw)) return null;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol === "file:") return /^file:\/\/\/(?!\/)/iu.test(raw) && url.hostname === "" && !/%(?:2f|5c|00)/iu.test(raw) ? raw : null;
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
	const authority = raw.match(/^https?:\/\/([^/?#\\\s]+)(?:[/?#]|$)/iu)?.[1];
	return authority && !authority.includes("@") ? raw : null;
}
/**
* 拒绝多余字段；Host 可额外要求 sessionId，但只转发封闭导航字段给 worker。
* @param value - HTTP JSON 载荷。
* @param withSession - Host 路由为 true，worker 本地端点为 false。
* @returns 已清洗的命令；非法字段或地址返回 null。
*/
function parseNavigation(value, withSession = false) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const body = value;
	if (withSession && !validId(body.sessionId)) return null;
	if (![
		"navigate",
		"reload",
		"back",
		"forward"
	].includes(body.action)) return null;
	const action = body.action;
	if (Object.hasOwn(body, "targetId") && !validId(body.targetId)) return null;
	if (!Object.hasOwn(body, "targetId") && (action !== "navigate" || !withSession)) return null;
	const allowed = action === "navigate" ? [
		"targetId",
		"action",
		"url"
	] : ["targetId", "action"];
	if (withSession) allowed.push("sessionId");
	if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
	if (action === "navigate") {
		const url = navigationUrl(body.url);
		return url === null ? null : {
			...body.targetId === void 0 ? {} : { targetId: body.targetId },
			action,
			url
		};
	}
	if (Object.hasOwn(body, "url")) return null;
	return {
		targetId: body.targetId,
		action
	};
}
//#endregion
//#region third-party/upstream/src/worker/mp4-fragments.ts
const MAX_BOX_BYTES = 64 * 1024 * 1024;
var Mp4FragmentParser = class {
	onInit;
	onFragment;
	maxBoxBytes;
	buffer;
	initBoxes;
	fragmentBoxes;
	ready;
	constructor({ onInit, onFragment, maxBoxBytes = MAX_BOX_BYTES }) {
		this.onInit = onInit;
		this.onFragment = onFragment;
		this.maxBoxBytes = maxBoxBytes;
		this.buffer = Buffer.alloc(0);
		this.initBoxes = [];
		this.fragmentBoxes = [];
		this.ready = false;
	}
	push(chunk) {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		while (this.buffer.length >= 8) {
			const size = this.buffer.readUInt32BE(0);
			const type = this.buffer.toString("ascii", 4, 8);
			if (size === 1) throw new Error("64-bit MP4 boxes are not supported");
			if (size < 8 || size > this.maxBoxBytes) throw new Error(`invalid MP4 box size ${size}`);
			if (this.buffer.length < size) return;
			const box = this.buffer.subarray(0, size);
			this.buffer = this.buffer.subarray(size);
			this.#box(type, box);
		}
	}
	end() {
		if (this.buffer.length !== 0) throw new Error("truncated MP4 stream");
	}
	#box(type, box) {
		if (!this.ready) {
			if (type !== "ftyp" && type !== "moov") throw new Error(`unexpected MP4 init box ${type}`);
			this.initBoxes.push(box);
			if (type === "moov") {
				this.ready = true;
				this.onInit(Buffer.concat(this.initBoxes));
				this.initBoxes = [];
			}
			return;
		}
		if (type === "moof") {
			this.fragmentBoxes = [box];
			return;
		}
		if (type === "mdat" && this.fragmentBoxes.length) {
			this.fragmentBoxes.push(box);
			this.onFragment(Buffer.concat(this.fragmentBoxes));
			this.fragmentBoxes = [];
			return;
		}
		if (type !== "free" && type !== "sidx") throw new Error(`unexpected MP4 media box ${type}`);
	}
};
//#endregion
//#region third-party/upstream/src/worker/capture-platform.ts
const execFile$1 = promisify(execFile);
function buildCaptureInput({ platform = process.platform, env = process.env, source, fps, maxWidth, encoder }) {
	if (platform === "win32") {
		if (source.sourceType !== "window-hwnd" || !source.hwnd) {
			const error = /* @__PURE__ */ new Error("Windows FFmpeg capture requires a Chrome window handle");
			error.code = "ffmpeg-window-hwnd-missing";
			throw error;
		}
		const outputWidth = Math.max(2, Math.floor(Math.min(maxWidth, source.captureWidth) / 2) * 2);
		const outputHeight = Math.max(2, Math.floor(source.captureHeight * outputWidth / source.captureWidth / 2) * 2);
		const filters = [
			`gfxcapture=${[
				`hwnd=${source.hwnd}`,
				`max_framerate=${fps}`,
				"capture_cursor=false",
				"capture_border=false",
				"display_border=false",
				`crop_left=${source.cropLeft || 0}`,
				`crop_top=${source.cropTop || 0}`,
				`crop_right=${source.cropRight || 0}`,
				`crop_bottom=${source.cropBottom || 0}`,
				`width=${outputWidth}`,
				`height=${outputHeight}`,
				"resize_mode=scale_aspect"
			].join(":")}`,
			`fps=${fps}`,
			`setpts=N/(${fps}*TB)`
		];
		if (encoder === "libx264") filters.push("hwdownload", "format=bgra", "format=yuv420p");
		return ["-filter_complex", filters.join(",")];
	}
	if (platform === "darwin") return [
		"-f",
		"avfoundation",
		"-framerate",
		String(fps),
		"-i",
		`${source.displayIndex || 1}:none`
	];
	if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) {
		const error = /* @__PURE__ */ new Error("The bundled FFmpeg does not provide a guaranteed Wayland Portal capture input");
		error.code = "unsupported-ffmpeg-pipewire";
		throw error;
	}
	const display = env.DISPLAY || ":0";
	return [
		"-f",
		"x11grab",
		"-framerate",
		String(fps),
		"-video_size",
		`${source.captureWidth}x${source.captureHeight}`,
		"-i",
		`${display}+${source.captureX},${source.captureY}`
	];
}
function buildEncoderArgs({ encoder, fps, maxWidth, bitrateKbps = 4e3, source, platform = process.platform }) {
	const maxrateKbps = Math.round(bitrateKbps * 1.25);
	const bufsizeKbps = bitrateKbps * 2;
	const rateArgs = [
		"-b:v",
		`${bitrateKbps}k`,
		"-maxrate",
		`${maxrateKbps}k`,
		"-bufsize",
		`${bufsizeKbps}k`
	];
	if (platform === "win32" && source?.sourceType === "window-hwnd") {
		const common = [
			"-an",
			"-g",
			String(fps),
			"-bf",
			"0",
			...rateArgs
		];
		if (encoder === "h264_mf") common.push("-c:v", encoder, "-hw_encoding", "1", "-scenario", "display_remoting", "-rate_control", "ld_vbr");
		else if (encoder === "libx264") common.push("-c:v", encoder, "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p");
		else common.push("-c:v", encoder);
		return [
			...common,
			"-movflags",
			"empty_moov+default_base_moof+frag_keyframe+skip_trailer",
			"-frag_duration",
			"100000",
			"-f",
			"mp4",
			"pipe:1"
		];
	}
	const filters = [];
	if (platform === "darwin" && source) filters.push(`crop=${source.captureWidth}:${source.captureHeight}:${source.captureX}:${source.captureY}`);
	filters.push(`scale='min(${maxWidth},iw)':-2`);
	const common = [
		"-an",
		"-vf",
		filters.join(","),
		"-pix_fmt",
		"yuv420p",
		"-g",
		String(fps),
		"-keyint_min",
		String(fps),
		"-sc_threshold",
		"0",
		"-bf",
		"0",
		"-profile:v",
		"baseline",
		...rateArgs
	];
	if (encoder === "libx264") common.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency");
	else common.push("-c:v", encoder);
	return [
		...common,
		"-movflags",
		"empty_moov+default_base_moof+frag_keyframe",
		"-frag_duration",
		"500000",
		"-f",
		"mp4",
		"pipe:1"
	];
}
function selectWindowCandidate(windows, bounds, targetTitle = "") {
	const candidates = windows.filter((window) => window.hwnd && window.width > 0 && window.height > 0);
	if (candidates.length === 0) return null;
	const normalizedTitle = targetTitle.trim().toLocaleLowerCase();
	const ranked = candidates.map((window) => {
		return {
			window,
			geometryScore: bounds ? Math.abs((window.x ?? 0) - bounds.left) + Math.abs((window.y ?? 0) - bounds.top) + Math.abs(window.width - bounds.width) + Math.abs(window.height - bounds.height) : 0
		};
	}).sort((a, b) => a.geometryScore - b.geometryScore);
	const closest = ranked.filter((entry) => entry.geometryScore <= ranked[0].geometryScore + 8);
	if (normalizedTitle) {
		const titleMatch = closest.find(({ window }) => String(window.title || "").toLocaleLowerCase().includes(normalizedTitle));
		if (titleMatch) return titleMatch.window;
	}
	return ranked[0].window;
}
async function enumerateWindowsForPid(browserPid, run = execFile$1) {
	if (!Number.isInteger(browserPid) || browserPid <= 0) return [];
	const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EgoWindowProbe {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not [EgoWindowProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][EgoWindowProbe]::SetProcessDPIAware() }
$items = [System.Collections.Generic.List[object]]::new()
[void][EgoWindowProbe]::EnumWindows({
  param($hwnd, $lParam)
  $ownerPid = 0
  [void][EgoWindowProbe]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
  if ($ownerPid -eq ${browserPid} -and [EgoWindowProbe]::IsWindowVisible($hwnd)) {
    $rect = [EgoWindowProbe+RECT]::new()
    $client = [EgoWindowProbe+RECT]::new()
    $title = [Text.StringBuilder]::new(2048)
    [void][EgoWindowProbe]::GetWindowRect($hwnd, [ref]$rect)
    [void][EgoWindowProbe]::GetClientRect($hwnd, [ref]$client)
    [void][EgoWindowProbe]::GetWindowText($hwnd, $title, $title.Capacity)
    $items.Add([pscustomobject]@{
      hwnd = $hwnd.ToInt64()
      title = $title.ToString()
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
      clientWidth = $client.Right - $client.Left
      clientHeight = $client.Bottom - $client.Top
      minimized = [EgoWindowProbe]::IsIconic($hwnd)
    })
  }
  return $true
}, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($items)
`;
	const { stdout } = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64")
	], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 5e3,
		maxBuffer: 1024 * 1024
	});
	const parsed = JSON.parse(stdout.trim() || "[]");
	return Array.isArray(parsed) ? parsed : [parsed];
}
async function resolveCaptureSource({ sessions, targetId, browserPid, platform = process.platform, windowEnumerator = enumerateWindowsForPid }) {
	const value = (await sessions.call(targetId, "Runtime.evaluate", {
		expression: "({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,devicePixelRatio,title:document.title})",
		returnByValue: true
	})).result?.value || {};
	if (![
		value.screenX,
		value.screenY,
		value.outerWidth,
		value.outerHeight,
		value.innerWidth,
		value.innerHeight
	].every((v) => Number.isFinite(v))) {
		const error = /* @__PURE__ */ new Error("Browser window geometry is unavailable");
		error.code = "ffmpeg-capture-source-missing";
		throw error;
	}
	const dpr = Number(value.devicePixelRatio) || 1;
	if (platform === "win32") {
		let bounds = null;
		try {
			const window = await sessions.cdp.call("Browser.getWindowForTarget", { targetId });
			bounds = (await sessions.cdp.call("Browser.getWindowBounds", { windowId: window.windowId })).bounds || window.bounds || null;
		} catch {}
		const selected = selectWindowCandidate(await windowEnumerator(browserPid), bounds, String(value.title || ""));
		if (!selected) {
			const error = /* @__PURE__ */ new Error(`Chrome window not found for browser PID ${browserPid || "unknown"}`);
			error.code = "ffmpeg-window-not-found";
			throw error;
		}
		const targetTitle = String(value.title || "").trim().toLocaleLowerCase();
		const windowTitle = String(selected.title || "").toLocaleLowerCase();
		if (targetTitle && !windowTitle.includes(targetTitle)) {
			const error = /* @__PURE__ */ new Error("The requested target is not the visible tab in its Chrome window");
			error.code = "ffmpeg-target-not-visible";
			throw error;
		}
		if (selected.minimized) {
			const error = /* @__PURE__ */ new Error("The target Chrome window is minimized");
			error.code = "capture-source-not-visible";
			throw error;
		}
		const contentWidth = Math.max(2, Math.round(Number(value.innerWidth) * dpr));
		const contentHeight = Math.max(2, Math.round(Number(value.innerHeight) * dpr));
		const clientWidth = Number(selected.clientWidth) || contentWidth;
		const clientHeight = Number(selected.clientHeight) || contentHeight;
		const cropLeft = Math.max(0, Math.floor((clientWidth - contentWidth) / 2));
		const cropRight = Math.max(0, clientWidth - contentWidth - cropLeft);
		const cropTop = Math.max(0, clientHeight - contentHeight);
		return {
			sourceType: "window-hwnd",
			hwnd: String(selected.hwnd),
			captureX: 0,
			captureY: 0,
			captureWidth: contentWidth,
			captureHeight: contentHeight,
			cropLeft,
			cropTop,
			cropRight,
			cropBottom: 0,
			contentWidthCss: Number(value.innerWidth),
			contentHeightCss: Number(value.innerHeight),
			scaleFactor: dpr,
			minimized: !!selected.minimized
		};
	}
	const chromeX = Math.max(0, (Number(value.outerWidth) - Number(value.innerWidth)) / 2);
	const chromeY = Math.max(0, Number(value.outerHeight) - Number(value.innerHeight) - chromeX);
	return {
		sourceType: "display-crop",
		captureX: Math.round((Number(value.screenX) + chromeX) * dpr),
		captureY: Math.round((Number(value.screenY) + chromeY) * dpr),
		captureWidth: Math.max(2, Math.round(Number(value.innerWidth) * dpr)),
		captureHeight: Math.max(2, Math.round(Number(value.innerHeight) * dpr)),
		contentWidthCss: Number(value.innerWidth),
		contentHeightCss: Number(value.innerHeight),
		scaleFactor: dpr
	};
}
//#endregion
//#region third-party/upstream/src/worker/capture-ffmpeg.ts
const defaultSpawn = spawn;
function runProbe(path, argv, spawn, timeoutMs, captureOutput = false) {
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
			child = spawn(path, argv, {
				shell: false,
				windowsHide: true,
				stdio: captureOutput ? [
					"ignore",
					"pipe",
					"pipe"
				] : "ignore"
			});
		} catch {
			resolve({
				ok: false,
				output
			});
			return;
		}
		if (captureOutput) {
			child.stdout?.on("data", (chunk) => {
				output += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				output += chunk.toString();
			});
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(false);
		}, timeoutMs);
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
	});
}
async function resolveFfmpegPath(configuredPath = "", spawn = defaultSpawn) {
	const candidates = configuredPath ? [configuredPath] : ["ffmpeg"];
	for (const candidate of candidates) try {
		if (candidate !== "ffmpeg") await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		if ((await runProbe(candidate, ["-version"], spawn, 3e3)).ok) return candidate;
	} catch {}
	const error = /* @__PURE__ */ new Error(configuredPath ? `FFmpeg is not executable: ${configuredPath}` : "No usable FFmpeg executable was resolved");
	error.code = configuredPath ? "ffmpeg-not-executable" : "ffmpeg-not-installed";
	throw error;
}
async function assertCaptureSupport(path, platform = process.platform, spawn = defaultSpawn) {
	if (platform !== "win32") return;
	const result = await runProbe(path, [
		"-hide_banner",
		"-h",
		"filter=gfxcapture"
	], spawn, 3e3, true);
	if (!result.ok || !/Filter gfxcapture\b/.test(result.output)) {
		const error = /* @__PURE__ */ new Error("This FFmpeg build does not support Windows gfxcapture; configure a current FFmpeg build instead of desktop capture");
		error.code = "ffmpeg-gfxcapture-unavailable";
		throw error;
	}
}
async function selectEncoder(path, requested, spawn = defaultSpawn, capture = null, platform = process.platform) {
	if (requested === "software") return "libx264";
	const candidates = requested !== "auto" ? [requested] : platform === "win32" ? [
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"libx264"
	] : process.platform === "darwin" ? ["h264_videotoolbox", "libx264"] : [
		"h264_nvenc",
		"h264_vaapi",
		"h264_qsv",
		"libx264"
	];
	for (const encoder of candidates) {
		const encoderArgs = encoder === "h264_mf" ? [
			"-c:v",
			encoder,
			"-hw_encoding",
			"1",
			"-scenario",
			"display_remoting"
		] : ["-c:v", encoder];
		if ((await runProbe(path, [
			"-hide_banner",
			"-loglevel",
			"error",
			...platform === "win32" && capture?.source ? buildCaptureInput({
				source: capture.source,
				fps: capture.fps,
				maxWidth: capture.maxWidth,
				encoder
			}) : [
				"-f",
				"lavfi",
				"-i",
				"color=size=64x64:rate=1"
			],
			"-frames:v",
			"1",
			...encoderArgs,
			"-f",
			"null",
			"-"
		], spawn, 2e3)).ok) return encoder;
	}
	const error = /* @__PURE__ */ new Error(`FFmpeg encoder is unavailable: ${requested}`);
	error.code = "ffmpeg-encoder-unavailable";
	throw error;
}
function codecFromAvcInit(buffer) {
	const index = Buffer.from(buffer).indexOf(Buffer.from("avcC"));
	if (index < 0 || index + 8 > buffer.length) return "avc1.42E01E";
	return `avc1.${[
		buffer[index + 5],
		buffer[index + 6],
		buffer[index + 7]
	].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
var FfmpegCaptureBackend = class {
	sessions;
	browserPid;
	getConfig;
	generation;
	onStatus;
	onVideoInit;
	onVideoChunk;
	onVideoEnd;
	spawn;
	sourceResolver;
	pathResolver;
	supportProbe;
	child;
	stopping;
	termination;
	offDestroyed;
	stderr;
	targetId;
	constructor({ sessions, browserPid, getConfig, generation, onStatus, onVideoInit, onVideoChunk, onVideoEnd, spawn = defaultSpawn, sourceResolver = resolveCaptureSource, pathResolver = resolveFfmpegPath, supportProbe = assertCaptureSupport }) {
		this.sessions = sessions;
		this.browserPid = browserPid;
		this.getConfig = getConfig;
		this.generation = generation;
		this.onStatus = onStatus;
		this.onVideoInit = onVideoInit;
		this.onVideoChunk = onVideoChunk;
		this.onVideoEnd = onVideoEnd;
		this.spawn = spawn;
		this.sourceResolver = sourceResolver;
		this.pathResolver = pathResolver;
		this.supportProbe = supportProbe;
		this.child = null;
		this.stopping = null;
		this.termination = null;
		this.targetId = "";
		this.offDestroyed = sessions.onDestroyed?.((targetId) => {
			if (this.targetId !== targetId) return;
			this.onStatus({
				backend: "ffmpeg",
				state: "failed",
				targetId,
				code: "capture-target-destroyed",
				message: "The watched target was closed"
			});
			this.stop("target-destroyed").catch(() => {});
		}) ?? null;
		this.stderr = Buffer.alloc(0);
	}
	async start({ targetId }) {
		this.targetId = targetId;
		const config = this.getConfig();
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: "Resolving FFmpeg binary"
		});
		const [path, source] = await Promise.all([this.pathResolver(config.ffmpegResolvedPath || config.ffmpegPath), this.sourceResolver({
			sessions: this.sessions,
			targetId,
			browserPid: this.browserPid
		})]);
		await this.supportProbe(path);
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: "Probing H.264 encoder"
		});
		const encoder = await selectEncoder(path, config.ffmpegEncoder, this.spawn, {
			source,
			fps: config.ffmpegFps,
			maxWidth: config.ffmpegMaxWidth
		});
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: `Starting capture with ${encoder}`
		});
		const argv = [
			"-hide_banner",
			"-loglevel",
			"warning",
			...buildCaptureInput({
				source,
				fps: config.ffmpegFps,
				maxWidth: config.ffmpegMaxWidth,
				encoder
			}),
			...buildEncoderArgs({
				encoder,
				fps: config.ffmpegFps,
				maxWidth: config.ffmpegMaxWidth,
				bitrateKbps: config.ffmpegBitrateKbps,
				source
			})
		];
		const child = this.spawn(path, argv, {
			shell: false,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		let initialized = false;
		const parser = new Mp4FragmentParser({
			onInit: (buffer) => {
				if (this.child !== child) return;
				initialized = true;
				const mime = `video/mp4; codecs="${codecFromAvcInit(buffer)}"`;
				this.onVideoInit({
					targetId,
					mime,
					width: source.contentWidthCss,
					height: source.contentHeightCss,
					generation: this.generation,
					buffer
				});
				this.onStatus({
					backend: "ffmpeg",
					state: "streaming",
					targetId,
					encoder,
					mime,
					code: null,
					message: null
				});
			},
			onFragment: (buffer) => {
				if (this.child === child) this.onVideoChunk({
					generation: this.generation,
					buffer
				});
			}
		});
		child.stdout.on("data", (chunk) => {
			try {
				parser.push(chunk);
			} catch (error) {
				this.#fail(child, targetId, "video-stream-corrupt", error);
			}
		});
		child.stdout.once("end", () => {
			try {
				parser.end();
			} catch (error) {
				if (this.child === child) this.#fail(child, targetId, "video-stream-corrupt", error);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-65536);
		});
		child.once("error", (error) => this.#fail(child, targetId, "ffmpeg-not-executable", error));
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = null;
			this.onVideoEnd({ generation: this.generation });
			this.onStatus({
				backend: "ffmpeg",
				state: "failed",
				targetId,
				code: "ffmpeg-capture-failed",
				message: this.stderr.toString("utf8") || `FFmpeg exited unexpectedly (${code ?? signal})`
			});
		});
		await new Promise((resolve, reject) => {
			const finish = (callback, value) => {
				clearTimeout(timer);
				clearInterval(check);
				callback(value);
			};
			const timer = setTimeout(() => finish(reject, /* @__PURE__ */ new Error("FFmpeg did not produce an MP4 init segment within 8 seconds")), 8e3);
			const check = setInterval(() => {
				if (initialized) finish(resolve, void 0);
				else if (this.child !== child) finish(reject, /* @__PURE__ */ new Error("FFmpeg exited before the MP4 init segment"));
			}, 20);
		}).catch(async (error) => {
			await this.stop("startup-failed");
			throw error;
		});
	}
	async switchTarget({ targetId }) {
		await this.stop("target-switch");
		await this.start({ targetId });
	}
	async updateConfig() {}
	async stop(reason = "stopped") {
		if (this.termination) return this.termination;
		const child = this.child;
		this.child = null;
		if (!child) return;
		this.termination = (async () => {
			this.stopping = child;
			try {
				child.stdin?.write("q\n");
			} catch {}
			await Promise.race([new Promise((resolve) => child.once("exit", () => resolve())), new Promise((resolve) => setTimeout(() => resolve(), 1500))]);
			if (child.exitCode === null) {
				try {
					child.kill("SIGTERM");
				} catch {}
				await Promise.race([new Promise((resolve) => child.once("exit", () => resolve())), new Promise((resolve) => setTimeout(() => resolve(), 1e3))]);
			}
			if (child.exitCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
				await new Promise((resolve) => child.once("exit", () => resolve()));
			}
			this.stopping = null;
			this.onVideoEnd({
				generation: this.generation,
				reason
			});
		})();
		try {
			await this.termination;
		} finally {
			this.termination = null;
		}
	}
	status() {
		return {
			backend: "ffmpeg",
			state: this.child ? "streaming" : "idle",
			generation: this.generation
		};
	}
	#fail(child, targetId, code, error) {
		if (this.child !== child) return;
		this.onStatus({
			backend: "ffmpeg",
			state: "failed",
			targetId,
			code,
			message: error.message
		});
		this.stop(code).catch(() => {});
	}
	dispose() {
		this.offDestroyed?.();
		this.offDestroyed = null;
	}
};
/** A sanity ceiling; the OS clamps to the display anyway. */
const MAX_VIEWPORT_WIDTH = 3840;
const MAX_VIEWPORT_HEIGHT = 2160;
/** Keep a requested viewport inside a sane range (a sliver is unusable). */
function clampViewportSize(width, height) {
	return {
		width: Math.min(MAX_VIEWPORT_WIDTH, Math.max(320, Math.round(width))),
		height: Math.min(MAX_VIEWPORT_HEIGHT, Math.max(200, Math.round(height)))
	};
}
/**
* Apply a drag delta to the current viewport width.
*
* The panel's size-sync toggle maps the user's drag on the sidebar edge to a
* window-width change, not to an absolute width: the panel is much narrower
* than the browser window, so absolute mapping would shrink the window to the
* sidebar on the very first frame.
*/
function widthWithDelta(currentWidth, delta) {
	const next = Math.round(currentWidth + delta);
	return Math.min(MAX_VIEWPORT_WIDTH, Math.max(320, next));
}
/**
* Compute CDP `Browser.setWindowBounds` bounds for a desired page viewport.
*
* `left`/`top` are preserved when known so the window does not jump to another
* corner while the user drags a panel edge. `windowState: 'normal'` is always
* included: a maximized window ignores width/height until it is restored.
*/
function computeWindowBounds(viewport, chromeFrame = {
	width: 0,
	height: 0
}, current = {}) {
	const width = Math.max(320, Math.round(viewport.width + Math.max(0, chromeFrame.width)));
	const height = Math.max(200, Math.round(viewport.height + Math.max(0, chromeFrame.height)));
	return {
		...typeof current.left === "number" && Number.isFinite(current.left) ? { left: Math.round(current.left) } : {},
		...typeof current.top === "number" && Number.isFinite(current.top) ? { top: Math.round(current.top) } : {},
		width,
		height,
		windowState: "normal"
	};
}
//#endregion
//#region third-party/host/worker/ego-cast-worker.ts
const SENTINEL = "@@DSH_RESULT@@";
const HOME = homedir() || process.env.HOME || process.env.USERPROFILE || "/root";
const IS_WIN = platform() === "win32";
const STATE_HOME = IS_WIN ? process.env.LOCALAPPDATA || join(HOME, "AppData", "Local") : process.env.XDG_STATE_HOME || join(HOME, ".local", "state");
const STATE_DIR = process.env.EGO_LINUX_STATE_DIR || join(STATE_HOME, "ego-lite-linux");
const BROWSER_STATE_FILE = join(STATE_DIR, "browser.json");
const CAST_STATE_FILE = join(STATE_DIR, "ego-cast.json");
let castConfig = {
	captureBackend: "auto",
	streamProfile: "balanced",
	ffmpegFallbackReason: "",
	cdpFps: 20,
	cdpQuality: 80,
	cdpMaxWidth: 2560,
	cdpBackstopIntervalMs: 3e3,
	ffmpegFps: 20,
	ffmpegMaxWidth: 1280,
	ffmpegBitrateKbps: 4e3,
	ffmpegEncoder: "auto",
	ffmpegPath: "",
	ffmpegResolvedPath: ""
};
try {
	castConfig = {
		...castConfig,
		...JSON.parse(process.argv[2] || "{}")
	};
} catch {}
const HUMAN_PROBE_JS = `(() => {
  const el=document.querySelector('iframe[src*="recaptcha"],.g-recaptcha,.h-captcha,iframe[src*="hcaptcha"],.cf-turnstile,iframe[src*="turnstile"],iframe[src*="cloudflare"],#challenge-form,.challenge-form,#captcha,.captcha');
  if(el)return{detected:true,kind:/recaptcha/i.test(el.outerHTML)?'recaptcha':/hcaptcha/i.test(el.outerHTML)?'hcaptcha':/turnstile/i.test(el.outerHTML)?'turnstile':'captcha'};
  const h=String(location.hostname||'');
  if(h==='localhost'||h==='127.0.0.1'||h==='::1'||h==='[::1]'||/\.localhost$/.test(h))return{detected:false,kind:null};
  const t=((document.body&&document.body.innerText)||'').slice(0,120000).toLowerCase();
  return /verify (that )?you are (a )?human|your activity looks unusual|i.?m not a robot|confirm you.?re human|人机验证|安全验证|我是人类|滑块验证|拖动滑块|点击.{0,8}验证/.test(t)?{detected:true,kind:'captcha'}:{detected:false,kind:null};
})()`;
const sseClients = /* @__PURE__ */ new Set();
const videoClients = /* @__PURE__ */ new Set();
const probeCache = /* @__PURE__ */ new Map();
const frameCache = /* @__PURE__ */ new Map();
/** 导航结束后页面可能恢复原生尺寸；下一帧采集前复核目标页面仍使用面板尺寸。 */
const panelViewports = /* @__PURE__ */ new Map();
let active = null;
let currentStatus = {
	backend: "cdp",
	state: "idle",
	targetId: null,
	generation: 0,
	watchers: 0
};
let videoInit = null;
function normalizeConfig(input) {
	const next = { ...castConfig };
	const enumValue = (key, values) => {
		if (values.includes(input[key])) next[key] = input[key];
	};
	const numberValue = (key, min, max) => {
		const v = input[key];
		if (Number.isFinite(v) && v >= min && v <= max) next[key] = v;
	};
	enumValue("captureBackend", [
		"auto",
		"cdp",
		"ffmpeg"
	]);
	if (typeof input.ffmpegFallbackReason === "string") next.ffmpegFallbackReason = input.ffmpegFallbackReason;
	enumValue("streamProfile", [
		"low",
		"balanced",
		"high"
	]);
	enumValue("ffmpegEncoder", [
		"auto",
		"software",
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"h264_videotoolbox",
		"h264_vaapi"
	]);
	numberValue("cdpFps", 5, 30);
	numberValue("cdpQuality", 1, 100);
	numberValue("cdpMaxWidth", 320, 2560);
	numberValue("cdpBackstopIntervalMs", 1e3, 1e4);
	numberValue("ffmpegFps", 5, 30);
	numberValue("ffmpegMaxWidth", 320, 1920);
	numberValue("ffmpegBitrateKbps", 500, 2e4);
	if (typeof input.ffmpegPath === "string") next.ffmpegPath = input.ffmpegPath;
	if (typeof input.ffmpegResolvedPath === "string") next.ffmpegResolvedPath = input.ffmpegResolvedPath;
	return next;
}
castConfig = normalizeConfig(castConfig);
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
async function readJson(req, maxBytes = 8192) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new Error("body too large");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function writeSse(res, event, payload) {
	return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function queueSse(client, event, payload) {
	if (event === "frame") client.pendingFrame = payload;
	else client.pendingEvents.set(event, payload);
}
function sendSse(client, event, payload) {
	if (client.blocked) {
		queueSse(client, event, payload);
		return;
	}
	try {
		if (!writeSse(client.res, event, payload)) {
			client.blocked = true;
			client.res.once("drain", () => {
				client.blocked = false;
				const pendingEvents = [...client.pendingEvents];
				const pendingFrame = client.pendingFrame;
				client.pendingEvents.clear();
				client.pendingFrame = null;
				for (const [pendingEvent, pendingPayload] of pendingEvents) sendSse(client, pendingEvent, pendingPayload);
				if (pendingFrame) sendSse(client, "frame", pendingFrame);
			});
		}
	} catch {
		sseClients.delete(client);
	}
}
function broadcast(event, payload) {
	for (const client of sseClients) sendSse(client, event, payload);
}
function publishStatus(status) {
	currentStatus = {
		...currentStatus,
		...status
	};
	broadcast("capture-status", currentStatus);
}
/** 目录只引用最近一次实际采集的视口，避免缓存的布局指标与页面截图尺寸分叉。 */
function rememberFrame(frame) {
	frameCache.delete(frame.targetId);
	frameCache.set(frame.targetId, {
		frame: frame.data,
		lastActive: frame.ts,
		viewportW: frame.vw,
		viewportH: frame.vh
	});
	while (frameCache.size > 30) frameCache.delete(frameCache.keys().next().value);
}
function publishJpeg(frame) {
	rememberFrame(frame);
	broadcast("frame", frame);
}
function publishVideoInit(event) {
	videoInit = {
		generation: event.generation,
		mime: "",
		buffer: event.buffer
	};
	for (const client of videoClients) if (client.generation === event.generation) writeVideo(client, event.buffer);
}
function publishVideoChunk(event) {
	for (const client of videoClients) if (client.generation === event.generation) writeVideo(client, event.buffer);
}
function writeVideo(client, buffer) {
	if (client.blocked) {
		client.queue.push(buffer);
		if (client.queue.length > 8) {
			videoClients.delete(client);
			try {
				client.res.destroy(/* @__PURE__ */ new Error("video client is too slow"));
			} catch {}
		}
		return;
	}
	try {
		if (!client.res.write(buffer)) {
			client.blocked = true;
			client.res.once("drain", () => {
				client.blocked = false;
				const pending = client.queue.shift();
				if (pending) writeVideo(client, pending);
			});
		} else if (client.queue.length > 0) writeVideo(client, client.queue.shift());
	} catch {
		videoClients.delete(client);
	}
}
function endVideo({ generation } = {}) {
	for (const client of [...videoClients]) if (generation === void 0 || client.generation === generation) {
		videoClients.delete(client);
		try {
			client.res.end();
		} catch {}
	}
}
const manager = new CaptureManager({
	getConfig: () => castConfig,
	onStatus: publishStatus,
	backendFactories: {
		cdp: ({ onStatus }) => {
			if (!active) throw new Error("no live browser");
			return new CdpCaptureBackend({
				cdp: active.cdp,
				sessions: active.sessions,
				getConfig: () => castConfig,
				onStatus,
				onJpegFrame: publishJpeg
			});
		},
		ffmpeg: ({ generation, onStatus }) => {
			if (!active) throw new Error("no live browser");
			return new FfmpegCaptureBackend({
				sessions: active.sessions,
				browserPid: active.pid ?? 0,
				getConfig: () => castConfig,
				generation,
				onStatus,
				onVideoInit: publishVideoInit,
				onVideoChunk: publishVideoChunk,
				onVideoEnd: endVideo
			});
		}
	}
});
async function readBrowserState() {
	try {
		return JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(BROWSER_STATE_FILE, "utf8")));
	} catch {
		return null;
	}
}
async function resolveBrowser() {
	if (process.env.EGO_LINUX_CDP_URL) return {
		wsUrl: process.env.EGO_LINUX_CDP_URL,
		port: null
	};
	const state = await readBrowserState();
	if (!state?.port) return null;
	try {
		const response = await fetch(`http://127.0.0.1:${state.port}/json/version`, { signal: AbortSignal.timeout(1500) });
		const wsUrl = response.ok ? (await response.json()).webSocketDebuggerUrl : null;
		return wsUrl ? {
			port: state.port ?? null,
			wsUrl
		} : null;
	} catch {
		return null;
	}
}
async function listTargets() {
	if (!active) return [];
	return ((await active.cdp.call("Target.getTargets")).targetInfos || []).filter((target) => target.type === "page");
}
async function activeTargetId() {
	if (!active?.port) return currentStatus.targetId || null;
	try {
		const response = await fetch(`http://127.0.0.1:${active.port}/json/list`, { signal: AbortSignal.timeout(1500) });
		return (response.ok ? await response.json() : []).find((entry) => entry.type === "page")?.id || currentStatus.targetId || null;
	} catch {
		return currentStatus.targetId || null;
	}
}
async function snapshotSpaces() {
	const targets = await listTargets();
	const activeId = await activeTargetId();
	const spaces = [];
	for (const target of targets.slice(0, 30)) {
		const frame = frameCache.get(target.targetId);
		const cached = probeCache.get(target.targetId);
		if (!cached || Date.now() - cached.at > 5e3) active.sessions.call(target.targetId, "Runtime.evaluate", {
			expression: HUMAN_PROBE_JS,
			returnByValue: true,
			awaitPromise: false
		}, 3e3).then((result) => {
			const r = result;
			probeCache.set(target.targetId, {
				at: Date.now(),
				human: r.result?.value || null
			});
		}).catch(() => {});
		spaces.push({
			targetId: target.targetId,
			url: target.url,
			title: target.title,
			active: target.targetId === activeId,
			lastActive: frame?.lastActive || 0,
			viewportW: frame?.viewportW ?? null,
			viewportH: frame?.viewportH ?? null,
			humanCheck: cached?.human || null
		});
	}
	spaces.sort((a, b) => Number(b.active) - Number(a.active) || b.lastActive - a.lastActive);
	return spaces;
}
async function connectLoop() {
	while (true) {
		const browser = await resolveBrowser();
		if (!browser) {
			await sleep(3e3);
			continue;
		}
		try {
			const ws = new WebSocket(browser.wsUrl);
			await new Promise((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true });
				ws.addEventListener("error", () => reject(/* @__PURE__ */ new Error("ws error")), { once: true });
			});
			const cdp = new CdpClient(ws);
			const sessions = new TargetSessions(cdp);
			sessions.onDestroyed((targetId) => {
				panelViewports.delete(targetId);
				frameCache.delete(targetId);
				forgetHoverTarget(targetId);
			});
			active = {
				...browser,
				ws,
				cdp,
				sessions
			};
			publishStatus({ browserConnected: true });
			await manager.browserConnected();
			await new Promise((resolve) => {
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.addEventListener("error", () => resolve(), { once: true });
			});
			await manager.browserDisconnected();
			await sessions.dispose();
		} catch (error) {
			publishStatus({
				state: "failed",
				code: "browser-disconnected",
				message: error.message,
				browserConnected: false
			});
		} finally {
			active = null;
			panelViewports.clear();
			frameCache.clear();
			await sleep(2e3);
		}
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function stopSiblingWorkers() {
	const self = process.pid;
	const SCRIPT_ARG_RE = /node(?:\.exe)?"?\s+"?[^"\s]*ego-cast-worker\.mjs(?:["\s]|$)/i;
	if (IS_WIN) {
		const ps = [
			`$self = ${self}`,
			"$procs = Get-CimInstance Win32_Process",
			"$anc = @{}",
			"$cur = $procs | Where-Object { $_.ProcessId -eq $self } | Select-Object -First 1",
			"while ($cur) { $anc[[int]$cur.ProcessId] = $true; $cur = $procs | Where-Object { $_.ProcessId -eq $cur.ParentProcessId } | Select-Object -First 1 }",
			"$procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'node(\\.exe)?\"?\\s+\"?[^\"\\s]*ego-cast-worker\\.mjs([\"\\s]|$)' -and -not $anc[[int]$_.ProcessId] } | Select-Object -ExpandProperty ProcessId"
		].join("; ");
		try {
			const output = execFileSync("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(ps, "utf16le").toString("base64")
			], {
				encoding: "utf8",
				timeout: 8e3
			});
			for (const line of output.split(/\r?\n/)) if (/^\d+$/.test(line.trim())) try {
				execFileSync("taskkill", [
					"/PID",
					line.trim(),
					"/T",
					"/F"
				], { stdio: "ignore" });
			} catch {}
		} catch {}
		return;
	}
	try {
		const output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
			encoding: "utf8",
			timeout: 8e3
		});
		const rows = /* @__PURE__ */ new Map();
		for (const line of output.split("\n")) {
			const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
			if (match) rows.set(Number(match[1]), {
				ppid: Number(match[2]),
				args: match[3]
			});
		}
		const ancestors = new Set([self]);
		let pp = rows.get(self)?.ppid;
		while (pp !== void 0 && pp > 0 && !ancestors.has(pp)) {
			ancestors.add(pp);
			pp = rows.get(pp)?.ppid;
		}
		for (const [pid, row] of rows) {
			if (ancestors.has(pid)) continue;
			if (SCRIPT_ARG_RE.test(row.args)) try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	} catch {}
}
/**
* Chrome's own frame around the page, used to turn a desired PAGE viewport into
* a WINDOW size. Measured from the page because the frame height differs by
* platform/version; falls back to a conservative constant when the page cannot
* be evaluated (closed tab, navigation in flight).
*/
async function measureChromeFrame(browser, targetId) {
	try {
		const value = (await browser.sessions.call(targetId, "Runtime.evaluate", {
			expression: "({ ow: window.outerWidth, iw: window.innerWidth, oh: window.outerHeight, ih: window.innerHeight })",
			returnByValue: true
		}))?.result?.value;
		if (value && Number.isFinite(value.ow) && Number.isFinite(value.iw) && Number.isFinite(value.oh) && Number.isFinite(value.ih)) return {
			width: Math.max(0, Math.round(value.ow - value.iw)),
			height: Math.max(0, Math.round(value.oh - value.ih))
		};
	} catch {}
	return {
		width: 0,
		height: IS_WIN ? 132 : 88
	};
}
/** 测量页面实际视口与像素比；窗口尺寸被系统限制时不能仅凭 CDP 返回成功判定已铺满。 */
async function measureViewport(browser, targetId) {
	try {
		const value = (await browser.sessions.call(targetId, "Runtime.evaluate", {
			expression: "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })",
			returnByValue: true
		}))?.result?.value;
		if (value && Number.isFinite(value.w) && Number.isFinite(value.h) && value.w > 0 && value.h > 0) {
			const dpr = Number.isFinite(value.dpr) && value.dpr > 0 ? value.dpr : 1;
			return {
				width: Math.round(value.w),
				height: Math.round(value.h),
				pixelRatio: dpr
			};
		}
	} catch {}
	return null;
}
/**
* The panel's resize handles fire several requests per second while dragging.
* Measuring the window, Chrome's frame and the page viewport on every one of
* them meant ~5 CDP round-trips per step and made the drag stutter. Cache the
* expensive parts; the cached viewport is maintained by our own resizes and
* re-read from the session every couple of seconds.
*/
const windowSizeCache = /* @__PURE__ */ new Map();
const windowSizeViewportRefresh = /* @__PURE__ */ new Map();
async function main() {
	stopSiblingWorkers();
	rmSync(CAST_STATE_FILE, { force: true });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, {
				workerOk: true,
				browserConnected: !!active,
				capture: manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/spaces") return sendJson(res, 200, {
				ok: true,
				spaces: active ? await snapshotSpaces() : [],
				capture: manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/frame") {
				const browser = active;
				if (!browser) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				const targetId = url.searchParams.get("targetId");
				if (url.searchParams.size < 1 || url.searchParams.size > 3 || !targetId) return sendJson(res, 400, {
					ok: false,
					error: "targetId required"
				});
				if ([...url.searchParams.keys()].some((key) => ![
					"targetId",
					"quality",
					"maxWidth"
				].includes(key))) return sendJson(res, 400, {
					ok: false,
					error: "unsupported query"
				});
				const quality = Number(url.searchParams.get("quality") ?? castConfig.cdpQuality);
				const maxWidth = Number(url.searchParams.get("maxWidth") ?? castConfig.cdpMaxWidth);
				if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100 || !Number.isSafeInteger(maxWidth) || maxWidth < 320 || maxWidth > 2560) return sendJson(res, 400, {
					ok: false,
					error: "quality or maxWidth out of range"
				});
				if (!(await listTargets()).some((target) => target.targetId === targetId)) return sendJson(res, 409, {
					ok: false,
					error: "target is no longer available"
				});
				try {
					const requested = panelViewports.get(targetId);
					if (requested) {
						if (!await matchPanelViewport(browser.sessions, targetId, requested, () => measureViewport(browser, targetId))) return sendJson(res, 503, {
							ok: false,
							error: "viewport did not match the panel"
						});
					}
					const captured = await captureFrame(browser.sessions, targetId, {
						quality,
						maxWidth
					});
					rememberFrame(captured);
					return sendJson(res, 200, captured);
				} catch {
					return sendJson(res, 503, {
						ok: false,
						error: "frame unavailable"
					});
				}
			}
			if (req.method === "POST" && url.pathname === "/api/hover") {
				const body = await readJson(req);
				const browser = active;
				if (!browser) return sendJson(res, 409, { ok: false });
				if (typeof body.targetId !== "string" || !Number.isSafeInteger(body.x) || !Number.isSafeInteger(body.y) || !(await listTargets()).some((target) => target.targetId === body.targetId)) return sendJson(res, 400, { ok: false });
				const x = body.x, y = body.y;
				const session = browser.sessions.get(body.targetId);
				if (session?.viewportW != null && session.viewportH != null && (x < 0 || y < 0 || x >= session.viewportW || y >= session.viewportH)) return sendJson(res, 400, { ok: false });
				try {
					return sendJson(res, 200, {
						ok: true,
						...await hoverAt(browser.sessions, body.targetId, x, y)
					});
				} catch {
					return sendJson(res, 503, { ok: false });
				}
			}
			if (req.method === "GET" && url.pathname === "/api/snapshot") {
				const browser = active;
				if (!browser) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				const maxWidth = Number(url.searchParams.get("maxWidth") ?? 320);
				if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 2560) return sendJson(res, 400, {
					ok: false,
					error: "maxWidth must be an integer from 1 to 2560"
				});
				const targets = await listTargets();
				const targetId = url.searchParams.get("targetId") || await activeTargetId() || targets[0]?.targetId;
				if (!targetId || !targets.some((target) => target.targetId === targetId)) return sendJson(res, 409, {
					ok: false,
					error: "target is no longer available"
				});
				const png = await captureSnapshot(browser.sessions, targetId, maxWidth);
				res.writeHead(200, {
					"content-type": "image/png",
					"content-length": png.length,
					"cache-control": "no-store"
				});
				return res.end(png);
			}
			if (req.method === "POST" && url.pathname === "/api/window-size") {
				const body = await readJson(req);
				const requestedWidth = Number(body.width);
				const requestedDelta = Number(body.delta);
				const requestedHeight = Number(body.height);
				const requestedDy = Number(body.dy);
				const requestedAspect = Number(body.aspect);
				const requestedPixelRatio = Number(body.pixelRatio);
				const pixelRatio = Number.isFinite(requestedPixelRatio) && requestedPixelRatio >= 1 && requestedPixelRatio <= 3 ? Math.round(requestedPixelRatio * 100) / 100 : 1;
				const hasWidth = Number.isFinite(requestedWidth) && requestedWidth >= 200;
				const hasDelta = Number.isFinite(requestedDelta) && requestedDelta !== 0;
				const hasHeight = Number.isFinite(requestedHeight) && requestedHeight >= 120;
				const hasDy = Number.isFinite(requestedDy) && requestedDy !== 0;
				const hasAspect = Number.isFinite(requestedAspect) && requestedAspect > 0 && requestedAspect < 10;
				if (!hasWidth && !hasDelta && !hasHeight && !hasDy && !hasAspect) return sendJson(res, 400, {
					ok: false,
					error: "width, delta, height, dy or aspect is required"
				});
				if (!active) return sendJson(res, 409, {
					ok: false,
					code: "browser-disconnected",
					error: "no live browser"
				});
				const browser = active;
				const targetId = typeof body.targetId === "string" && body.targetId ? body.targetId : await activeTargetId();
				if (!targetId) return sendJson(res, 409, {
					ok: false,
					error: "no active target"
				});
				try {
					if (hasWidth && hasHeight && typeof body.targetId === "string") {
						const requested = {
							...clampViewportSize(requestedWidth, requestedHeight),
							pixelRatio
						};
						const viewport = await matchPanelViewport(browser.sessions, targetId, requested, () => measureViewport(browser, targetId));
						if (!viewport) return sendJson(res, 503, {
							ok: false,
							error: "viewport did not match the panel"
						});
						panelViewports.set(targetId, viewport);
						return sendJson(res, 200, {
							ok: true,
							viewport
						});
					}
					const now = Date.now();
					let cache = windowSizeCache.get(targetId);
					if (!cache || now - cache.measuredAt > 1e4) {
						const { windowId } = await browser.cdp.call("Browser.getWindowForTarget", { targetId });
						if (typeof windowId !== "number") return sendJson(res, 409, {
							ok: false,
							code: "headless",
							error: "the browser has no window (headless); use the pop-out button first"
						});
						const current = await browser.cdp.call("Browser.getWindowBounds", { windowId });
						const chromeFrame = await measureChromeFrame(browser, targetId);
						const measured = await measureViewport(browser, targetId);
						const bounds = current?.bounds ?? {};
						cache = {
							windowId,
							chromeFrame,
							viewport: measured ?? {
								width: Math.max(0, (bounds.width ?? 0) - chromeFrame.width),
								height: Math.max(0, (bounds.height ?? 0) - chromeFrame.height)
							},
							left: typeof bounds.left === "number" ? bounds.left : 0,
							top: typeof bounds.top === "number" ? bounds.top : 0,
							measuredAt: now,
							viewportAt: now
						};
						windowSizeCache.set(targetId, cache);
					} else if (now - cache.viewportAt > 2e3) {
						const session = await browser.sessions.updateViewport(targetId).catch(() => null);
						if (session && Number.isFinite(session.viewportW) && Number.isFinite(session.viewportH)) cache.viewport = {
							width: session.viewportW,
							height: session.viewportH
						};
						cache.viewportAt = now;
					}
					const currentWidth = cache.viewport.width;
					const currentHeight = cache.viewport.height;
					if ((currentWidth <= 0 || currentHeight <= 0) && !(hasWidth && hasHeight)) return sendJson(res, 409, {
						ok: false,
						error: "could not determine the current viewport size"
					});
					const width = hasWidth ? Math.round(requestedWidth) : hasDelta ? widthWithDelta(currentWidth, requestedDelta) : currentWidth;
					let height;
					if (hasHeight) height = Math.round(requestedHeight);
					else if (hasAspect) height = Math.round(width / requestedAspect);
					else if (hasDy) height = Math.round(currentHeight + requestedDy);
					else height = Math.round(width * currentHeight / currentWidth);
					const clamped = clampViewportSize(width, height);
					const bounds = computeWindowBounds(clamped, cache.chromeFrame, {
						left: cache.left,
						top: cache.top
					});
					await browser.cdp.call("Browser.setWindowBounds", {
						windowId: cache.windowId,
						bounds
					});
					cache.viewport = clamped;
					cache.left = typeof bounds.left === "number" ? bounds.left : cache.left;
					cache.top = typeof bounds.top === "number" ? bounds.top : cache.top;
					cache.measuredAt = now;
					cache.viewportAt = now;
					if (!windowSizeViewportRefresh.has(targetId)) {
						const timer = setTimeout(() => {
							windowSizeViewportRefresh.delete(targetId);
							browser.sessions.updateViewport(targetId).catch(() => {});
						}, 160);
						timer.unref?.();
						windowSizeViewportRefresh.set(targetId, timer);
					}
					return sendJson(res, 200, {
						ok: true,
						windowId: cache.windowId,
						bounds,
						viewport: clamped
					});
				} catch (error) {
					windowSizeCache.delete(targetId);
					return sendJson(res, 503, {
						ok: false,
						code: "window-resize-failed",
						error: error.message || String(error)
					});
				}
			}
			if (req.method === "GET" && url.pathname === "/api/watch/status") return sendJson(res, 200, {
				ok: true,
				...manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/video/status") return sendJson(res, 200, {
				ok: true,
				...manager.status(),
				mime: videoInit?.mime || null
			});
			if (req.method === "POST" && url.pathname === "/api/config") {
				castConfig = normalizeConfig(await readJson(req));
				await manager.updateConfig();
				return sendJson(res, 200, {
					ok: true,
					config: castConfig
				});
			}
			if (req.method === "POST" && url.pathname === "/api/watch/start") {
				if (!active) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				return sendJson(res, 200, {
					ok: true,
					...await manager.startWatch(await readJson(req))
				});
			}
			if (req.method === "POST" && url.pathname === "/api/watch/switch") return sendJson(res, 200, {
				ok: true,
				...await manager.switchWatch(await readJson(req))
			});
			if (req.method === "POST" && url.pathname === "/api/watch/stop") return sendJson(res, 200, {
				ok: true,
				...await manager.stopWatch(await readJson(req))
			});
			if (req.method === "POST" && url.pathname === "/api/navigation") {
				const command = parseNavigation(await readJson(req));
				if (!command || !command.targetId) return sendJson(res, 400, {
					ok: false,
					error: "invalid navigation request"
				});
				const browser = active;
				if (!browser) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				if (!(await listTargets()).some((target) => target.targetId === command.targetId)) return sendJson(res, 409, {
					ok: false,
					error: "target is no longer available"
				});
				try {
					const ok = await navigateTarget(browser.sessions, command);
					return sendJson(res, ok ? 200 : 409, { ok });
				} catch {
					return sendJson(res, 503, {
						ok: false,
						error: "navigation failed"
					});
				}
			}
			if (req.method === "POST" && url.pathname === "/api/input") {
				const body = await readJson(req);
				if (!active) return sendJson(res, 409, {
					ok: false,
					code: "browser-disconnected",
					error: "no live browser"
				});
				if (!body.targetId) return sendJson(res, 400, {
					ok: false,
					code: "target-required",
					error: "targetId required"
				});
				if (!(await listTargets()).some((target) => target.targetId === body.targetId)) return sendJson(res, 409, {
					ok: false,
					code: "capture-target-stale",
					error: "target is no longer available"
				});
				try {
					return sendJson(res, 200, await active.sessions.sendInput(body.targetId, body));
				} catch (error) {
					return sendJson(res, 503, {
						ok: false,
						code: "input-dispatch-failed",
						error: error.message || String(error)
					});
				}
			}
			if (req.method === "POST" && url.pathname === "/api/close") {
				const { targetId } = await readJson(req);
				if (!active || !targetId) return sendJson(res, 400, {
					ok: false,
					error: "targetId required"
				});
				await active.cdp.call("Target.closeTarget", { targetId });
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "POST" && url.pathname === "/api/flush") {
				if (!active) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				await active.cdp.call("Storage.flushCookies").catch(() => {});
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "GET" && url.pathname === "/api/stream") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
					"x-accel-buffering": "no"
				});
				res.write(":ok\n\n");
				const client = {
					res,
					blocked: false,
					pendingFrame: null,
					pendingEvents: /* @__PURE__ */ new Map()
				};
				sseClients.add(client);
				writeSse(res, "capture-status", manager.status());
				snapshotSpaces().then((spaces) => {
					if (sseClients.has(client)) writeSse(res, "spaces", spaces);
				}).catch(() => {});
				const close = () => {
					sseClients.delete(client);
				};
				req.on("close", close);
				res.on("close", close);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/video/stream") {
				const generation = Number(url.searchParams.get("generation"));
				if (!videoInit || generation !== currentStatus.generation || generation !== videoInit.generation) return sendJson(res, 409, {
					ok: false,
					error: "stale video generation",
					generation: currentStatus.generation
				});
				res.writeHead(200, {
					"content-type": "video/mp4",
					"cache-control": "no-store",
					"x-ego-generation": String(generation),
					"x-ego-backend": "ffmpeg"
				});
				const client = {
					res,
					generation,
					blocked: false,
					queue: []
				};
				videoClients.add(client);
				writeVideo(client, videoInit.buffer);
				const close = () => {
					videoClients.delete(client);
				};
				req.on("close", close);
				res.on("close", close);
				return;
			}
			sendJson(res, 404, {
				ok: false,
				error: "not found"
			});
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				error: error.message || String(error)
			});
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(CAST_STATE_FILE, JSON.stringify({
		port,
		pid: process.pid
	}, null, 2));
	const metadataTimer = setInterval(() => {
		if (!active || sseClients.size === 0) return;
		snapshotSpaces().then((spaces) => broadcast("spaces", spaces)).catch(() => {});
	}, 1e3);
	const shutdown = async () => {
		clearInterval(metadataTimer);
		await manager.dispose().catch(() => {});
		try {
			active?.ws?.close();
		} catch {}
		try {
			if (JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(CAST_STATE_FILE, "utf8"))).pid === process.pid) rmSync(CAST_STATE_FILE, { force: true });
		} catch {}
		server.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	console.log(`${SENTINEL}${JSON.stringify({
		ok: true,
		port,
		pid: process.pid
	})}`);
	connectLoop().catch((error) => console.error("ego-cast-worker: connect loop failed", error));
}
main().catch((error) => {
	console.error("ego-cast-worker failed:", error.stack || error.message);
	process.exit(1);
});
//#endregion
export {};
