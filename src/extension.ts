import * as vscode from 'vscode';
import fetch from 'node-fetch';

let chatPanel: vscode.WebviewPanel | undefined;
const API_BASE_URL = 'http://127.0.0.1:5000';

export function activate(context: vscode.ExtensionContext) {
    try {
        // Chat panel implementation
        context.subscriptions.push(
            vscode.commands.registerCommand('diplugin.openChat', () => {
                if (!chatPanel) {
                    chatPanel = createChatPanel(context);
                    setupChatWebviewListeners();
                }
                chatPanel.reveal();
            })
        );

        // Completion provider with error handling
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider('*', {
                async provideCompletionItems(document, position) {
                    try {
                        const response = await fetch(`${API_BASE_URL}/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                code: document.getText(),
                                position: { line: position.line, character: position.character }
                            })
                        });

                        if (!response.ok) {
                            throw new Error('API request failed');
                        }

                        const data = await response.json() as CompletionResponse;
                        return data.suggestions.map((text) => {
                            const item = new vscode.CompletionItem(text);
                            item.kind = vscode.CompletionItemKind.Snippet;
                            return item;
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage('Failed to fetch code suggestions');
                        return [];
                    }
                }
            }, '.', '"', "'", ' ')
        );

        // Refactoring command with diff preview
        context.subscriptions.push(
            vscode.commands.registerCommand('diplugin.refactorCode', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }

                try {
                    const response = await fetch(`${API_BASE_URL}/refactor`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code: editor.document.getText() })
                    });

                    if (!response.ok) {
                        throw new Error('API request failed');
                    }

                    const refactoredCode = await response.text();
                    const newDocument = await vscode.workspace.openTextDocument({
                        content: refactoredCode,
                        language: editor.document.languageId
                    });

                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        editor.document.uri,
                        newDocument.uri,
                        'Refactored Code Preview'
                    );
                } catch (error) {
                    console.error(error);
                    vscode.window.showErrorMessage('Code refactoring failed');
                }
            })
        );
        console.log('DIPlugin activated!');
        vscode.window.showInformationMessage('DIPlugin activated successfully!');
    } catch (error) {
        console.log('Error activation!', error);
    }
}

function createChatPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'chatPanel',
        'AI Chat',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [context.extensionUri],
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent(panel, context);
    return panel;
}

function setupChatWebviewListeners() {
    if (!chatPanel) { return; }

    chatPanel.webview.onDidReceiveMessage(async message => {
		console.log("Received message in extension:", message);
        if (message.command === 'sendMessage') {
            await handleChatMessage(message.text);
		}
    });

    chatPanel.onDidDispose(() => {
        chatPanel = undefined;
    });
}

function getWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    // Generate URIs for local resources
    const styleUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css')
    );

    const nonce = getNonce();

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'none';
                img-src ${panel.webview.cspSource};
                style-src 'unsafe-inline' ${panel.webview.cspSource};
                script-src 'nonce-${nonce}' 'unsafe-inline';
                font-src ${panel.webview.cspSource};
            ">
            <link rel="stylesheet" href="${styleUri}">
        </head>
        <body>
            <div class="chat-container">
                <div class="messages" id="messages"></div>
                <div class="input-area">
                    <textarea 
                        id="input" 
                        placeholder="Ask your question !!!" 
                        rows="3"
                    ></textarea>
                    <button id="sendButton">Send</button>
                </div>
            </div>
            
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const messagesDiv = document.getElementById('messages');
                const input = document.getElementById('input');
                const sendButton = document.getElementById('sendButton');
				document.getElementById('input').addEventListener('keydown', handleKeyDown);
				document.getElementById('sendButton').addEventListener('click', sendMessage);

                
                function appendMessage(text, isBot) {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = \`message \${isBot ? 'bot' : 'user'}\`;
                    messageDiv.innerHTML = text;
                    messagesDiv.appendChild(messageDiv);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
                
                function handleKeyDown(event) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        sendMessage();
                    }
                }
                
                function sendMessage() {
                    const message = input.value.trim();
                    if (!message) return;
                    
                    input.value = '';
                    sendButton.disabled = true;
                    
                    appendMessage(message, false);
                    vscode.postMessage({
                        command: 'sendMessage',
                        text: message
                    });
                }
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'receiveMessage') {
                        appendMessage(message.text, true);
                    } else if (message.command === 'error') {
                        appendMessage(\`<div class="error">\${message.text}</div>\`, true);
                    }
                    sendButton.disabled = false;
                });
            </script>
        </body>
        </html>
    `;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 64; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

interface ChatResponse {
    response: string;
}

interface CompletionResponse {
    suggestions: string[];
}

async function handleChatMessage(userMessage: string) {
    if (!chatPanel) { return; }

    try {
        const response = await fetch(`${API_BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: userMessage })
        });
		if (!response.ok) {
            throw new Error('API request failed');
        }
        const data = await response.json();
		console.log("Full API response:", data.response);

		if (!data.response) {
			throw new Error("Invalid response from API");
		}
        const safeResponse = data.response || "No response from AI";

        chatPanel.webview.postMessage({
            command: 'receiveMessage',
            text: safeResponse,
            isBot: true
        });
    } catch (error) {
        chatPanel.webview.postMessage({
            command: 'error',
            text: error
        });
    }
}


export function deactivate() {
    if (chatPanel) {
        chatPanel.dispose();
    }
}

