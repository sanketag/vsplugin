"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const node_fetch_1 = __importDefault(require("node-fetch"));
let chatPanel;
const API_BASE_URL = 'http://127.0.0.1:5000';
function activate(context) {
    try {
        // Chat panel implementation
        context.subscriptions.push(vscode.commands.registerCommand('diplugin.openChat', () => {
            if (!chatPanel) {
                chatPanel = createChatPanel(context);
                setupChatWebviewListeners();
            }
            chatPanel.reveal();
        }));
        // Completion provider with error handling
        context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', {
            provideCompletionItems(document, position) {
                return __awaiter(this, void 0, void 0, function* () {
                    try {
                        const response = yield (0, node_fetch_1.default)(`${API_BASE_URL}/generate`, {
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
                        const data = yield response.json();
                        return data.suggestions.map((text) => {
                            const item = new vscode.CompletionItem(text);
                            item.kind = vscode.CompletionItemKind.Snippet;
                            return item;
                        });
                    }
                    catch (error) {
                        vscode.window.showErrorMessage('Failed to fetch code suggestions');
                        return [];
                    }
                });
            }
        }, '.', '"', "'", ' '));
        // Refactoring command with diff preview
        context.subscriptions.push(vscode.commands.registerCommand('diplugin.refactorCode', () => __awaiter(this, void 0, void 0, function* () {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            try {
                const response = yield (0, node_fetch_1.default)(`${API_BASE_URL}/refactor`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: editor.document.getText() })
                });
                if (!response.ok) {
                    throw new Error('API request failed');
                }
                const refactoredCode = yield response.text();
                const newDocument = yield vscode.workspace.openTextDocument({
                    content: refactoredCode,
                    language: editor.document.languageId
                });
                yield vscode.commands.executeCommand('vscode.diff', editor.document.uri, newDocument.uri, 'Refactored Code Preview');
            }
            catch (error) {
                console.error(error);
                vscode.window.showErrorMessage('Code refactoring failed');
            }
        })));
        console.log('DIPlugin activated!');
        vscode.window.showInformationMessage('DIPlugin activated successfully!');
    }
    catch (error) {
        console.log('Error activation!', error);
    }
}
function createChatPanel(context) {
    const panel = vscode.window.createWebviewPanel('chatPanel', 'AI Chat', vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
        retainContextWhenHidden: true
    });
    panel.webview.html = getWebviewContent(panel, context);
    return panel;
}
function setupChatWebviewListeners() {
    if (!chatPanel) {
        return;
    }
    chatPanel.webview.onDidReceiveMessage((message) => __awaiter(this, void 0, void 0, function* () {
        console.log("Received message in extension:", message);
        if (message.command === 'sendMessage') {
            yield handleChatMessage(message.text);
        }
    }));
    chatPanel.onDidDispose(() => {
        chatPanel = undefined;
    });
}
function getWebviewContent(panel, context) {
    // Generate URIs for local resources
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css'));
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
function handleChatMessage(userMessage) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!chatPanel) {
            return;
        }
        try {
            const response = yield (0, node_fetch_1.default)(`${API_BASE_URL}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMessage })
            });
            if (!response.ok) {
                throw new Error('API request failed');
            }
            const data = yield response.json();
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
        }
        catch (error) {
            chatPanel.webview.postMessage({
                command: 'error',
                text: error
            });
        }
    });
}
function deactivate() {
    if (chatPanel) {
        chatPanel.dispose();
    }
}
//# sourceMappingURL=extension.js.map