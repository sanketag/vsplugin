import * as path from 'path';

export function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 64; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function getFileIcon(filePath: string): string {
    const ext = path.extname(filePath).slice(1);
    const icons: Record<string, string> = {
        js: 'file-code',
        ts: 'file-code',
        py: 'file-code',
        md: 'markdown',
        json: 'json'
    };
    return `codicon-${icons[ext] || 'file'}`;
}