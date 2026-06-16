/**
 * SerialPortManager - Opens Windows COM serial ports from WSL or native Windows
 * 
 * Architecture: Fully bidirectional TCP bridge (no stdin/stdout at all).
 * 1. PowerShell starts TCP listener, opens serial port
 * 2. Node.js connects to PowerShell's TCP server
 * 3. Serial data: PS → TCP → Node.js (real-time, 5ms poll)
 * 4. Send commands: Node.js → TCP → PS (HEX:<data>\n protocol)
 * 5. stdin is NOT used (avoids Peek() blocking the loop)
 * 
 * Platform support:
 * - WSL: PowerShell runs via WSL interop, Node.js connects to Windows host IP
 * - Native Windows: PowerShell runs directly, Node.js connects to 127.0.0.1
 */

import { ChildProcess, spawn, execSync } from 'child_process';
import * as net from 'net';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ComPortInfo {
    port: string;
    description: string;
    instanceId: string;
}

export interface SerialPortConfig {
    port: string;
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    stopBits: 'One' | 'OnePointFive' | 'Two';
    parity: 'None' | 'Odd' | 'Even' | 'Mark' | 'Space';
}

export class SerialPortManager extends EventEmitter {
    private process: ChildProcess | null = null;
    private tcpClient: net.Socket | null = null;
    private _connected: boolean = false;
    private currentConfig: SerialPortConfig | null = null;
    private tempScriptPath: string | undefined;
    private dataBuffer: string = '';
    private windowsHostIp: string | undefined;
    private readonly isWSL: boolean;

    constructor() {
        super();
        // Detect if running inside WSL
        this.isWSL = this.detectWSL();
    }

    /**
     * Detect if we are running inside WSL.
     */
    private detectWSL(): boolean {
        try {
            const release = fs.readFileSync('/proc/version', 'utf-8');
            return release.toLowerCase().includes('microsoft') || release.toLowerCase().includes('wsl');
        } catch {
            return false;
        }
    }

    private getPowerShellPath(): string {
        const config = vscode.workspace.getConfiguration('wsl-serial-monitor');
        return config.get<string>('powershellPath', 'powershell.exe');
    }

    /**
     * Get the IP address to connect to PowerShell's TCP server.
     * - WSL: need to find Windows host IP via default gateway
     * - Native Windows: always 127.0.0.1
     */
    private getWindowsHostIp(): string {
        if (this.windowsHostIp) {
            return this.windowsHostIp;
        }
        if (!this.isWSL) {
            this.windowsHostIp = '127.0.0.1';
            return this.windowsHostIp;
        }
        try {
            const result = execSync("ip route show default | awk '{print $3}'", {
                encoding: 'utf-8', timeout: 3000
            }).trim();
            this.windowsHostIp = result || '127.0.0.1';
        } catch {
            this.windowsHostIp = '127.0.0.1';
        }
        return this.windowsHostIp;
    }

