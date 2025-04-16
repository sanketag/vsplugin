import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { getNonce, getFileIcon } from './utils';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { Readable } from 'stream';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import * as path from 'path';
import axios from 'axios';
import { diffLines } from 'diff'

// Register common languages for syntax highlighting
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);

// Use the configurable API URL instead of hardcoding
let API_BASE_URL = 'http://127.0.0.1:9693'; // Default value

interface ChatMessage {
    id: string;
    content: string;
    isBot: boolean;
    timestamp: number;
    codeSuggestion?: string;
    codeLanguage?: string;
    isStreaming?: boolean;
}

interface CodeContext {
    filePath: string;
    code: string;
    language: string;
    selection?: string;
    position?: vscode.Position;
}

interface ContextFile {
    path: string;
    content: string;
    language?: string;
}

interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    model: string;
    contextFiles: ContextFile[];
    timestamp: number;
}

interface ChatSettings {
    autoContext: boolean;
    defaultModel: string;
    streamResponses: boolean;
    showTimestamps: boolean;
}

interface AICompletionSettings {
    enabled: boolean;
    delay: number;
    autoTrigger: boolean;
}

export class CodeRefactoringProvider {
    private _context: vscode.ExtensionContext;
    private _statusBarItem: vscode.StatusBarItem;
    private _abortController?: AbortController;
    private _decoration: vscode.TextEditorDecorationType;
    private _addedLineDecoration: vscode.TextEditorDecorationType;
    private _removedLineDecoration: vscode.TextEditorDecorationType;
    private _inlineRefactoringPanel?: vscode.WebviewPanel;
    private _isRefactoringInProgress: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        
        // Create status bar item for showing refactoring status
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._context.subscriptions.push(this._statusBarItem);
        
        // Initialize decoration types for highlighting changes
        this._decoration = vscode.window.createTextEditorDecorationType({
            border: '1px solid #888',
            backgroundColor: 'rgba(100, 100, 255, 0.1)'
        });
        
