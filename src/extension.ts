/**
 * WSL Serial Monitor Extension for VS Code
 * 
 * Opens Windows COM serial ports from WSL or native Windows,
 * and displays real-time serial logs in a WebView editor tab.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SerialPortManager } from './serialPort';
import { SerialMonitorViewProvider } from './serialMonitorView';
import { LogStore } from './logStore';

let serialManager: SerialPortManager | undefined;
let viewProvider: SerialMonitorViewProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let logStore: LogStore | undefined;
let agentCliCommand: string | undefined;
let autoConnectAttempted = false;
let openInProgress = false;

class SerialMonitorTreeItem extends vscode.TreeItem {
    constructor(label: string, commandId?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (commandId) {
            this.command = { command: commandId, title: label };
        }
    }
}

class SerialMonitorTreeProvider implements vscode.TreeDataProvider<SerialMonitorTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SerialMonitorTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SerialMonitorTreeItem): SerialMonitorTreeItem {
        return element;
    }

    getChildren(): SerialMonitorTreeItem[] {
        const connected = serialManager?.isConnected() ?? false;
        const items: SerialMonitorTreeItem[] = [];
        items.push(new SerialMonitorTreeItem(connected ? '🟢 Connected' : '🔴 Disconnected'));
        items.push(new SerialMonitorTreeItem('📡 Open Serial Port', 'wsl-serial-monitor.open'));
        items.push(new SerialMonitorTreeItem('⏹ Close Port', 'wsl-serial-monitor.close'));
        items.push(new SerialMonitorTreeItem('💾 Save Log', 'wsl-serial-monitor.saveLog'));
        items.push(new SerialMonitorTreeItem('🗑 Clear Log', 'wsl-serial-monitor.clearLog'));
        items.push(new SerialMonitorTreeItem('🤖 Copy Agent CLI', 'wsl-serial-monitor.copyAgentCliCommand'));
        items.push(new SerialMonitorTreeItem('⚙ Open Settings', 'wsl-serial-monitor.openSettings'));
        return items;
    }
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('WSL Serial Monitor');
    outputChannel.appendLine(`[INIT] Platform: ${process.platform}, VS Code: ${vscode.version}`);

    serialManager = new SerialPortManager();
    const agentLogDir = getAgentLogDirectory(context);
    logStore = new LogStore(agentLogDir);
    cleanupOldLogs(logStore);
    const agentCli = ensureAgentCliShim(context, agentLogDir);
    agentCliCommand = `${quoteShellPath(agentCli.executablePath)} logs`;
    outputChannel.appendLine(`[CLI] Agent CLI: ${agentCliCommand} sessions`);
    viewProvider = new SerialMonitorViewProvider(
        context,
        serialManager,
        (message: string) => outputChannel?.appendLine(message)
    );

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('wslSerialMonitor', {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                outputChannel?.appendLine('[WEBVIEW] Deserializing restored panel');
                viewProvider?.revive(webviewPanel);
            }
        })
    );

    // Register TreeView for sidebar
    const treeProvider = new SerialMonitorTreeProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('serial-monitor-panel', treeProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.open', async () => {
            await openSerialPort({ tryDefaultPortFirst: false });
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.close', async () => {
            if (serialManager) {
                await serialManager.close();
                vscode.window.showInformationMessage('Serial port closed.');
                treeProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.listPorts', async () => {
            if (serialManager) {
                const ports = await serialManager.listPorts();
                if (ports.length === 0) {
                    vscode.window.showWarningMessage('No COM ports found.');
                } else {
                    const portList = ports.map(p => `${p.port} - ${p.description}`).join('\n');
                    vscode.window.showInformationMessage(`Available ports:\n${portList}`, { modal: true });
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.sendData', async () => {
            if (!serialManager || !serialManager.isConnected()) {
                vscode.window.showWarningMessage('No serial port is open.');
                return;
            }
            const data = await vscode.window.showInputBox({
                prompt: 'Enter data to send (prefix 0x for hex)',
                placeHolder: 'text or 0x48656C6C6F'
            });
            if (data !== undefined && serialManager) {
                const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
                const lineEnding = config.get<string>('lineEnding', '\\r\\n')
                    .replace(/\\\\r/g, '\\r').replace(/\\\\n/g, '\\n');
                
                if (data.startsWith('0x') || data.startsWith('0X')) {
                    const bytes = Buffer.from(data.slice(2).replace(/\s+/g, ''), 'hex');
                    await serialManager.send(bytes);
                } else {
                    let sendData = data;
                    if (lineEnding !== 'None') { sendData += lineEnding; }
                    await serialManager.send(Buffer.from(sendData, 'utf-8'));
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.clearLog', () => {
            if (viewProvider) { viewProvider.clearLog(); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.saveLog', async () => {
            await saveLog();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.copyAgentCliCommand', async () => {
            if (!agentCliCommand) {
                vscode.window.showWarningMessage('Agent CLI is not ready.');
                return;
            }
            const command = `${agentCliCommand} sessions`;
            await vscode.env.clipboard.writeText(command);
            vscode.window.showInformationMessage(`Agent CLI command copied: ${command}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wsl-serial-monitor.openSettings', async () => {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:Roger-Han.wsl-serial-monitor'
            );
        })
    );

    // Serial data events
    let dataCount = 0;
    serialManager.on('data', (data: string) => {
        dataCount++;
        logStore?.appendSerialData(data);
        if (viewProvider) { viewProvider.appendLog(data); }
    });

    serialManager.on('connect', (info: string) => {
        outputChannel?.appendLine(`[CONNECTED] ${info}`);
        dataCount = 0;
        const connection = parseSerialConnectionInfo(info);
        const session = logStore?.startSession(connection.port, connection.baudRate);
        if (session) {
            outputChannel?.appendLine(`[LOG] Session ${session.sessionId} -> ${session.filePath}`);
        }
        if (viewProvider) { viewProvider.setStatus(true, info); }
        treeProvider.refresh();
        vscode.window.showInformationMessage(`Connected: ${info}`);
    });

    serialManager.on('disconnect', (reason: string) => {
        outputChannel?.appendLine(`[DISCONNECTED] ${reason} (${dataCount} lines)`);
        logStore?.closeSession(reason);
        if (viewProvider) { viewProvider.setStatus(false, reason); }
        treeProvider.refresh();
        vscode.window.showWarningMessage(`Disconnected: ${reason}`);
    });

    serialManager.on('error', (err: string) => {
        outputChannel?.appendLine(`[ERROR] ${err}`);
        vscode.window.showErrorMessage(`Serial Error: ${err}`);
    });

    outputChannel.appendLine('[INIT] Extension activated.');

    void tryAutoConnectOnStartup(treeProvider);
}

async function tryAutoConnectOnStartup(treeProvider: SerialMonitorTreeProvider) {
    if (autoConnectAttempted || !serialManager) {
        return;
    }

    autoConnectAttempted = true;

    const defaultPort = vscode.workspace.getConfiguration('wsl-serial-monitor')
        .get<string>('defaultPort', '')
        .trim();

    if (!defaultPort) {
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));

    await openSerialPort({ tryDefaultPortFirst: true });
    treeProvider.refresh();
}

async function openSerialPort(options: { tryDefaultPortFirst: boolean }) {
    if (!serialManager) { return; }
    if (openInProgress) {
        outputChannel?.appendLine('[OPEN] Ignored because another open operation is in progress');
        return;
    }

    openInProgress = true;

    try {
        outputChannel?.appendLine('[OPEN] Starting...');
        outputChannel?.show(true);

        if (viewProvider) { viewProvider.show(); }

        const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
        const defaultPort = config.get<string>('defaultPort', '').trim();
        const defaultBaudRate = config.get<number>('defaultBaudRate', 115200);

        if (options.tryDefaultPortFirst && defaultPort) {
            const defaultPortConfig = buildPortConfig(defaultPort, defaultBaudRate);
            outputChannel?.appendLine(`[OPEN] Trying default port ${defaultPortConfig.port} @ ${defaultPortConfig.baudRate}`);

            try {
                await openSerialPortWithRetry(defaultPortConfig, 'default port');
                outputChannel?.appendLine('[OPEN] Connected using default port');
                return;
            } catch (err: any) {
                outputChannel?.appendLine(`[OPEN] Default port failed: ${err.message}`);
                // Silent failure for startup auto-connect — no popup
                return;
            }
        }

        let ports;
        try {
            ports = await serialManager.listPorts();
            outputChannel?.appendLine(`[SCAN] Found ${ports.length} COM ports`);
        } catch (err: any) {
            outputChannel?.appendLine(`[ERROR] listPorts failed: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to list ports: ${err.message}`);
            return;
        }

        if (ports.length === 0) {
            vscode.window.showErrorMessage('No COM ports found. Ensure device is connected.');
            return;
        }

        const portItems = ports.map(p => ({
            label: p.port, description: p.description, detail: p.instanceId
        }));

        const selectedPort = await vscode.window.showQuickPick(portItems, {
            placeHolder: 'Select COM port', title: 'Serial Monitor'
        });
        if (!selectedPort) { return; }

        const baudRate = await pickBaudRate(defaultBaudRate);
        if (!baudRate) { return; }

        const portConfig = buildPortConfig(selectedPort.label, baudRate);

        outputChannel?.appendLine(`[OPEN] ${portConfig.port} @ ${portConfig.baudRate}`);

        try {
            await openSerialPortWithRetry(portConfig, 'selected port');
            outputChannel?.appendLine('[OPEN] Connected');
        } catch (err: any) {
            outputChannel?.appendLine(`[ERROR] ${err.message}`);
            vscode.window.showErrorMessage(`Failed: ${err.message}`);
        }
    } finally {
        openInProgress = false;
    }
}
function isAccessDeniedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return /access is denied|access denied|访问被拒绝/i.test(message);
}

async function openSerialPortWithRetry(
    portConfig: ReturnType<typeof buildPortConfig>,
    source: string
): Promise<void> {
    if (!serialManager) {
        throw new Error('Serial manager is not initialized.');
    }

    try {
        await serialManager.open(portConfig);
    } catch (err) {
        if (!isAccessDeniedError(err)) {
            throw err;
        }

        outputChannel?.appendLine(`[OPEN] ${source} hit access denied, retrying once after cleanup`);
        await serialManager.close();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await serialManager.open(portConfig);
    }
}

function buildPortConfig(port: string, baudRate: number) {
    const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
    return {
        port,
        baudRate,
        dataBits: config.get<number>('defaultDataBits', 8) as 5 | 6 | 7 | 8,
        stopBits: config.get<string>('defaultStopBits', 'One') as 'One' | 'OnePointFive' | 'Two',
        parity: config.get<string>('defaultParity', 'None') as 'None' | 'Odd' | 'Even' | 'Mark' | 'Space'
    };
}

function getAgentLogDirectory(context: vscode.ExtensionContext): string {
    const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
    const configuredDir = config.get<string>('agentLogDirectory', 'logs').trim() || 'logs';

    if (path.isAbsolute(configuredDir)) {
        return configuredDir;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const baseDir = workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
    return path.join(baseDir, configuredDir);
}

function ensureAgentCliShim(
    context: vscode.ExtensionContext,
    agentLogDir: string
): { executablePath: string } {
    const binDir = path.join(context.globalStorageUri.fsPath, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const cliJsPath = path.join(context.extensionUri.fsPath, 'out', 'cli.js');
    const nodePath = process.execPath;

    if (process.platform === 'win32') {
        const executablePath = path.join(binDir, 'wsl-serial-monitor.cmd');
        const content = [
            '@echo off',
            `set "WSL_SERIAL_MONITOR_LOG_DIR=${agentLogDir}"`,
            `"${nodePath}" "${cliJsPath}" %*`
        ].join('\r\n');
        fs.writeFileSync(executablePath, content, 'utf-8');
        return { executablePath };
    }

    const executablePath = path.join(binDir, 'wsl-serial-monitor');
    const content = [
        '#!/usr/bin/env sh',
        `export WSL_SERIAL_MONITOR_LOG_DIR=${quoteShellPath(agentLogDir)}`,
        `exec ${quoteShellPath(nodePath)} ${quoteShellPath(cliJsPath)} "$@"`
    ].join('\n');
    fs.writeFileSync(executablePath, `${content}\n`, 'utf-8');
    fs.chmodSync(executablePath, 0o755);
    return { executablePath };
}

function cleanupOldLogs(store: LogStore): void {
    const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
    const maxAgeDays = config.get<number>('logRotationMaxAgeDays', 30);
    const maxFiles = config.get<number>('logRotationMaxFiles', 100);
    const maxTotalSizeMB = config.get<number>('logRotationMaxTotalSizeMB', 500);

    try {
        const result = store.cleanupOldSessions({ maxAgeDays, maxFiles, maxTotalSizeMB });
        if (result.deleted > 0) {
            outputChannel?.appendLine(`[CLEANUP] Deleted ${result.deleted} old log files, kept ${result.kept}`);
        }
    } catch (err: any) {
        outputChannel?.appendLine(`[CLEANUP] Error: ${err.message}`);
    }
}

function quoteShellPath(value: string): string {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseSerialConnectionInfo(info: string): { port: string; baudRate: number } {
    const match = info.match(/^(.+?)\s+@\s+(\d+)\s+baud$/i);
    if (!match) {
        return { port: info.trim() || 'serial', baudRate: 0 };
    }

    return {
        port: match[1].trim(),
        baudRate: Number(match[2])
    };
}

async function pickBaudRate(defaultBaudRate: number): Promise<number | undefined> {
    const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];
    const selectedBaud = await vscode.window.showQuickPick(
        baudRates.map((baud) => ({ label: baud, picked: parseInt(baud, 10) === defaultBaudRate })),
        {
            placeHolder: `Baud rate (default: ${defaultBaudRate})`,
            title: 'Serial Monitor'
        }
    );

    return selectedBaud ? parseInt(selectedBaud.label, 10) : undefined;
}

async function saveLog() {
    if (!viewProvider) {
        vscode.window.showWarningMessage('No log view active.');
        return;
    }

    const lines = viewProvider.getLogLines();
    if (lines.length === 0) {
        vscode.window.showWarningMessage('No log data to save.');
        return;
    }

    const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
    const saveDir = config.get<string>('saveDirectory', '');
    const filePrefix = config.get<string>('saveFilePrefix', 'serial_log');

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const filename = `${filePrefix}_${ts}.log`;

    let targetDir = saveDir;
    if (!targetDir) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        targetDir = workspaceFolders ? workspaceFolders[0].uri.fsPath : require('os').homedir();
    }

    const filePath = path.join(targetDir, filename);

    try {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        vscode.window.showInformationMessage(`Log saved: ${filePath}`);
        outputChannel?.appendLine(`[SAVE] ${lines.length} lines → ${filePath}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Save failed: ${err.message}`);
        outputChannel?.appendLine(`[ERROR] Save failed: ${err.message}`);
    }
}

export async function deactivate(): Promise<void> {
    if (serialManager) {
        await serialManager.close();
    }
    logStore?.closeSession('extension deactivated');
}