    /**
     * Write a temp .ps1 script file. On WSL, convert path via wslpath.
     * On native Windows, the path is already valid.
     */
    private writeTempScript(content: string): string {
        const tmpFile = path.join(os.tmpdir(), `wsl-serial-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
        fs.writeFileSync(tmpFile, content, { encoding: 'utf-8' });
        this.tempScriptPath = tmpFile;

        if (!this.isWSL) {
            // Native Windows: tmpFile is already a valid Windows path
            return tmpFile;
        }

        // WSL: convert Linux path to Windows path via wslpath
        try {
            return execSync(`wslpath -w "${tmpFile}"`, { encoding: 'utf-8', timeout: 3000 }).trim();
        } catch {
            return tmpFile;
        }
    }

    private deleteTempScript(): void {
        if (this.tempScriptPath) {
            try { fs.unlinkSync(this.tempScriptPath); } catch { }
            this.tempScriptPath = undefined;
        }
    }

    private waitForProcessClose(process: ChildProcess, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (closed: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                process.removeListener('close', onClose);
                resolve(closed);
            };
            const onClose = () => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            process.once('close', onClose);
        });
    }

    async listPorts(): Promise<ComPortInfo[]> {
        const psPath = this.getPowerShellPath();
        const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ports = Get-CimInstance -ClassName Win32_PnPEntity | Where-Object {
    $_.Name -match '\\(COM[0-9]+\\)'
} | ForEach-Object {
    $name = $_.Name
    if ($name -match '(COM[0-9]+)') {
        [PSCustomObject]@{ Port = $Matches[1]; Description = $name; InstanceId = $_.PNPDeviceID }
    }
} | Sort-Object Port
foreach ($p in $ports) {
    Write-Output ("PORT|" + $p.Port + "|" + $p.Description + "|" + $p.InstanceId)
}
`.trim();

        const scriptPath = this.writeTempScript(script);
        return new Promise((resolve, reject) => {
            const child = spawn(psPath, [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
            ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

            let output = '';
            child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf-8'); });
            child.stderr?.on('data', (d: Buffer) => { console.warn(`[WSL Serial] ${d.toString('utf-8').trim()}`); });

            child.on('close', () => {
                this.deleteTempScript();
                const ports: ComPortInfo[] = [];
                for (const line of output.split(/\r?\n/)) {
                    if (line.startsWith('PORT|')) {
                        const p = line.split('|');
                        if (p.length >= 4) {
                            ports.push({ port: p[1].trim(), description: p[2].trim(), instanceId: p[3].trim() });
                        }
                    }
                }
                resolve(ports);
            });
            child.on('error', (err) => { this.deleteTempScript(); reject(new Error(`PowerShell error: ${err.message}`)); });
            setTimeout(() => { if (!child.killed) { child.kill(); reject(new Error('Timeout listing ports')); } }, 15000);
        });
    }

    /**
     * Open COM port. Fully bidirectional TCP bridge.
     * 
     * TCP protocol (both directions):
     *   PS → Node: raw serial bytes + control messages (CONNECTED|..., DISCONNECTED|..., ERROR|...)
     *   Node → PS: "HEX:<hexdata>\n" for send commands, "QUIT\n" for close
     * 
     * CRITICAL: No stdin/Peek() used in PS loop - that was blocking everything.
     */
    async open(config: SerialPortConfig): Promise<void> {
        if (this.process || this.tcpClient) {
            await this.close();
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        this.currentConfig = config;
        this.dataBuffer = '';

        const tcpPort = 40000 + Math.floor(Math.random() * 20000);
        const winHostIp = this.getWindowsHostIp();
        const psPath = this.getPowerShellPath();

        // PowerShell: TCP server + serial port. Commands come via TCP (not stdin).
        const script = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, ${tcpPort})
$listener.Start()

$client = $listener.AcceptTcpClient()
$stream = $client.GetStream()

function Send-Bytes([string]$msg) {
    $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
    try { $stream.Write($b, 0, $b.Length); $stream.Flush() } catch {}
}

# Buffer for TCP commands from Node.js
$pendingCommand = ""
$cmdBuf = New-Object byte[] 256

try {
    $port = New-Object System.IO.Ports.SerialPort
    $port.PortName = "${config.port}"
    $port.BaudRate = ${config.baudRate}
    $port.DataBits = ${config.dataBits}
    $port.StopBits = [System.IO.Ports.StopBits]::${config.stopBits}
    $port.Parity = [System.IO.Ports.Parity]::${config.parity}
    $port.ReadTimeout = 500
    $port.WriteTimeout = 1000
    $port.Encoding = [System.Text.Encoding]::UTF8
    $port.DtrEnable = $true
    $port.RtsEnable = $true
    $port.Open()

    Send-Bytes ("CONNECTED|" + $port.PortName + "|${config.baudRate}" + [char]10)

    $hbCount = 0
    while ($port.IsOpen) {
        # Read from serial -> write to TCP (primary task)
        try {
            $n = $port.BytesToRead
            if ($n -gt 0) {
                $data = $port.ReadExisting()
                if ($data.Length -gt 0) {
                    $data = $data -replace '\x00', ''
                    if ($data.Length -gt 0) {
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes($data)
                        $stream.Write($bytes, 0, $bytes.Length)
                        $stream.Flush()
                    }
                }
            }
        } catch [System.TimeoutException] {
        } catch {
            if ($port.IsOpen) { Send-Bytes ("READ_ERROR|" + $_.Exception.Message + [char]10) }
            break
        }

        # Read commands from TCP (non-blocking, read all available bytes at once)
        try {
            if ($stream.DataAvailable) {
                $readLen = $stream.Read($cmdBuf, 0, $cmdBuf.Length)
                if ($readLen -gt 0) {
                    for ($i = 0; $i -lt $readLen; $i++) {
                        $ch = [char]$cmdBuf[$i]
                        if ($ch -eq [char]10) {
                            $cmd = $pendingCommand.Trim()
                            $pendingCommand = ""
                            if ($cmd -eq "QUIT") {
                                break
                            } elseif ($cmd.StartsWith("HEX:")) {
                                $hex = $cmd.Substring(4)
                                $sendBytes = [byte[]]::new($hex.Length / 2)
                                for ($j = 0; $j -lt $hex.Length; $j += 2) {
                                    $sendBytes[$j / 2] = [Convert]::ToByte($hex.Substring($j, 2), 16)
                                }
                                $port.Write($sendBytes, 0, $sendBytes.Length)
                            }
                        } elseif ($ch -ne [char]13) {
                            $pendingCommand += $ch
                        }
                    }
                }
            }
        } catch {
            if ($port.IsOpen) { Send-Bytes ("CMD_ERROR|" + $_.Exception.Message + [char]10) }
        }

        $hbCount++
        if ($hbCount -ge 500) {
            $hbCount = 0
            # Keep-alive: just reset the counter
        }

        Start-Sleep -Milliseconds 10
    }

    if ($port.IsOpen) { $port.Close() }
    $port.Dispose()
    Send-Bytes ("DISCONNECTED|Port closed" + [char]10)
} catch {
    try { Send-Bytes ("ERROR|" + $_.Exception.Message + [char]10) } catch {}
    exit 1
} finally {
    Start-Sleep -Milliseconds 100
    try { $stream.Dispose() } catch {}
    try { $client.Dispose() } catch {}
    try { $listener.Stop() } catch {}
}
`.trim();

        const scriptPath = this.writeTempScript(script);
        console.log(`[Serial] PS script: ${scriptPath}, TCP port: ${tcpPort}, Host IP: ${winHostIp}`);

        return new Promise<void>((resolve, reject) => {
            let initialized = false;
            const timeout = setTimeout(() => {
                if (!initialized) {
                    this.cleanup();
                    reject(new Error(`Timeout connecting to ${config.port}`));
                }
            }, 20000);

            const child = spawn(psPath, [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
            ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

            this.process = child;
            console.log(`[Serial] PowerShell spawned, pid: ${child.pid}`);

            child.stdout?.on('data', (d: Buffer) => {
                console.log(`[Serial] PS stdout: ${d.toString('utf-8').trim()}`);
            });
            child.stderr?.on('data', (d: Buffer) => {
                const err = d.toString('utf-8').trim();
                if (err.startsWith('HEARTBEAT|')) {
                    console.log(`[Serial] ${err}`);
                    this.emit('heartbeat', err);
                } else if (err) {
                    console.warn(`[Serial] PS stderr: ${err}`);
                }
            });

            child.on('close', (code) => {
                console.log(`[Serial] PS process closed, code: ${code}`);
                this._connected = false;
                this.process = null;
                this.deleteTempScript();
                if (initialized) {
                    this.emit('disconnect', `Process exited (code ${code})`);
                } else {
                    clearTimeout(timeout);
                    if (this.tcpClient) {
                        try { this.tcpClient.destroy(); } catch { }
                        this.tcpClient = null;
                    }
                    reject(new Error(`PowerShell exited with code ${code}`));
                }
            });

            child.on('error', (err) => {
                console.error(`[Serial] PS process error: ${err.message}`);
                this._connected = false;
                this.process = null;
                this.deleteTempScript();
                if (!initialized) {
                    clearTimeout(timeout);
                    if (this.tcpClient) {
                        try { this.tcpClient.destroy(); } catch { }
                        this.tcpClient = null;
                    }
                    reject(new Error(`PowerShell error: ${err.message}`));
                }
            });

            console.log(`[Serial] Attempting TCP connect to ${winHostIp}:${tcpPort}...`);
            this.connectWithRetry(winHostIp, tcpPort, 10000, (socket, err) => {
                if (err || !socket) {
                    console.error(`[Serial] TCP connect failed: ${err?.message}`);
                    if (!initialized) {
                        clearTimeout(timeout);
                        this.cleanup();
                        reject(err || new Error('TCP connect failed'));
                    }
                    return;
                }
                this.setupTcpDataHandler(socket, {
                    onConnected: (info) => {
                        this._connected = true;
                        initialized = true;
                        clearTimeout(timeout);
                        this.emit('connect', info);
                        resolve();
                    },
                    onData: (data) => {
                        this.emit('data', data);
                    },
                    onDisconnect: (reason) => {
                        this._connected = false;
                        this.emit('disconnect', reason);
                    },
                    onError: (msg) => {
                        this.emit('error', msg);
                    }
                });
            });
        });
    }

    private connectWithRetry(
        host: string, port: number, timeoutMs: number,
        callback: (socket: net.Socket | null, error?: Error) => void
    ): void {
        const startTime = Date.now();
        let attempts = 0;

        const tryConnect = () => {
            attempts++;
            const socket = new net.Socket();
            socket.setNoDelay(true);

            socket.on('error', (err: NodeJS.ErrnoException) => {
                console.warn(`[Serial] TCP attempt ${attempts} failed: ${err.code || err.message}`);
                socket.destroy();
                if (Date.now() - startTime < timeoutMs) {
                    setTimeout(tryConnect, 200);
                } else {
                    callback(null, new Error(`TCP connect failed after ${attempts} attempts to ${host}:${port}`));
                }
            });

            socket.connect(port, host, () => {
                console.log(`[Serial] TCP connected to ${host}:${port} after ${attempts} attempt(s)`);
                callback(socket);
            });
        };

        setTimeout(tryConnect, 500);
    }

    private setupTcpDataHandler(
        socket: net.Socket,
        handlers: {
            onConnected: (info: string) => void;
            onData: (rawChunk: string) => void;
            onDisconnect: (reason: string) => void;
            onError: (msg: string) => void;
        }
    ): void {
        this.tcpClient = socket;
        socket.setEncoding('utf-8');

        let handshakeDone = false;

        socket.on('data', (data: Buffer) => {
            const text = data.toString('utf-8');
            this.dataBuffer += text;

            if (!handshakeDone) {
                const nlIdx = this.dataBuffer.indexOf('\n');
                if (nlIdx !== -1) {
                    const line = this.dataBuffer.substring(0, nlIdx).replace(/\r$/, '');
                    this.dataBuffer = this.dataBuffer.substring(nlIdx + 1);

                    if (line.startsWith('CONNECTED|')) {
                        const parts = line.split('|');
                        handshakeDone = true;
                        handlers.onConnected(`${parts[1]} @ ${parts[2]} baud`);
                    } else if (line.startsWith('ERROR|')) {
                        handlers.onError(line.substring('ERROR|'.length));
                        return;
                    }
                }
            }

            if (handshakeDone && this.dataBuffer.length > 0) {
                // Extract control messages when they appear as complete lines.
                // Everything else is forwarded as raw serial data immediately.
                let rawData = '';
                let tempBuffer = this.dataBuffer;
                this.dataBuffer = '';

                let nlIdx: number;
                while ((nlIdx = tempBuffer.indexOf('\n')) !== -1) {
                    const line = tempBuffer.substring(0, nlIdx).replace(/\r$/, '');
                    tempBuffer = tempBuffer.substring(nlIdx + 1);

                    if (line.startsWith('DISCONNECTED|')) {
                        handlers.onDisconnect(line.substring('DISCONNECTED|'.length));
                        return;
                    } else if (line.startsWith('READ_ERROR|')) {
                        handlers.onError(`Read error: ${line.substring('READ_ERROR|'.length)}`);
                    } else if (line.startsWith('CMD_ERROR|')) {
                        handlers.onError(`Command error: ${line.substring('CMD_ERROR|'.length)}`);
                    } else {
                        rawData += line + '\n';
                    }
                }

                // Leftover without \n is also raw serial data, not a complete control line.
                if (tempBuffer.length > 0) {
                    rawData += tempBuffer;
                }

                if (rawData.length > 0) {
                    handlers.onData(rawData);
                }
            }
        });

        socket.on('close', () => {
            this._connected = false;
            this.tcpClient = null;
            if (handshakeDone) {
                handlers.onDisconnect('TCP closed');
            }
        });

        socket.on('error', (err) => {
            this.tcpClient = null;
            if (handshakeDone) {
                handlers.onError(`TCP: ${err.message}`);
            }
        });
    }

    private cleanup(): void {
        this._connected = false;
        if (this.tcpClient) {
            try { this.tcpClient.destroy(); } catch { }
            this.tcpClient = null;
        }
        if (this.process) {
            try { this.process.kill(); } catch { }
            this.process = null;
        }
        this.deleteTempScript();
    }

    /**
     * Send data to serial port via TCP (not stdin).
     * Protocol: "HEX:<hexdata>\n"
     */
    async send(data: Buffer): Promise<void> {
        if (!this.tcpClient || !this._connected) {
            throw new Error('No serial port is open');
        }
        const hexData = data.toString('hex').toUpperCase();
        const cmd = `HEX:${hexData}\n`;
        return new Promise((resolve, reject) => {
            const ok = this.tcpClient!.write(cmd);
            if (!ok) { this.tcpClient!.once('drain', () => resolve()); } else { resolve(); }
        });
    }

    /**
     * Close serial port. Send QUIT via TCP, then kill process.
     */
    async close(): Promise<void> {
        this._connected = false;
        const process = this.process;

        if (this.tcpClient) {
            try {
                this.tcpClient.write('QUIT\n');
            } catch { }

            const closedGracefully = process
                ? await this.waitForProcessClose(process, 2000)
                : false;

            if (!closedGracefully) {
                try { this.tcpClient.destroy(); } catch { }
                this.tcpClient = null;
            }
        }

        if (process && this.process) {
            try { this.process.kill(); } catch { }
            await this.waitForProcessClose(process, 1000);
            this.process = null;
        }

        if (this.tcpClient) {
            try { this.tcpClient.destroy(); } catch { }
            this.tcpClient = null;
        }

        this.deleteTempScript();
    }

    isConnected(): boolean { return this._connected; }
    onData(fn: (data: string) => void): this { return this.on('data', fn); }
    onConnect(fn: (info: string) => void): this { return this.on('connect', fn); }
    onDisconnect(fn: (reason: string) => void): this { return this.on('disconnect', fn); }
    onError(fn: (err: string) => void): this { return this.on('error', fn); }
}
