import * as path from 'path';
import * as vscode from "vscode";

export function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getSelectedCodeContext(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return '';

  const document = editor.document;
  const selection = editor.selection;

  if (selection.isEmpty) {
    return document.getText();
  }

  return document.getText(selection);
}

// Update getFileIcon to support more file types
export function getFileIcon(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const icons: Record<string, string> = {
    'js': 'file-code',
    'ts': 'file-code',
    'sql': 'database',
    'py': 'python',
    'yaml': 'yaml',
    'yml': 'yaml',
    'json': 'json',
    'csv': 'csv',
    'xml': 'xml',
    'sh': 'terminal',
    'dockerfile': 'docker',
    'md': 'markdown'
  };
  return `codicon-${icons[ext] || 'file'}`;
}