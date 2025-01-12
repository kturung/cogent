import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../components/Logger';

interface ICommandParams {
    command: string;
}

// Utility function to load node-pty
function loadNodePty() {
    try {
        //@ts-ignore
        const requireFunc = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
        const moduleName = path.join(vscode.env.appRoot, "node_modules", "node-pty");
        return requireFunc(moduleName);
    } catch (error) {
        const logger = Logger.getInstance();
        logger.error(`Failed to load node-pty: ${error}`);
        return null;
    }
}

// Utility function to match command against pattern with wildcard support
function matchCommandPattern(command: string, pattern: string): boolean {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
        .replace(/\*/g, '.*'); // Convert * to .*
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(command);
}

export class CommandRunTool implements vscode.LanguageModelTool<ICommandParams> {
    private static terminal: vscode.Terminal | undefined;
    private static nodePty = loadNodePty();

    private filterPowerShellHeader(text: string): string {
        if (os.platform() === 'win32') {
            const lines = text.split('\n');
            return lines
                .filter(line => !line.startsWith('Copyright (C) Microsoft Corporation'))
                .filter(line => !line.startsWith('Install the latest PowerShell'))
                .join('\n');
        }
        return text;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICommandParams>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const stripAnsi = (str: string) => {
            return str
                .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
                .replace(/\u001b\].*?\u0007/g, ''); // Remove PowerShell OSC sequences
        };
        return new Promise((resolve, reject) => {
            if (!CommandRunTool.nodePty) {
                return resolve(new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Error: node-pty not available')
                ]));
            }

            const shell = os.platform() === 'win32' ? 'powershell.exe' : 'zsh';
            let output = '';
            let writeEmitter = new vscode.EventEmitter<string>();


            const ptyProcess = CommandRunTool.nodePty.spawn(shell, [], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath || process.cwd(),
                env: process.env
            });

            ptyProcess.onData((data: string) => {
                const filteredData = stripAnsi(this.filterPowerShellHeader(data));
                output += filteredData;
                writeEmitter.fire(data);
            });

            const ptyTerminal = vscode.window.createTerminal({
                name: 'Cogent Command',
                pty: {
                    onDidWrite: writeEmitter.event,
                    open: () => {
                        ptyProcess.write(`${options.input.command}\r`);
                        // Add exit command after the main command
                        setTimeout(() => {
                            ptyProcess.write('\rexit\r');
                        }, 100);
                    },
                    close: () => {
                        ptyProcess.kill();
                        writeEmitter.dispose();
                    },
                    handleInput: (data: string) => {
                        ptyProcess.write(data);
                    },
                    setDimensions: (dimensions: vscode.TerminalDimensions) => {
                        ptyProcess.resize(dimensions.columns, dimensions.rows);
                    }
                }
            });

            // Get configured timeout (in seconds) and convert to milliseconds
            const timeoutSeconds = vscode.workspace.getConfiguration('cogent').get('commandTimeout', 30);
            const timeoutMs = timeoutSeconds * 1000;

            let exitTimeout = setTimeout(() => {
                ptyProcess.kill();
                resolve(new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        stripAnsi(output) || `Command timed out after ${timeoutSeconds} seconds`
                    )
                ]));
            }, timeoutMs);

            token.onCancellationRequested(() => {
                clearTimeout(exitTimeout);
                ptyProcess.kill();
                reject(new Error('Command cancelled'));
            });

            ptyTerminal.show();

            // Listen for process exit
            ptyProcess.onExit(() => {
                clearTimeout(exitTimeout);
                resolve(new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(stripAnsi(output) || 'Command completed')
                ]));
            });
        });
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICommandParams>,
        _token: vscode.CancellationToken
    ) {
        const config = vscode.workspace.getConfiguration('cogent');
        const autoConfirm = config.get('autoConfirmTools.runCommand', false);

        // Only proceed if auto-confirm is enabled
        if (autoConfirm) {
            const patterns = config.get<string[]>('autoConfirmToolsCommandPatterns', []);

            // If patterns list is empty or command matches any pattern, auto-confirm
            if (patterns.length === 0 || patterns.some((pattern: string) =>
                matchCommandPattern(options.input.command, pattern)
            )) {
                return {
                    invocationMessage: `Executing command: ${options.input.command}`
                };
            }
        }

        return {
            invocationMessage: `Executing command: ${options.input.command}`,
            confirmationMessages: {
                title: 'Run Command',
                message: new vscode.MarkdownString(`Execute command: \`${options.input.command}\`?`)
            }
        };
    }
}
