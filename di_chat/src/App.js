import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './App.css';

const App = () => {
  // State for sessions and active session
  const [sessions, setSessions] = useState(() => {
    const savedSessions = localStorage.getItem('chat-sessions');
    return savedSessions ? JSON.parse(savedSessions) : [
      { id: '1', title: 'New Chat', messages: [], collapsed: false, createdAt: Date.now() },
    ];
  });
  const [activeSessionId, setActiveSessionId] = useState(() => {
    return localStorage.getItem('active-session-id') || '1';
  });
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem('selected-model') || 'qwen2.5-coder:0.5b');
  
  // Refs
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const eventSourceRef = useRef(null);

  // Get active session
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];

  // Fetch available models on component mount
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await fetch('http://localhost:9693/api/models');
        const data = await response.json();
        if (data.models && Array.isArray(data.models)) {
          setAvailableModels(data.models);
        }
      } catch (err) {
        console.error('Failed to fetch models:', err);
      }
    };
    
    fetchModels();
  }, []);

  // Save sessions to localStorage when they change
  useEffect(() => {
    localStorage.setItem('chat-sessions', JSON.stringify(sessions));
    localStorage.setItem('active-session-id', activeSessionId);
  }, [sessions, activeSessionId]);

  // Save selected model to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('selected-model', selectedModel);
  }, [selectedModel]);

  // Scroll to bottom of messages with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [activeSession?.messages]);

  // Focus input on load and when active session changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeSessionId]);

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 150)}px`;
    }
  }, [inputMessage]);

  // Get conversation history for context
  const getConversationHistory = useCallback(() => {
    if (!activeSession) return [];
    
    return activeSession.messages.map(msg => ({
      role: msg.isUser ? 'user' : 'assistant',
      content: msg.content
    }));
  }, [activeSession]);

  // Handle sending a message
  const handleSendMessage = useCallback(async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage = {
        id: Date.now().toString(),
        content: inputMessage,
        isUser: true,
        timestamp: Date.now(),
    };

    // Update session with user message
    setSessions(prevSessions => prevSessions.map(session => {
        if (session.id === activeSessionId) {
            const updatedMessages = [...session.messages, userMessage];
            const title = session.messages.length === 0 
                ? inputMessage.substring(0, 30) + (inputMessage.length > 30 ? '...' : '')
                : session.title;
            return {
                ...session,
                title,
                messages: updatedMessages,
            };
        }
        return session;
    }));

    setInputMessage('');
    setIsLoading(true);
    setError(null);

    // Add empty bot message
    const botMessageId = (Date.now() + 1).toString();
      setSessions(prevSessions => prevSessions.map(session => {
        if (session.id === activeSessionId) {
            return {
                ...session,
                messages: [...session.messages, {
                    id: botMessageId,
                    content: '',
                    isUser: false,
                    timestamp: Date.now(),
                    contentParts: [], // Initialize with empty array
                }],
            };
        }
        return session;
      }));

    try {
        // Close any existing connection
        if (eventSourceRef.current) {
            eventSourceRef.current.abort();
        }

        // Create new AbortController for this request
        const abortController = new AbortController();
        eventSourceRef.current = abortController;

        // Get conversation history
        const history = getConversationHistory();
        
        // Create payload
        const payload = {
            prompt: inputMessage,
            model: selectedModel,
            history: history.slice(0, -1),
            stream: true
        };

        // Use EventSource for proper SSE handling
        const encodedPayload = encodeURIComponent(JSON.stringify(payload));
        const eventSource = new EventSource(`http://localhost:9693/api/generate?data=${encodedPayload}`);

        const timeout = setTimeout(() => {
            eventSource.close();
            abortController.abort();
            setIsLoading(false);
            setError('Request timed out');
        }, 30000);

        // In your eventSource.onmessage handler:
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            
            setSessions(prevSessions => prevSessions.map(session => {
              if (session.id === activeSessionId) {
                return {
                  ...session,
                  messages: session.messages.map(msg => {
                    if (msg.id === botMessageId) {
                      // Current message state
                      const currentContent = msg.content || '';
                      const contentToAdd = data.content || '';
                      
                      // Check if we're in a code block state
                      const isInCodeBlock = ((currentContent.match(/```/g) || []).length % 2 !== 0);
                      const startsCodeBlock = contentToAdd.includes('```') && !isInCodeBlock;
                      const endsCodeBlock = contentToAdd.includes('```') && isInCodeBlock;
                      
                      // Determine content type based on code block state
                      let contentType = data.content_type || 'text';
                      let language = '';
                      
                      if (startsCodeBlock) {
                        // Extract language if code block is starting
                        const langMatch = contentToAdd.match(/```(\w*)/);
                        language = langMatch?.[1] || '';
                        contentType = 'code';
                      } else if (isInCodeBlock || endsCodeBlock) {
                        // We're inside a code block or ending one
                        contentType = 'code';
                      }
                      
                      // Update message with new content part
                      return {
                        ...msg,
                        content: currentContent + contentToAdd,
                        contentParts: [
                          ...(msg.contentParts || []),
                          {
                            content: contentToAdd,
                            content_type: contentType,
                            language: language,
                            list_type: data.list_type || '',
                            formatting: data.formatting || {}
                          }
                        ]
                      };
                    }
                    return msg;
                  }),
                };
              }
              return session;
            }));
          } catch (err) {
            console.error('Error processing event:', err);
          }
        };

        eventSource.addEventListener('end', () => {
            eventSource.close();
            setIsLoading(false);
            clearTimeout(timeout);
        });

        eventSource.onerror = (err) => {
            console.error('EventSource error:', err);
            eventSource.close();
            setIsLoading(false);
            setError('Connection error');
            clearTimeout(timeout);
        };

        const processCompleteMessage = (message) => {
          if (!message || !message.content) return message;
          
          // Identify code blocks in the complete message
          const content = message.content;
          const codeBlocks = [];
          const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
          
          let match;
          let lastIndex = 0;
          
          // Find all code blocks
          while ((match = codeBlockRegex.exec(content)) !== null) {
            // Add text before code block
            if (match.index > lastIndex) {
              codeBlocks.push({
                content: content.substring(lastIndex, match.index),
                content_type: 'text'
              });
            }
            
            // Add code block
            codeBlocks.push({
              content: match[2],
              content_type: 'code',
              language: match[1] || ''
            });
            
            lastIndex = match.index + match[0].length;
          }
          
          // Add any remaining text
          if (lastIndex < content.length) {
            codeBlocks.push({
              content: content.substring(lastIndex),
              content_type: 'text'
            });
          }
          
          // If we found code blocks, replace contentParts
          if (codeBlocks.length > 0) {
            return {
              ...message,
              contentParts: codeBlocks
            };
          }
          
          return message;
        };
        
        // Add this to your "end" event handler
        eventSource.addEventListener('end', () => {
          eventSource.close();
          setIsLoading(false);
          clearTimeout(timeout);
          
          // Post-process the complete message
          setSessions(prevSessions => prevSessions.map(session => {
            if (session.id === activeSessionId) {
              return {
                ...session,
                messages: session.messages.map(msg => {
                  if (msg.id === botMessageId) {
                    return processCompleteMessage(msg);
                  }
                  return msg;
                }),
              };
            }
            return session;
          }));
        });

    } catch (err) {
        console.error('Error:', err);
        setIsLoading(false);
        setError(err.message);
        
        setSessions(prevSessions => prevSessions.map(session => {
            if (session.id === activeSessionId) {
                return {
                    ...session,
                    messages: session.messages.map(msg => {
                        if (msg.id === botMessageId) {
                            return { 
                                ...msg, 
                                content: `Error: ${err.message || 'Failed to get response'}`,
                                contentParts: [{
                                    content: `Error: ${err.message || 'Failed to get response'}`,
                                    content_type: 'error'
                                }]
                            };
                        }
                        return msg;
                    }),
                };
            }
            return session;
        }));
    }
}, [inputMessage, isLoading, activeSessionId, selectedModel, getConversationHistory]);

  // Render content based on content type
  const renderContentPart = (part, index) => {
    if (!part || !part.content) return null;
  
    switch (part.content_type) {
      case 'code':
        // Clean up code content
        let codeContent = part.content;
        
        // Remove potential remaining backticks
        if (codeContent.startsWith('```')) {
          const firstNewline = codeContent.indexOf('\n');
          codeContent = firstNewline > 0 ? codeContent.substring(firstNewline + 1) : '';
        }
        
        if (codeContent.endsWith('```')) {
          codeContent = codeContent.substring(0, codeContent.length - 3);
        }
        
        return (
          <div key={index} className="content-part code-block">
            {part.language && (
              <div className="code-language">{part.language}</div>
            )}
            <SyntaxHighlighter
              style={atomDark}
              language={part.language || 'text'}
              PreTag="div"
              showLineNumbers={true}
              wrapLines={true}
              wrapLongLines={true}
              customStyle={{
                margin: 0,
                borderRadius: '0.5rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {codeContent.trim()}
            </SyntaxHighlighter>
          </div>
        );
      
      case 'math':
        return (
          <div 
            key={index} 
            className="content-part math-block"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(part.content, {
                throwOnError: false,
                displayMode: true
              })
            }}
          />
        );
      
      case 'list':
        const ListTag = part.list_type === 'numbered' ? 'ol' : 'ul';
        const items = part.content.split('\n').filter(item => item.trim());
        
        return (
          <ListTag key={index} className={`content-part list ${part.list_type}`}>
            {items.map((item, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: item }} />
            ))}
          </ListTag>
        );
      
      case 'table':
        const rows = part.content.split('\n').filter(row => row.trim());
        return (
          <div key={index} className="content-part table-container">
            <table>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {row.split('|').filter(cell => cell.trim()).map((cell, j) => (
                      <td key={j} dangerouslySetInnerHTML={{ __html: cell.trim() }} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      
      case 'error':
        return (
          <div key={index} className="content-part error-message">
            {part.content}
          </div>
        );
      
      case 'text':
      default:
        let content = part.content;
        if (part.formatting) {
          // Apply formatting based on hints
          if (part.formatting.bold) {
            content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                            .replace(/__(.*?)__/g, '<strong>$1</strong>');
          }
          if (part.formatting.italic) {
            content = content.replace(/\*(.*?)\*/g, '<em>$1</em>')
                            .replace(/_(.*?)_/g, '<em>$1</em>');
          }
          if (part.formatting.code) {
            content = content.replace(/`(.*?)`/g, '<code>$1</code>');
          }
          if (part.formatting.link) {
            content = content.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
          }
          if (part.formatting.header) {
            const level = Math.min(part.formatting.header, 6);
            content = `<h${level}>${content.replace(/^#+\s*/, '')}</h${level}>`;
          }
        }
        
        return (
          <div 
            key={index} 
            className="content-part text"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        );
    }
  };

  // Create new chat session
  const handleNewChat = useCallback(() => {
    const newSession = {
      id: Date.now().toString(),
      title: 'New Chat',
      messages: [],
      collapsed: false,
      createdAt: Date.now(),
    };
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(newSession.id);
  }, []);

  // Toggle session collapse
  const toggleSessionCollapse = useCallback((sessionId) => {
    setSessions(prevSessions => prevSessions.map(session => {
      if (session.id === sessionId) {
        return { ...session, collapsed: !session.collapsed };
      }
      return session;
    }));
  }, []);

  // Set active session
  const setActiveSession = useCallback((sessionId) => {
    setActiveSessionId(sessionId);
  }, []);

  // Handle key press in input
  const handleKeyPress = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  }, [handleSendMessage]);

  // Delete a session
  const deleteSession = useCallback((sessionId, e) => {
    e.stopPropagation();
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== sessionId);
      // If we're deleting the active session, switch to another one
      if (sessionId === activeSessionId && filtered.length > 0) {
        setActiveSessionId(filtered[0].id);
      }
      // If we're deleting the last session, create a new one
      if (filtered.length === 0) {
        const newSession = {
          id: Date.now().toString(),
          title: 'New Chat',
          messages: [],
          collapsed: false,
          createdAt: Date.now(),
        };
        setActiveSessionId(newSession.id);
        return [newSession];
      }
      return filtered;
    });
  }, [activeSessionId]);

  // Format timestamp
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Custom paragraph component for better spacing
  const Paragraph = ({ node, ...props }) => (
    <p style={{ marginBottom: '1rem', lineHeight: '1.6' }} {...props} />
  );

  // Enhanced code block component
  const CodeBlock = ({ node, inline, className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    
    // Handle inline code
    if (inline) {
      return (
        <code className={className} {...props} style={{
          background: 'var(--bg-tertiary)',
          padding: '0.2rem 0.4rem',
          borderRadius: '0.25rem',
          fontFamily: 'Fira Code, monospace',
        }}>
          {children}
        </code>
      );
    }

    return match ? (
      <div style={{ position: 'relative' }}>
        <div style={{
          position: 'absolute',
          right: '0.5rem',
          top: '0.5rem',
          background: 'var(--accent-color)',
          color: 'white',
          padding: '0.2rem 0.5rem',
          borderRadius: '0.25rem',
          fontSize: '0.8rem',
          zIndex: 1,
        }}>
          {match[1]}
        </div>
        <SyntaxHighlighter 
          style={atomDark} 
          language={match[1]} 
          PreTag="div" 
          showLineNumbers={true}
          wrapLines={true}
          {...props}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    ) : (
      <SyntaxHighlighter 
        style={atomDark} 
        PreTag="div" 
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    );
  };

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <button className="new-chat-btn" onClick={handleNewChat}>
          + New Chat
        </button>
        
        {/* Model selection dropdown */}
        <div className="model-selector">
          <label htmlFor="model-select">Model:</label>
          <select 
            id="model-select" 
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            {availableModels.length > 0 ? (
              availableModels.map(model => (
                <option key={model.name} value={model.name}>
                  {model.name}
                </option>
              ))
            ) : (
              <option value="qwen2.5-coder:0.5b">qwen2.5-coder:0.5b</option>
            )}
          </select>
        </div>
        
        <div className="sessions-list">
          {sessions
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(session => (
              <div 
                key={session.id} 
                className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
              >
                <div 
                  className="session-header" 
                  onClick={() => setActiveSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <div className="session-actions">
                    <button 
                      className="collapse-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSessionCollapse(session.id);
                      }}
                      aria-label={session.collapsed ? 'Expand' : 'Collapse'}
                    >
                      {session.collapsed ? '>' : '⌄'}
                    </button>
                    <button
                      className="delete-btn"
                      onClick={(e) => deleteSession(session.id, e)}
                      aria-label="Delete chat"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {!session.collapsed && (
                  <div className="session-messages-preview">
                    {session.messages.slice(0, 2).map(msg => (
                      <div key={msg.id} className="preview-message">
                        <span className="preview-content">
                          {msg.content.substring(0, 30)}{msg.content.length > 30 ? '...' : ''}
                        </span>
                        <span className="preview-time">
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                    ))}
                    {session.messages.length === 0 && (
                      <div className="preview-message empty">No messages yet</div>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="chat-container">
        {activeSession.messages.length === 0 ? (
          <div className="welcome-message">
            <h1>Hi there</h1>
            <p>How can I help you today?</p>
          </div>
        ) : (
          <div className="messages-container">
            {activeSession.messages.map((message) => (
              <div 
                key={message.id} 
                className={`message ${message.isUser ? 'user' : 'bot'}`}
              >
                <div className="avatar">
                  {message.isUser ? '👤' : '🤖'}
                </div>
                <div className="message-content-container">
                  <div className="message-content">
                  {message.isUser ? (
                    message.content
                  ) : (
                    <div className="bot-response">
                      {Array.isArray(message.contentParts) && message.contentParts.length > 0 ? (
                        message.contentParts.map((part, index) => renderContentPart(part, index))
                      ) : (
                        message.content && <div className="content-part text">{message.content}</div>
                      )}
                      {message.contentParts && message.contentParts.length === 0 && !message.content && (
                        <div className="content-part text">Loading...</div>
                      )}
                    </div>
                  )}
                  </div>
                  <div className="message-time">
                    {formatTime(message.timestamp)}
                  </div>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="message bot">
                <div className="avatar">🤖</div>
                <div className="typing-indicator">
                  <span className="dot"></span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {/* Input Area */}
        <div className="input-area">
          <div className="input-container">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Type a message..."
              disabled={isLoading}
              rows={1}
            />
            <button 
              onClick={handleSendMessage}
              disabled={!inputMessage.trim() || isLoading}
              aria-label="Send message"
              className="send-button"
            >
              {isLoading ? (
                <span className="spinner"></span>
              ) : (
                'Send'
              )}
            </button>
          </div>
          <div className="input-hint">
            Press Enter to send, Shift+Enter for new line
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
