/**
 * Feather Bridge — OMP extension that streams session events over a Unix socket.
 *
 * Loaded via: omp -e /path/to/feather-bridge.ts --session-dir <dir> --allow-home
 *
 * Protocol (newline-delimited JSON on a Unix domain socket):
 *
 *   Server → Client (events):
 *     {"type":"connected","sessionFile":"...","isStreaming":false}
 *     {"type":"message_start","message":{...}}
 *     {"type":"message_end","message":{...}}
 *     {"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
 *     {"type":"tool_execution_end","toolCallId":"...","toolName":"bash","result":{...},"isError":false}
 *     {"type":"agent_start"}
 *     {"type":"agent_end"}
 *     {"type":"state","isStreaming":true}
 *
 *   Client → Server (commands):
 *     {"type":"prompt","message":"do the thing"}
 *     {"type":"abort"}
 *
 * Socket path: <session-dir>/feather.sock
 * If FEATHER_BRIDGE_SOCK is set, uses that path instead.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";

export default function featherBridge(pi: ExtensionAPI) {
	const clients = new Set<net.Socket>();
	let server: net.Server | null = null;
	let sockPath: string | null = null;
	// Capture context from the first event handler invocation
	let ctx: ExtensionContext | null = null;

	function broadcast(event: object): void {
		if (clients.size === 0) return;
		const line = JSON.stringify(event) + "\n";
		for (const sock of clients) {
			try {
				sock.write(line);
			} catch {
				clients.delete(sock);
			}
		}
	}

	function startServer(socketPath: string, context: ExtensionContext): void {
		if (server) return; // Already started
		sockPath = socketPath;

		// Clean up stale socket from a previous run
		try {
			fs.unlinkSync(sockPath);
		} catch {}

		server = net.createServer((sock) => {
			clients.add(sock);

			// Send initial state on connect
			sock.write(
				JSON.stringify({
					type: "connected",
					isStreaming: !context.isIdle(),
					model: context.model?.id,
				}) + "\n",
			);

			let buffer = "";
			sock.on("data", (chunk) => {
				buffer += chunk.toString();
				let nl: number;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line) handleCommand(line, sock);
				}
			});

			sock.on("close", () => {
				clients.delete(sock);
			});

			sock.on("error", () => {
				clients.delete(sock);
			});
		});

		server.listen(sockPath, () => {
			pi.logger.debug(`[feather-bridge] Listening on ${sockPath}`);
		});

		server.on("error", (err: Error) => {
			pi.logger.debug(`[feather-bridge] Server error: ${err.message}`);
		});
	}

	function handleCommand(data: string, sock: net.Socket): void {
		let cmd: { type: string; message?: string };
		try {
			cmd = JSON.parse(data);
		} catch {
			sock.write(JSON.stringify({ type: "error", error: "invalid JSON" }) + "\n");
			return;
		}

		switch (cmd.type) {
			case "prompt":
				if (typeof cmd.message === "string") {
					pi.sendUserMessage(cmd.message);
					sock.write(JSON.stringify({ type: "ack", command: "prompt" }) + "\n");
				} else {
					sock.write(JSON.stringify({ type: "error", error: "prompt requires message string" }) + "\n");
				}
				break;

			case "abort":
				ctx?.abort();
				sock.write(JSON.stringify({ type: "ack", command: "abort" }) + "\n");
				break;

			case "get_state":
				sock.write(
					JSON.stringify({
						type: "state",
						isStreaming: ctx ? !ctx.isIdle() : false,
						hasPendingMessages: ctx?.hasPendingMessages() ?? false,
						model: ctx?.model?.id,
					}) + "\n",
				);
				break;

			default:
				sock.write(JSON.stringify({ type: "error", error: `unknown command: ${cmd.type}` }) + "\n");
		}
	}

	function cleanup(): void {
		for (const sock of clients) {
			try {
				sock.end();
			} catch {}
		}
		clients.clear();
		if (server) {
			server.close();
			server = null;
		}
		if (sockPath) {
			try {
				fs.unlinkSync(sockPath);
			} catch {}
		}
	}

	// ── Event subscriptions ──────────────────────────────────────────────

	// Start the socket server once the session is ready
	pi.on("session_start", async (_event, context) => {
		ctx = context;
		const sessionFile = context.sessionManager.getSessionFile?.();
		const sessionDir = sessionFile ? path.dirname(sessionFile) : undefined;
		const socketPath =
			process.env.FEATHER_BRIDGE_SOCK ||
			(sessionDir ? path.join(sessionDir, "feather.sock") : null);

		if (!socketPath) {
			pi.logger.debug("[feather-bridge] No session dir — bridge disabled");
			return;
		}

		startServer(socketPath, context);
	});

	pi.on("agent_start", async () => {
		broadcast({ type: "agent_start" });
		broadcast({ type: "state", isStreaming: true });
	});

	pi.on("agent_end", async (event) => {
		broadcast({
			type: "agent_end",
			messageCount: event.messages?.length ?? 0,
		});
		broadcast({ type: "state", isStreaming: false });
	});

	pi.on("turn_start", async (event) => {
		broadcast({
			type: "turn_start",
			turnIndex: event.turnIndex,
			timestamp: event.timestamp,
		});
	});

	pi.on("turn_end", async (event) => {
		broadcast({
			type: "turn_end",
			turnIndex: event.turnIndex,
		});
	});

	pi.on("message_start", async (event, context) => {
		ctx = context; // Keep context fresh
		broadcast({
			type: "message_start",
			message: serializeMessage(event.message),
		});
	});

	pi.on("message_end", async (event) => {
		broadcast({
			type: "message_end",
			message: serializeMessage(event.message),
		});
	});

	pi.on("tool_execution_start", async (event) => {
		broadcast({
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			intent: event.intent,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		broadcast({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			// result can be huge; truncate for the bridge
			result: truncateResult(event.result),
		});
	});

	pi.on("auto_compaction_start", async (event) => {
		broadcast({ type: "auto_compaction_start", reason: event.reason, action: event.action });
	});

	pi.on("auto_compaction_end", async (event) => {
		broadcast({ type: "auto_compaction_end", action: event.action, aborted: event.aborted, skipped: event.skipped });
	});

	pi.on("session_shutdown" as any, async () => {
		cleanup();
	});
}

// ── Helpers ────────────────────────────────────────────────────────────────

function serializeMessage(msg: any): object {
	if (!msg) return {};
	return {
		role: msg.role,
		content: msg.content,
		model: msg.model,
		stopReason: msg.stopReason,
		usage: msg.usage,
	};
}

function truncateResult(result: unknown): unknown {
	if (result == null) return null;
	const s = typeof result === "string" ? result : JSON.stringify(result);
	if (s.length <= 4000) return result;
	if (typeof result === "string") return result.slice(0, 4000) + "\n… (truncated)";
	return { _truncated: true, preview: s.slice(0, 4000) };
}
