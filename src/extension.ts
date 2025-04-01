import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { getNonce } from './utils';
import { marked } from 'marked';
import { Readable } from 'stream';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

// Register common languages for syntax highlighting
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);

const API_BASE_URL = 'http://127.0.0.1:5000';

interface ChatMessage {
    id: string;
    content: string;
    isBot: boolean;
    timestamp: number;
    codeSuggestion?: string;
    codeLanguage?: string;
    isStreaming?: boolean;
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
        await this._loadSessions();
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
    
    private _setWebviewMessageListener(webviewView: vscode.WebviewView): void {
        webviewView.webview.onDidReceiveMessage(async (message) => {
            console.log('Received message:', message);  // Added for debugging
            
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
                contextFiles: await this._getCurrentContextFiles(),
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
            const exists = session.contextFiles.some(f => f.path === fileUri.fsPath);
            
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
            session.contextFiles = session.contextFiles.filter(f => f.path !== filePath);
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
            const response = await fetch(`${API_BASE_URL}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: userMessage,
                    model: session.model,
                    context: this._settings.autoContext ? session.contextFiles : []
                }),
                signal
            });
    
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
            const reader = Readable.toWeb(response.body as Readable).getReader();
            if (!reader) throw new Error('Failed to get response reader');
            
            const decoder = new TextDecoder();
            let fullResponse = '';
            
            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                fullResponse += chunk;
                
                const botMsg = session.messages.find(m => m.id === botMessageId);
                if (botMsg) {
                    const processed = this._processBotResponse(fullResponse);
                    botMsg.content = processed.content;
                    botMsg.codeSuggestion = processed.codeSuggestion;
                    botMsg.codeLanguage = processed.codeLanguage;
                    
                    this._updateWebview();
                }
            }
            
            // Process final response
            const botMsg = session.messages.find(m => m.id === botMessageId);
            if (botMsg) {
                const processed = this._processBotResponse(fullResponse);
                botMsg.content = processed.content;
                botMsg.codeSuggestion = processed.codeSuggestion;
                botMsg.codeLanguage = processed.codeLanguage;
                botMsg.isStreaming = false;
                
                if (botMsg.codeSuggestion) {
                    await this._showCodeDiff(botMsg.codeSuggestion);
                }
            }
        } finally {
            this._abortController = undefined;
        }
    }
    
    private async _fetchBotResponse(session: ChatSession, botMessageId: string, userMessage: string): Promise<void> {
        const response = await fetch(`${API_BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: userMessage,
                model: session.model,
                context: this._settings.autoContext ? session.contextFiles : []
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const data = await response.json();
        const botResponse = this._processBotResponse(data.response);

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
        const processed = marked.parse(response, {
            highlight: (code, lang) => {
                if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(lang, code).value;
                } else {
                    return hljs.highlightAuto(code).value;
                }
            }
        });
    
        // Improved code extraction - get language too
        const codeMatch = processed.match(/<pre><code class="language-([a-zA-Z0-9]+)">([\s\S]*?)<\/code><\/pre>/);
        
        return {
            content: codeMatch ? processed.replace(codeMatch[0], '') : processed,
            codeSuggestion: codeMatch?.[2],
            codeLanguage: codeMatch?.[1]
        };
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
                                const pathParts = file.path.split(/[/\\]/);
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
                        const ext = fileName.split('.').pop().toLowerCase();
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
                        text = text.replace(/\n/g, ' ').trim();
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

export function activate(context: vscode.ExtensionContext) {
    const provider = new ChatViewProvider(context, context.extensionUri);
    
    // Expose provider commands for external access
    (provider as any)._view = undefined;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
        vscode.commands.registerCommand('diplugin.focusChat', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.diplugin-sidebar');
            await vscode.commands.executeCommand('workbench.action.focusView');
        }),
        vscode.commands.registerCommand('diplugin.newChat', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.diplugin-sidebar');
            await vscode.commands.executeCommand('diplugin.focusChat');
            // The provider will be accessible through the extension
            (provider as any)._view?.webview.postMessage({ command: 'newChat' });
        })
    );

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(comment-discussion) AI Chat";
    statusBarItem.tooltip = "Open AI Chat";
    statusBarItem.command = "diplugin.focusChat";
    statusBarItem.show();
}

export function deactivate() {}