        this._addedLineDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(80, 200, 80, 0.2)',
            isWholeLine: true,
            before: {
                contentText: '+ ',
                color: 'green'
            }
        });
        
        this._removedLineDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 100, 100, 0.2)',
            isWholeLine: true,
            before: {
                contentText: '- ',
                color: 'red'
            }
        });
        
        // Load initial configuration
        const config = vscode.workspace.getConfiguration('aiChat');
        if (config.has('apiBaseUrl')) {
            API_BASE_URL = config.get('apiBaseUrl') as string;
        }
        
        // Register commands for accepting/rejecting refactoring
        this._context.subscriptions.push(
            vscode.commands.registerCommand('diplugin.acceptRefactoring', () => this._handleAcceptRefactoring()),
            vscode.commands.registerCommand('diplugin.rejectRefactoring', () => this._handleRejectRefactoring())
        );
    }

    public async refactorSelectedCode(): Promise<void> {
        // Check if refactoring is already in progress
        if (this._isRefactoringInProgress) {
            vscode.window.showInformationMessage('A refactoring operation is already in progress');
            return;
        }
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage('No code selected for refactoring');
            return;
        }

        const selectedCode = editor.document.getText(selection);
        const targetVersion = await this._promptForTargetVersion();
        if (!targetVersion) return; // User cancelled

        this._isRefactoringInProgress = true;
        this._showRefactoringStatus('$(sync~spin) Refactoring...');
        
        try {
            const refactoredCode = await this._callRefactorApi(selectedCode, targetVersion);
            if (refactoredCode) {
                await this._showInlineRefactorPreview(selectedCode, refactoredCode, selection);
            }
        } catch (error) {
            this._hideRefactoringStatus();
            this._isRefactoringInProgress = false;
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Refactoring failed: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Refactoring failed with an unknown error');
            }
        }
    }

    private async _promptForTargetVersion(): Promise<string | undefined> {
        const versions = ['airflow2.6', 'airflow2.5', 'airflow2.4', 'airflow2.0'];
        return vscode.window.showQuickPick(versions, {
            placeHolder: 'Select target Airflow version',
            title: 'Refactor Code'
        });
    }

    private async _callRefactorApi(code: string, targetVersion: string): Promise<string> {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        
        try {
            const response = await fetch(`${API_BASE_URL}/v1/refactor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: code,
                    target_version: targetVersion
                }),
                signal
            });
    
            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }
    
            // Handle streaming response
            const reader = Readable.toWeb(response.body as any).getReader();
            if (!reader) {
                throw new Error('Failed to get response reader');
            }
            
            const decoder = new TextDecoder();
            let fullResponse = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                fullResponse += chunk;
            }
            
            return fullResponse;
        } finally {
            this._abortController = undefined;
        }
    }
    
    private _currentDecorations?: {
        preview: vscode.TextEditorDecorationType;
        codelens: vscode.Disposable;
        timeout: NodeJS.Timeout;
    };

    private async _showInlineRefactorPreview(originalCode: string, refactoredCode: string, selection: vscode.Selection): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        // Calculate the diff
        const changes = diffLines(originalCode, refactoredCode);
        
        // Clear any existing decorations
        editor.setDecorations(this._decoration, []);
        
        // Create decoration for the inline preview
        const inlinePreviewDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: this._getInlinePreviewText(changes),
                margin: '10px 0 0 0',
                border: '1px solid var(--vscode-panel-border)',
                backgroundColor: 'var(--vscode-editor-background)',
                width: 'max-content',
                height: 'max-content',
                color: 'var(--vscode-editor-foreground)'
            },
            isWholeLine: true
        });
        
        // Apply decoration at the start of selection
        const decorationRange = new vscode.Range(
            selection.start.line, 0,
            selection.start.line, 0
        );
        
        editor.setDecorations(inlinePreviewDecoration, [decorationRange]);
        
        // Apply diff decorations to highlight changes in the editor
        this._applyDiffDecorations(editor, selection, originalCode, refactoredCode);
        
        this._hideRefactoringStatus();
        
        // Create buttons for accept/reject using Codelens
        const acceptCodeLensProvider: vscode.CodeLensProvider = {
            provideCodeLenses: (document: vscode.TextDocument) => {
                if (document.uri.toString() !== editor.document.uri.toString()) return [];
                
                const range = new vscode.Range(selection.start.line, 0, selection.start.line, 0);
                
                const acceptLens = new vscode.CodeLens(range, {
                    title: '✓ Accept',
                    command: 'diplugin.acceptRefactoring',
                    arguments: [refactoredCode, selection]
                });
                
                const rejectLens = new vscode.CodeLens(range, {
                    title: '✗ Reject',
                    command: 'diplugin.rejectRefactoring',
                    arguments: []
                });
                
                return [acceptLens, rejectLens];
            }
        };
        
        // Register the codelens provider temporarily
        const codeLensDisposable = vscode.languages.registerCodeLensProvider(
            { pattern: editor.document.uri.fsPath },
            acceptCodeLensProvider
        );
        
        // Set a timer to remove decorations if user doesn't interact
        const decorationTimeout = setTimeout(() => {
            inlinePreviewDecoration.dispose();
            editor.setDecorations(this._addedLineDecoration, []);
            editor.setDecorations(this._removedLineDecoration, []);
            codeLensDisposable.dispose();
            this._isRefactoringInProgress = false;
        }, 60000); // Remove after 1 minute of inactivity
        
        // Store these to dispose later
        this._currentDecorations = {
            preview: inlinePreviewDecoration,
            codelens: codeLensDisposable,
            timeout: decorationTimeout
        };
    }
    
    // Helper method to generate the text content for the inline preview
    private _getInlinePreviewText(changes: Array<{added?: boolean, removed?: boolean, value: string}>): string {
        let previewText = 'Refactoring Preview:\n';
        
        changes.forEach(change => {
            if (change.added) {
                previewText += `+ ${change.value.trim()}\n`;
            } else if (change.removed) {
                previewText += `- ${change.value.trim()}\n`;
            } else {
                previewText += `  ${change.value.trim()}\n`;
            }
        });
        
        return previewText + '\n[Enter to Accept, Esc to Reject]';
    }
    
    private _applyDiffDecorations(
        editor: vscode.TextEditor, 
        selection: vscode.Selection,
        originalCode: string, 
        refactoredCode: string
    ): void {
        const originalLines = originalCode.split('\n');
        const refactoredLines = refactoredCode.split('\n');
        
        const changes = diffLines(originalCode, refactoredCode);
        
        const addedRanges: vscode.Range[] = [];
        const removedRanges: vscode.Range[] = [];
        
        let lineOffset = selection.start.line;
        let currentLine = 0;
        
        changes.forEach(change => {
            const lineCount = change.value.split('\n').length - 1;
            
            if (change.added) {
                // Highlight added lines in green
                const startLine = lineOffset + currentLine;
                const endLine = startLine + lineCount;
                
                for (let i = startLine; i <= endLine; i++) {
                    const line = editor.document.lineAt(i);
                    addedRanges.push(line.range);
                }
                
                currentLine += lineCount;
            } else if (change.removed) {
                // Highlight removed lines in red
                const startLine = lineOffset + currentLine;
                const endLine = startLine + lineCount;
                
                for (let i = startLine; i <= endLine; i++) {
                    if (i < editor.document.lineCount) {
                        const line = editor.document.lineAt(i);
                        removedRanges.push(line.range);
                    }
                }
            } else {
                // Unchanged lines
                currentLine += lineCount;
            }
        });
        
        // Apply decorations
        editor.setDecorations(this._addedLineDecoration, addedRanges);
        editor.setDecorations(this._removedLineDecoration, removedRanges);
    }

    private _getInlinePreviewContent(changes: Array<{added?: boolean, removed?: boolean, value: string}>): string {
        const nonce = getNonce();
        
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
                <title>Code Refactor Preview</title>
                <style>
                    body {
                        font-family: var(--vscode-editor-font-family, 'Segoe UI');
                        font-size: var(--vscode-editor-font-size, 12px);
                        padding: 0;
                        margin: 0;
                        background-color: var(--vscode-editor-background, #1e1e1e);
                        color: var(--vscode-editor-foreground, #d4d4d4);
                    }
                    .container {
                        display: flex;
                        flex-direction: column;
                        padding: 6px;
                        max-height: 200px;
                        overflow: auto;
                    }
                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 6px;
                        user-select: none;
                    }
                    .title {
                        font-weight: bold;
                        font-size: 14px;
                    }
                    .actions {
                        display: flex;
                        gap: 8px;
                    }
                    button {
                        padding: 4px 8px;
                        background-color: var(--vscode-button-background, #0e639c);
                        color: var(--vscode-button-foreground, white);
                        border: none;
                        border-radius: 2px;
                        cursor: pointer;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground, #1177bb);
                    }
                    .keyboard-shortcut {
                        opacity: 0.7;
                        margin-left: 4px;
                        font-size: 10px;
                    }
                    
                    /* Hides the preview panel when not needed, CSS only approach */
                    .diffPreview {
                        display: ${changes.length > 0 ? 'block' : 'none'};
                        margin-top: 4px;
                        max-height: 150px;
                        overflow: auto;
                        border: 1px solid var(--vscode-panel-border, #555);
                        border-radius: 3px;
                    }
                    .line {
                        padding: 1px 4px;
                        font-family: var(--vscode-editor-font-family, monospace);
                        white-space: pre;
                    }
                    .added {
                        background-color: rgba(80, 200, 80, 0.2);
                        color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
                    }
                    .removed {
                        background-color: rgba(255, 100, 100, 0.2);
                        color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
                    }
                    .unchanged {
                        color: var(--vscode-editor-foreground, #d4d4d4);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="title">Refactoring Preview</div>
                        <div class="actions">
                            <button id="reject">Reject <span class="keyboard-shortcut">(Esc)</span></button>
                            <button id="accept">Accept <span class="keyboard-shortcut">(Enter)</span></button>
                        </div>
                    </div>
                    
                    <div class="diffPreview">
                        ${changes.map(change => {
                            const className = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
                            const prefix = change.added ? '+ ' : change.removed ? '- ' : '  ';
                            return `<div class="line ${className}">${prefix}${this._escapeHtml(change.value)}</div>`;
                        }).join('')}
                    </div>
                </div>
                
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    
                    document.getElementById('accept').addEventListener('click', () => {
                        vscode.postMessage({ command: 'accept' });
                    });
                    
                    document.getElementById('reject').addEventListener('click', () => {
                        vscode.postMessage({ command: 'reject' });
                    });
                    
                    window.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            vscode.postMessage({ command: 'accept' });
                            e.preventDefault();
                        } else if (e.key === 'Escape' || e.key === 'Backspace') {
                            vscode.postMessage({ command: 'reject' });
                            e.preventDefault();
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    private async _handleAcceptRefactoring(refactoredCode?: string, selection?: vscode.Selection): Promise<void> {
        // Clean up decorations
        if (this._currentDecorations) {
            if (this._currentDecorations.preview) this._currentDecorations.preview.dispose();
            if (this._currentDecorations.codelens) this._currentDecorations.codelens.dispose();
            if (this._currentDecorations.timeout) clearTimeout(this._currentDecorations.timeout);
            this._currentDecorations = undefined;
        }
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        // Clear decorations
        editor.setDecorations(this._addedLineDecoration, []);
        editor.setDecorations(this._removedLineDecoration, []);
        
        // Apply the refactoring if provided
        if (refactoredCode && selection) {
            await this._applyRefactoring(refactoredCode, selection);
        }
        
        this._isRefactoringInProgress = false;
    }
    
    private async _handleRejectRefactoring(): Promise<void> {
        // Clean up decorations
        if (this._currentDecorations) {
            if (this._currentDecorations.preview) this._currentDecorations.preview.dispose();
            if (this._currentDecorations.codelens) this._currentDecorations.codelens.dispose();
            if (this._currentDecorations.timeout) clearTimeout(this._currentDecorations.timeout);
            this._currentDecorations = undefined;
        }
        
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(this._addedLineDecoration, []);
            editor.setDecorations(this._removedLineDecoration, []);
        }
        
        this._isRefactoringInProgress = false;
        vscode.window.showInformationMessage('Refactoring rejected');
    }

    private async _applyRefactoring(refactoredCode: string, selection: vscode.Selection): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        await editor.edit(editBuilder => {
            editBuilder.replace(selection, refactoredCode);
        });
        
        vscode.window.showInformationMessage('Code successfully refactored');
    }

    private _showRefactoringStatus(text: string): void {
        this._statusBarItem.text = text;
        this._statusBarItem.show();
    }

    private _hideRefactoringStatus(): void {
        this._statusBarItem.hide();
    }

    private _escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    public dispose(): void {
        this._statusBarItem.dispose();
        this._decoration.dispose();
        this._addedLineDecoration.dispose();
        this._removedLineDecoration.dispose();
        if (this._inlineRefactoringPanel) {
            this._inlineRefactoringPanel.dispose();
        }
    }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'diplugin.chatView';
    private _view?: vscode.WebviewView;
    private _sessions: ChatSession[] = [];
    private _currentSessionId?: string;
    private _models: string[] = ['gpt-4', 'gpt-3.5', 'claude-3-opus', 'claude-3-sonnet'];
    private _settings: ChatSettings = {
        autoContext: true,
        defaultModel: 'gpt-4',
        streamResponses: true,
        showTimestamps: true
    };
    private _abortController?: AbortController;

    constructor(
        private _context: vscode.ExtensionContext,
        private _extensionUri: vscode.Uri
    ) {
        this._initialize();
    }
    
    private async _initialize(): Promise<void> {
        // Load API config from VSCode settings
        const config = vscode.workspace.getConfiguration('aiChat');
        if (config.has('apiBaseUrl')) {
            API_BASE_URL = config.get('apiBaseUrl') as string;
        }
        
        // Load settings from global state
        const savedSettings = this._context.globalState.get<ChatSettings>('chatSettings');
        if (savedSettings) {
            this._settings = savedSettings;
        }
        
        await this._loadSessions();
        
        // Register for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiChat.apiBaseUrl')) {
                const config = vscode.workspace.getConfiguration('aiChat');
                API_BASE_URL = config.get('apiBaseUrl') as string;
            }
        });
    }

    private async _loadSessions(): Promise<void> {
        const saved = this._context.globalState.get<ChatSession[]>('sessions');
        if (saved) this._sessions = saved;
        
        if (this._sessions.length === 0) {
            await this._createNewSession();
        } else {
            this._currentSessionId = this._sessions[0].id;
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
    
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules')
            ]
        };
    
        webviewView.webview.html = this._getWebviewContent(webviewView.webview);
        
        // Set up the message listener
        this._setWebviewMessageListener(webviewView);
        
        // Initialize the webview with current state after a short delay
        // This ensures the webview has fully loaded before sending data
        setTimeout(() => {
            this._updateWebview();
        }, 500);
    }

    private async _getEnhancedContext(): Promise<CodeContext | null> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;

        const document = editor.document;
        const selection = editor.selection;
        const selectedText = selection.isEmpty ? '' : document.getText(selection);

        return {
            filePath: document.uri.fsPath,
            code: document.getText(),
            language: document.languageId,
            selection: selectedText,
            position: selection.active
        };
    }

    private async _handleCodeAction(action: string): Promise<void> {
        const context = await this._getEnhancedContext();
        if (!context) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        let prompt = '';
        switch (action) {
            case 'explainCode':
                prompt = `Explain this ${context.language} code:\n\n${context.selection || context.code}\n\nFocus on data migration patterns and Airflow best practices.`;
                break;
            case 'generateTest':
                prompt = `Generate a test case for this ${context.language} code:\n\n${context.selection || context.code}\n\nInclude assertions for data validation.`;
                break;
            case 'optimizeCode':
                prompt = `Optimize this ${context.language} code for better performance:\n\n${context.selection || context.code}`;
                break;
            case 'documentCode':
                prompt = `Add comprehensive documentation to this ${context.language} code:\n\n${context.selection || context.code}`;
                break;
            case 'refactorCode':
                prompt = `Refactor this ${context.language} code to improve readability:\n\n${context.selection || context.code}`;
                break;
        }

        if (prompt) {
            await this._handleUserMessage(prompt);
        }
    }
    
    private _setWebviewMessageListener(webviewView: vscode.WebviewView): void {
        webviewView.webview.onDidReceiveMessage(async (message) => {
            console.log('Received message:', message.command);  // Added for debugging
            
            switch (message.command) {
                case 'sendMessage':
                    await this._handleUserMessage(message.text);
                    break;
                case 'newChat':
                    await this._createNewSession();
                    break;
                case 'switchModel':
                    await this._updateModel(message.model);
                    break;
                case 'updateSettings':
                    await this._updateSettings(message.settings);
                    break;
                case 'quickAction':
                    await this._handleQuickAction(message.action);
                    break;
                case 'codeAction':
                    await this._handleCodeAction(message.action);
                    break;
                case 'applyCodeSuggestion':
                    await this._applyCodeSuggestion(message.code);
                    break;
                case 'loadSession':
                    await this._loadSessionById(message.sessionId);
                    break;
                case 'renameSession':
                    await this._renameSession(message.sessionId, message.title);
                    break;
                case 'deleteSession':
                    await this._deleteSession(message.sessionId);
                    break;
                case 'addContextFile':
                    await this._addContextFile();
                    break;
                case 'removeContextFile':
                    await this._removeContextFile(message.filePath);
                    break;
                case 'stopResponse':
                    this._stopBotResponse();
                    break;
                case 'showCodeDiff':
                    await this._showCodeDiff(message.code);
                    break;
                case 'webviewReady':
                    this._updateWebview();
                    break;
            }
        });
    }

    private async _loadSessionById(sessionId: string): Promise<void> {
        const session = this._sessions.find(s => s.id === sessionId);
        if (session) {
            this._currentSessionId = session.id;
            this._updateWebview();
        }
    }

    private get _currentSession(): ChatSession | undefined {
        return this._sessions.find(s => s.id === this._currentSessionId);
    }

    private async _saveSessions(): Promise<void> {
        await this._context.globalState.update('sessions', this._sessions);
    }

    private async _createNewSession(): Promise<void> {
        try {
            const session: ChatSession = {
                id: Date.now().toString(),
                title: 'New Chat',
                messages: [],
                model: this._settings.defaultModel,
                contextFiles: this._settings.autoContext ? await this._getCurrentContextFiles() : [],
                timestamp: Date.now()
            };
    
            this._sessions.unshift(session);
            this._currentSessionId = session.id;
            await this._saveSessions();
            this._updateWebview();
        } catch (error) {
            this._showError(error);
        }
    }

    private async _renameSession(sessionId: string, newTitle: string): Promise<void> {
        const session = this._sessions.find(s => s.id === sessionId);
        if (session) {
            session.title = newTitle;
            await this._saveSessions();
            this._updateWebview();
        }
    }

    private async _deleteSession(sessionId: string): Promise<void> {
        const index = this._sessions.findIndex(s => s.id === sessionId);
        if (index !== -1) {
            this._sessions.splice(index, 1);
            
            if (this._currentSessionId === sessionId) {
                this._currentSessionId = this._sessions.length > 0 ? this._sessions[0].id : undefined;
                if (!this._currentSessionId) {
                    await this._createNewSession();
                    return;
                }
            }
            
            await this._saveSessions();
            this._updateWebview();
        }
    }

    private async _getCurrentContextFiles(): Promise<ContextFile[]> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return [];
        
        return [{
            path: editor.document.uri.fsPath,
            content: editor.document.getText(),
            language: editor.document.languageId
        }];
    }

    private async _addContextFile(): Promise<void> {
        const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Add to context'
        });
        
        if (!files || files.length === 0) return;
        
        const fileUri = files[0];
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const session = this._currentSession;
        
        if (session) {
            // Check if file already exists in context
            const normalizedPath = fileUri.fsPath.replace(/\\/g, '/');
            const exists = session.contextFiles.some(f => f.path.replace(/\\/g, '/') === normalizedPath);
            
            if (!exists) {
                session.contextFiles.push({
                    path: fileUri.fsPath,
                    content: doc.getText(),
                    language: doc.languageId
                });
                
                await this._saveSessions();
                this._updateWebview();
            }
        }
    }
    
    private async _removeContextFile(filePath: string): Promise<void> {
        const session = this._currentSession;
        if (session) {
            const normalizedFilePath = filePath.replace(/\\/g, '/');
            session.contextFiles = session.contextFiles.filter(f => f.path.replace(/\\/g, '/') !== normalizedFilePath);
            await this._saveSessions();
            this._updateWebview();
        }
    }

    private async _handleUserMessage(message: string): Promise<void> {
        const session = this._currentSession;
        if (!session || !this._view) return;
    
        const messageId = Date.now().toString();
        
        // Add user message
        session.messages.push({
            id: messageId,
            content: message,
            isBot: false,
            timestamp: Date.now()
        });
        
        // Add placeholder for bot response
        const botMessageId = `bot-${Date.now().toString()}`;
        session.messages.push({
            id: botMessageId,
            content: '',
            isBot: true,
            timestamp: Date.now(),
            isStreaming: true
        });
        
        // Update UI
        this._updateWebview(true);
        
        try {
            if (this._settings.streamResponses) {
                await this._streamBotResponse(session, botMessageId, message);
            } else {
                await this._fetchBotResponse(session, botMessageId, message);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                // Response was intentionally aborted
                const botMsg = session.messages.find(m => m.id === botMessageId);
                if (botMsg) {
                    botMsg.content += ' (Response stopped)';
                    botMsg.isStreaming = false;
                }
            } else {
                this._showError(error);
                
                // Remove the bot message placeholder on error
                session.messages = session.messages.filter(m => m.id !== botMessageId);
            }
        }
    
        await this._saveSessions();
        this._updateWebview();
    }
    
    private async _streamBotResponse(session: ChatSession, botMessageId: string, userMessage: string): Promise<void> {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        
        try {
            // API call remains the same
            const response = await fetch(`${API_BASE_URL}/v1/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: userMessage,
                    context: this._settings.autoContext && session.contextFiles.length > 0 ? {
                        file_path: session.contextFiles[0].path,
                        code: session.contextFiles[0].content,
                        language: session.contextFiles[0].language || 'text',
                        selection: ''
                    } : {},
                    model: session.model
                }),
                signal
            });
    
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
            const reader = Readable.toWeb(response.body as any).getReader();
            if (!reader) throw new Error('Failed to get response reader');
            
            const decoder = new TextDecoder();
            let fullResponse = '';
            
            // Find the bot message in the session
            const botMsg = session.messages.find(m => m.id === botMessageId);
            if (!botMsg) throw new Error('Bot message not found');
            
            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                fullResponse += chunk;
                
                if (botMsg) {
                    const processed = this._processBotResponse(fullResponse);
                    botMsg.content = processed.content;
                    botMsg.codeSuggestion = processed.codeSuggestion;
                    botMsg.codeLanguage = processed.codeLanguage;
                    
                    // Instead of updating the entire webview, only update the streaming message
                    this._updateStreamingMessage(botMessageId, botMsg);
                }
            }
            
            // Process final response
            if (botMsg) {
                const processed = this._processBotResponse(fullResponse);
                botMsg.content = processed.content;
                botMsg.codeSuggestion = processed.codeSuggestion;
                botMsg.codeLanguage = processed.codeLanguage;
                botMsg.isStreaming = false;
                
                if (botMsg.codeSuggestion) {
                    await this._showCodeDiff(botMsg.codeSuggestion);
                }
                
                // Update the entire webview once at the end
                this._updateWebview();
            }
        } finally {
            this._abortController = undefined;
        }
    }

    // New method to update only the streaming message content
    private _updateStreamingMessage(messageId: string, message: ChatMessage): void {
        if (!this._view) return;
    
        try {
            this._view.webview.postMessage({
                command: 'updateStreamingMessage',
                messageId: messageId,
                content: message.content,
                codeSuggestion: message.codeSuggestion,
                codeLanguage: message.codeLanguage
            });
        } catch (error) {
            console.error('Error updating streaming message:', error);
        }
    }
    
    private async _fetchBotResponse(session: ChatSession, botMessageId: string, userMessage: string): Promise<void> {
        // Modified to match API in main.py
        const response = await fetch(`${API_BASE_URL}/v1/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // messages: session.messages.filter(m => !m.isStreaming).map(m => ({
                //     role: m.isBot ? 'assistant' : 'user',
                //     content: m.content
                // })),
                // model: session.model,
                // context: this._settings.autoContext ? session.contextFiles : []
                message: userMessage,
                context: this._settings.autoContext && session.contextFiles.length > 0 ? {
                    file_path: session.contextFiles[0].path,
                    code: session.contextFiles[0].content,
                    language: session.contextFiles[0].language || 'text',
                    selection: '' // Add selection if available
                } : {},
                model: session.model
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        // Read the streaming response and collect all chunks
        const reader = Readable.toWeb(response.body as any).getReader();
        if (!reader) throw new Error('Failed to get response reader');
        
        const decoder = new TextDecoder();
        let fullResponse = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullResponse += decoder.decode(value, { stream: true });
        }
        
        const botResponse = this._processBotResponse(fullResponse);

        const botMsg = session.messages.find(m => m.id === botMessageId);
        if (botMsg) {
            botMsg.content = botResponse.content;
            botMsg.codeSuggestion = botResponse.codeSuggestion;
            botMsg.codeLanguage = botResponse.codeLanguage;
            botMsg.isStreaming = false;

            if (botMsg.codeSuggestion) {
                await this._showCodeDiff(botMsg.codeSuggestion);
            }
        }
    }
    
    private _stopBotResponse(): void {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = undefined;
        }
    }

    private _processBotResponse(response: string): {
        content: string;
        codeSuggestion?: string;
        codeLanguage?: string;
    } {
        // With the dummy API, we'll get random text - try to make it look presentable
        try {
            // Process as markdown
            marked.use(markedHighlight({
                highlight(code: string, lang: string | undefined): string {
                    if (lang && hljs.getLanguage(lang)) {
                        return hljs.highlight(code, { language: lang }).value;
                    } else {
                        return hljs.highlightAuto(code).value;
                    }
                }
            }));
            
            const processed = marked.parse(response);
        
            // Look for code blocks in the response
            const codeMatch = response.match(/```([a-zA-Z0-9]+)?\s*([\s\S]*?)```/);
            
            return {
                content: codeMatch ? processed.replace(codeMatch[0], '') : processed,
                codeSuggestion: codeMatch?.[2],
                codeLanguage: codeMatch?.[1] || 'text'
            };
        } catch (error) {
            console.error('Error processing bot response:', error);
            return {
                content: response
            };
        }
    }

    private async _showCodeDiff(suggestion: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const tempFile = await vscode.workspace.openTextDocument({
            content: suggestion,
            language: editor.document.languageId
        });

        await vscode.commands.executeCommand(
            'vscode.diff',
            editor.document.uri,
            tempFile.uri,
            'Code Suggestion Preview'
        );
    }

    private async _applyCodeSuggestion(code: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await editor.edit(editBuilder => {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                editBuilder.replace(fullRange, code);
            });
        }
    }

    private async _updateModel(newModel: string): Promise<void> {
        const session = this._currentSession;
        if (session) {
            session.model = newModel;
            await this._saveSessions();
            this._updateWebview();
        }
    }

    private async _updateSettings(newSettings: Partial<ChatSettings>): Promise<void> {
        this._settings = { ...this._settings, ...newSettings };
        await this._context.globalState.update('chatSettings', this._settings);
        this._updateWebview();
    }

    private async _handleQuickAction(action: string): Promise<void> {
        const prompt = this._getQuickActionPrompt(action);
        if (prompt) await this._handleUserMessage(prompt);
    }

    private _getQuickActionPrompt(action: string): string | null {
        const prompts: Record<string, string> = {
            'explainCode': 'Please explain the following code:',
            'generateTest': 'Generate a test case for this code:',
            'optimizeCode': 'Optimize this code for better performance:',
            'documentCode': 'Add comprehensive documentation to this code:',
            'refactorCode': 'Refactor this code to improve readability:'
        };
        return prompts[action] || null;
    }

    private _showError(error: unknown): void {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this._view?.webview.postMessage({
            command: 'showError',
            message: `Error: ${message}`
        });
        vscode.window.showErrorMessage(`AI Chat Error: ${message}`);
    }

    private _updateWebview(loading = false): void {
        if (!this._view) return;

        try {
            this._view.webview.postMessage({
                command: 'updateChat',
                sessions: this._sessions,
                currentSessionId: this._currentSessionId,
                currentSession: this._currentSession,
                models: this._models,
                settings: this._settings,
                loadingState: loading
            });
        } catch (error) {
            console.error('Error updating webview:', error);
        }
    }

    private _getWebviewContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="
                    default-src 'none';
                    img-src ${webview.cspSource};
                    style-src ${webview.cspSource} 'unsafe-inline';
                    script-src 'nonce-${nonce}';
                    font-src ${webview.cspSource};
                ">
                <link rel="stylesheet" href="${styleUri}">
                <link rel="stylesheet" href="${codiconsUri}">
                <title>AI Chat</title>
            </head>
            <body>
                <div class="chat-container">
                    <div class="chat-layout">
                        <div class="chat-sidebar" id="chatSidebar">
                            <div class="model-selector">
                                <div class="model-select-container">
                                    <select id="modelSelect">
                                        <option value="gpt-4">GPT-4</option>
                                        <option value="gpt-3.5">GPT-3.5</option>
                                        <option value="claude-3-opus">Claude 3 Opus</option>
                                        <option value="claude-3-sonnet">Claude 3 Sonnet</option>
                                    </select>
                                    <span class="select-arrow codicon codicon-chevron-down"></span>
                                </div>
                            </div>
                            
                            <div class="session-list-header">
                                <span>Conversations</span>
                                <button id="newChatButton" class="new-chat-button">
                                    <span class="codicon codicon-add"></span> New
                                </button>
                            </div>
                            
                            <div class="session-list" id="sessionList"></div>
                            
                            <div class="context-files" id="contextFilesSection">
                                <div class="context-header">
                                    <span>Context Files</span>
                                    <button id="addContextButton" class="new-chat-button">
                                        <span class="codicon codicon-add"></span>
                                    </button>
                                </div>
                                <div id="contextFilesList"></div>
                            </div>
                            <div class="context-actions">
                                <button id="attachContext" class="action-button" title="Attach current code context">
                                    <span class="codicon codicon-code"></span> Attach Code
                                </button>
                                <button id="clearContext" class="action-button" title="Clear context">
                                    <span class="codicon codicon-clear-all"></span> Clear
                                </button>
                            </div>
                            
                            <div id="contextStatus" class="context-status">
                                <span class="codicon codicon-info"></span>
                                <span id="contextInfo">No code context attached</span>
                            </div>
                        </div>
                        
                        <div class="chat-main">
                            <div class="chat-header">
                                <div class="header-title">
                                    <span class="codicon codicon-comment-discussion"></span>
                                    <span id="currentSessionTitle">AI Chat</span>
                                </div>
                                <div class="header-actions">
                                    <button id="settingsButton" class="header-button" title="Settings">
                                        <span class="codicon codicon-gear"></span>
                                    </button>
                                </div>
                            </div>
                            
                            <div class="messages-container" id="messagesContainer"></div>
                            
                            <div class="input-area">
                                <div class="input-container">
                                    <textarea id="userInput" class="input-field" placeholder="Ask a question..." rows="1"></textarea>
                                    <button id="sendButton" class="send-button" title="Send message">
                                        <span class="codicon codicon-send"></span>
                                    </button>
                                </div>
                                <div class="input-actions">
                                    <button class="input-action-button quick-action" data-action="explainCode">
                                        <span class="codicon codicon-lightbulb"></span>
                                        Explain
                                    </button>
                                    <button class="input-action-button quick-action" data-action="optimizeCode">
                                        <span class="codicon codicon-rocket"></span>
                                        Optimize
                                    </button>
                                    <button class="input-action-button quick-action" data-action="refactorCode">
                                        <span class="codicon codicon-symbol-class"></span>
                                        Refactor
                                    </button>
                                    <button class="input-action-button quick-action" data-action="documentCode">
                                        <span class="codicon codicon-comment"></span>
                                        Document
                                    </button>
                                    <button class="input-action-button quick-action" data-action="generateTest">
                                        <span class="codicon codicon-beaker"></span>
                                        Test
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="toast-container" id="toastContainer"></div>
                
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    let currentSessionId = null;
                    let sessions = [];
                    let settings = {
                        autoContext: true,
                        defaultModel: 'gpt-4',
                        streamResponses: true,
                        showTimestamps: true
                    };

                    // DOM Elements
                    const sessionList = document.getElementById('sessionList');
                    const messagesContainer = document.getElementById('messagesContainer');
                    const userInput = document.getElementById('userInput');
                    const sendButton = document.getElementById('sendButton');
                    const modelSelect = document.getElementById('modelSelect');
                    const currentSessionTitle = document.getElementById('currentSessionTitle');
                    const contextFilesList = document.getElementById('contextFilesList');
                    const toastContainer = document.getElementById('toastContainer');

                    // Initialize auto-resize textarea
                    userInput.addEventListener('input', autoResizeTextarea);
                    
                    function autoResizeTextarea() {
                        userInput.style.height = 'auto';
                        userInput.style.height = (userInput.scrollHeight) + 'px';
                        
                        // Reset to 1 row if empty
                        if (userInput.value.trim() === '') {
                            userInput.style.height = '';
                        }
                    }

                    // Event Listeners - Make sure these are defined before they're called
                    // Send message when button is clicked
                    sendButton.addEventListener('click', () => {
                        console.log('Send button clicked');
                        sendMessage();
                    });

                    // Send message when Enter is pressed (not Shift+Enter)
                    userInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            console.log('Enter key pressed');
                            e.preventDefault();
                            sendMessage();
                        }
                    });

                    document.getElementById('newChatButton').addEventListener('click', () => {
                        console.log('New chat button clicked');
                        vscode.postMessage({ command: 'newChat' });
                    });

                    document.getElementById('addContextButton').addEventListener('click', () => {
                        console.log('Add context button clicked');
                        vscode.postMessage({ command: 'addContextFile' });
                    });

                    document.getElementById('settingsButton').addEventListener('click', () => {
                        console.log('Settings button clicked');
                        toggleSettings();
                    });
                    
                    document.getElementById('attachContext').addEventListener('click', () => {
                        console.log('Attach context button clicked');
                        vscode.postMessage({ command: 'addContextFile' });
                    });
                    
                    document.getElementById('clearContext').addEventListener('click', () => {
                        console.log('Clear context button clicked');
                        if (currentSessionId) {
                            const session = sessions.find(s => s.id === currentSessionId);
                            if (session && session.contextFiles.length > 0) {
                                session.contextFiles.forEach(file => {
                                    vscode.postMessage({ 
                                        command: 'removeContextFile', 
                                        filePath: file.path 
                                    });
                                });
                            }
                        }
                    });
                    
                    modelSelect.addEventListener('change', () => {
                        console.log('Model changed to:', modelSelect.value);
                        vscode.postMessage({ 
                            command: 'switchModel', 
                            model: modelSelect.value 
                        });
                    });

                    // Setup quick actions
                    document.querySelectorAll('.quick-action').forEach(button => {
                        button.addEventListener('click', () => {
                            console.log('Quick action clicked:', button.dataset.action);
                            vscode.postMessage({
                                command: 'quickAction',
                                action: button.dataset.action
                            });
                        });
                    });

                    // Message Handling
                    window.addEventListener('message', (event) => {
                        const message = event.data;
                        console.log('Received message from extension:', message.command);
                        
                        switch (message.command) {
                            case 'updateChat':
                                updateUI(message);
                                break;
                            case 'updateStreamingMessage':
                                updateStreamingMessageContent(message);
                                break;
                            case 'showError':
                                showToast(message.message, 'error');
                                break;
                        }
                    });

                    function toggleSettings() {
                        // Create a modal for settings
                        const settingsHTML = \`
                            <div class="settings-modal" id="settingsModal">
                                <div class="settings-content">
                                    <div class="settings-header">
                                        <h3>Settings</h3>
                                        <button class="close-button" id="closeSettings">
                                            <span class="codicon codicon-close"></span>
                                        </button>
                                    </div>
                                    <div class="settings-body">
                                        <div class="setting-item">
                                            <label>
                                                <input type="checkbox" id="settingAutoContext" 
                                                    \${settings.autoContext ? 'checked' : ''}>
                                                Automatically include active file in context
                                            </label>
                                        </div>
                                        <div class="setting-item">
                                            <label>
                                                <input type="checkbox" id="settingStreamResponses" 
                                                    \${settings.streamResponses ? 'checked' : ''}>
                                                Stream responses (show typing effect)
                                            </label>
                                        </div>
                                        <div class="setting-item">
                                            <label>
                                                <input type="checkbox" id="settingShowTimestamps" 
                                                    \${settings.showTimestamps ? 'checked' : ''}>
                                                Show message timestamps
                                            </label>
                                        </div>
                                    </div>
                                    <div class="settings-footer">
                                        <button class="primary-button" id="saveSettings">Save Settings</button>
                                    </div>
                                </div>
                            </div>
                        \`;
                        
                        // Add modal to DOM
                        const modalContainer = document.createElement('div');
                        modalContainer.innerHTML = settingsHTML;
                        document.body.appendChild(modalContainer);
                        
                        // Handle close button
                        document.getElementById('closeSettings').addEventListener('click', () => {
                            document.body.removeChild(modalContainer);
                        });
                        
                        // Handle save button
                        document.getElementById('saveSettings').addEventListener('click', () => {
                            const newSettings = {
                                autoContext: document.getElementById('settingAutoContext').checked,
                                streamResponses: document.getElementById('settingStreamResponses').checked,
                                showTimestamps: document.getElementById('settingShowTimestamps').checked
                            };
                            
                            vscode.postMessage({
                                command: 'updateSettings',
                                settings: newSettings
                            });
                            
                            document.body.removeChild(modalContainer);
                        });
                    }

                    function updateUI(data) {
                        console.log('Updating UI with data');
                        sessions = data.sessions;
                        currentSessionId = data.currentSessionId;
                        settings = data.settings;
                        
                        updateSessionList(data.sessions, data.currentSessionId);
                        updateMessages(data.currentSession?.messages || []);
                        updateModelSelector(data.currentSession?.model);
                        updateContextFiles(data.currentSession?.contextFiles || []);
                        
                        currentSessionTitle.textContent = data.currentSession?.title || 'AI Chat';
                    }

                    function updateStreamingMessageContent(data) {
                        const messageElement = document.querySelector(\`[data-message-id="\${data.messageId}"]\`);
                        if (!messageElement) return;
                        
                        // Update the message content
                        const contentElement = messageElement.querySelector('.message-content');
                        if (contentElement) {
                            contentElement.innerHTML = data.content || '';
                        }
                        
                        // Handle code suggestion if present
                        const existingCodeBlock = messageElement.querySelector('.code-block');
                        if (data.codeSuggestion) {
                            if (existingCodeBlock) {
                                // Update existing code block
                                const codeElement = existingCodeBlock.querySelector('code');
                                if (codeElement) {
                                    codeElement.textContent = data.codeSuggestion;
                                    codeElement.className = \`language-\${data.codeLanguage || ''}\`;
                                }
                                
                                // Update language tag
                                const langTag = existingCodeBlock.querySelector('.language-tag');
                                if (langTag) {
                                    langTag.textContent = data.codeLanguage || 'code';
                                }
                            } else {
                                // Create new code block if it doesn't exist yet
                                const codeBlockHtml = \`
                                    <div class="code-block">
                                        <div class="code-header">
                                            <span class="language-tag">\${data.codeLanguage || 'code'}</span>
                                            <button class="copy-button" title="Copy to clipboard">
                                                <span class="codicon codicon-copy"></span>
                                            </button>
                                        </div>
                                        <pre><code class="language-\${data.codeLanguage || ''}">\${escapeHtml(data.codeSuggestion)}</code></pre>
                                        <div class="code-actions">
                                            <button class="code-action-button apply-code" title="Apply to editor">
                                                <span class="codicon codicon-check"></span>
                                                Apply
                                            </button>
                                            <button class="code-action-button view-diff" title="View differences">
                                                <span class="codicon codicon-git-compare"></span>
                                                Compare
                                            </button>
                                        </div>
                                    </div>
                                \`;
                                
                                const tempDiv = document.createElement('div');
                                tempDiv.innerHTML = codeBlockHtml;
                                messageElement.appendChild(tempDiv.firstChild);
                                
                                // Add event listeners to the newly created buttons
                                const copyBtn = messageElement.querySelector('.copy-button');
                                if (copyBtn) {
                                    copyBtn.addEventListener('click', (e) => {
                                        const codeBlock = e.target.closest('.code-block');
                                        const code = codeBlock.querySelector('code').textContent;
                                        
                                        navigator.clipboard.writeText(code).then(() => {
                                            const originalIcon = copyBtn.innerHTML;
                                            copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
                                            
                                            setTimeout(() => {
                                                copyBtn.innerHTML = originalIcon;
                                            }, 2000);
                                        });
                                    });
                                }
                                
                                const applyBtn = messageElement.querySelector('.apply-code');
                                if (applyBtn) {
                                    applyBtn.addEventListener('click', () => {
                                        vscode.postMessage({
                                            command: 'applyCodeSuggestion',
                                            code: data.codeSuggestion
                                        });
                                        
                                        showToast('Code applied to editor', 'success');
                                    });
                                }
                                
                                const diffBtn = messageElement.querySelector('.view-diff');
                                if (diffBtn) {
                                    diffBtn.addEventListener('click', () => {
                                        vscode.postMessage({
                                            command: 'showCodeDiff',
                                            code: data.codeSuggestion
                                        });
                                    });
                                }
                            }
                        }
                    }

                    function updateSessionList(sessions, currentId) {
                        sessionList.innerHTML = sessions.map(session => {
                            // Get first message content for title if default "New Chat"
                            const title = session.title === 'New Chat' && session.messages.length > 0 ? 
                                truncateText(session.messages[0].content, 28) : session.title;
                            
                            const date = new Date(session.timestamp);
                            const formattedDate = \`\${date.toLocaleDateString()} \${date.getHours()}:\${String(date.getMinutes()).padStart(2, '0')}\`;
                            return \`
                                <div class="session-item \${session.id === currentId ? 'active' : ''}" 
                                     data-session-id="\${session.id}">
                                    <span class="codicon codicon-comment-discussion session-icon"></span>
                                    <div class="session-info">
                                        <div class="session-title">\${title}</div>
                                        <div class="session-timestamp">\${formattedDate}</div>
                                    </div>
                                    <div class="session-actions">
                                        <button class="action-button session-rename" data-id="\${session.id}" title="Rename">
                                            <span class="codicon codicon-edit"></span>
                                        </button>
                                        <button class="action-button session-delete" data-id="\${session.id}" title="Delete">
                                            <span class="codicon codicon-trash"></span>
                                        </button>
                                    </div>
                                </div>
                            \`;
                        }).join('');

                        // Add event listeners after rendering DOM elements
                        setTimeout(() => {
                            // Add event listeners to session items
                            document.querySelectorAll('.session-item').forEach(item => {
                                item.addEventListener('click', (e) => {
                                    if (!e.target.closest('.session-actions')) {
                                        console.log('Session clicked:', item.dataset.sessionId);
                                        vscode.postMessage({
                                            command: 'loadSession',
                                            sessionId: item.dataset.sessionId
                                        });
                                    }
                                });
                            });
                            
                            // Add event listeners to rename buttons
                            document.querySelectorAll('.session-rename').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    const sessionId = btn.dataset.id;
                                    const session = sessions.find(s => s.id === sessionId);
                                    if (session) {
                                        const newTitle = prompt('Enter new name for this chat:', session.title);
                                        if (newTitle !== null) {
                                            console.log('Renaming session:', sessionId, 'to', newTitle);
                                            vscode.postMessage({
                                                command: 'renameSession',
                                                sessionId,
                                                title: newTitle
                                            });
                                        }
                                    }
                                });
                            });
                            
                            // Add event listeners to delete buttons
                            document.querySelectorAll('.session-delete').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    const sessionId = btn.dataset.id;
                                    if (confirm('Are you sure you want to delete this chat?')) {
                                        console.log('Deleting session:', sessionId);
                                        vscode.postMessage({
                                            command: 'deleteSession',
                                            sessionId
                                        });
                                    }
                                });
                            });
                        }, 0);
                    }

                    function updateContextFiles(files) {
                        if (files.length === 0) {
                            document.getElementById('contextFilesSection').classList.add('hidden');
                        } else {
                            document.getElementById('contextFilesSection').classList.remove('hidden');
                            
                            contextFilesList.innerHTML = files.map(file => {
                                const pathParts = file.path;
                                const fileName = pathParts[pathParts.length - 1];
                                const fileIcon = getFileIcon(fileName);
                                
                                return \`
                                    <div class="context-file">
                                        <span class="codicon \${fileIcon} file-icon"></span>
                                        <span class="file-name" title="\${file.path}">\${fileName}</span>
                                        <button class="remove-file" data-path="\${file.path}">
                                            <span class="codicon codicon-close"></span>
                                        </button>
                                    </div>
                                \`;
                            }).join('');
                            
                            // Add event listeners after rendering
                            setTimeout(() => {
                                document.querySelectorAll('.remove-file').forEach(btn => {
                                    btn.addEventListener('click', () => {
                                        console.log('Removing context file:', btn.dataset.path);
                                        vscode.postMessage({
                                            command: 'removeContextFile',
                                            filePath: btn.dataset.path
                                        });
                                    });
                                });
                            }, 0);
                        }
                    }
                    
                    function getFileIcon(fileName) {
                        const baseName = fileName.split('/').pop() || '';
                        const ext = baseName.split('.').pop()?.toLowerCase() || '';
                        const icons = {
                            'js': 'codicon-symbol-field',
                            'ts': 'codicon-symbol-field',
                            'jsx': 'codicon-symbol-field',
                            'tsx': 'codicon-symbol-field',
                            'py': 'codicon-symbol-field',
                            'html': 'codicon-symbol-field',
                            'css': 'codicon-symbol-field',
                            'json': 'codicon-json',
                            'md': 'codicon-markdown'
                        };
                        
                        return icons[ext] || 'codicon-file';
                    }

                    function updateMessages(messages) {
                        // Group consecutive messages from same sender
                        const messageGroups = [];
                        let currentGroup = [];
                        
                        messages.forEach((msg, i) => {
                            if (i === 0 || messages[i-1].isBot !== msg.isBot) {
                                if (currentGroup.length > 0) messageGroups.push(currentGroup);
                                currentGroup = [msg];
                            } else {
                                currentGroup.push(msg);
                            }
                        });

                        if (currentGroup.length > 0) messageGroups.push(currentGroup);
                        
                        // Generate HTML for message groups
                        messagesContainer.innerHTML = messageGroups.map(group => {
                            const isBot = group[0].isBot;
                            const sender = isBot ? 'AI Assistant' : 'You';
                            
                            return \`
                                <div class="message-group">
                                    <div class="message-sender">\${sender}</div>
                                    \${group.map(msg => {
                                        const timestamp = new Intl.DateTimeFormat('default', {
                                            hour: 'numeric',
                                            minute: 'numeric'
                                        }).format(new Date(msg.timestamp));
                                        
                                        return \`
                                            <div class="message \${isBot ? 'bot-message' : 'user-message'}" data-message-id="\${msg.id}">
                                                <div class="message-content">\${msg.content || ''}</div>
                                                
                                                \${msg.isStreaming ? \`
                                                    <div class="typing-indicator">
                                                        <span class="typing-dot"></span>
                                                        <span class="typing-dot"></span>
                                                        <span class="typing-dot"></span>
                                                    </div>
                                                    <div class="message-actions">
                                                        <button class="action-button stop-button" title="Stop generating">
                                                            <span class="codicon codicon-debug-stop"></span>
                                                        </button>
                                                    </div>
                                                \` : ''}
                                                
                                                \${msg.codeSuggestion ? \`
                                                    <div class="code-block">
                                                        <div class="code-header">
                                                            <span class="language-tag">\${msg.codeLanguage || 'code'}</span>
                                                            <button class="copy-button" title="Copy to clipboard">
                                                                <span class="codicon codicon-copy"></span>
                                                            </button>
                                                        </div>
                                                        <pre><code class="language-\${msg.codeLanguage || ''}">\${escapeHtml(msg.codeSuggestion)}</code></pre>
                                                        <div class="code-actions">
                                                            <button class="code-action-button apply-code" title="Apply to editor">
                                                                <span class="codicon codicon-check"></span>
                                                                Apply
                                                            </button>
                                                            <button class="code-action-button view-diff" title="View differences">
                                                                <span class="codicon codicon-git-compare"></span>
                                                                Compare
                                                            </button>
                                                        </div>
                                                    </div>
                                                \` : ''}
                                                
                                                \${settings.showTimestamps ? \`<div class="message-time">\${timestamp}</div>\` : ''}
                                            </div>
                                        \`;
                                    }).join('')}
                                </div>
                            \`;
                        }).join('');
                        
                        // Add event listeners after rendering
                        setTimeout(() => {
                            // Add event listeners for code actions
                            document.querySelectorAll('.apply-code').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    const messageEl = e.target.closest('.message');
                                    const messageId = messageEl.dataset.messageId;
                                    const message = findMessageById(messageId);
                                    
                                    if (message && message.codeSuggestion) {
                                        console.log('Applying code suggestion');
                                        vscode.postMessage({
                                            command: 'applyCodeSuggestion',
                                            code: message.codeSuggestion
                                        });
                                        
                                        showToast('Code applied to editor', 'success');
                                    }
                                });
                            });
                            
                            // View differences button
                            document.querySelectorAll('.view-diff').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    const messageEl = e.target.closest('.message');
                                    const messageId = messageEl.dataset.messageId;
                                    const message = findMessageById(messageId);
                                    
                                    if (message && message.codeSuggestion) {
                                        console.log('Comparing code differences');
                                        vscode.postMessage({
                                            command: 'showCodeDiff',
                                            code: message.codeSuggestion
                                        });
                                    }
                                });
                            });
                            
                            // Add event listeners for copy buttons
                            document.querySelectorAll('.copy-button').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    const codeBlock = e.target.closest('.code-block');
                                    const code = codeBlock.querySelector('code').textContent;
                                    
                                    navigator.clipboard.writeText(code).then(() => {
                                        const originalIcon = btn.innerHTML;
                                        btn.innerHTML = '<span class="codicon codicon-check"></span>';
                                        
                                        setTimeout(() => {
                                            btn.innerHTML = originalIcon;
                                        }, 2000);
                                    });
                                });
                            });
                            
                            // Add event listeners for stop generation
                            document.querySelectorAll('.stop-button').forEach(btn => {
                                btn.addEventListener('click', () => {
                                    console.log('Stopping response generation');
                                    vscode.postMessage({ command: 'stopResponse' });
                                });
                            });
                        }, 0);
                        
                        // Scroll to the bottom of the chat
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }
                    
                    function findMessageById(id) {
                        const session = sessions.find(s => s.id === currentSessionId);
                        if (session) {
                            return session.messages.find(m => m.id === id);
                        }
                        return null;
                    }

                    function updateModelSelector(currentModel) {
                        if (currentModel) {
                            modelSelect.value = currentModel;
                        }
                    }
                    
                    function escapeHtml(unsafe) {
                        return unsafe
                            .replace(/&/g, "&amp;")
                            .replace(/</g, "&lt;")
                            .replace(/>/g, "&gt;")
                            .replace(/"/g, "&quot;")
                            .replace(/'/g, "&#039;");
                    }

                    function sendMessage() {
                        const text = userInput.value.trim();
                        if (text) {
                            console.log('Sending message:', text);
                            vscode.postMessage({ 
                                command: 'sendMessage', 
                                text 
                            });
                            userInput.value = '';
                            userInput.style.height = '';
                        }
                    }

                    function showToast(message, type = 'info') {
                        const toast = document.createElement('div');
                        toast.className = \`toast toast-\${type}\`;
                        
                        const icon = type === 'error' ? 'error' : 
                                     type === 'success' ? 'check' : 'info';
                        
                        toast.innerHTML = \`
                            <span class="codicon codicon-\${icon}"></span>
                            <div class="toast-content">\${message}</div>
                            <button class="toast-close">
                                <span class="codicon codicon-close"></span>
                            </button>
                        \`;
                        
                        toastContainer.appendChild(toast);
                        
                        // Auto-remove after 5 seconds
                        const timeout = setTimeout(() => {
                            if (toast.parentNode) {
                                toast.remove();
                            }
                        }, 5000);
                        
                        // Setup close button
                        toast.querySelector('.toast-close').addEventListener('click', () => {
                            clearTimeout(timeout);
                            toast.remove();
                        });
                        
                        // Setup animated entrance
                        setTimeout(() => {
                            toast.classList.add('show');
                        }, 10);
                    }
                    
                    function truncateText(text, maxLength) {
                        if (!text) return '';
                        text = text.trim();
                        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
                    }

                    // Send a ready message to let the extension know the webview is initialized
                    console.log('Webview initialized, sending ready message');
                    vscode.postMessage({ command: 'webviewReady' });
                </script>
            </body>
            </html>
        `;
    }
}

class AIInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private lastRequestTime: number = 0;
    private completionDebounceTimeout: NodeJS.Timeout | undefined;
    private isRequestInProgress: boolean = false;
    
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | null> {
        // Don't trigger completions too frequently or if a request is already in progress
        const now = Date.now();
        if (now - this.lastRequestTime < 500 || this.isRequestInProgress) {
            return null;
        }
        
        this.lastRequestTime = now;
        this.isRequestInProgress = true;
        
        try {
            // Get the file content and cursor position
            const fileText = document.getText();
            const filePath = document.uri.fsPath;
            
            // Get text leading up to cursor for prompt context
            const textUpToCursor = document.getText(new vscode.Range(
                new vscode.Position(0, 0),
                position
            ));
            
            // Make API call to your backend
            const response = await fetch(`${API_BASE_URL}/v1/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: textUpToCursor,
                    file_path: filePath,
                    max_tokens: 256
                })
            });
            
            if (!response.ok) {
                console.error(`API error: ${response.status}`);
                return null;
            }
            
            // Process streaming response
            const reader = Readable.toWeb(response.body as any).getReader();
            if (!reader) return null;
            
            const decoder = new TextDecoder();
            let fullResponse = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullResponse += decoder.decode(value, { stream: true });
                if (token.isCancellationRequested) {
                    return null;
                }
            }
            
            // Create inline completion items
            const completions: vscode.InlineCompletionItem[] = [];
            const suggestions = fullResponse.trim().split('\n');
            
            for (const suggestion of suggestions) {
                if (!suggestion.trim()) continue;
                
                // Create an inline completion item with the suggestion text
                const item = new vscode.InlineCompletionItem(
                    suggestion,
                    new vscode.Range(position, position)
                );
                
                // Add command for when the completion is accepted
                item.command = {
                    command: 'diplugin.logCompletionAccepted',
                    title: 'Completion Accepted'
                };
                
                completions.push(item);
            }
            
            return completions;
        } catch (error) {
            console.error('Inline completion provider error:', error);
            return null;
        } finally {
            this.isRequestInProgress = false;
        }
    }
    
    setupAutoTrigger() {
        const settings = getCompletionSettings();
        if (!settings.autoTrigger) {
            return; // Don't auto trigger if disabled
        }
        // Listen for document changes
        vscode.workspace.onDidChangeTextDocument(event => {
            // Skip triggering for large changes (like file load)
            if (event.contentChanges.length === 0 || 
                event.contentChanges.some(change => change.text.length > 100)) {
                return;
            }
            
            // Only trigger for typing events (not bulk edits)
            const isTypingEvent = event.contentChanges.length === 1 && 
                                 event.contentChanges[0].text.length <= 1;
            
            if (!isTypingEvent) {
                return;
            }
        
            // Update settings in real-time
            const currentSettings = getCompletionSettings();
            if (!currentSettings.enabled || !currentSettings.autoTrigger) {
                return;
            }
            
            // Clear existing timeout
            if (this.completionDebounceTimeout) {
                clearTimeout(this.completionDebounceTimeout);
            }
            
            // Schedule inline completion trigger after delay
            this.completionDebounceTimeout = setTimeout(() => {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }, currentSettings.delay);
        });
    
        // Also listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiChat')) {
                // Settings changed, potentially update behavior
                const settings = getCompletionSettings();
                if (!settings.enabled) {
                    // Clear any pending triggers
                    if (this.completionDebounceTimeout) {
                        clearTimeout(this.completionDebounceTimeout);
                        this.completionDebounceTimeout = undefined;
                    }
                }
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "diplugin" is now active!');
    
    // Load API config from VSCode settings
    const config = vscode.workspace.getConfiguration('aiChat');
    if (config.has('apiBaseUrl')) {
        API_BASE_URL = config.get('apiBaseUrl') as string;
    }
    
    const provider = new ChatViewProvider(context, context.extensionUri);
    
    // Initialize the code refactoring provider
    const refactoringProvider = new CodeRefactoringProvider(context);
    
    // Register chat view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );
    
    // Register the refactor command
    context.subscriptions.push(
        vscode.commands.registerCommand('diplugin.refactorCode', async () => {
            await refactoringProvider.refactorSelectedCode();
        }),
        vscode.commands.registerCommand('diplugin.focusChat', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.diplugin-sidebar');
        }),
        vscode.commands.registerCommand('diplugin.askAi', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor');
                return;
            }
        
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
        
            const prompt = selectedText || await vscode.window.showInputBox({ 
                prompt: 'Enter your prompt for the AI' 
            });
            
            if (!prompt) {
                vscode.window.showInformationMessage('No prompt provided');
                return;
            }
        
            try {
                const response = await axios.post(`${API_BASE_URL}/v1/complete`, {
                    prompt,
                    file_path: editor.document.uri.fsPath,
                    max_tokens: 512
                });
        
                const aiResponse = response.data || 'No response received from AI.';
        
                const doc = await vscode.workspace.openTextDocument({ 
                    content: aiResponse, 
                    language: 'markdown' 
                });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    vscode.window.showErrorMessage(`API error: ${error.message}`);
                } else {
                    vscode.window.showErrorMessage(`Unexpected error: ${String(error)}`);
                }
            }
        })
    );
    
    // Create status bar item for quick access
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = "$(comment-discussion) AI Chat";
    statusBarItem.tooltip = "Open AI Chat";
    statusBarItem.command = "diplugin.focusChat";
    statusBarItem.show();
    
    context.subscriptions.push(statusBarItem);
    
    // Register the inline completion provider
    const inlineCompletionProvider = new AIInlineCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },  // All files
            inlineCompletionProvider
        )
    );
    
    // Track completion acceptance
    context.subscriptions.push(
        vscode.commands.registerCommand('diplugin.logCompletionAccepted', () => {
            // You can add analytics or other processing when a completion is accepted
            console.log('Completion was accepted');
        })
    );
    
    // Set up auto-triggering for inline completions
    inlineCompletionProvider.setupAutoTrigger();

    configureEditorSettings();

    // Register commands and providers
    // context.subscriptions.push(
    //     vscode.commands.registerCommand('diplugin.refactorCode', async () => {
    //         const provider = new ChatViewProvider(context, context.extensionUri);
    //         await provider._handleCodeAction('refactorCode');
    //     }),
    //     vscode.commands.registerCommand('diplugin.explainCode', async () => {
    //         const provider = new ChatViewProvider(context, context.extensionUri);
    //         await provider._handleCodeAction('explainCode');
    //     })
    // );
    // context.subscriptions.push(disposable);

    
}

export function deactivate() {
    // Clean up resources when extension is deactivated
    console.log('Extension "diplugin" is now deactivated.');
}

function getCompletionSettings(): AICompletionSettings {
    const config = vscode.workspace.getConfiguration('aiChat');
    return {
        enabled: config.get<boolean>('enableInlineCompletions', true),
        delay: config.get<number>('inlineCompletionDelay', 500),
        autoTrigger: config.get<boolean>('autoTriggerCompletions', true)
    };
}

async function configureEditorSettings() {
    // Only suggest changing settings if they're not already set
    const editorConfig = vscode.workspace.getConfiguration('editor');
    
    // Enable inline suggestions if not already enabled
    if (editorConfig.get('inlineSuggest.enabled') === false) {
        const updateSetting = await vscode.window.showInformationMessage(
            'For the best AI completion experience, it\'s recommended to enable "editor.inlineSuggest.enabled". ' +
            'Would you like to enable this setting?',
            'Yes', 'No'
        );
        
        if (updateSetting === 'Yes') {
            await editorConfig.update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
        }
    }
    
    // Suggest setting up keybindings for accepting/rejecting inline suggestions
    const keyboardConfig = vscode.workspace.getConfiguration('keyboard');
    if (!keyboardConfig.get('acceptSuggestionOnEnter')) {
        const updateKeybinding = await vscode.window.showInformationMessage(
            'Would you like to configure keyboard shortcuts for accepting (Tab) and dismissing (Escape) AI suggestions?',
            'Yes', 'No'
        );
        
        if (updateKeybinding === 'Yes') {
            // Open the keybindings.json file
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
            
            // Suggest keybindings to add
            const msg = vscode.window.showInformationMessage(
                'Add these entries to your keybindings.json file:\n\n' +
                '{\n' +
                '    "key": "tab",\n' +
                '    "command": "editor.action.inlineSuggest.commit",\n' +
                '    "when": "inlineSuggestionVisible && !editorTabMovesFocus"\n' +
                '},\n' +
                '{\n' +
                '    "key": "escape",\n' +
                '    "command": "editor.action.inlineSuggest.hide",\n' +
                '    "when": "inlineSuggestionVisible"\n' +
                '}'
            );
        }
    }
}