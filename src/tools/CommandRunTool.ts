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

export class CommandRunTool implements vscode.LanguageModelTool<ICommandParams> {
    private static terminal: vscode.Terminal | undefined;
    private static nodePty = loadNodePty();

    // Add prompt patterns for different shells
    private readonly PROMPT_PATTERNS = {
        zsh: /[\n\r][^\n\r]*(%|#|\$)\s*$/,
        bash: /[\n\r][^\n\r]*(\$|#)\s*$/,
        powershell: /[\n\r][^\n\r]*PS[^\n\r>]*>\s*$/
    };

    private isPrompt(data: string, shell: string): boolean {
        const pattern = this.PROMPT_PATTERNS[shell as keyof typeof this.PROMPT_PATTERNS];
        return pattern ? pattern.test(data) : false;
    }

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

            const isWindows = os.platform() === 'win32';
            const shell = isWindows ? 'powershell.exe' : 'zsh';
            let output = '';
            let outputBuffer = '';
            let commandStarted = false;
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
                outputBuffer += filteredData;

                if (isWindows) {
                    output += filteredData;
                } else {
                    // For zsh, only start capturing output after the command is sent
                    if (commandStarted) {
                        output += filteredData;
                    }

                    // Check for shell prompt after command execution
                    if (commandStarted && this.isPrompt(outputBuffer, 'zsh')) {
                        // Remove the prompt from the output
                        output = output.replace(this.PROMPT_PATTERNS.zsh, '');
                        ptyProcess.kill();
                        resolve(new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(stripAnsi(output.trim()))
                        ]));
                    }
                }

                writeEmitter.fire(data);
            });

            const ptyTerminal = vscode.window.createTerminal({
                name: 'Cogent Command',
                pty: {
                    onDidWrite: writeEmitter.event,
                    open: () => {
                        // Clear the buffer before sending the command
                        outputBuffer = '';
                        ptyProcess.write(`${options.input.command}\r`);
                        commandStarted = true;

                        // For PowerShell, add exit command after the main command
                        if (isWindows) {
                            setTimeout(() => {
                                ptyProcess.write('\rexit\r');
                            }, 100);
                        }
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
            
            // For PowerShell, listen for process exit
            if (isWindows) {
                ptyProcess.onExit(() => {
                    clearTimeout(exitTimeout);
                    resolve(new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(stripAnsi(output) || 'Command completed')
                    ]));
                });
            }
        });
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICommandParams>,
        _token: vscode.CancellationToken
    ) {
        const autoConfirm = vscode.workspace.getConfiguration('cogent').get('autoConfirmTools.runCommand', false);
        
        if (autoConfirm) {
            return {
                invocationMessage: `Executing command: ${options.input.command}`
            };
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