import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DiffView } from '../components/DiffView';

interface IFileOperationParams {
    path?: string;
    paths?: string[];
    content?: string;
}

export class FileUpdateTool implements vscode.LanguageModelTool<IFileOperationParams> {
    private diffView?: DiffView;

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFileOperationParams>,
        _token: vscode.CancellationToken
    ) {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspacePath) {
                throw new Error('No workspace folder found');
            }
            if (!options.input.path) {
                throw new Error('File path is required');
            }
            const filePath = options.input.path;
            const originalContent = await fs.readFile(filePath, 'utf-8');

            this.diffView = new DiffView(filePath, originalContent);
            await this.diffView.show();

            if (options.input.content) {
                const lines = options.input.content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    await this.diffView.update(
                        lines.slice(0, i + 1).join('\n'),
                        i
                    );
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Changes shown in diff view for ${options.input.path}. Review and save to apply changes.`)
            ]);
        } catch (err: unknown) {
            if (this.diffView) {
                await this.diffView.close();
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error updating file: ${(err as Error)?.message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFileOperationParams>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: `Updating file: ${options.input.path}`,
            confirmationMessages: {
                title: 'Update File',
                message: new vscode.MarkdownString(`Update contents of ${options.input.path}?`)
            }
        };
    }
}