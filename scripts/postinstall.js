const fs = require('fs');
const path = require('path');
// Ensure scripts directory exists
if (!fs.existsSync('scripts')) {
    fs.mkdirSync('scripts');
}
// Platform-specific cleanup and setup
function ensureDirectoryExists(dirPath) {
    const normalizedPath = dirPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    
    let currentPath = '';
    for (const part of parts) {
        currentPath = currentPath ? path.join(currentPath, part) : part;
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath);
        }
    }
}
// Ensure media directory exists
ensureDirectoryExists('media');
// Check if icon.svg exists in media directory
if (!fs.existsSync(path.join('media', 'icon.svg'))) {
    // Create a basic SVG icon if it doesn't exist
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#007acc"/>
        <text x="12" y="16" font-family="Arial" font-size="12" fill="white" text-anchor="middle">AI</text>
    </svg>`;
    
    fs.writeFileSync(path.join('media', 'icon.svg'), svgContent);
    console.log('Created default icon.svg');
}
console.log('Postinstall script completed successfully');