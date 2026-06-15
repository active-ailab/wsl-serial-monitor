/**
 * SerialMonitorViewProvider - Creates a WebView editor tab to display serial logs.
 * 
 * Features:
 * - Real-time auto-scrolling log display
 * - Text search with highlighting
 * - Pause/Resume scrolling
 * - Clear log
 * - Connection status indicator
 * - Auto-link URLs
 * - Copy log to clipboard
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SerialPortManager } from './serialPort';

export class SerialMonitorViewProvider {
    private static readonly UI_STATE_KEY = 'serialMonitor.uiState';
    private panel: vscode.WebviewPanel | undefined;
    private context: vscode.ExtensionContext;
    private extensionUri: vscode.Uri;
    private serialManager: SerialPortManager;
    private debugLog: (message: string) => void;
    private webviewReady: boolean = false;
    private logBuffer: string[] = [];
    private logBufferByteSizes: number[] = [];
    private logBufferBytes: number = 0;
    private isConnected: boolean = false;
    private statusInfo: string = 'Disconnected';
    private pendingLogs: string[] = [];
    private flushTimer: NodeJS.Timeout | undefined;
    private lineBuffer: string = '';  // Buffer for partial lines from TCP chunks

    constructor(
        context: vscode.ExtensionContext,
        serialManager: SerialPortManager,
        debugLog?: (message: string) => void
    ) {
        this.context = context;
        this.extensionUri = context.extensionUri;
        this.serialManager = serialManager;
        this.debugLog = debugLog ?? (() => undefined);
    }

    private getMaxBufferBytes(): number {
        const raw = vscode.workspace.getConfiguration('wsl-serial-monitor')
            .get<string>('bufferSize', '2M');
        const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([KkMm])$/);

        if (!match) {
            return 2 * 1024 * 1024;
        }

        const value = Number(match[1]);
        const unit = match[2].toUpperCase();
        const multiplier = unit === 'M' ? 1024 * 1024 : 1024;
        const bytes = Math.round(value * multiplier);

        if (Number.isNaN(bytes)) {
            return 2 * 1024 * 1024;
        }

        return Math.min(Math.max(bytes, 100 * 1024), 256 * 1024 * 1024);
    }

    private getLineByteSize(line: string): number {
        return Buffer.byteLength(line, 'utf-8') + 1;
    }

    private getPersistedUiState(): Record<string, unknown> {
        return this.context.workspaceState.get<Record<string, unknown>>(
            SerialMonitorViewProvider.UI_STATE_KEY,
            {}
        );
    }

    private async persistUiState(state: unknown): Promise<void> {
        await this.context.workspaceState.update(
            SerialMonitorViewProvider.UI_STATE_KEY,
            (state && typeof state === 'object') ? state as Record<string, unknown> : {}
        );
    }

    private trimLogBuffer(maxBufferBytes: number): void {
        while (this.logBufferBytes > maxBufferBytes && this.logBuffer.length > 0) {
            this.logBuffer.shift();
            const removedBytes = this.logBufferByteSizes.shift() ?? 0;
            this.logBufferBytes = Math.max(0, this.logBufferBytes - removedBytes);
        }
    }

    private createSendBuffer(text: string, hex: boolean, appendNewline: boolean): Buffer {
        if (hex) {
            const normalized = text.replace(/^0x/i, '').replace(/\s+/g, '');
            if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
                throw new Error('Invalid HEX input. Use an even number of hex characters.');
            }
            const buffer = Buffer.from(normalized, 'hex');
            return appendNewline ? Buffer.concat([buffer, Buffer.from('\r\n', 'utf-8')]) : buffer;
        }

        const payload = appendNewline ? `${text}\r\n` : text;
        return Buffer.from(payload, 'utf-8');
    }

    revive(panel: vscode.WebviewPanel): void {
        if (this.panel) {
            panel.dispose();
            return;
        }
        this.attachPanel(panel);
        panel.webview.html = this.getWebviewContent();

        setTimeout(() => {
            if (!this.webviewReady && this.panel) {
                this.debugLog('[WEBVIEW] Ready timeout — forcing');
                this.webviewReady = true;
                this.panel.webview.postMessage({
                    type: 'status',
                    connected: this.isConnected,
                    info: this.statusInfo
                });
                if (this.logBuffer.length > 0) {
                    this.panel.webview.postMessage({
                        type: 'snapshot',
                        lines: this.getLogLines()
                    });
                }
                this.flushPendingLogs();
            }
        }, 3000);
    }

    private attachPanel(panel: vscode.WebviewPanel): void {
        this.panel = panel;
        this.webviewReady = false;
        this.pendingLogs = [];
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'ready':
                        this.webviewReady = true;
                        this.panel?.webview.postMessage({
                            type: 'status',
                            connected: this.isConnected,
                            info: this.statusInfo
                        });
                        if (this.logBuffer.length > 0) {
                            this.panel?.webview.postMessage({
                                type: 'snapshot',
                                lines: this.getLogLines()
                            });
                        }
                        this.flushPendingLogs();
                        break;
                    case 'clear':
                        this.logBuffer = [];
                        this.logBufferByteSizes = [];
                        this.logBufferBytes = 0;
                        this.pendingLogs = [];
                        this.lineBuffer = '';
                        break;
                    case 'copy':
                        await vscode.env.clipboard.writeText(this.logBuffer.join('\n'));
                        vscode.window.showInformationMessage('Log copied to clipboard.');
                        break;
                    case 'send':
                        if (!this.serialManager.isConnected()) {
                            vscode.window.showWarningMessage('No serial port is open. Connect before sending.');
                            break;
                        }
                        try {
                            const data = this.createSendBuffer(
                                String(message.text ?? ''),
                                Boolean(message.hex),
                                Boolean(message.appendNewline)
                            );
                            await this.serialManager.send(data);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Send failed: ${err.message}`);
                        }
                        break;
                    case 'connect':
                        await vscode.commands.executeCommand('wsl-serial-monitor.open');
                        break;
                    case 'disconnect':
                        await vscode.commands.executeCommand('wsl-serial-monitor.close');
                        break;
                    case 'requestStatus':
                        this.panel?.webview.postMessage({
                            type: 'status',
                            connected: this.isConnected,
                            info: this.statusInfo
                        });
                        if (this.logBuffer.length > 0) {
                            this.panel?.webview.postMessage({
                                type: 'snapshot',
                                lines: this.getLogLines()
                            });
                        }
                        break;
                    case 'save':
                        vscode.commands.executeCommand('wsl-serial-monitor.saveLog');
                        break;
                    case 'persistUiState':
                        await this.persistUiState(message.state);
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        const attachedPanel = panel;
        this.panel.onDidDispose(
            () => {
                if (this.panel === attachedPanel) {
                    this.panel = undefined;
                    this.webviewReady = false;
                }
            },
            null,
            this.context.subscriptions
        );

        this.panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible) {
                    if (!this.webviewReady) {
                        this.panel!.webview.html = this.getWebviewContent();
                    } else {
                        this.panel?.webview.postMessage({
                            type: 'status',
                            connected: this.isConnected,
                            info: this.statusInfo
                        });
                        if (this.logBuffer.length > 0) {
                            this.panel?.webview.postMessage({
                                type: 'snapshot',
                                lines: this.getLogLines()
                            });
                        }
                    }
                }
            },
            null,
            this.context.subscriptions
        );
    }

    /**
     * Show the WebView panel (create if needed).
     */
    show(): void {
        if (this.panel) {
            if (this.webviewReady) {
                this.panel.reveal(vscode.ViewColumn.Two);
                return;
            }
            this.panel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'wslSerialMonitor',
            '🔌 Serial Monitor',
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );

        this.attachPanel(panel);
        panel.webview.html = this.getWebviewContent();

        setTimeout(() => {
            if (!this.webviewReady && this.panel) {
                this.debugLog('[WEBVIEW] Ready timeout — forcing');
                this.webviewReady = true;
                this.panel.webview.postMessage({
                    type: 'status',
                    connected: this.isConnected,
                    info: this.statusInfo
                });
                if (this.logBuffer.length > 0) {
                    this.panel.webview.postMessage({
                        type: 'snapshot',
                        lines: this.getLogLines()
                    });
                }
                this.flushPendingLogs();
            }
        }, 3000);
    }

    /**
     * Append a log line. Batches updates for performance.
     */
    /**
     * Append raw data chunk from serial port. Splits strictly on \n.
     * Data arrives with \n from serialPort.ts (complete lines).
     * Partial lines (without \n) are buffered until the next chunk.
     */
    appendLog(data: string): void {
        const maxBufferBytes = this.getMaxBufferBytes();

        // Accumulate into line buffer
        this.lineBuffer += data;

        // Split strictly on \n — only complete lines get displayed
        let nlIdx: number;
        while ((nlIdx = this.lineBuffer.indexOf('\n')) !== -1) {
            const line = this.lineBuffer.substring(0, nlIdx).replace(/\r$/, '');
            this.lineBuffer = this.lineBuffer.substring(nlIdx + 1);
            const lineByteSize = this.getLineByteSize(line);

            this.logBuffer.push(line);
            this.logBufferByteSizes.push(lineByteSize);
            this.logBufferBytes += lineByteSize;
            this.pendingLogs.push(line);
        }

        // Remaining partial data stays in lineBuffer for next chunk
        this.trimLogBuffer(maxBufferBytes);

        // Flush at 60fps (16ms) for smoother updates
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushPendingLogs();
            }, 16);
        }
    }

    /**
     * Send a debug message to the WebView counter area.
     */
    sendDebug(text: string): void {
        this.panel?.webview.postMessage({ type: 'debug', text });
    }

    /**
     * Get all log lines for saving to file.
     */
    getLogLines(): string[] {
        return [...this.logBuffer];
    }

    /**
     * Flush pending log lines to the WebView.
     */
    private flushPendingLogs(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }

        if (this.pendingLogs.length > 0 && this.panel && this.webviewReady) {
            this.panel.webview.postMessage({
                type: 'log',
                lines: this.pendingLogs
            });
            this.pendingLogs = [];
        }

        if (this.pendingLogs.length > 0 && !this.webviewReady) {
            this.debugLog(`[WEBVIEW] Holding log batch until ready lines=${this.pendingLogs.length}`);
        }
    }

    /**
     * Clear the log view.
     */
    clearLog(): void {
        this.logBuffer = [];
        this.logBufferByteSizes = [];
        this.logBufferBytes = 0;
        this.pendingLogs = [];
        this.lineBuffer = '';
        if (this.panel && this.webviewReady) {
            this.debugLog('[WEBVIEW] Sent clear');
            this.panel.webview.postMessage({ type: 'clear' });
        }
    }

    /**
     * Update connection status in the WebView.
     */
    setStatus(connected: boolean, info: string): void {
        this.isConnected = connected;
        this.statusInfo = info;
        if (this.panel && this.webviewReady) {
            this.debugLog(`[WEBVIEW] Sent live status connected=${connected} info=${info}`);
            this.panel.webview.postMessage({
                type: 'status',
                connected,
                info
            });
        } else {
            this.debugLog(`[WEBVIEW] Deferred live status connected=${connected} info=${info}`);
        }
    }

    /**
     * Format a timestamp.
     */
    private formatTimestamp(date: Date): string {
        const h = String(date.getHours()).padStart(2, '0');
        const m = String(date.getMinutes()).padStart(2, '0');
        const s = String(date.getSeconds()).padStart(2, '0');
        const ms = String(date.getMilliseconds()).padStart(3, '0');
        return `${h}:${m}:${s}.${ms}`;
    }

    /**
     * Generate the full WebView HTML content.
     */
    private getWebviewContent(): string {
        const scriptUri = this.panel?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'serial-monitor.js')
        );
        const persistedUiStateJson = JSON.stringify(this.getPersistedUiState()).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Serial Monitor</title>
    <style>
        :root {
            --bg-primary: #1e1e1e;
            --bg-secondary: #252526;
            --bg-toolbar: #2d2d2d;
            --text-primary: #d4d4d4;
            --text-secondary: #808080;
            --text-accent: #569cd6;
            --border-color: #3c3c3c;
            --status-connected: #4ec9b0;
            --status-disconnected: #f44747;
            --search-highlight: #e8b73066;
            --search-active: #e8b730aa;
            --scrollbar-thumb: #424242;
            --input-bg: #3c3c3c;
            --input-border: #555;
            --btn-bg: #0e639c;
            --btn-hover: #1177bb;
            --danger-bg: #c72e2e;
            --danger-hover: #d63636;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
            font-size: 13px;
            background: var(--bg-primary);
            color: var(--text-primary);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: var(--bg-toolbar);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
            flex-wrap: wrap;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .toolbar-separator {
            width: 1px;
            height: 20px;
            background: var(--border-color);
            margin: 0 4px;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            padding: 4px 10px;
            border-radius: 4px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
        }

        .data-counter {
            font-size: 10px;
            color: var(--text-secondary);
            padding: 1px 6px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 3px;
            font-family: monospace;
            white-space: nowrap;
            flex-shrink: 0;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--status-disconnected);
            transition: background 0.3s;
        }

        .status-dot.connected {
            background: var(--status-connected);
            box-shadow: 0 0 6px var(--status-connected);
        }

        .compact-label {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            font-size: 11px;
            color: var(--text-secondary);
            cursor: pointer;
            white-space: nowrap;
            flex-shrink: 0;
            padding: 0 4px;
        }

        .compact-label input[type="checkbox"] {
            margin: 0;
            width: 13px;
            height: 13px;
        }

        .btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--text-primary);
            font-size: 12px;
            cursor: pointer;
            transition: background 0.15s;
            white-space: nowrap;
        }

        .btn:hover { background: var(--btn-bg); border-color: var(--btn-bg); }
        .btn:active { opacity: 0.8; }

        .btn-primary {
            background: var(--btn-bg);
            border-color: var(--btn-bg);
        }
        .btn-primary:hover { background: var(--btn-hover); }

        .btn-danger {
            background: var(--danger-bg);
            border-color: var(--danger-bg);
        }
        .btn-danger:hover { background: var(--danger-hover); }

        .btn.paused {
            background: var(--search-active);
            border-color: #e8b730;
            color: #000;
        }

        .search-box {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-left: auto;
        }

        .search-input {
            padding: 4px 8px;
            border: 1px solid var(--input-border);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--text-primary);
            font-size: 12px;
            font-family: inherit;
            width: 200px;
            outline: none;
        }

        .search-input:focus {
            border-color: var(--btn-bg);
        }

        .search-count {
            font-size: 11px;
            color: var(--text-secondary);
            min-width: 60px;
            text-align: center;
        }

        .log-container {
            flex: 1;
            overflow: hidden;
            position: relative;
        }

        .log-content {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow-y: auto;
            overflow-x: auto;
            padding: 8px 12px;
            white-space: pre;
            word-wrap: normal;
            overflow-wrap: normal;
            line-height: 1.6;
            font-size: 13px;
            tab-size: 4;
        }

        .log-content::-webkit-scrollbar { width: 10px; height: 10px; }
        .log-content::-webkit-scrollbar-track { background: var(--bg-primary); }
        .log-content::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 5px; }
        .log-content::-webkit-scrollbar-thumb:hover { background: #555; }
        .log-content::-webkit-scrollbar-corner { background: var(--bg-primary); }

        .log-line {
            min-height: 1.6em;
            border-bottom: 1px solid transparent;
            white-space: pre;
        }

        .log-line:hover { background: rgba(255,255,255,0.03); }
        .log-line .timestamp { color: var(--text-secondary); user-select: none; }
        .log-line .data { color: var(--text-primary); }

        /* Virtual scrolling styles */
        .log-line[style*="position: absolute"] {
            box-sizing: border-box;
            padding: 0 8px;
        }

        .log-line.search-match-line {
            background: var(--search-active);
            outline: 1px solid #e8b730;
        }

        #virtualScrollSpacer {
            pointer-events: none;
        }

        .search-match { background: var(--search-highlight); border-radius: 2px; padding: 0 1px; }
        .search-match.active { background: var(--search-active); outline: 1px solid #e8b730; }

        .input-bar {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: var(--bg-toolbar);
            border-top: 1px solid var(--border-color);
            flex-shrink: 0;
        }

        .input-bar.visible { display: flex; }

        .input-panel {
            display: flex;
            flex-direction: column;
            gap: 8px;
            flex: 1;
            min-width: 0;
        }

        .input-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex-wrap: wrap;
        }

        .input-bar input {
            flex: 1;
            padding: 6px 10px;
            border: 1px solid var(--input-border);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--text-primary);
            font-size: 13px;
            font-family: inherit;
            outline: none;
        }

        .input-bar input:focus { border-color: var(--btn-bg); }

        .quick-command-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex-wrap: wrap;
        }

        .quick-command-editor {
            display: none;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex-wrap: wrap;
        }

        .quick-command-editor.visible {
            display: flex;
        }

        .quick-command-list {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
            min-width: 0;
            flex: 1;
        }

        .quick-command-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            max-width: 240px;
            padding: 3px 4px 3px 8px;
            border: 1px solid var(--border-color);
            border-radius: 999px;
            background: var(--input-bg);
        }

        .quick-command-chip button {
            border: none;
            background: transparent;
            color: var(--text-primary);
            cursor: pointer;
            font-size: 11px;
            line-height: 1;
        }

        .quick-command-send {
            max-width: 190px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding: 0 2px;
        }

        .quick-command-remove {
            color: var(--text-secondary) !important;
            width: 18px;
            height: 18px;
            border-radius: 50%;
        }

        .quick-command-remove:hover {
            background: var(--danger-bg) !important;
            color: #fff !important;
        }

        .quick-command-empty {
            font-size: 11px;
            color: var(--text-secondary);
        }

        .input-inline-label {
            font-size: 11px;
            color: var(--text-secondary);
            display: inline-flex;
            align-items: center;
            gap: 4px;
            white-space: nowrap;
        }

        .paused-indicator {
            display: none;
            position: absolute;
            bottom: 8px;
            left: 50%;
            transform: translateX(-50%);
            padding: 4px 16px;
            background: rgba(232, 183, 48, 0.9);
            color: #000;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            z-index: 10;
            cursor: pointer;
        }

        .paused-indicator.visible { display: block; }

        .welcome {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-secondary);
            text-align: center;
            gap: 16px;
        }

        .welcome .icon { font-size: 48px; opacity: 0.5; }
        .welcome .hint { font-size: 13px; line-height: 1.8; }
        .welcome .hint code { background: var(--input-bg); padding: 2px 6px; border-radius: 3px; font-size: 12px; }

        .hidden { display: none !important; }

        .btn-regex {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 2px 6px;
            border: 1px solid var(--input-border);
            border-radius: 3px;
            background: var(--input-bg);
            color: var(--text-secondary);
            font-size: 11px;
            font-family: monospace;
            font-weight: bold;
            cursor: pointer;
            flex-shrink: 0;
            transition: background 0.15s, color 0.15s, border-color 0.15s;
        }

        .btn-regex:hover { border-color: var(--btn-bg); color: var(--text-primary); }

        .btn-regex.active {
            background: var(--btn-bg);
            border-color: var(--btn-bg);
            color: #fff;
        }

        .filter-bar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 3px 8px;
            background: var(--bg-toolbar);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
            flex-wrap: nowrap;
            min-height: 30px;
            overflow-x: auto;
            overflow-y: hidden;
        }

        .filter-bar::-webkit-scrollbar { height: 4px; }
        .filter-bar::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

        .filter-bar-label { font-size: 11px; color: var(--text-secondary); white-space: nowrap; flex-shrink: 0; }

        .filter-entries {
            display: flex;
            align-items: center;
            gap: 3px;
            flex-wrap: nowrap;
            flex: 1;
            min-width: 0;
            overflow-x: auto;
            overflow-y: hidden;
        }

        .filter-entries::-webkit-scrollbar { height: 0; }

        .filter-entry {
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 1px 4px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 3px;
            font-size: 11px;
            flex-shrink: 0;
            white-space: nowrap;
        }

        .filter-entry.disabled { opacity: 0.4; }

        .filter-entry input[type="text"] {
            width: 100px;
            padding: 1px 4px;
            border: 1px solid var(--input-border);
            border-radius: 2px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 11px;
            font-family: inherit;
            outline: none;
        }

        .filter-entry input[type="text"]:focus { border-color: var(--btn-bg); width: 140px; }

        .filter-entry input[type="color"] {
            width: 18px; height: 18px; padding: 0;
            border: 1px solid var(--input-border); border-radius: 2px;
            background: none; cursor: pointer; flex-shrink: 0;
        }

        .filter-entry input[type="checkbox"] { cursor: pointer; margin: 0; width: 13px; height: 13px; flex-shrink: 0; }

        .filter-entry .filter-remove {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px; height: 16px;
            border: none; border-radius: 2px;
            background: transparent; color: var(--text-secondary);
            font-size: 12px; cursor: pointer; padding: 0; line-height: 1; flex-shrink: 0;
        }

        .filter-entry .filter-remove:hover { background: var(--danger-bg); color: #fff; }

        .btn-filter-add {
            display: inline-flex; align-items: center; gap: 2px;
            padding: 2px 8px; border: 1px dashed var(--input-border); border-radius: 3px;
            background: transparent; color: var(--text-secondary); font-size: 11px;
            cursor: pointer; white-space: nowrap; flex-shrink: 0;
        }

        .btn-filter-add:hover { border-color: var(--btn-bg); color: var(--text-primary); background: rgba(14, 99, 156, 0.1); }

        .btn-filter-clear {
            padding: 2px 6px; border: 1px solid var(--input-border); border-radius: 3px;
            background: var(--input-bg); color: var(--text-secondary); font-size: 10px; cursor: pointer; flex-shrink: 0;
        }

        .btn-filter-clear:hover { border-color: var(--danger-bg); color: var(--text-primary); }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-group">
            <div class="status-indicator">
                <span class="status-dot" id="statusDot"></span>
                <span id="statusText">Disconnected</span>
            </div>
        </div>
        <div class="toolbar-separator"></div>
        <div class="toolbar-group">
            <button class="btn btn-primary" id="btnConnect" onclick="handleConnect()">⚡ Connect</button>
            <button class="btn btn-danger hidden" id="btnDisconnect" onclick="handleDisconnect()">⏹ Disconnect</button>
        </div>
        <div class="toolbar-separator"></div>
        <div class="toolbar-group">
            <button class="btn" id="btnPause" onclick="togglePause()">⏸ Pause</button>
            <button class="btn" onclick="clearLog()">🗑 Clear</button>
            <button class="btn" onclick="copyLog()">📋 Copy</button>
            <button class="btn" onclick="saveLog()">💾 Save</button>
            <button class="btn" id="btnToggleInput" onclick="toggleInput()">✏️ Send</button>
            <button class="btn" id="btnAutoScroll" onclick="toggleAutoScroll()">⬇ Auto-scroll: ON</button>
            <label class="compact-label" title="Show timestamp on each line">
                <input type="checkbox" id="chkTimestamp" onchange="toggleTimestamp()" /> ⏱
            </label>
            <span class="data-counter" id="dataCounter">0</span>
        </div>
        <div class="search-box">
            <input type="text" class="search-input" id="searchInput" placeholder="Search logs..." oninput="onSearchInput()" />
            <button class="btn-regex" id="btnSearchRegex" onclick="toggleSearchRegex()" title="Regex search">.*</button>
            <span class="search-count" id="searchCount"></span>
            <button class="btn" onclick="searchPrev()">▲</button>
            <button class="btn" onclick="searchNext()">▼</button>
        </div>
    </div>
    <div class="filter-bar" id="filterBar">
        <span class="filter-bar-label">🔍</span>
        <label class="compact-label" title="Filter Only: only show matching lines">
            <input type="checkbox" id="chkFilterOnly" onchange="toggleFilterMode()" /> ⊘
        </label>
        <div class="filter-entries" id="filterEntries"></div>
        <button class="btn-filter-add" onclick="addFilter()">＋ Add Filter</button>
        <span id="filterCount" style="font-size: 11px; color: var(--text-secondary); margin: 0 4px;"></span>
        <button class="btn-filter-clear" onclick="clearFilters()">Clear All</button>
    </div>
    <div class="log-container" id="logContainer">
        <div class="log-content" id="logContent">
            <div class="welcome" id="welcome">
                <div class="icon">📡</div>
                <div class="hint">
                    <strong>WSL Serial Monitor</strong><br><br>
                    Click <code>⚡ Connect</code> or use command:<br>
                    <code>WSL Serial: Open Serial Port</code><br><br>
                    Shortcut: <code>Ctrl+Alt+S</code><br><br>
                    Ports are accessed via PowerShell interop from WSL.
                </div>
            </div>
        </div>
        <div class="paused-indicator" id="pausedIndicator" onclick="togglePause()">⏸ PAUSED — Click to resume</div>
    </div>
    <div class="input-bar" id="inputBar">
        <div class="input-panel">
            <div class="input-row">
                <span style="color: var(--text-secondary); font-size: 12px;">TX:</span>
                <input type="text" id="sendInput" placeholder="Type data to send..." onkeydown="if(event.key==='Enter')sendData()" />
                <button class="btn btn-primary" onclick="sendData()">Send</button>
                <label class="input-inline-label" title="Append CRLF when sending">
                    <input type="checkbox" id="appendNewline" checked /> CRLF
                </label>
                <label class="input-inline-label">
                    <input type="checkbox" id="hexMode" /> HEX
                </label>
            </div>
            <div class="quick-command-row">
                <span style="color: var(--text-secondary); font-size: 12px;">Quick:</span>
                <div class="quick-command-list" id="quickCommandList"></div>
                <button class="btn" onclick="toggleQuickCommandEditor()">＋ Add</button>
            </div>
            <div class="quick-command-editor" id="quickCommandEditor">
                <input type="text" id="quickCommandInput" placeholder="Add quick command..." onkeydown="if(event.key==='Enter')addQuickCommand()" />
                <label class="input-inline-label" title="Append CRLF when sending this quick command">
                    <input type="checkbox" id="quickCommandAppendNewline" checked /> CRLF
                </label>
                <label class="input-inline-label">
                    <input type="checkbox" id="quickCommandHexMode" /> HEX
                </label>
                <button class="btn" onclick="addQuickCommand()">Save</button>
                <button class="btn" onclick="toggleQuickCommandEditor(false)">Cancel</button>
            </div>
        </div>
    </div>
    <script>
        // Pass config from host to external script
        window.__maxBufferBytes = ${this.getMaxBufferBytes()};
        window.__persistedUiState = ${persistedUiStateJson};
    </script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
