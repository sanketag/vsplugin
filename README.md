# DIPlugin - AI Coding Assistant 🚀

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://marketplace.visualstudio.com/items?itemName=your-publisher.diplugin)
[![VS Code Version](https://img.shields.io/badge/VS%20Code-%3E%3D1.85.0-blue.svg)](https://code.visualstudio.com/)

**Your AI Pair Programmer** - Enhance your development workflow with intelligent code completion, real-time chat assistance, and AI-powered refactoring.

## ✨ Features

### Core Functionality
- **AI Chat Panel** (`diplugin.openChat`)  
  Interactive sidebar chat with your AI model
- **Code Refactoring** (`diplugin.refactorCode`)  
  Single-command code optimization with diff preview
- **Smart Code Completion**  
  Context-aware suggestions for JavaScript & Python
- **Custom API Integration**  
  Secure connection to your AI backend

### Technical Highlights
- CommonJS module system
- XSS protection with DOMPurify
- Markdown rendering support
- Configurable API endpoints
- VS Code 1.85+ compatibility

## 📥 Installation

### Prerequisites
- Visual Studio Code ≥1.85
- Running AI API endpoint

### Installation Methods
**VSIX Installation**
```bash
# In VS Code command palette
Extensions: Install from VSIX...
```

### Adding API Config
```bash
{
  "aiChat.apiBaseUrl": "http://your-actual-api-endpoint",
  "aiChat.enableTelemetry": false
}
```
